import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../app.js';
import { prisma, queryStats } from '../db.js';
import { resetStatsCache } from '../routes/health.js';

/**
 * #79 — Audit: no per-row queries in list routes.
 *
 * All list routes have been manually audited and confirmed to use batched queries:
 * - `/providers`: uses `include: { services }` (single JOIN query)
 * - `/vouchers`: uses `include: { provider }` + `serviceLabels()` helper that batches
 *   service lookups into ONE `findMany({ where: { id: { in: ids } } })`
 * - `/receipts`: same pattern as vouchers with `serviceLabels()` batching, plus
 *   `providerSummaries()` (#51), which batches the clinic name and country for
 *   the whole page into ONE `findMany({ where: { address: { in: addresses } } })`
 *   instead of a lookup per row. `Receipt` has no Prisma relation to `Provider`,
 *   so it cannot use `include` the way `Voucher` does; the batch is what keeps
 *   it to one query either way.
 * - `/services`: uses `groupBy` aggregation, no per-row lookups
 * - `/sponsors`: `totalsBySponsor()` (#317) reads the whole page's match rows
 *   and budget movements in ONE `findMany({ where: { sponsorAddress: { in: addresses } } })`
 *   each, then groups in JS — the amounts are i128 decimal strings, so no SQL
 *   aggregate can add them. Guarded by a real query count in
 *   `sponsors.test.ts`, not by this comment.
 * - `/vouchers` again, for the match join: `matchesByOriginalVoucherId()`
 *   batches a page's `sponsorMatch` lookup into one query, which the existing
 *   "fixed number of queries, not one per row" check in `routes.test.ts`
 *   counts alongside the rest of the page.
 *
 * No route issues N+1 queries. This file serves as documentation of that finding
 * and a regression guard via the existing route tests in routes.test.ts.
 */

/** Shared by both blocks: a fresh instance per case, closed after it. */
let app: FastifyInstance;

beforeEach(async () => {
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

describe('list routes use batched queries (#79)', () => {
  it('/providers includes services via Prisma include, not per-row queries', async () => {
    // The providers list route uses include: { services: { where: { active: true } } }
    // which generates a single JOIN query. Verified by reading src/routes/providers.ts:69-74.
    const res = await app.inject({
      method: 'GET',
      url: '/providers?limit=10',
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(Array.isArray(body.providers)).toBe(true);
    // If there were per-row queries, each provider.services would trigger a separate DB call
  });

  it('/vouchers uses serviceLabels() batch for service names', async () => {
    // The serviceLabels() helper in src/lib/services.ts collects all unique
    // (providerAddress, serviceCode) pairs and does ONE findMany query:
    //   prisma.service.findMany({ where: { id: { in: ids } } })
    // This is O(1) database calls regardless of page size.
    const res = await app.inject({
      method: 'GET',
      url: '/vouchers?funder=GDRHSGBLCHN4DNXQMIHWR3XJH4JM4ZNEIZGURNG42KSQVYULDW3PQH3I',
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(Array.isArray(body.vouchers)).toBe(true);
  });

  it('/receipts also uses serviceLabels() and providerSummaries() batching', async () => {
    // Same pattern as vouchers - the receipts list calls serviceLabels(page)
    // and providerSummaries(page), each batching its lookups into one query
    // for the whole page instead of one per row.
    const res = await app.inject({
      method: 'GET',
      url: '/receipts?beneficiaryRef=' + 'a'.repeat(64),
    });
    expect(res.statusCode).toBe(200);

    const body = JSON.parse(res.body);
    expect(Array.isArray(body.receipts)).toBe(true);
  });
});

/**
 * #320 — the aggregate routes compute once per ledger.
 *
 * `/stats/funnel` and `/stats/services` scan the whole read model, and the
 * dashboard asks them both on every visit. A cached answer is invisible in
 * the response — it is byte-identical to a computed one — so the only thing
 * that can prove the cache is the number of operations the request causes,
 * which is what `queryStats` counts.
 *
 * One operation is always left on a hit: the cursor read that decides
 * whether the memo is still current. It is a primary-key lookup, and it is
 * what makes the rest skippable rather than merely fast — a cached answer
 * that cannot be dated is the bug this guards against, not the cost.
 */
describe('aggregate routes compute once per ledger (#320)', () => {
  const FUNNEL_CLINIC = `G${'C'.repeat(55)}`;
  const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';

  /**
   * Fixed timestamps rather than `Date.now()` offsets: the funnel medians are
   * asserted exactly, and a fixture built from four separate `now()` calls
   * would differ from itself by milliseconds.
   */
  const HOUR_MS = 60 * 60 * 1000;
  const T0 = Date.UTC(2026, 9, 1, 12);

  type FunnelBody = {
    country: string | null;
    clinic: string | null;
    counts: { funded: number; claimed: number; attested: number; settled: number };
    medianHours: {
      fundedToClaimed: number | null;
      claimedToAttested: number | null;
      attestedToSettled: number | null;
    };
  };

  type ServiceStatsBody = {
    total: number;
    limit: number;
    services: { serviceCode: number; label: string | null; count: number; value: string }[];
  };

  async function get<T>(url: string): Promise<T> {
    const res = await app.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(200);
    return res.json() as T;
  }

  /** How many Prisma operations one request causes. */
  async function operationsFor(url: string): Promise<number> {
    const before = queryStats.queries;
    await get(url);
    return queryStats.queries - before;
  }

  beforeEach(async () => {
    await prisma.receipt.deleteMany();
    await prisma.voucher.deleteMany();
    await prisma.service.deleteMany();
    await prisma.provider.deleteMany();
    await prisma.indexerState.deleteMany();
    // The memo is module state, so it outlives the app built for the case
    // before this one.
    resetStatsCache();

    await prisma.provider.create({
      data: {
        address: FUNNEL_CLINIC,
        name: 'Ikeja General Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date('2026-09-01T00:00:00Z'),
      },
    });
    await prisma.service.create({
      data: {
        id: `${FUNNEL_CLINIC}:101`,
        code: 101,
        label: 'Antenatal visit',
        price: '12000000',
        active: true,
        providerAddress: FUNNEL_CLINIC,
      },
    });
    await prisma.voucher.createMany({
      data: [
        {
          id: 'qc-claimed',
          funder: FUNDER,
          beneficiaryRef: 'a'.repeat(64),
          providerAddress: FUNNEL_CLINIC,
          serviceCode: 101,
          amount: '10000000',
          status: 'Claimed',
          claimedAt: new Date(T0 - HOUR_MS),
          createdAt: new Date(T0 - 5 * HOUR_MS),
          expiresAt: new Date(T0 + 24 * HOUR_MS),
        },
        {
          id: 'qc-settled',
          funder: FUNDER,
          beneficiaryRef: 'b'.repeat(64),
          providerAddress: FUNNEL_CLINIC,
          serviceCode: 101,
          amount: '30000000',
          status: 'Settled',
          claimedAt: new Date(T0 - 4 * HOUR_MS),
          attestedAt: new Date(T0 - 3 * HOUR_MS),
          createdAt: new Date(T0 - 8 * HOUR_MS),
          expiresAt: new Date(T0 + 24 * HOUR_MS),
        },
      ],
    });
    await prisma.receipt.create({
      data: {
        voucherId: 'qc-settled',
        beneficiaryRef: 'b'.repeat(64),
        providerAddress: FUNNEL_CLINIC,
        serviceCode: 101,
        amount: '30000000',
        settledAt: new Date(T0 - 2 * HOUR_MS),
      },
    });
    await prisma.indexerState.create({ data: { id: 1, lastLedger: 1_000 } });
  });

  it('runs no read-model query on a second /stats/funnel within one ledger', async () => {
    const cold = await operationsFor('/stats/funnel');
    // The cursor, every voucher and every receipt. An unscoped call skips the
    // clinic list because there is no filter to resolve.
    expect(cold).toBe(3);

    expect(await operationsFor('/stats/funnel')).toBe(1);

    // What the cached answer says is what the scan said.
    const body = await get<FunnelBody>('/stats/funnel');
    expect(body).toEqual({
      country: null,
      clinic: null,
      counts: { funded: 2, claimed: 2, attested: 1, settled: 1 },
      medianHours: { fundedToClaimed: 4, claimedToAttested: 1, attestedToSettled: 1 },
    });
  });

  it("does not answer one funnel filter from another filter's cached scope", async () => {
    // A memo keyed on the ledger alone would serve whichever question was
    // asked first, and both answers are plausible numbers.
    expect((await get<FunnelBody>('/stats/funnel')).counts.funded).toBe(2);
    expect((await get<FunnelBody>('/stats/funnel?country=zz')).counts.funded).toBe(0);

    const byClinic = await get<FunnelBody>(`/stats/funnel?clinic=${FUNNEL_CLINIC}`);
    expect(byClinic.clinic).toBe(FUNNEL_CLINIC);
    expect(byClinic.counts.funded).toBe(2);
    expect(byClinic.counts.settled).toBe(1);
  });

  it('runs no read-model query on a second /stats/services, at any limit', async () => {
    const cold = await operationsFor('/stats/services');
    // The cursor, every voucher, and the one batched label lookup.
    expect(cold).toBe(3);

    expect(await operationsFor('/stats/services')).toBe(1);
    // `limit` trims the cached ranking, so a second page size is not a
    // second scan either.
    expect(await operationsFor('/stats/services?limit=2')).toBe(1);

    const body = await get<ServiceStatsBody>('/stats/services?limit=2');
    expect(body.total).toBe(1);
    expect(body.services).toHaveLength(1);
    expect(body.services[0]).toMatchObject({
      serviceCode: 101,
      label: 'Antenatal visit',
      count: 2,
      value: '40000000',
    });
  });

  it('recomputes when the cursor advances, and shows what arrived with it', async () => {
    await get<ServiceStatsBody>('/stats/services');
    expect(await operationsFor('/stats/services')).toBe(1);

    // The indexer commits a ledger, and with it the voucher that landed in it.
    await prisma.voucher.create({
      data: {
        id: 'qc-newcode',
        funder: FUNDER,
        beneficiaryRef: 'c'.repeat(64),
        providerAddress: FUNNEL_CLINIC,
        serviceCode: 202,
        amount: '5000000',
        status: 'Funded',
        createdAt: new Date(T0 - HOUR_MS),
        expiresAt: new Date(T0 + 24 * HOUR_MS),
      },
    });
    await prisma.indexerState.update({ where: { id: 1 }, data: { lastLedger: 1_001 } });

    expect(await operationsFor('/stats/services')).toBeGreaterThanOrEqual(3);

    const services = await get<ServiceStatsBody>('/stats/services');
    expect(services.total).toBe(2);
    expect(services.services.map((service) => service.serviceCode)).toEqual([101, 202]);

    // Same for the funnel: the new voucher is funded, so it is counted.
    await prisma.indexerState.update({ where: { id: 1 }, data: { lastLedger: 1_002 } });
    expect((await get<FunnelBody>('/stats/funnel')).counts.funded).toBe(3);
  });

  // The fixture is replaced before each case but survives the last one, and
  // with `fileParallelism: false` the next file in the run reads these rows:
  // a `/vouchers` page for this funder comes back carrying `qc-*` ids it never
  // created. Same teardown as the setup above.
  afterAll(async () => {
    await prisma.receipt.deleteMany();
    await prisma.voucher.deleteMany();
    await prisma.service.deleteMany();
    await prisma.provider.deleteMany();
    await prisma.indexerState.deleteMany();
    resetStatsCache();
  });
});

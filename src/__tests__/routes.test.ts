import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma, queryStats } from '../db.js';
import { CONTRACTS, env } from '../env.js';
import { encodeCursor } from '../lib/cursor.js';
import { backfillDailyStats } from '../lib/daily-stats.js';
import { CLAIM_GRACE_MS } from '../lib/lifecycle.js';
import { LIST_ROUTE_RATE_LIMIT } from '../lib/rate-limits.js';
import { webhookCircuit } from '../lib/webhooks.js';
import { resetStatsCache } from '../routes/health.js';
import { server } from '../stellar/client.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const SECOND_CLINIC = 'GDRHSGBLCHN4DNXQMIHWR3XJH4JM4ZNEIZGURNG42KSQVYULDW3PQH3I';
const PENDING_CLINIC = 'GBWBYKGC5OCRELVP5WHAKEMBSZMNUY3HOKVSYBQGLFNWWQHNH2SD53FZ';
/** An address that appears on a receipt but never registered (`#51`). */
const UNREGISTERED_CLINIC = `G${'U'.repeat(55)}`;
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const ADMIN = 'A'.repeat(56);
const NEW_ADMIN = 'B'.repeat(56);
const ATTESTER = 'GATTESTER'.padEnd(56, 'A');
const FORMER_ATTESTER = 'GFORMER'.padEnd(56, 'B');
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const OTHER_REF = 'a'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const REGISTRY = CONTRACTS.find((c) => c.contract === 'registry')!.contractId;
const VOUCHER = CONTRACTS.find((c) => c.contract === 'voucher')!.contractId;

let app: FastifyInstance;
let testClientId = 0;

function nextTestClientIp(): string {
  const id = ++testClientId;
  return `10.${(id >>> 16) & 255}.${(id >>> 8) & 255}.${id & 255}`;
}

async function get(url: string) {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': nextTestClientIp() },
  });
  return { status: res.statusCode, body: res.json() };
}

async function getWithHeaders(url: string) {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': nextTestClientIp() },
  });
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

async function getCsv(url: string) {
  const res = await app.inject({
    method: 'GET',
    url,
    headers: { 'x-forwarded-for': nextTestClientIp() },
  });
  return { status: res.statusCode, body: res.body, headers: res.headers, json: () => res.json() };
}

/** Parses RFC 4180 CSV into rows of cells, so tests exercise the real escaping. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else {
      cell += char;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

async function seed() {
  await prisma.provider.create({
    data: {
      address: CLINIC,
      name: 'Ikeja General Clinic',
      country: 'NG',
      status: 'Active',
      registeredAt: new Date('2026-09-01T00:00:00Z'),
      services: {
        create: [
          { id: `${CLINIC}:101`, code: 101, label: 'Outpatient consult', price: '30000000' },
          { id: `${CLINIC}:202`, code: 202, label: 'Malaria rapid test', price: '10000000' },
          // Delisted after vouchers were funded against it.
          {
            id: `${CLINIC}:303`,
            code: 303,
            label: 'Antenatal visit',
            price: '50000000',
            active: false,
          },
        ],
      },
    },
  });
  await prisma.provider.create({
    data: {
      address: PENDING_CLINIC,
      name: 'Kisumu Health Post',
      country: 'KE',
      status: 'Pending',
      registeredAt: new Date('2026-09-05T00:00:00Z'),
    },
  });
  await prisma.provider.create({
    data: {
      address: SECOND_CLINIC,
      name: 'Mwanza Mission Hospital',
      country: 'TZ',
      status: 'Active',
      registeredAt: new Date('2026-08-15T00:00:00Z'),
      services: {
        create: [
          {
            id: `${SECOND_CLINIC}:101`,
            code: 101,
            label: 'General consultation',
            price: '40000000',
          },
          { id: `${SECOND_CLINIC}:202`, code: 202, label: 'Malaria rapid test', price: '15000000' },
          { id: `${SECOND_CLINIC}:404`, code: 404, label: 'Dental cleaning', price: '20000000' },
        ],
      },
    },
  });

  const now = Date.now();
  const base = { funder: FUNDER, beneficiaryRef: REF, providerAddress: CLINIC };
  await prisma.voucher.createMany({
    data: [
      // Settled, with a receipt below.
      {
        ...base,
        id: '1',
        serviceCode: 101,
        amount: '30000000',
        status: 'Settled',
        createdAt: new Date(now - 10 * DAY),
        expiresAt: new Date(now + 20 * DAY),
        settledNet: '29700000',
        settledFee: '300000',
      },
      // Funded and already past expiry: refundable now.
      {
        ...base,
        id: '2',
        serviceCode: 202,
        amount: '10000000',
        status: 'Funded',
        createdAt: new Date(now - 40 * DAY),
        expiresAt: new Date(now - DAY),
      },
      // Claimed, expired yesterday: still inside the claim grace period.
      {
        ...base,
        id: '3',
        serviceCode: 303,
        amount: '50000000',
        status: 'Claimed',
        createdAt: new Date(now - 31 * DAY),
        expiresAt: new Date(now - DAY),
      },
      // Attested, by a known attester, with the dispute window closed:
      // settleable.
      {
        ...base,
        id: '4',
        serviceCode: 101,
        amount: '30000000',
        status: 'Attested',
        createdAt: new Date(now - 5 * DAY),
        expiresAt: new Date(now + 25 * DAY),
        attestedAt: new Date(now - 4 * DAY),
        attestedBy: ATTESTER,
        disputeDeadline: new Date(now - 60_000),
      },
      // Disputed, for someone else, with a reason and a recorded outcome.
      {
        ...base,
        beneficiaryRef: OTHER_REF,
        id: '5',
        serviceCode: 999,
        amount: '30000000',
        status: 'Disputed',
        createdAt: new Date(now - 2 * DAY),
        expiresAt: new Date(now + 28 * DAY),
        disputeReason: 2,
        disputeResolvedAt: new Date(now - DAY),
        disputeResolvedBy: ADMIN,
        disputeOutcome: 'Provider',
      },
    ],
  });
  await prisma.receipt.createMany({
    data: [
      {
        voucherId: '1',
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '30000000',
        settledAt: new Date(now - 6 * DAY),
      },
      {
        voucherId: '9',
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 202,
        amount: '10000000',
        settledAt: new Date(now - 3 * DAY),
      },
    ],
  });

  const at = (dayOffset: number) => new Date(now - dayOffset * DAY);
  await prisma.governanceEvent.createMany({
    data: [
      {
        id: 'gov-1',
        contractId: REGISTRY,
        contract: 'registry',
        kind: 'Proposed',
        admin: ADMIN,
        pendingAdmin: NEW_ADMIN,
        ledger: 10,
        occurredAt: at(30),
      },
      {
        id: 'gov-2',
        contractId: REGISTRY,
        contract: 'registry',
        kind: 'Changed',
        admin: NEW_ADMIN,
        pendingAdmin: null,
        ledger: 12,
        occurredAt: at(29),
      },
      {
        id: 'gov-3',
        contractId: VOUCHER,
        contract: 'voucher',
        kind: 'Proposed',
        admin: ADMIN,
        pendingAdmin: NEW_ADMIN,
        ledger: 14,
        occurredAt: at(28),
      },
    ],
  });
  await prisma.providerStatusChange.createMany({
    data: [
      { id: 'st-1', providerAddress: CLINIC, status: 'Active', ledger: 10, changedAt: at(20) },
      {
        id: 'st-2',
        providerAddress: CLINIC,
        status: 'Suspended',
        ledger: 12,
        changedAt: at(15),
      },
      { id: 'st-3', providerAddress: CLINIC, status: 'Active', ledger: 14, changedAt: at(10) },
    ],
  });
  await prisma.servicePriceChange.createMany({
    data: [
      {
        id: 'sp-1',
        providerAddress: CLINIC,
        code: 101,
        price: '30000000',
        ledger: 10,
        changedAt: at(20),
      },
      {
        id: 'sp-2',
        providerAddress: CLINIC,
        code: 101,
        price: '35000000',
        ledger: 12,
        changedAt: at(15),
      },
    ],
  });
  await prisma.attester.createMany({
    data: [
      { address: ATTESTER, active: true, addedAt: at(40) },
      {
        address: FORMER_ATTESTER,
        active: false,
        addedAt: at(39),
        removedAt: at(30),
      },
    ],
  });
  // Deliberately out of ledger order in creation, so the endpoint has to
  // sort rather than rely on insertion order.
  await prisma.contractEvent.createMany({
    data: [
      {
        id: 'ce-2',
        contractId: VOUCHER,
        contract: 'voucher',
        name: 'voucher_settled',
        ledger: 22,
        txHash: 'f'.repeat(64),
        closedAt: at(6),
        voucherId: '1',
        data: JSON.stringify({ voucher_id: '1', net: '29700000', fee: '300000' }),
      },
      {
        id: 'ce-1',
        contractId: VOUCHER,
        contract: 'voucher',
        name: 'voucher_created',
        ledger: 20,
        txHash: 'e'.repeat(64),
        closedAt: at(10),
        voucherId: '1',
        data: JSON.stringify({ voucher_id: '1', amount: '30000000' }),
      },
      {
        id: 'ce-other',
        contractId: REGISTRY,
        contract: 'registry',
        name: 'provider_registered',
        ledger: 19,
        txHash: 'd'.repeat(64),
        closedAt: at(11),
        voucherId: null,
        data: '{}',
      },
    ],
  });
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
}, 30_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.contractEvent.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.attester.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.governanceEvent.deleteMany();
  await prisma.providerStatusChange.deleteMany();
  await prisma.servicePriceChange.deleteMany();
  await prisma.dailyStat.deleteMany();
  await seed();
  resetStatsCache();
});

describe('OpenAPI spec', () => {
  it('serves a valid spec at /openapi.json', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe('SCI Healthcare API');
    expect(spec.paths['/vouchers']).toBeDefined();
    expect(spec.paths['/providers']).toBeDefined();
    expect(spec.paths['/receipts']).toBeDefined();
    expect(spec.paths['/governance']).toBeDefined();
  });

  it('serves Swagger UI at /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    // swagger-ui redirects to /docs/ or returns HTML
    expect([200, 302]).toContain(res.statusCode);
  });
});

describe('GET /health and /stats', () => {
  it('reports liveness', async () => {
    expect(await get('/health')).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('counts providers, vouchers and settled value', async () => {
    const { status, body } = await get('/stats');
    expect(status).toBe(200);
    expect(body).toEqual({
      providers: 3,
      activeProviders: 2,
      vouchers: 5,
      settledVouchers: 1,
      settledValue: '30000000',
      // #52: the single settled voucher in `seed()` paid a 300000 fee.
      feesCollected: '300000',
      receipts: 2,
      faucetDrips: 0,
      faucetWallets: 0,
    });
  });

  // #52: `settledFee` is stored per voucher but was never summed. The figure
  // is the protocol's lifetime earnings, so it must be exact — these ids are
  // chosen so a Number accumulation rounds them and fails the assertion.
  it('sums settledFee into an exact feesCollected total, skipping settled vouchers without a fee', async () => {
    const now = Date.now();
    await prisma.voucher.createMany({
      data: [
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'fee-1',
          serviceCode: 101,
          amount: '9007199254740993',
          status: 'Settled',
          createdAt: new Date(now - 4 * DAY),
          expiresAt: new Date(now + DAY),
          settledFee: '9007199254740993',
        },
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'fee-2',
          serviceCode: 101,
          amount: '9007199254740995',
          status: 'Settled',
          createdAt: new Date(now - 3 * DAY),
          expiresAt: new Date(now + DAY),
          settledFee: '9007199254740995',
        },
        // Settled before the fee column existed: contributes nothing, but
        // must not make the sum NaN or drop the other fees.
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'fee-3',
          serviceCode: 101,
          amount: '30000000',
          status: 'Settled',
          createdAt: new Date(now - 2 * DAY),
          expiresAt: new Date(now + DAY),
          settledFee: null,
        },
      ],
    });

    const { status, body } = await get('/stats');
    expect(status).toBe(200);
    // 300000 (seeded voucher 1) + the two above MAX_SAFE_INTEGER fees.
    expect(body.feesCollected).toBe('18014398509781988');
    expect(typeof body.feesCollected).toBe('string');
  });

  it('reports feesCollected as "0" when nothing has settled', async () => {
    await prisma.voucher.updateMany({
      where: { status: 'Settled' },
      data: { status: 'Funded' },
    });

    const { body } = await get('/stats');
    expect(body.settledVouchers).toBe(0);
    expect(body.feesCollected).toBe('0');
  });

  it('counts faucet drips and the distinct wallets behind them', async () => {
    await prisma.faucetDrip.createMany({
      data: [
        { id: 'drip-1', wallet: FUNDER, amount: '100000000', ledger: 10, drippedAt: new Date() },
        // Same wallet again: more drips, still one person trying the demo.
        { id: 'drip-2', wallet: FUNDER, amount: '100000000', ledger: 11, drippedAt: new Date() },
        { id: 'drip-3', wallet: CLINIC, amount: '100000000', ledger: 12, drippedAt: new Date() },
      ],
    });

    try {
      const { body } = await get('/stats');
      expect(body.faucetDrips).toBe(3);
      expect(body.faucetWallets).toBe(2);
    } finally {
      await prisma.faucetDrip.deleteMany();
    }
  });

  // #60: settledValue must stay exact at the top of the i128 range — the
  // property the JS BigInt path guaranteed and the SQL path on Postgres
  // reproduces (verified against a real Postgres in this PR's notes). This
  // guards the SQLite branch of `settledTotals()` against a future
  // float64/CAST-based rewrite: a Number accumulation here loses the low
  // digits outright.
  it('sums a settled i128-max amount into settledValue exactly', async () => {
    const now = Date.now();
    const I128_MAX = '340282366920938463463374607431768211455';
    await prisma.voucher.create({
      data: {
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        id: 'i128-max',
        serviceCode: 101,
        amount: I128_MAX,
        status: 'Settled',
        createdAt: new Date(now - DAY),
        expiresAt: new Date(now + DAY),
        settledFee: '1',
      },
    });

    const { body } = await get('/stats');
    // Seeded settled voucher (30000000 / fee 300000) + the i128-max row.
    expect(body.settledVouchers).toBe(2);
    expect(body.settledValue).toBe((BigInt(I128_MAX) + 30000000n).toString());
    expect(body.feesCollected).toBe('300001');
  });
});

describe('GET /stats/funnel', () => {
  const funnelClinic = `G${'C'.repeat(55)}`;
  const createdAt = new Date('2026-01-01T00:00:00Z');
  const hoursAfterCreation = (hours: number) => new Date(createdAt.getTime() + hours * 3_600_000);

  beforeEach(async () => {
    await prisma.provider.create({
      data: {
        address: funnelClinic,
        name: 'Funnel Clinic',
        country: 'ZZ',
        status: 'Active',
        registeredAt: createdAt,
      },
    });

    // Seed 8 vouchers so all stage counts (funded=8, claimed=7, attested=6,
    // settled=5) are at or above the STATS_MIN_CELL=5 threshold and no
    // suppression occurs in the existing counts/medians assertions.
    await prisma.voucher.createMany({
      data: [
        { id: 'funnel-funded', status: 'Funded', claimedAt: null, attestedAt: null },
        {
          id: 'funnel-claimed',
          status: 'Claimed',
          claimedAt: hoursAfterCreation(2),
          attestedAt: null,
        },
        {
          id: 'funnel-attested',
          status: 'Attested',
          claimedAt: hoursAfterCreation(4),
          attestedAt: hoursAfterCreation(7),
        },
        {
          id: 'funnel-settled-a',
          status: 'Settled',
          claimedAt: hoursAfterCreation(6),
          attestedAt: hoursAfterCreation(11),
        },
        {
          id: 'funnel-settled-b',
          status: 'Settled',
          claimedAt: hoursAfterCreation(8),
          attestedAt: hoursAfterCreation(11),
        },
        {
          id: 'funnel-settled-c',
          status: 'Settled',
          claimedAt: hoursAfterCreation(10),
          attestedAt: hoursAfterCreation(13),
        },
        {
          id: 'funnel-settled-d',
          status: 'Settled',
          claimedAt: hoursAfterCreation(12),
          attestedAt: hoursAfterCreation(15),
        },
        {
          id: 'funnel-settled-e',
          status: 'Settled',
          claimedAt: hoursAfterCreation(14),
          attestedAt: hoursAfterCreation(17),
        },
      ].map((voucher) => ({
        ...voucher,
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: funnelClinic,
        serviceCode: 101,
        amount: '1000000',
        createdAt,
        expiresAt: new Date(createdAt.getTime() + DAY),
      })),
    });

    await prisma.receipt.createMany({
      data: [
        { voucherId: 'funnel-settled-a', settledAt: hoursAfterCreation(17) },
        { voucherId: 'funnel-settled-b', settledAt: hoursAfterCreation(15) },
        { voucherId: 'funnel-settled-c', settledAt: hoursAfterCreation(19) },
        { voucherId: 'funnel-settled-d', settledAt: hoursAfterCreation(22) },
        { voucherId: 'funnel-settled-e', settledAt: hoursAfterCreation(25) },
      ].map((receipt) => ({
        ...receipt,
        beneficiaryRef: REF,
        providerAddress: funnelClinic,
        serviceCode: 101,
        amount: '1000000',
      })),
    });
  });

  it('returns stage counts and fixed-time medians filtered by country or clinic', async () => {
    // funded=8, claimed=7, attested=6, settled=5 — all above STATS_MIN_CELL=5.
    // medians: fundedToClaimed=[2,4,6,8,10,12,14]→8, claimedToAttested=[3,5,3,3,3,3]→3,
    //          attestedToSettled=[6,4,6,7,8]→6
    const expected = {
      counts: { funded: 8, claimed: 7, attested: 6, settled: 5 },
      suppressed: false,
      medianHours: { fundedToClaimed: 8, claimedToAttested: 3, attestedToSettled: 6 },
    };

    const byCountry = await get('/stats/funnel?country=zz');
    expect(byCountry.status).toBe(200);
    expect(byCountry.body).toMatchObject({ country: 'ZZ', clinic: null, ...expected });

    const byClinic = await get(`/stats/funnel?clinic=${funnelClinic}`);
    expect(byClinic.status).toBe(200);
    expect(byClinic.body).toMatchObject({ country: null, clinic: funnelClinic, ...expected });

    const combined = await get(`/stats/funnel?country=NG&clinic=${funnelClinic}`);
    // Country NG has no matching providers: all counts are 0, which is not
    // sensitive and is never suppressed.
    expect(combined.body.suppressed).toBe(false);
    expect(combined.body.counts).toEqual({ funded: 0, claimed: 0, attested: 0, settled: 0 });
    expect(combined.body.medianHours).toEqual({
      fundedToClaimed: null,
      claimedToAttested: null,
      attestedToSettled: null,
    });
  });

  it('suppresses stage counts below STATS_MIN_CELL on scoped queries', async () => {
    // The existing funnel clinic has funded=8, claimed=7, attested=6, settled=5.
    // A second tiny clinic with only 2 settled vouchers should have them suppressed.
    const tinyClinic = `G${'T'.repeat(55)}`;
    await prisma.provider.create({
      data: {
        address: tinyClinic,
        name: 'Tiny Clinic',
        country: 'ZZ',
        status: 'Active',
        registeredAt: createdAt,
      },
    });
    await prisma.voucher.createMany({
      data: ['tiny-a', 'tiny-b'].map((id) => ({
        id,
        status: 'Settled',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: tinyClinic,
        serviceCode: 101,
        amount: '1000000',
        createdAt,
        claimedAt: hoursAfterCreation(1),
        attestedAt: hoursAfterCreation(2),
        expiresAt: new Date(createdAt.getTime() + DAY),
      })),
    });
    await prisma.receipt.createMany({
      data: ['tiny-a', 'tiny-b'].map((voucherId) => ({
        voucherId,
        beneficiaryRef: REF,
        providerAddress: tinyClinic,
        serviceCode: 101,
        amount: '1000000',
        settledAt: hoursAfterCreation(3),
      })),
    });

    const { status, body } = await get(`/stats/funnel?clinic=${tinyClinic}`);
    expect(status).toBe(200);
    expect(body.suppressed).toBe(true);
    // 2 vouchers funded/claimed/attested — below threshold of 5 → all null.
    expect(body.counts.funded).toBeNull();
    expect(body.counts.settled).toBeNull();
  });

  it('never suppresses the global aggregate (unscoped query)', async () => {
    // The global /stats/funnel has no country or clinic filter, so STATS_MIN_CELL
    // does not apply regardless of how small the total counts are.
    const tinyClinic2 = `G${'U'.repeat(55)}`;
    await prisma.provider.create({
      data: {
        address: tinyClinic2,
        name: 'Tiny2',
        country: 'XY',
        status: 'Active',
        registeredAt: createdAt,
      },
    });
    await prisma.voucher.create({
      data: {
        id: 'tiny2-a',
        status: 'Funded',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: tinyClinic2,
        serviceCode: 101,
        amount: '1000000',
        createdAt,
        claimedAt: null,
        attestedAt: null,
        expiresAt: new Date(createdAt.getTime() + DAY),
      },
    });

    const { status, body } = await get('/stats/funnel');
    expect(status).toBe(200);
    expect(body.suppressed).toBe(false);
    // All counts are concrete numbers, never null.
    expect(typeof body.counts.funded).toBe('number');
  });

  it('rejects a country filter that is not a two-letter code', async () => {
    const { status, body } = await get('/stats/funnel?country=ZZZ');
    expect(status).toBe(400);
    expect(body.error).toBe('bad_request');
  });
});

describe('GET /stats/disputes (#245)', () => {
  const resolvedAt = (hours: number) =>
    new Date(Date.parse('2026-01-01T00:00:00Z') + hours * 3_600_000);

  it('counts disputes, the rate against attestation, reasons, outcomes and median time', async () => {
    await prisma.voucher.deleteMany();
    await prisma.voucher.createMany({
      data: [
        // Resolved for the funder: status moved on, so only the reason column
        // proves it was ever disputed. Attestation time is the resolution
        // clock, not creation (which is 100 hours earlier).
        {
          id: 'dispute-funder',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '1000000',
          status: 'Refunded',
          createdAt: resolvedAt(-100),
          expiresAt: resolvedAt(48),
          attestedAt: resolvedAt(0),
          disputeReason: 1,
          disputeResolvedAt: resolvedAt(10),
          disputeResolvedBy: ADMIN,
          disputeOutcome: 'Funder',
        },
        // Resolved for the provider, 20 hours after attestation.
        {
          id: 'dispute-provider',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '1000000',
          status: 'Settled',
          createdAt: resolvedAt(-100),
          expiresAt: resolvedAt(48),
          attestedAt: resolvedAt(0),
          disputeReason: 2,
          disputeResolvedAt: resolvedAt(20),
          disputeResolvedBy: ADMIN,
          disputeOutcome: 'Provider',
        },
        // Still open: neither outcome, so it has to be counted as unresolved.
        {
          id: 'dispute-open',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '1000000',
          status: 'Disputed',
          createdAt: resolvedAt(-100),
          expiresAt: resolvedAt(48),
          attestedAt: resolvedAt(0),
          disputeReason: 2,
        },
        // Attested, never disputed: denominator without a numerator.
        {
          id: 'attested-only',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '1000000',
          status: 'Attested',
          createdAt: resolvedAt(-100),
          expiresAt: resolvedAt(48),
          attestedAt: resolvedAt(0),
        },
      ],
    });

    const { status, body } = await get('/stats/disputes');
    expect(status).toBe(200);
    expect(body.count).toBe(3);
    expect(body.attestedVouchers).toBe(4);
    // A string, fixed to four places, so 3/4 is 0.7500 and never
    // engine-dependent numeric formatting.
    expect(body.rate).toBe('0.7500');
    expect(body.byReason).toEqual({ '1': 1, '2': 2 });
    expect(body.byOutcome).toEqual({ Funder: 1, Provider: 1, Unresolved: 1 });
    // Median of the two resolved disputes: (10 + 20) / 2, measured from
    // attestation rather than creation.
    expect(body.medianResolutionHours).toBe(15);
  });

  it('rounds the rate half up at the last fixed digit', async () => {
    await prisma.voucher.deleteMany();
    await prisma.voucher.createMany({
      data: ['r1', 'r2'].map((id) => ({
        id,
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '1000000',
        status: 'Disputed',
        createdAt: resolvedAt(-1),
        expiresAt: resolvedAt(48),
        attestedAt: resolvedAt(0),
        disputeReason: 3,
      })),
    });
    // Two disputed of three attested: 0.6666... rounds to 0.6667.
    await prisma.voucher.create({
      data: {
        id: 'r3',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '1000000',
        status: 'Attested',
        createdAt: resolvedAt(-1),
        expiresAt: resolvedAt(48),
        attestedAt: resolvedAt(0),
      },
    });

    const { body } = await get('/stats/disputes');
    expect(body.rate).toBe('0.6667');
  });

  it('reports zeros and a null median on an empty read model', async () => {
    await prisma.voucher.deleteMany();

    const { status, body } = await get('/stats/disputes');
    expect(status).toBe(200);
    expect(body).toEqual({
      count: 0,
      attestedVouchers: 0,
      rate: '0.0000',
      byReason: {},
      byOutcome: { Funder: 0, Provider: 0, Unresolved: 0 },
      medianResolutionHours: null,
    });
  });
});

describe('GET /funders/:address (#246)', () => {
  it('returns counts and exact value per status in one request', async () => {
    const { status, body } = await get(`/funders/${FUNDER}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      address: FUNDER,
      vouchers: 5,
      totalValue: '150000000',
      totalValueDisplay: '15.0000000',
      byStatus: { Funded: 1, Claimed: 1, Attested: 1, Settled: 1, Disputed: 1, Refunded: 0 },
      valueByStatus: {
        Funded: '10000000',
        Claimed: '50000000',
        Attested: '30000000',
        Settled: '30000000',
        Disputed: '30000000',
        Refunded: '0',
      },
    });
  });

  it('returns all zeros for a funder with no vouchers, not a 404', async () => {
    const { status, body } = await get(`/funders/${SECOND_CLINIC}`);
    expect(status).toBe(200);
    expect(body.vouchers).toBe(0);
    expect(body.totalValue).toBe('0');
    expect(body.totalValueDisplay).toBe('0.0000000');
    // Every status is present, so a dashboard renders the same table shape.
    expect(Object.values(body.byStatus)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(Object.values(body.valueByStatus)).toEqual(['0', '0', '0', '0', '0', '0']);
  });

  it('sums past 2^53 with BigInt, exactly', async () => {
    await prisma.voucher.createMany({
      data: [
        {
          id: 'funder-big-1',
          funder: SECOND_CLINIC,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '9007199254740993',
          status: 'Funded',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + DAY),
        },
        {
          id: 'funder-big-2',
          funder: SECOND_CLINIC,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '9007199254740995',
          status: 'Funded',
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + DAY),
        },
      ],
    });

    const { body } = await get(`/funders/${SECOND_CLINIC}`);
    expect(body.totalValue).toBe('18014398509481988');
    expect(body.byStatus.Funded).toBe(2);
    expect(body.valueByStatus.Funded).toBe('18014398509481988');
  });

  it('rejects an address that is not a valid Stellar account', async () => {
    const { status, body } = await get('/funders/not-an-address');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });
});

describe('?count and pagination links (#247, #248)', () => {
  it('omits total from every list route unless count=true', async () => {
    const plain = await get(`/vouchers?funder=${FUNDER}`);
    expect(plain.body).not.toHaveProperty('total');

    const falsey = await get(`/vouchers?funder=${FUNDER}&count=false`);
    expect(falsey.body).not.toHaveProperty('total');

    expect((await get('/providers')).body).not.toHaveProperty('total');
    expect((await get(`/receipts?beneficiaryRef=${REF}`)).body).not.toHaveProperty('total');
    expect((await get('/services')).body).not.toHaveProperty('total');

    expect((await get(`/vouchers?funder=${FUNDER}&count=true`)).body.total).toBe(5);
    expect((await get('/providers?count=true')).body.total).toBe(3);
    expect((await get(`/receipts?beneficiaryRef=${REF}&count=true`)).body.total).toBe(2);
    // Three catalogue entries: codes 101, 202 and 404.
    expect((await get('/services?count=true')).body.total).toBe(3);
  });

  it('counts the whole filtered set, not the cursor page', async () => {
    const page = await get(`/vouchers?funder=${FUNDER}&limit=2&count=true`);
    expect(page.body.total).toBe(5);
    expect(page.body.nextCursor).toBeTruthy();

    const next = await get(
      `/vouchers?funder=${FUNDER}&limit=2&count=true&cursor=${page.body.nextCursor}`,
    );
    expect(next.status).toBe(200);
    expect(next.body.vouchers).toHaveLength(2);
    expect(next.body.total).toBe(5);
  });

  it('rejects a count that is not true or false', async () => {
    const { status, body } = await get('/vouchers?count=yes');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('sends an RFC 8288 next link that keeps every filter', async () => {
    const { status, headers } = await getWithHeaders(
      `/vouchers?funder=${FUNDER}&beneficiaryRef=${REF}&limit=1`,
    );
    expect(status).toBe(200);
    const link = String(headers.link);
    expect(link).toContain('rel="next"');

    const target = /<([^>]+)>; rel="next"/.exec(link);
    expect(target).not.toBeNull();
    const next = new URL(target![1]!, 'http://localhost');
    // The next link stays on the path the caller used, so following it does
    // not silently move a legacy client onto another version.
    expect(next.pathname).toBe('/vouchers');
    expect(next.searchParams.get('funder')).toBe(FUNDER);
    expect(next.searchParams.get('beneficiaryRef')).toBe(REF);
    expect(next.searchParams.get('limit')).toBe('1');
    expect(next.searchParams.get('cursor')).toBeTruthy();
  });

  it('omits the link on the last page', async () => {
    const { headers } = await getWithHeaders(`/vouchers?funder=${FUNDER}&limit=100`);
    // No next page, so no rel="next"; the legacy alias's successor link may
    // still be present.
    expect(String(headers.link ?? '')).not.toContain('rel="next"');
  });

  it('exposes Link to browser clients across origins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/vouchers?funder=${FUNDER}&limit=1`,
      headers: { origin: 'https://clinic.example', 'x-forwarded-for': nextTestClientIp() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-expose-headers']).toContain('Link');
  });

  it('keeps rel=next beside the /v1 successor link on the legacy alias', async () => {
    const { headers } = await getWithHeaders(`/vouchers?funder=${FUNDER}&limit=2`);
    const link = String(headers.link);
    expect(link).toContain('rel="next"');
    expect(link).toContain('rel="successor-version"');
  });
});

describe('GET /countries', () => {
  // Helper: create n Active providers for a country, using unique addresses.
  const addClinics = (country: string, n: number, prefix: string) =>
    prisma.provider.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        address: `${prefix}${i}`.padEnd(56, '0').slice(0, 56),
        name: `${country} Clinic ${i}`,
        country,
        status: 'Active' as const,
        registeredAt: new Date('2026-01-01T00:00:00Z'),
      })),
    });

  it('returns clinic counts sorted by country code', async () => {
    // seed() creates 1 Active NG and 1 Active TZ provider. Add enough in each
    // to bring both above STATS_MIN_CELL=5, plus a fresh KE block.
    await addClinics('NG', 10, 'PNX'); // NG: 1 (seeded) + 10 = 11
    await addClinics('TZ', 10, 'PTX'); // TZ: 1 (seeded) + 10 = 11
    await addClinics('KE', 7, 'PKX'); // KE: 0 Active (seeded is Pending) + 7 = 7

    const { status, body } = await get('/countries');
    expect(status).toBe(200);
    const countries: { code: string; clinicCount: number | null }[] = body.countries;
    expect(countries.find((c) => c.code === 'NG')?.clinicCount).toBe(11);
    expect(countries.find((c) => c.code === 'KE')?.clinicCount).toBe(7);
    expect(countries.find((c) => c.code === 'TZ')?.clinicCount).toBe(11);
    // Response is sorted alphabetically.
    const codes = countries.map((c) => c.code);
    expect(codes).toEqual([...codes].sort());
  });

  it('suppresses clinicCount when below STATS_MIN_CELL', async () => {
    // seed() creates 1 Active NG and 1 Active TZ — both below threshold.
    // Bring NG and TZ above threshold so they don't add extra primary
    // suppressions and skew the complementary-suppression logic.
    await addClinics('NG', 10, 'PNY'); // NG: 1 + 10 = 11
    await addClinics('TZ', 10, 'PTY'); // TZ: 1 + 10 = 11
    // AA: 2 clinics → below threshold → primary suppression.
    await addClinics('AA', 2, 'PAA');
    // BB: 10 clinics → not suppressed.
    await addClinics('BB', 10, 'PBB');
    // CC: 8 clinics → not suppressed on its own, but it is the smallest
    // revealed entry and will receive complementary suppression.
    await addClinics('CC', 8, 'PCC');

    const { status, body } = await get('/countries');
    expect(status).toBe(200);
    const aa = body.countries.find((c: { code: string }) => c.code === 'AA');
    expect(aa.clinicCount).toBeNull();
    expect(aa.suppressed).toBe(true);
    // Complementary suppression: exactly 1 primary suppression and ≥3 entries →
    // the next-smallest revealed entry (CC=8) is also suppressed.
    const cc = body.countries.find((c: { code: string }) => c.code === 'CC');
    expect(cc.clinicCount).toBeNull();
    expect(cc.suppressed).toBe(true);
    // The larger entry remains revealed.
    const bb = body.countries.find((c: { code: string }) => c.code === 'BB');
    expect(bb.clinicCount).toBe(10);
    expect(bb.suppressed).toBe(false);
  });
});

describe('GET /version', () => {
  it('returns network and contract metadata', async () => {
    const { status, body } = await get('/version');
    expect(status).toBe(200);
    // Read from package.json, not hard-coded here, so a release bump is one
    // edit and this test still proves the route reports it.
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(['testnet', 'public', 'futurenet']).toContain(body.network);
    expect(body.contracts.registry).toMatch(/^[A-Z]{2}[A-Z0-9]{54}$/);
    expect(body.contracts.voucher).toMatch(/^[A-Z]{2}[A-Z0-9]{54}$/);
    expect(body.contracts.receipt).toMatch(/^[A-Z]{2}[A-Z0-9]{54}$/);
  });

  it('reports the build commit, indexer start ledger and process start time', async () => {
    const { status, body } = await get('/version');
    expect(status).toBe(200);
    expect(body.commit === null || typeof body.commit === 'string').toBe(true);
    expect(body.indexerStartLedger).toBe(env.INDEXER_START_LEDGER);
    expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);
    expect(new Date(body.startedAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('reports RENDER_GIT_COMMIT when the platform provides one', async () => {
    const previous = process.env.RENDER_GIT_COMMIT;
    process.env.RENDER_GIT_COMMIT = 'a1b2c3d4e5f6';
    try {
      const { body } = await get('/version');
      expect(body.commit).toBe('a1b2c3d4e5f6');
    } finally {
      if (previous === undefined) delete process.env.RENDER_GIT_COMMIT;
      else process.env.RENDER_GIT_COMMIT = previous;
    }
  });

  it('exposes deployment metadata only, never credentials', async () => {
    const { body } = await get('/version');
    const keys = Object.keys(body).sort();
    expect(keys).toEqual([
      'commit',
      'contracts',
      'indexerStartLedger',
      'network',
      'rpcUrl',
      'rpcUrls',
      'startedAt',
      'version',
    ]);
    expect(JSON.stringify(body)).not.toContain(env.DATABASE_URL);
    expect(body).not.toHaveProperty('databaseUrl');
  });

  it('redacts credentials in RPC URL', async () => {
    const { body } = await get('/version');
    // If the URL contains @, it should be redacted
    if (body.rpcUrl.includes('@')) {
      expect(body.rpcUrl).toMatch(/:\/\/\*\*\*@/);
    }
  });

  it('lists every configured RPC endpoint, with the active one first reported', async () => {
    const { body } = await get('/version');
    expect(Array.isArray(body.rpcUrls)).toBe(true);
    expect(body.rpcUrls).toContain(body.rpcUrl);
    expect(body.rpcUrls).toEqual(env.RPC_URLS.map((u: string) => u));
  });
});

describe('GET /indexer', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await prisma.indexerState.update({
      where: { id: 1 },
      data: {
        paused: false,
        gap: false,
        gapOldestLedger: null,
        gapCursorLedger: null,
      },
    });
  });

  it('returns running status and one latest-ledger value', async () => {
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: 100, updatedAt: new Date('2026-10-01T00:00:00Z') },
      update: {
        lastLedger: 100,
        paused: false,
        gap: false,
        gapOldestLedger: null,
        updatedAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    const rpc = vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 120 } as never);

    const { status, body } = await get('/indexer');

    expect(status).toBe(200);
    expect(body).toEqual({
      lastLedger: 100,
      latestLedger: 120,
      lagLedgers: 20,
      paused: false,
      gap: false,
      gapOldestLedger: null,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('returns paused and gap fields', async () => {
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        lastLedger: 50,
        paused: true,
        gap: true,
        gapOldestLedger: 200,
      },
      update: { lastLedger: 50, paused: true, gap: true, gapOldestLedger: 200 },
    });
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 250 } as never);

    const { status, body } = await get('/indexer');
    expect(status).toBe(200);
    expect(body).toMatchObject({
      lastLedger: 50,
      latestLedger: 250,
      lagLedgers: 200,
      paused: true,
      gap: true,
      gapOldestLedger: 200,
    });
  });
});

describe('GET /ready', () => {
  afterEach(() => vi.restoreAllMocks());

  // Webhook rows are not part of the per-test reset above, and another suite
  // may leave some behind (every test file shares one database).
  beforeEach(async () => {
    await prisma.webhookDelivery.deleteMany();
  });

  /** One queued delivery, aged by `ageMs` so the backlog threshold is testable. */
  async function queueDelivery(ageMs = 0) {
    await prisma.webhookDelivery.create({
      data: {
        id: randomUUID(),
        url: 'https://clinic.example.test/webhooks',
        event: 'voucher_settled',
        voucherId: '1',
        status: 'Settled',
        ledger: 1,
        payload: '{}',
        nextAttemptAt: new Date(),
        createdAt: new Date(Date.now() - ageMs),
      },
    });
  }

  async function seedCursor(lastLedger: number) {
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger },
      update: { lastLedger, leaseOwner: null, leaseExpiresAt: null },
    });
  }

  it('defaults the lag threshold to 120 ledgers', () => {
    expect(env.READY_MAX_LAG_LEDGERS).toBe(120);
  });

  it('is ready at exactly the threshold', async () => {
    await seedCursor(1000);
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1120 } as never);

    const { status, body } = await get('/ready');
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.checks).toMatchObject({
      indexer: 'ok',
      lagLedgers: 120,
      maxLagLedgers: env.READY_MAX_LAG_LEDGERS,
      rpcUrl: env.SOROBAN_RPC_URL,
      reconcile: 'ok',
      reconcileMismatches: 0,
    });
  });

  it('reports per-endpoint circuit breaker state, redacted (#265)', async () => {
    await seedCursor(1000);
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1000 } as never);
    webhookCircuit.recordFailure('https://clinic.example.test/webhooks?token=secret');

    try {
      const { status, body } = await get('/ready');
      // A single failure is not yet a tripped breaker, and reporting one
      // must not take a healthy instance out of rotation either way.
      expect(status).toBe(200);
      expect(body.checks.webhooks.breakers).toContainEqual({
        endpoint: 'https://clinic.example.test/webhooks',
        state: 'closed',
        consecutiveFailures: 1,
        openedAt: null,
      });
      expect(JSON.stringify(body)).not.toContain('token=secret');
    } finally {
      webhookCircuit.reset();
    }
  });

  it('reports reconciliation drift without taking the instance out of rotation', async () => {
    await seedCursor(1000);
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1000 } as never);
    await prisma.reconcileMismatch.create({
      data: {
        voucherId: '1',
        kind: 'field_mismatch',
        fields: JSON.stringify([{ field: 'status', db: 'Funded', chain: 'Settled' }]),
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });

    try {
      const { status, body } = await get('/ready');
      // Drift is a data-quality alarm, not a reason to stop serving.
      expect(status).toBe(200);
      expect(body.status).toBe('ready');
      expect(body.checks.reconcile).toBe('drift');
      expect(body.checks.reconcileMismatches).toBe(1);
    } finally {
      await prisma.reconcileMismatch.deleteMany();
    }
  });

  it('reports a fresh webhook backlog without degrading (#130)', async () => {
    await seedCursor(1000);
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1000 } as never);
    await queueDelivery();

    const { status, body } = await get('/ready');
    // A delivery that is merely queued says nothing about this instance:
    // the loop runs every few seconds and retries inside the backoff ceiling.
    expect(status).toBe(200);
    expect(body.checks.webhooks).toMatchObject({
      state: 'ok',
      enabled: true,
      pending: 1,
      abandoned: 0,
      oldestPendingAgeSeconds: 0,
      maxPendingAgeSeconds: env.READY_WEBHOOK_MAX_AGE_MS / 1000,
    });
  });

  it('degrades when a delivery has been pending past the threshold (#130)', async () => {
    await seedCursor(1000);
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1000 } as never);
    const maxAgeSeconds = env.READY_WEBHOOK_MAX_AGE_MS / 1000;
    await queueDelivery((maxAgeSeconds + 60) * 1000);

    const { status, body } = await get('/ready');
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks.webhooks.state).toBe('backlog');
    expect(body.checks.webhooks.pending).toBe(1);
    expect(body.checks.webhooks.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(maxAgeSeconds);
  });

  it('counts abandoned deliveries separately from the pending backlog (#130)', async () => {
    await seedCursor(1000);
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1000 } as never);
    await prisma.webhookDelivery.create({
      data: {
        id: randomUUID(),
        url: 'https://clinic.example.test/webhooks',
        event: 'voucher_settled',
        voucherId: '1',
        status: 'Settled',
        ledger: 1,
        payload: '{}',
        nextAttemptAt: new Date(),
        attempts: 6,
        abandonedAt: new Date(),
        lastError: 'HTTP 500',
      },
    });

    const { status, body } = await get('/ready');
    // An abandoned delivery is already counted where it matters; it is not
    // pending, so it does not change readiness on its own.
    expect(status).toBe(200);
    expect(body.checks.webhooks).toMatchObject({ state: 'ok', pending: 0, abandoned: 1 });
    expect(body.checks.webhooks.oldestPendingAgeSeconds).toBeNull();
  });

  it('is degraded one ledger past the threshold', async () => {
    await seedCursor(1000);
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1121 } as never);

    const { status, body } = await get('/ready');
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks).toMatchObject({
      indexer: 'lagging',
      lagLedgers: 121,
      maxLagLedgers: env.READY_MAX_LAG_LEDGERS,
    });
  });

  it('returns 503 with gap details when the indexer has a retention gap', async () => {
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: 50, gap: true, gapOldestLedger: 200, gapCursorLedger: 50 },
      update: {
        lastLedger: 50,
        gap: true,
        gapOldestLedger: 200,
        gapCursorLedger: 50,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 1000 } as never);

    const { status, body } = await get('/ready');
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks.indexer).toBe('gap');
    expect(body.checks.gap).toMatchObject({
      detected: true,
      cursorLedger: 50,
      oldestAvailable: 200,
    });
    expect(body.checks.gap.message).toContain('RUNBOOK');
  });
});

describe('GET /providers', () => {
  it('searches clinics by part of their name', async () => {
    const { status, body } = await get('/providers?q=Ikeja');
    expect(status).toBe(200);
    expect(body.providers.map((p: { name: string }) => p.name)).toEqual(['Ikeja General Clinic']);
  });

  it('filters by status and lists only active services', async () => {
    const { body } = await get('/providers?status=Active&count=true');
    expect(body.total).toBe(2);
    expect(body.providers[0].name).toBe('Ikeja General Clinic');
    expect(body.providers[0].services.map((s: { code: number }) => s.code)).toEqual([101, 202]);
    expect(body.providers[0].services[0].priceDisplay).toBe('3.0000000');
  });

  it('filters by country', async () => {
    const { body } = await get('/providers?country=KE');
    expect(body.providers.map((p: { address: string }) => p.address)).toEqual([PENDING_CLINIC]);
  });

  it('rejects an invalid status', async () => {
    const { status, body } = await get('/providers?status=Verified');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('returns one provider with its full catalogue, including delisted services', async () => {
    const { body } = await get(`/providers/${CLINIC}`);
    expect(body.services).toHaveLength(3);
    expect(body.services.find((s: { code: number }) => s.code === 303).active).toBe(false);
  });

  it('404s an unknown provider', async () => {
    const { status, body } = await get(`/providers/${FUNDER}`);
    expect(status).toBe(404);
    expect(body.error).toBe('provider_not_found');
  });
});

describe('GET /providers sorting and service filter (#237, #238)', () => {
  it('lists only clinics that currently offer a service code', async () => {
    const general = await get('/providers?serviceCode=101');
    expect(general.status).toBe(200);
    expect(general.body.providers.map((p: { address: string }) => p.address)).toEqual([
      CLINIC,
      SECOND_CLINIC,
    ]);

    // 303 is delisted at CLINIC, so it is not an offering there.
    const paused = await get('/providers?serviceCode=303&count=true');
    expect(paused.body.total).toBe(0);
  });

  it('combines the service filter with status and country', async () => {
    const { body } = await get('/providers?serviceCode=101&status=Active&country=NG');
    expect(body.providers.map((p: { address: string }) => p.address)).toEqual([CLINIC]);

    const wrongCountry = await get('/providers?serviceCode=101&country=KE');
    expect(wrongCountry.body.providers).toEqual([]);
  });

  it('sorts by name, country and registration, in both directions', async () => {
    const namesAsc = await get('/providers?sort=name');
    expect(namesAsc.body.providers.map((p: { name: string }) => p.name)).toEqual([
      'Ikeja General Clinic',
      'Kisumu Health Post',
      'Mwanza Mission Hospital',
    ]);

    const namesDesc = await get('/providers?sort=name&order=desc');
    expect(namesDesc.body.providers.map((p: { name: string }) => p.name)).toEqual([
      'Mwanza Mission Hospital',
      'Kisumu Health Post',
      'Ikeja General Clinic',
    ]);

    // The historical default, newest registration first.
    const registered = await get('/providers?sort=registered');
    expect(registered.body.providers.map((p: { address: string }) => p.address)).toEqual([
      PENDING_CLINIC,
      CLINIC,
      SECOND_CLINIC,
    ]);

    const countries = await get('/providers?sort=country&order=desc');
    expect(countries.body.providers.map((p: { country: string }) => p.country)).toEqual([
      'TZ',
      'NG',
      'KE',
    ]);
  });

  it('pages every sort without gaps or repeats', async () => {
    for (const sort of ['name', 'country', 'registered']) {
      const seen: string[] = [];
      let cursor: string | null | undefined;
      do {
        const suffix = cursor ? `&cursor=${cursor}` : '';
        const { body } = await get(`/providers?sort=${sort}&limit=1${suffix}`);
        seen.push(body.providers[0].address);
        cursor = body.nextCursor;
      } while (cursor);

      expect(new Set(seen).size, `${sort} must not repeat a clinic`).toBe(seen.length);
      expect(seen, `${sort} must visit every clinic`).toHaveLength(3);
    }
  });

  it('rejects a cursor issued for another ordering', async () => {
    const first = await get('/providers?sort=name&limit=1');
    const cursor = first.body.nextCursor as string;
    expect(cursor).toBeTruthy();

    const sameSort = await get(`/providers?sort=name&cursor=${cursor}`);
    expect(sameSort.status).toBe(200);

    const otherSort = await get(`/providers?sort=country&cursor=${cursor}`);
    expect(otherSort.status).toBe(400);
    expect(otherSort.body.error).toBe('invalid_cursor');

    const otherOrder = await get(`/providers?sort=name&order=desc&cursor=${cursor}`);
    expect(otherOrder.status).toBe(400);
    expect(otherOrder.body.error).toBe('invalid_cursor');
  });

  it('rejects an unknown sort or service code', async () => {
    const sort = await get('/providers?sort=price');
    expect(sort.status).toBe(400);
    expect(sort.body.error).toBe('invalid_query');

    const code = await get('/providers?serviceCode=not-a-code');
    expect(code.status).toBe(400);
    expect(code.body.error).toBe('invalid_query');
  });
});

describe('GET /providers capacity and openVouchers (#316)', () => {
  const CAP_CLINIC = `G${'C'.repeat(55)}`;
  const createdAt = new Date('2026-01-01T00:00:00Z');

  beforeEach(async () => {
    await prisma.provider.create({
      data: {
        address: CAP_CLINIC,
        name: 'Capacity Clinic',
        country: 'ZZ',
        status: 'Active',
        registeredAt: createdAt,
        capacity: 3,
      },
    });
    // openVouchers counts Funded and Claimed only; the others must not add.
    await prisma.voucher.createMany({
      data: [
        {
          id: 'cap-funded-1',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CAP_CLINIC,
          serviceCode: 101,
          amount: '1',
          status: 'Funded',
          createdAt,
          expiresAt: createdAt,
        },
        {
          id: 'cap-funded-2',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CAP_CLINIC,
          serviceCode: 101,
          amount: '1',
          status: 'Funded',
          createdAt,
          expiresAt: createdAt,
        },
        {
          id: 'cap-claimed-1',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CAP_CLINIC,
          serviceCode: 101,
          amount: '1',
          status: 'Claimed',
          createdAt,
          expiresAt: createdAt,
        },
        {
          id: 'cap-settled-1',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CAP_CLINIC,
          serviceCode: 101,
          amount: '1',
          status: 'Settled',
          createdAt,
          expiresAt: createdAt,
        },
        {
          id: 'cap-attested-1',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CAP_CLINIC,
          serviceCode: 101,
          amount: '1',
          status: 'Attested',
          createdAt,
          expiresAt: createdAt,
        },
      ],
    });
  });

  it('reports capacity and the open (Funded + Claimed) count on the detail route', async () => {
    const { status, body } = await get(`/providers/${CAP_CLINIC}`);
    expect(status).toBe(200);
    expect(body.capacity).toBe(3);
    expect(body.openVouchers).toBe(3); // 2 Funded + 1 Claimed, excluding Settled/Attested
  });

  it('reports the same fields on the list route', async () => {
    const { body } = await get('/providers?q=Capacity');
    const clinic = body.providers.find((p: { address: string }) => p.address === CAP_CLINIC);
    expect(clinic.capacity).toBe(3);
    expect(clinic.openVouchers).toBe(3);
  });

  it('exposes capacity and openVouchers through the sparse-field allow-list', async () => {
    const { body } = await get(`/providers?q=Capacity&fields=address,capacity,openVouchers`);
    const clinic = body.providers.find((p: { address: string }) => p.address === CAP_CLINIC);
    expect(Object.keys(clinic).sort()).toEqual(['address', 'capacity', 'openVouchers']);
  });

  it('reports openVouchers as 0 and capacity as null for a clinic that set neither', async () => {
    const NULL_CLINIC = `G${'D'.repeat(55)}`;
    await prisma.provider.create({
      data: {
        address: NULL_CLINIC,
        name: 'Quiet Clinic',
        country: 'ZZ',
        status: 'Active',
        registeredAt: createdAt,
      },
    });
    const { body } = await get(`/providers/${NULL_CLINIC}`);
    expect(body.capacity).toBeNull();
    expect(body.openVouchers).toBe(0);
  });
});

describe('GET /providers/:address/stats', () => {
  /** Timestamp offsets in seconds from the same creation time. */
  async function seedTimings(
    rows: {
      claimedAtSeconds: number | null;
      attestedAtSeconds: number | null;
      providerAddress?: string;
      status?: string;
    }[],
  ) {
    const createdAt = new Date('2026-10-01T00:00:00Z');
    const at = (seconds: number | null) =>
      seconds === null ? null : new Date(createdAt.getTime() + seconds * 1000);
    await prisma.voucher.createMany({
      data: rows.map((row, i) => ({
        id: `timing-${i}`,
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: row.providerAddress ?? CLINIC,
        serviceCode: 101,
        amount: '30000000',
        status: row.status ?? 'Attested',
        createdAt,
        expiresAt: new Date(createdAt.getTime() + DAY),
        claimedAt: at(row.claimedAtSeconds),
        attestedAt: at(row.attestedAtSeconds),
      })),
    });
  }

  it('returns counts by voucher status and the total settled value', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/stats`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      address: CLINIC,
      name: 'Ikeja General Clinic',
      status: 'Active',
      vouchers: 5,
      byStatus: {
        Funded: 1,
        Claimed: 1,
        Attested: 1,
        Settled: 1,
        Disputed: 1,
        Refunded: 0,
      },
      settledVouchers: 1,
      settledValue: '30000000',
      settledValueDisplay: '3.0000000',
      // Existing vouchers lack claimedAt, including one with attestedAt.
      medianClaimSeconds: null,
      medianAttestationSeconds: null,
    });
  });

  it('returns zeroed stats for a provider with no vouchers', async () => {
    const { status, body } = await get(`/providers/${PENDING_CLINIC}/stats`);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      vouchers: 0,
      settledVouchers: 0,
      settledValue: '0',
      settledValueDisplay: '0.0000000',
      medianClaimSeconds: null,
      medianAttestationSeconds: null,
      byStatus: { Funded: 0, Claimed: 0, Attested: 0, Settled: 0, Disputed: 0, Refunded: 0 },
    });
  });

  it('sums settled value exactly beyond Number.MAX_SAFE_INTEGER', async () => {
    await prisma.voucher.create({
      data: {
        id: 'big-1',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '9007199254740993',
        status: 'Settled',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + DAY),
      },
    });

    const { body } = await get(`/providers/${CLINIC}/stats`);
    expect(body.settledVouchers).toBe(2);
    expect(body.settledValue).toBe((30000000n + 9007199254740993n).toString());
  });

  it('takes numeric odd-count medians, including vouchers in later lifecycle states', async () => {
    await seedTimings([
      { claimedAtSeconds: 30, attestedAtSeconds: 33, status: 'Settled' },
      { claimedAtSeconds: 2, attestedAtSeconds: 22, status: 'Disputed' },
      { claimedAtSeconds: 10, attestedAtSeconds: 110, status: 'Refunded' },
    ]);

    const { status, body } = await get(`/providers/${CLINIC}/stats`);
    expect(status).toBe(200);
    expect(body.medianClaimSeconds).toBe(10);
    // Claim-to-attestation durations are 3, 20 and 100, not creation-to-attestation.
    expect(body.medianAttestationSeconds).toBe(20);
  });

  it('averages the middle two of even samples without rounding', async () => {
    await seedTimings([
      { claimedAtSeconds: 20, attestedAtSeconds: 22 },
      { claimedAtSeconds: 1, attestedAtSeconds: 4 },
      { claimedAtSeconds: 100, attestedAtSeconds: 300 },
      { claimedAtSeconds: 2, attestedAtSeconds: 32 },
    ]);

    const { body } = await get(`/providers/${CLINIC}/stats`);
    expect(body.medianClaimSeconds).toBe(11); // (2 + 20) / 2
    expect(body.medianAttestationSeconds).toBe(16.5); // (3 + 30) / 2
  });

  it('uses only complete observations for each stage independently', async () => {
    await seedTimings([
      { claimedAtSeconds: 20, attestedAtSeconds: null, status: 'Claimed' },
      { claimedAtSeconds: 4, attestedAtSeconds: 14 },
      { claimedAtSeconds: null, attestedAtSeconds: 1000 },
      { claimedAtSeconds: null, attestedAtSeconds: null, status: 'Funded' },
    ]);

    const { body } = await get(`/providers/${CLINIC}/stats`);
    expect(body.medianClaimSeconds).toBe(12);
    expect(body.medianAttestationSeconds).toBe(10);
  });

  it('returns a claim median but null attestation time before any complete attestation', async () => {
    await seedTimings([{ claimedAtSeconds: 8, attestedAtSeconds: null, status: 'Claimed' }]);

    const { body } = await get(`/providers/${CLINIC}/stats`);
    expect(body.medianClaimSeconds).toBe(8);
    expect(body.medianAttestationSeconds).toBeNull();
  });

  it.each([
    { claimedAtSeconds: 0, attestedAtSeconds: 0, claim: 0, attestation: 0 },
    { claimedAtSeconds: 0.125, attestedAtSeconds: 0.375, claim: 0.125, attestation: 0.25 },
  ])(
    'preserves a singleton interval, including zero and fractional seconds: $claim',
    async (sample) => {
      await seedTimings([sample]);

      const { body } = await get(`/providers/${CLINIC}/stats`);
      expect(body.medianClaimSeconds).toBe(sample.claim);
      expect(body.medianAttestationSeconds).toBe(sample.attestation);
    },
  );

  it.each([
    { claimedAtSeconds: -1, attestedAtSeconds: -2, claim: null, attestation: null },
    { claimedAtSeconds: 10, attestedAtSeconds: 9, claim: 10, attestation: null },
    { claimedAtSeconds: -1, attestedAtSeconds: 2, claim: null, attestation: 3 },
  ])(
    'excludes negative intervals independently: $claimedAtSeconds, $attestedAtSeconds',
    async (sample) => {
      await seedTimings([sample]);

      const { body } = await get(`/providers/${CLINIC}/stats`);
      expect(body.medianClaimSeconds).toBe(sample.claim);
      expect(body.medianAttestationSeconds).toBe(sample.attestation);
    },
  );

  it('isolates each provider and serves the same metrics through the v1 route', async () => {
    await seedTimings([
      { claimedAtSeconds: 6, attestedAtSeconds: 15 },
      { claimedAtSeconds: 1000, attestedAtSeconds: 5000, providerAddress: SECOND_CLINIC },
    ]);

    const legacy = await get(`/providers/${CLINIC}/stats`);
    const versioned = await get(`/v1/providers/${CLINIC}/stats`);
    expect(versioned.status).toBe(200);
    expect(versioned.body).toEqual(legacy.body);
    expect(versioned.body.medianClaimSeconds).toBe(6);
    expect(versioned.body.medianAttestationSeconds).toBe(9);

    const other = await get(`/providers/${SECOND_CLINIC}/stats`);
    expect(other.body.medianClaimSeconds).toBe(1000);
    expect(other.body.medianAttestationSeconds).toBe(4000);
  });

  it('documents nullable numeric response times and their intervals in OpenAPI', async () => {
    const { body: spec } = await get('/openapi.json');
    for (const prefix of ['', '/v1']) {
      const schema =
        spec.paths[`${prefix}/providers/{address}/stats`].get.responses['200'].content[
          'application/json'
        ].schema;
      for (const field of ['medianClaimSeconds', 'medianAttestationSeconds']) {
        expect(schema.required).toContain(field);
        expect(schema.properties[field].anyOf).toEqual([
          { type: 'number', minimum: 0 },
          { type: 'null' },
        ]);
        expect(schema.properties[field].description).toContain('seconds');
      }
      expect(schema.properties.medianClaimSeconds.description).toContain('claimedAt - createdAt');
      expect(schema.properties.medianAttestationSeconds.description).toContain(
        'attestedAt - claimedAt',
      );
    }
  });

  it('404s an unknown provider', async () => {
    const { status, body } = await get(`/providers/${FUNDER}/stats`);
    expect(status).toBe(404);
    expect(body.error).toBe('provider_not_found');
  });
});

describe('GET /stats/daily', () => {
  beforeEach(async () => {
    await backfillDailyStats();
  });

  const sum = (
    body: { series: Array<Record<string, { count: number; amount: string }>> },
    key: string,
  ) =>
    body.series.reduce(
      (acc, row) => {
        const bucket = row[key]!;
        return {
          count: acc.count + bucket.count,
          amount: (BigInt(acc.amount) + BigInt(bucket.amount)).toString(),
        };
      },
      { count: 0, amount: '0' },
    );

  it('returns one row per UTC day, oldest first, including empty days', async () => {
    const { status, body } = await get('/stats/daily?days=30');
    expect(status).toBe(200);
    expect(body.days).toBe(30);
    expect(body.series).toHaveLength(30);

    const dates = body.series.map((r: { date: string }) => r.date);
    expect(new Set(dates).size).toBe(30);
    for (let i = 1; i < dates.length; i += 1) {
      expect(Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`)).toBe(
        DAY,
      );
    }
    expect(dates[dates.length - 1]).toBe(new Date().toISOString().slice(0, 10));

    // Days with nothing on them are present and zeroed, so charts need no gaps filled.
    const empty = body.series.find((r: { funded: { count: number } }) => r.funded.count === 0);
    expect(empty).toMatchObject({
      funded: { count: 0, amount: '0' },
      settled: { count: 0, amount: '0' },
      refunded: { count: 0, amount: '0' },
    });
  });

  it('sums funded and settled activity inside the window, exactly', async () => {
    const { body } = await get('/stats/daily?days=30');
    // Funded: ids 1, 4 and 5 (ids 2 and 3 were created outside the 30-day window).
    expect(sum(body, 'funded')).toEqual({ count: 3, amount: '90000000' });
    // Settled: the two receipts from the seed.
    expect(sum(body, 'settled')).toEqual({ count: 2, amount: '40000000' });
    expect(sum(body, 'refunded')).toEqual({ count: 0, amount: '0' });
  });

  it('buckets a refund by its refundedAt day', async () => {
    const now = Date.now();
    const refundedAt = new Date(now - 2 * DAY);
    await prisma.voucher.create({
      data: {
        id: 'refund-1',
        funder: FUNDER,
        beneficiaryRef: OTHER_REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '7000000',
        status: 'Refunded',
        createdAt: new Date(now - 20 * DAY),
        expiresAt: new Date(now + DAY),
        refundedAt,
      },
    });
    await backfillDailyStats();

    const { body } = await get('/stats/daily?days=7');
    const day = body.series.find(
      (r: { date: string }) => r.date === refundedAt.toISOString().slice(0, 10),
    );
    expect(day.refunded).toEqual({ count: 1, amount: '7000000' });
  });

  it('defaults to 30 days and rejects a window outside 1..365', async () => {
    expect((await get('/stats/daily')).body.days).toBe(30);
    expect((await get('/stats/daily?days=365')).status).toBe(200);
    expect((await get('/stats/daily?days=0')).status).toBe(400);
    expect((await get('/stats/daily?days=366')).status).toBe(400);
    expect((await get('/stats/daily?days=week')).status).toBe(400);
  });
});

describe('GET /vouchers', () => {
  it('requires at least one filter', async () => {
    const { status, body } = await get('/vouchers');
    expect(status).toBe(400);
    expect(body.error).toBe('filter_required');
  });

  it('rejects a malformed beneficiary reference', async () => {
    const { status } = await get('/vouchers?beneficiaryRef=not-hex');
    expect(status).toBe(400);
  });

  it('lists by funder, newest first, with pagination metadata', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&limit=2&count=true`);
    expect(body.total).toBe(5);
    expect(body.limit).toBe(2);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4']);
  });

  it('filters by beneficiary reference and status together', async () => {
    const { body } = await get(`/vouchers?beneficiaryRef=${REF}&status=Funded`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['2']);
  });

  it('resolves service labels, including delisted services and unknown codes', async () => {
    const { body } = await get(`/vouchers?provider=${CLINIC}`);
    const label = (id: string) =>
      body.vouchers.find((v: { id: string }) => v.id === id).serviceLabel;
    expect(label('1')).toBe('Outpatient consult');
    expect(label('3')).toBe('Antenatal visit');
    expect(label('5')).toBeNull();
  });

  it('derives settle and refund flags from the contract rules', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}`);
    const v = (id: string) => body.vouchers.find((x: { id: string }) => x.id === id);

    expect(v('2')).toMatchObject({ isRefundable: true, isSettleable: false });
    expect(v('3')).toMatchObject({ isRefundable: false, isSettleable: false });
    expect(new Date(v('3').refundableAt).getTime()).toBe(
      new Date(v('3').expiresAt).getTime() + CLAIM_GRACE_MS,
    );
    expect(v('4')).toMatchObject({ isRefundable: false, isSettleable: true, refundableAt: null });
    expect(v('1')).toMatchObject({ isRefundable: false, isSettleable: false, refundableAt: null });
  });

  it('carries the dispute reason', async () => {
    const { body } = await get('/vouchers?status=Disputed');
    expect(body.vouchers[0]).toMatchObject({ id: '5', disputeReason: 2 });
  });

  it('exposes the attester and the dispute outcome in the list view', async () => {
    const { body } = await get(`/vouchers?provider=${CLINIC}`);
    const v = (id: string) => body.vouchers.find((x: { id: string }) => x.id === id);

    expect(v('4').attestedBy).toBe(ATTESTER);
    expect(v('5')).toMatchObject({ disputeOutcome: 'Provider', disputeResolvedBy: ADMIN });
    expect(v('2').attestedBy).toBeNull();
  });

  it('filters by creation window, alone and combined with a funder', async () => {
    const from = encodeURIComponent(new Date(Date.now() - 6 * DAY).toISOString());
    const to = encodeURIComponent(new Date(Date.now() - 20 * DAY).toISOString());

    const recent = await get(`/vouchers?createdFrom=${from}&count=true`);
    expect(recent.body.total).toBe(2);
    expect(recent.body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4']);

    const older = await get(`/vouchers?funder=${FUNDER}&createdTo=${to}`);
    expect(older.body.vouchers.map((v: { id: string }) => v.id)).toEqual(['3', '2']);
  });

  it('compares amounts numerically, not as strings', async () => {
    // 10,000,000 sorts before 9,000,000 as a string but not numerically.
    const { body } = await get('/vouchers?minAmount=9000000&count=true');
    expect(body.total).toBe(5);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4', '1', '3', '2']);

    const capped = await get(`/vouchers?funder=${FUNDER}&maxAmount=30000000`);
    expect(capped.body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4', '1', '2']);
  });

  it('combines an amount band with a status', async () => {
    const { body } = await get(
      `/vouchers?provider=${CLINIC}&status=Attested&minAmount=20000000&maxAmount=40000000`,
    );
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['4']);
  });

  it('rejects malformed dates and amounts', async () => {
    expect((await get('/vouchers?createdFrom=yesterday')).status).toBe(400);
    expect((await get('/vouchers?minAmount=-1')).status).toBe(400);
    expect((await get('/vouchers?minAmount=abc')).status).toBe(400);
    expect(
      (await get('/vouchers?createdFrom=2026-10-10T00:00:00Z&createdTo=2026-10-01T00:00:00Z'))
        .status,
    ).toBe(400);
    expect((await get('/vouchers?minAmount=20000000&maxAmount=10000000')).status).toBe(400);
  });
});

describe('GET /vouchers sort', () => {
  it('defaults to newest first', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4', '1', '3', '2']);
  });

  it('sorts by createdAt ascending', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=createdAt&order=asc`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['2', '3', '1', '4', '5']);
  });

  it('sorts by expiresAt descending', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=expiresAt&order=desc`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4', '1', '3', '2']);
  });

  it('sorts amount numerically, not lexicographically', async () => {
    const now = Date.now();
    await prisma.voucher.create({
      data: {
        id: 'cheap',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '9000000',
        status: 'Funded',
        createdAt: new Date(now - DAY),
        expiresAt: new Date(now + 10 * DAY),
      },
    });

    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=amount&order=asc&count=true`);
    expect(body.total).toBe(6);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual([
      'cheap',
      '2',
      '1',
      '4',
      '5',
      '3',
    ]);

    const desc = await get(`/vouchers?funder=${FUNDER}&sort=amount&order=desc`);
    expect(desc.body.vouchers.map((v: { id: string }) => v.id)).toEqual([
      '3',
      '5',
      '4',
      '1',
      '2',
      'cheap',
    ]);
  });

  it('paginates after sorting by amount', async () => {
    const { body } = await get(
      `/vouchers?funder=${FUNDER}&sort=amount&order=asc&limit=2&offset=1&count=true`,
    );
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['1', '4']);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.total).toBe(5);
  });

  it('sorts and bands amounts across the whole i128 range (#96)', async () => {
    const now = Date.now();
    const huge = '170141183460469231731687303715884105727';
    await prisma.voucher.create({
      data: {
        id: 'huge',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: huge,
        status: 'Funded',
        createdAt: new Date(now - DAY),
        expiresAt: new Date(now + 10 * DAY),
      },
    });
    // Every write through the shared client fills the sortable key.
    const row = await prisma.voucher.findUnique({ where: { id: 'huge' } });
    expect(row?.amountKey).toBe(huge);

    const desc = await get(`/vouchers?funder=${FUNDER}&sort=amount&order=desc&limit=2&count=true`);
    expect(desc.body.total).toBe(6);
    expect(desc.body.vouchers.map((v: { id: string }) => v.id)).toEqual(['huge', '3']);

    const top = await get(`/vouchers?funder=${FUNDER}&minAmount=${huge}`);
    expect(top.body.vouchers.map((v: { id: string }) => v.id)).toEqual(['huge']);

    // Leading zeros are the same number.
    const padded = await get(`/vouchers?funder=${FUNDER}&minAmount=00050000000`);
    expect(padded.body.vouchers.map((v: { id: string }) => v.id)).toEqual(['huge', '3']);

    // A bound wider than any i128 compares as a number would.
    const wide = '1' + '0'.repeat(40);
    expect((await get(`/vouchers?funder=${FUNDER}&minAmount=${wide}&count=true`)).body.total).toBe(
      0,
    );
    expect((await get(`/vouchers?funder=${FUNDER}&maxAmount=${wide}&count=true`)).body.total).toBe(
      6,
    );
  });

  it('orders by the stored amount key, in the database (#96)', async () => {
    // Plant a key out of step with its amount. Only a database sort on
    // `amountKey` puts voucher 2 (the cheapest) first; an in-memory sort on
    // `amount` would not.
    await prisma.voucher.updateMany({ where: { id: '2' }, data: { amountKey: '9'.repeat(39) } });
    const { body } = await get(
      `/vouchers?funder=${FUNDER}&sort=amount&order=desc&limit=1&count=true`,
    );
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['2']);
    expect(body.total).toBe(5);
  });

  it('keeps an amount band on the cursor walk', async () => {
    const { body: page1 } = await get(`/vouchers?funder=${FUNDER}&minAmount=30000000&limit=2`);
    expect(page1.vouchers.map((v: { id: string }) => v.id)).toEqual(['5', '4']);
    const cursor = encodeCursor(new Date(page1.vouchers[1].createdAt), page1.vouchers[1].id);
    const { body: page2 } = await get(
      `/vouchers?funder=${FUNDER}&minAmount=30000000&limit=2&cursor=${cursor}`,
    );
    expect(page2.vouchers.map((v: { id: string }) => v.id)).toEqual(['1', '3']);
    expect(page2.nextCursor).toBeNull();
  });

  it('rejects an unknown sort or order', async () => {
    expect((await get(`/vouchers?funder=${FUNDER}&sort=price`)).status).toBe(400);
    expect((await get(`/vouchers?funder=${FUNDER}&order=up`)).status).toBe(400);
  });
});

describe('GET /vouchers.csv', () => {
  it('requires at least one filter, in the common error envelope', async () => {
    const { status, json } = await getCsv('/vouchers.csv');
    expect(status).toBe(400);
    expect(json()).toMatchObject({ error: 'filter_required' });
  });

  it('streams the filtered vouchers as a CSV attachment', async () => {
    const { status, headers, body } = await getCsv(`/vouchers.csv?funder=${FUNDER}`);
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('text/csv');
    expect(headers['content-disposition']).toContain('attachment');
    expect(headers['cache-control']).toBe('no-store');

    const rows = parseCsv(body);
    const header = rows[0]!;
    expect(header).toContain('id');
    expect(header).toContain('amountDisplay');
    expect(header).toContain('serviceLabel');
    // Never a beneficiary reference column.
    expect(header).not.toContain('beneficiaryRef');

    const byId = new Map(rows.slice(1).map((r) => [r[0], r]));
    expect([...byId.keys()].sort()).toEqual(['1', '2', '3', '4', '5']);
    expect(byId.get('1')![header.indexOf('amount')]).toBe('30000000');
    expect(byId.get('1')![header.indexOf('amountDisplay')]).toBe('3.0000000');
    expect(byId.get('1')![header.indexOf('providerName')]).toBe('Ikeja General Clinic');
    expect(byId.get('2')![header.indexOf('status')]).toBe('Funded');
    expect(byId.get('5')![header.indexOf('disputeReason')]).toBe('2');
  });

  it('accepts the same filters as the JSON route', async () => {
    const byStatus = parseCsv((await getCsv('/vouchers.csv?status=Funded')).body);
    expect(byStatus.slice(1).map((r) => r[0])).toEqual(['2']);

    const byProvider = parseCsv((await getCsv(`/vouchers.csv?provider=${SECOND_CLINIC}`)).body);
    expect(byProvider).toHaveLength(1); // header only, nothing for this clinic
  });

  it('escapes commas, quotes and line breaks in cells', async () => {
    const tricky = 'GD456OLJUTPFVB7GK5TQJ7MQZ3LRGAEL74VIH6BLVE4TATDASHO3SSUO';
    await prisma.provider.create({
      data: {
        address: tricky,
        name: 'Clinic "A", Ltd\nSecond line',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date(),
      },
    });
    await prisma.voucher.create({
      data: {
        id: 'csv-escape',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: tricky,
        serviceCode: 101,
        amount: '10000000',
        status: 'Funded',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + DAY),
      },
    });

    const { body } = await getCsv(`/vouchers.csv?provider=${tricky}`);
    const rows = parseCsv(body);
    expect(rows).toHaveLength(2);
    const nameColumn = rows[0]!.indexOf('providerName');
    expect(rows[1]![nameColumn]).toBe('Clinic "A", Ltd\nSecond line');
  });

  it('exports more rows than one batch, in cursor order, without gaps or repeats', async () => {
    // 501 rows is one past the 500-row batch size, so the export has to
    // continue from a cursor: a boundary that skipped or duplicated a row
    // would show up here.
    const now = Date.now();
    await prisma.voucher.createMany({
      data: Array.from({ length: 501 }, (_, i) => ({
        id: `bulk-${String(i).padStart(4, '0')}`,
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '1000000',
        status: 'Funded',
        createdAt: new Date(now - DAY),
        expiresAt: new Date(now + DAY),
      })),
    });

    const { status, body } = await getCsv(`/vouchers.csv?funder=${FUNDER}`);
    expect(status).toBe(200);

    const ids = parseCsv(body)
      .slice(1)
      .map((r) => r[0]!);
    expect(ids).toHaveLength(506); // 501 bulk + 5 seeded
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(506);
    expect(ids).toContain('bulk-0499'); // last row of the first 500-row batch
    expect(ids).toContain('bulk-0500'); // first row after the cursor boundary
  });
});

describe('GET /vouchers/:id', () => {
  it('includes the receipt for a settled voucher', async () => {
    const { body } = await get('/vouchers/1');
    expect(body.amountDisplay).toBe('3.0000000');
    expect(body.settledNet).toBe('29700000');
    expect(body.receipt).toMatchObject({ voucherId: '1', amount: '30000000' });
  });

  it('has a null receipt before settlement', async () => {
    const { body } = await get('/vouchers/2');
    expect(body.receipt).toBeNull();
  });

  it('404s an unknown voucher', async () => {
    const { status } = await get('/vouchers/404');
    expect(status).toBe(404);
  });

  it('exposes who attested the voucher', async () => {
    const { body } = await get('/vouchers/4');
    expect(body.attestedBy).toBe(ATTESTER);
  });

  it('exposes how a dispute was resolved', async () => {
    const { body } = await get('/vouchers/5');
    expect(body).toMatchObject({ disputeOutcome: 'Provider', disputeResolvedBy: ADMIN });
    expect(body.disputeResolvedAt).not.toBeNull();
  });

  it('returns the terms a funder chose at funding time (#319)', async () => {
    // No event announces these; reconciliation writes them from
    // `get_voucher_options`, and the detail route is where a funder can see
    // the window it actually picked instead of the protocol default.
    const commitment = 'ab'.repeat(32);
    await prisma.voucher.update({
      where: { id: '3' },
      data: { disputeWindowSecs: 259_200, presenceCommitment: commitment },
    });

    const { body } = await get('/vouchers/3');
    expect(body.disputeWindowSecs).toBe(259_200);
    expect(body.presenceCommitment).toBe(commitment);
  });

  it('returns null for both on a voucher funded without options (#319)', async () => {
    const { body } = await get('/vouchers/3');
    expect(body).toMatchObject({ disputeWindowSecs: null, presenceCommitment: null });
  });
});

describe('?include=receipt,provider (#167)', () => {
  it('embeds the receipt GET /receipts/:voucherId serves, null before settlement', async () => {
    const { status, body } = await get(`/vouchers?funder=${FUNDER}&include=receipt`);
    expect(status).toBe(200);

    // The acceptance criterion: the embedded object is the separate
    // endpoint's response, not a second hand-built shape.
    const settled = body.vouchers.find((v: { id: string }) => v.id === '1');
    const separate = await get('/receipts/1');
    expect(settled.receipt).toEqual(separate.body);

    const unsettled = body.vouchers.find((v: { id: string }) => v.id === '2');
    expect(unsettled.receipt).toBeNull();
  });

  it('embeds the provider GET /providers/:address serves', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&include=provider&limit=1`);
    const voucher = body.vouchers[0];
    const separate = await get(`/providers/${voucher.provider.address}`);
    expect(voucher.provider).toEqual(separate.body);
  });

  it('embeds both together', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&include=receipt,provider`);
    const voucher = body.vouchers.find((v: { id: string }) => v.id === '1');
    expect(voucher.receipt).toEqual((await get('/receipts/1')).body);
    expect(voucher.provider).toEqual((await get(`/providers/${CLINIC}`)).body);
  });

  it('leaves the default response unchanged when nothing is included', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&limit=1`);
    expect(body.vouchers[0]).not.toHaveProperty('receipt');
    expect(Object.keys(body.vouchers[0].provider).sort()).toEqual(['address', 'country', 'name']);
  });

  it('treats an empty include as no embedding, like an empty fields', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&limit=1&include=`);
    expect(body.vouchers[0]).not.toHaveProperty('receipt');
  });

  it('rejects an unknown include on the list route', async () => {
    const { status, body } = await get(`/vouchers?funder=${FUNDER}&include=receipt,nope`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('applies to GET /vouchers/:id, matching both separate endpoints', async () => {
    const { body } = await get('/vouchers/1?include=receipt,provider');
    expect(body.receipt).toEqual((await get('/receipts/1')).body);
    expect(body.provider).toEqual((await get(`/providers/${CLINIC}`)).body);
  });

  it('keeps the stored receipt row on GET /vouchers/:id without include', async () => {
    const { body } = await get('/vouchers/1');
    expect(body.receipt).toMatchObject({ voucherId: '1', beneficiaryRef: REF });
  });

  it('rejects an unknown include on the detail route', async () => {
    const { status } = await get('/vouchers/1?include=nope');
    expect(status).toBe(400);
  });

  it('projects include alongside ?fields=', async () => {
    const { body } = await get(
      `/vouchers?funder=${FUNDER}&limit=1&include=receipt&fields=id,receipt`,
    );
    expect(Object.keys(body.vouchers[0]).sort()).toEqual(['id', 'receipt']);
  });

  it('embeds a page in a fixed number of queries, not one per row', async () => {
    // `queryStats` counts the Prisma operations the request asks for
    // (`src/db.ts`, test-only). An N+1 implementation would show one receipt
    // lookup per voucher, so a five-row page would make five.
    // Give every seeded voucher a receipt so both pages take the same code
    // path; then the only difference between them is the row count.
    await prisma.receipt.createMany({
      data: ['2', '3', '4', '5'].map((voucherId) => ({
        voucherId,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '1000000',
        settledAt: new Date(),
      })),
    });

    const beforeOne = queryStats.queries;
    const single = await get(`/vouchers?funder=${FUNDER}&limit=1&include=receipt,provider`);
    expect(single.body.vouchers).toHaveLength(1);
    expect(single.body.vouchers[0].receipt).not.toBeNull();
    const forOneRow = queryStats.queries - beforeOne;
    expect(forOneRow).toBeGreaterThan(0);

    const beforePage = queryStats.queries;
    const page = await get(`/vouchers?funder=${FUNDER}&limit=5&include=receipt,provider`);
    expect(page.body.vouchers).toHaveLength(5);
    expect(queryStats.queries - beforePage).toBe(forOneRow);
  });
});

describe('GET /vouchers/:id/events', () => {
  it('returns the event log in ledger order with transaction hashes', async () => {
    const { status, body } = await get('/vouchers/1/events');
    expect(status).toBe(200);
    expect(body.voucherId).toBe('1');
    expect(body.total).toBe(2);
    expect(body.events.map((e: { name: string }) => e.name)).toEqual([
      'voucher_created',
      'voucher_settled',
    ]);
    expect(body.events.map((e: { ledger: number }) => e.ledger)).toEqual([20, 22]);
    expect(body.events[0].txHash).toBe('e'.repeat(64));
    expect(body.events[0].data).toMatchObject({ amount: '30000000' });
  });

  it('returns an empty list for a voucher with no logged events', async () => {
    const { body } = await get('/vouchers/2/events');
    expect(body).toMatchObject({ voucherId: '2', total: 0, events: [] });
  });

  it('404s an unknown voucher', async () => {
    const { status, body } = await get('/vouchers/404/events');
    expect(status).toBe(404);
    expect(body.error).toBe('voucher_not_found');
  });
});

describe('GET /attesters', () => {
  it('lists only active attesters by default, with attestation counts', async () => {
    const { status, body } = await get('/attesters');
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.attesters).toHaveLength(1);
    expect(body.attesters[0]).toMatchObject({
      address: ATTESTER,
      active: true,
      removedAt: null,
      attestations: 1,
    });
  });

  it('includes removed attesters with ?all=true', async () => {
    const { body } = await get('/attesters?all=true');
    expect(body.total).toBe(2);

    const former = body.attesters.find((a: { address: string }) => a.address === FORMER_ATTESTER);
    expect(former).toMatchObject({ active: false, attestations: 0 });
    expect(former.removedAt).not.toBeNull();
  });

  it('rejects an invalid all value', async () => {
    const { status, body } = await get('/attesters?all=maybe');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });
});

describe('GET /attesters/:address', () => {
  it('returns one attester with its attestation count', async () => {
    const { status, body } = await get(`/attesters/${ATTESTER}`);
    expect(status).toBe(200);
    expect(body).toMatchObject({ address: ATTESTER, active: true, attestations: 1 });
  });

  it('returns a removed attester with zero attestations', async () => {
    const { body } = await get(`/attesters/${FORMER_ATTESTER}`);
    expect(body).toMatchObject({ active: false, attestations: 0 });
  });

  it('404s an unknown attester', async () => {
    const { status, body } = await get(`/attesters/${FUNDER}`);
    expect(status).toBe(404);
    expect(body.error).toBe('attester_not_found');
  });
});

describe('GET /attesters/:address/stats', () => {
  it('counts attestations, later disputes and the median wait from claim (#169)', async () => {
    const claimed = new Date(Date.now() - 10 * DAY);
    const after = (hours: number) => new Date(claimed.getTime() + hours * 3_600_000);
    const fixture = {
      funder: FUNDER,
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '10000000',
      createdAt: new Date(claimed.getTime() - DAY),
      expiresAt: new Date(Date.now() + 20 * DAY),
      claimedAt: claimed,
      attestedBy: ATTESTER,
    };
    await prisma.voucher.createMany({
      data: [
        // Disputed, then resolved for the provider and settled: still counts.
        {
          ...fixture,
          id: 'a1',
          status: 'Settled',
          attestedAt: after(1),
          disputeReason: 3,
          disputeOutcome: 'Provider',
        },
        // Disputed and open.
        { ...fixture, id: 'a2', status: 'Disputed', attestedAt: after(3), disputeReason: 1 },
        // Settled without a dispute.
        { ...fixture, id: 'a3', status: 'Settled', attestedAt: after(8) },
        // Another attester's dispute does not count here.
        {
          ...fixture,
          id: 'a4',
          status: 'Disputed',
          attestedAt: after(2),
          attestedBy: FORMER_ATTESTER,
          disputeReason: 1,
        },
      ],
    });

    const { status, body } = await get(`/attesters/${ATTESTER}/stats`);
    expect(status).toBe(200);
    // Voucher 4 from the shared seed has no claimedAt, so it counts as an
    // attestation but not towards the median: waits are 1h, 3h and 8h.
    expect(body).toEqual({
      address: ATTESTER,
      active: true,
      attestations: 4,
      disputedAfterAttestation: 2,
      medianSecondsFromClaim: 3 * 3600,
    });

    const former = await get(`/attesters/${FORMER_ATTESTER}/stats`);
    expect(former.body).toMatchObject({
      active: false,
      attestations: 1,
      disputedAfterAttestation: 1,
      medianSecondsFromClaim: 2 * 3600,
    });
  });

  it('reports a null median before any timed attestation', async () => {
    const { body } = await get(`/attesters/${FORMER_ATTESTER}/stats`);
    expect(body).toEqual({
      address: FORMER_ATTESTER,
      active: false,
      attestations: 0,
      disputedAfterAttestation: 0,
      medianSecondsFromClaim: null,
    });
  });

  it('averages the two middle waits for an even count', async () => {
    const claimed = new Date(Date.now() - 5 * DAY);
    await prisma.voucher.update({
      where: { id: '4' },
      data: { claimedAt: claimed, attestedAt: new Date(claimed.getTime() + 2 * 3_600_000) },
    });
    await prisma.voucher.create({
      data: {
        id: 'a5',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '10000000',
        status: 'Attested',
        createdAt: new Date(claimed.getTime() - DAY),
        expiresAt: new Date(Date.now() + 20 * DAY),
        claimedAt: claimed,
        attestedAt: new Date(claimed.getTime() + 5 * 3_600_000),
        attestedBy: ATTESTER,
      },
    });
    const { body } = await get(`/attesters/${ATTESTER}/stats`);
    expect(body.medianSecondsFromClaim).toBe(3.5 * 3600);
  });

  it('404s an unknown attester', async () => {
    const { status, body } = await get(`/attesters/${FUNDER}/stats`);
    expect(status).toBe(404);
    expect(body.error).toBe('attester_not_found');
  });
});

describe('GET /receipts', () => {
  it('returns care history and total spend for one beneficiary', async () => {
    const { body } = await get(`/receipts?beneficiaryRef=${REF}&count=true`);
    expect(body.total).toBe(2);
    expect(body.totalSpend).toBe('40000000');
    expect(body.totalSpendDisplay).toBe('4.0000000');
    expect(body.receipts.map((r: { voucherId: string }) => r.voucherId)).toEqual(['9', '1']);
    expect(body.receipts[0].serviceLabel).toBe('Malaria rapid test');
  });

  it('returns nothing for a reference with no receipts', async () => {
    const { body } = await get(`/receipts?beneficiaryRef=${OTHER_REF}&count=true`);
    expect(body).toMatchObject({ total: 0, totalSpend: '0', receipts: [] });
  });

  it('requires a beneficiary reference', async () => {
    const { status } = await get('/receipts');
    expect(status).toBe(400);
  });

  it('lists receipts by provider, omitting beneficiaryRef', async () => {
    const { body } = await get(`/receipts?provider=${CLINIC}&count=true`);
    expect(body.total).toBe(2);
    expect(body.totalSpend).toBe('40000000');
    expect(body.receipts.map((r: { voucherId: string }) => r.voucherId)).toEqual(['9', '1']);
    expect(body.receipts[0]).not.toHaveProperty('beneficiaryRef');
    expect(body.receipts[0].serviceLabel).toBe('Malaria rapid test');
  });

  it('requires exactly one of beneficiaryRef or provider', async () => {
    const { status, body } = await get('/receipts');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');

    const { status: s2, body: b2 } = await get(
      `/receipts?beneficiaryRef=${REF}&provider=${CLINIC}`,
    );
    expect(s2).toBe(400);
    expect(b2.error).toBe('invalid_query');
  });

  // #51 — an address is what the chain records; the clinic name is what a
  // patient recognises when they look at a receipt.
  it('names the clinic that issued each receipt', async () => {
    const { body } = await get(`/receipts?beneficiaryRef=${REF}`);
    expect(body.receipts).toHaveLength(2);
    for (const receipt of body.receipts as { provider: unknown }[]) {
      expect(receipt.provider).toEqual({
        address: CLINIC,
        name: 'Ikeja General Clinic',
        country: 'NG',
      });
    }
    // Kept for clients already reading it; the object is additive.
    expect(body.receipts[0].providerAddress).toBe(CLINIC);
  });

  it('names the clinic in the provider view too', async () => {
    const { body } = await get(`/receipts?provider=${SECOND_CLINIC}`);
    expect(body.receipts).toHaveLength(0);

    await prisma.receipt.create({
      data: {
        voucherId: '12',
        beneficiaryRef: OTHER_REF,
        providerAddress: SECOND_CLINIC,
        serviceCode: 404,
        amount: '20000000',
        settledAt: new Date(Date.now() - DAY),
      },
    });
    const refetched = await get(`/receipts?provider=${SECOND_CLINIC}`);
    expect(refetched.body.receipts[0].provider).toEqual({
      address: SECOND_CLINIC,
      name: 'Mwanza Mission Hospital',
      country: 'TZ',
    });
    // The clinic's own list must still not reveal who the care was for.
    expect(refetched.body.receipts[0]).not.toHaveProperty('beneficiaryRef');
  });

  it('pages a cursor with the clinic named', async () => {
    const { body: page1 } = await get(`/receipts?beneficiaryRef=${REF}&limit=1`);
    expect(page1.receipts[0].provider.name).toBe('Ikeja General Clinic');
    const cursor = encodeCursor(new Date(page1.receipts[0].settledAt), page1.receipts[0].voucherId);
    const { body: page2 } = await get(`/receipts?beneficiaryRef=${REF}&limit=1&cursor=${cursor}`);
    expect(page2.receipts[0].provider).toEqual({
      address: CLINIC,
      name: 'Ikeja General Clinic',
      country: 'NG',
    });
  });

  it('reports an unknown clinic instead of failing the page', async () => {
    // A receipt whose provider row the indexer never wrote: the address came
    // off the settlement event, the registration did not. Nothing here may
    // invent a name for a clinic the read model has not seen.
    await prisma.receipt.create({
      data: {
        voucherId: '13',
        beneficiaryRef: REF,
        providerAddress: UNREGISTERED_CLINIC,
        serviceCode: 101,
        amount: '10000000',
        settledAt: new Date(Date.now() - DAY),
      },
    });

    const { status, body } = await get(`/receipts?beneficiaryRef=${REF}`);
    expect(status).toBe(200);
    const orphan = (body.receipts as { voucherId: string }[]).find((r) => r.voucherId === '13');
    expect(orphan).toMatchObject({
      provider: { address: UNREGISTERED_CLINIC, name: null, country: null },
    });
  });
});

// #53: one call that answers "how much care has this reference had, where
// and when", so the care history page does not fetch and sum every receipt
// on the client.
describe('GET /receipts/summary', () => {
  it('returns count, total, first and last visit matching the receipts', async () => {
    // The expectations are derived from GET /receipts itself, the source of
    // truth the issue names ("Summary values match the receipts"), not from
    // re-running the aggregation in the test.
    const { body: list } = await get(`/receipts?beneficiaryRef=${REF}&count=true`);
    expect(list.receipts).toHaveLength(2);

    const { status, body } = await get(`/receipts/summary?beneficiaryRef=${REF}`);
    expect(status).toBe(200);
    expect(body.count).toBe(list.total);
    expect(body.total).toBe(list.totalSpend);
    expect(body.totalDisplay).toBe(list.totalSpendDisplay);
    // The list is sorted settledAt desc, so first/last are its ends.
    expect(body.lastVisit).toBe(list.receipts[0].settledAt);
    expect(body.firstVisit).toBe(list.receipts[list.receipts.length - 1].settledAt);
  });

  it('names the clinics visited', async () => {
    const { body } = await get(`/receipts/summary?beneficiaryRef=${REF}`);
    expect(body.clinics).toEqual([
      {
        address: CLINIC,
        name: 'Ikeja General Clinic',
        country: 'NG',
        visits: 2,
        spend: '40000000',
        spendDisplay: '4.0000000',
      },
    ]);
  });

  it('sums totals with BigInt, exactly, past Number.MAX_SAFE_INTEGER', async () => {
    await prisma.receipt.createMany({
      data: [
        {
          voucherId: 'sum-big-1',
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '9007199254740993',
          settledAt: new Date(Date.now() - 2 * DAY),
        },
        {
          voucherId: 'sum-big-2',
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          // The odd pair rounds under Number accumulation.
          amount: '9007199254740995',
          settledAt: new Date(Date.now() - DAY),
        },
      ],
    });

    const { body } = await get(`/receipts/summary?beneficiaryRef=${REF}`);
    // 30000000 + 10000000 (seeded) + the two above.
    expect(body.total).toBe('18014398549481988');
  });

  it('aggregates across several clinics and reports unknown clinics as unknown', async () => {
    const now = Date.now();
    await prisma.receipt.createMany({
      data: [
        // A second clinic, and the earliest visit overall.
        {
          voucherId: 'sum-2nd',
          beneficiaryRef: REF,
          providerAddress: SECOND_CLINIC,
          serviceCode: 404,
          amount: '20000000',
          settledAt: new Date(now - 90 * DAY),
        },
        // A clinic the indexer never saw registered (#51 precedent: unknown,
        // not invented).
        {
          voucherId: 'sum-unknown',
          beneficiaryRef: REF,
          providerAddress: UNREGISTERED_CLINIC,
          serviceCode: 101,
          amount: '5000000',
          settledAt: new Date(now - 4 * DAY),
        },
      ],
    });

    const { body } = await get(`/receipts/summary?beneficiaryRef=${REF}`);
    expect(body.count).toBe(4);
    expect(body.firstVisit).toBe(new Date(now - 90 * DAY).toISOString());
    // The newest visit is a seeded receipt, whose timestamp comes from the
    // seed's own clock — read it back from GET /receipts rather than
    // recomputing it here.
    const { body: list } = await get(`/receipts?beneficiaryRef=${REF}`);
    expect(body.lastVisit).toBe(list.receipts[0].settledAt);
    expect(body.clinics).toHaveLength(3);
    // Deterministic order by address, so two calls render identically.
    const addresses = body.clinics.map((c: { address: string }) => c.address);
    expect(addresses).toEqual([...addresses].sort());
    expect(body.clinics.find((c: { address: string }) => c.address === SECOND_CLINIC)).toEqual({
      address: SECOND_CLINIC,
      name: 'Mwanza Mission Hospital',
      country: 'TZ',
      visits: 1,
      spend: '20000000',
      spendDisplay: '2.0000000',
    });
    expect(
      body.clinics.find((c: { address: string }) => c.address === UNREGISTERED_CLINIC),
    ).toMatchObject({ name: null, country: null, visits: 1, spend: '5000000' });
    // Per-clinic spend must add up to the grand total.
    const spendSum = (body.clinics as { spend: string }[])
      .reduce((acc: bigint, c) => acc + BigInt(c.spend), 0n)
      .toString();
    expect(spendSum).toBe(body.total);
  });

  it('summarises a reference with no care as zero, not as missing', async () => {
    const { status, body } = await get(`/receipts/summary?beneficiaryRef=${OTHER_REF}`);
    expect(status).toBe(200);
    expect(body).toEqual({
      count: 0,
      total: '0',
      totalDisplay: '0.0000000',
      firstVisit: null,
      lastVisit: null,
      clinics: [],
    });
  });

  it('requires a valid beneficiaryRef', async () => {
    const missing = await get('/receipts/summary');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('invalid_query');

    const malformed = await get('/receipts/summary?beneficiaryRef=not-a-ref');
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toBe('invalid_query');

    // The clinic view is deliberately not part of this endpoint: a clinic
    // querying by provider would summarise many patients into one number.
    const byProvider = await get(`/receipts/summary?provider=${CLINIC}`);
    expect(byProvider.status).toBe(400);
  });

  it('never echoes the beneficiary reference back', async () => {
    const { status, body } = await get(`/receipts/summary?beneficiaryRef=${REF}`);
    expect(status).toBe(200);
    expect(body).not.toHaveProperty('beneficiaryRef');
    expect(JSON.stringify(body)).not.toContain(REF);
  });

  it('is served under the /v1 alias with cache headers like the other read routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/receipts/summary?beneficiaryRef=${REF}`,
      headers: { 'x-forwarded-for': nextTestClientIp() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().count).toBe(2);
    expect(res.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=30');
    expect(res.headers['etag']).toMatch(/^W\/"\d+-[A-Za-z0-9_-]+"$/);
  });
});

describe('GET /receipts/:voucherId', () => {
  it('returns a single receipt by voucherId without beneficiaryRef', async () => {
    const { body } = await get('/receipts/1');
    expect(body.voucherId).toBe('1');
    expect(body.amount).toBe('30000000');
    expect(body.amountDisplay).toBe('3.0000000');
    expect(body.serviceLabel).toBe('Outpatient consult');
    expect(body).not.toHaveProperty('beneficiaryRef');
  });

  it('names the clinic on a shareable receipt', async () => {
    const { body } = await get('/receipts/1');
    expect(body.provider).toEqual({
      address: CLINIC,
      name: 'Ikeja General Clinic',
      country: 'NG',
    });
    expect(body.providerAddress).toBe(CLINIC);
  });

  it('names an unknown clinic as unknown', async () => {
    await prisma.receipt.create({
      data: {
        voucherId: '14',
        beneficiaryRef: REF,
        providerAddress: UNREGISTERED_CLINIC,
        serviceCode: 101,
        amount: '10000000',
        settledAt: new Date(Date.now() - DAY),
      },
    });
    const { body } = await get('/receipts/14');
    expect(body.provider).toEqual({ address: UNREGISTERED_CLINIC, name: null, country: null });
  });

  it('404s for an unknown voucher', async () => {
    const { status, body } = await get('/receipts/999');
    expect(status).toBe(404);
    expect(body.error).toBe('receipt_not_found');
  });

  describe('GET /receipts/:voucherId/proof', () => {
    it('returns proof fields from the event log', async () => {
      const { status, body } = await get('/receipts/1/proof');
      expect(status).toBe(200);
      expect(body).toMatchObject({
        txHash: 'f'.repeat(64),
        ledger: 22,
        eventId: 'ce-2',
        contractId: VOUCHER,
      });
    });

    it('404s for an unknown voucher', async () => {
      const { status, body } = await get('/receipts/999/proof');
      expect(status).toBe(404);
      expect(body.error).toBe('receipt_not_found');
    });
  });
});

describe('GET /vouchers', () => {
  it('accepts comma-separated status list', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&status=Claimed,Attested`);
    expect(body.vouchers.map((v: { id: string }) => v.id).sort()).toEqual(['3', '4']);
  });

  it('rejects invalid status values', async () => {
    const { status, body } = await get(`/vouchers?funder=${FUNDER}&status=Claimed,Invalid`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });
});

describe('GET /vouchers/due', () => {
  it('requires funder or provider', async () => {
    const { status, body } = await get('/vouchers/due?within=72h');
    expect(status).toBe(400);
    expect(body.error).toBe('filter_required');
  });

  it('rejects invalid within format', async () => {
    const { status, body } = await get(`/vouchers/due?funder=${FUNDER}&within=invalid`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('returns vouchers expiring, becoming refundable, or settleable within the window', async () => {
    // Use a fixed clock by seeding with specific dates
    const now = Date.now();

    // Add more vouchers for testing the due endpoint
    await prisma.voucher.createMany({
      data: [
        // Funded, expires in 48h -> should be in 72h window (refundable at expiry)
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'due-1',
          serviceCode: 101,
          amount: '30000000',
          status: 'Funded',
          createdAt: new Date(now - 10 * DAY),
          expiresAt: new Date(now + 48 * 60 * 60 * 1000),
        },
        // Claimed, expired 24h ago -> refundable in 6 days (outside 72h)
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'due-2',
          serviceCode: 101,
          amount: '30000000',
          status: 'Claimed',
          createdAt: new Date(now - 31 * DAY),
          expiresAt: new Date(now - 24 * 60 * 60 * 1000),
        },
        // Attested, dispute deadline in 24h -> settleable in window
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'due-3',
          serviceCode: 101,
          amount: '30000000',
          status: 'Attested',
          createdAt: new Date(now - 5 * DAY),
          expiresAt: new Date(now + 25 * DAY),
          disputeDeadline: new Date(now + 24 * 60 * 60 * 1000),
        },
        // Funded, expires in 10 days -> outside 72h window
        {
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          id: 'due-4',
          serviceCode: 101,
          amount: '30000000',
          status: 'Funded',
          createdAt: new Date(now - 10 * DAY),
          expiresAt: new Date(now + 10 * DAY),
        },
      ],
    });

    // Use provider filter
    const { body } = await get(`/vouchers/due?provider=${CLINIC}&within=72h`);

    // Existing seeded vouchers: id '2' (refundable now) and '4' (settleable now) are in window
    // New vouchers: due-1 (expires in 48h) and due-3 (dispute deadline in 24h) are in window
    // Total expected: 4
    const ids = body.vouchers.map((v: { id: string }) => v.id).sort();
    expect(ids).toContain('due-1');
    expect(ids).toContain('due-3');
    expect(ids).toContain('2');
    expect(ids).toContain('4');
    expect(ids).not.toContain('due-2');
    expect(ids).not.toContain('due-4');

    expect(body.total).toBe(4);
  });
});

describe('GET /governance', () => {
  it('reports current and pending admin plus history for each contract', async () => {
    const { status, body } = await get('/governance');
    expect(status).toBe(200);

    const byName = (name: string) =>
      body.contracts.find((c: { contract: string }) => c.contract === name);

    expect(byName('registry')).toMatchObject({ currentAdmin: NEW_ADMIN, pendingAdmin: null });
    expect(byName('registry').history.map((h: { type: string }) => h.type)).toEqual([
      'Proposed',
      'Changed',
    ]);

    expect(byName('voucher')).toMatchObject({ currentAdmin: ADMIN, pendingAdmin: NEW_ADMIN });
    expect(byName('voucher').history).toHaveLength(1);

    expect(byName('receipt')).toMatchObject({
      currentAdmin: null,
      pendingAdmin: null,
      history: [],
    });
  });
});

describe('cursor pagination', () => {
  it('pages through vouchers with cursor', async () => {
    const { body: page1 } = await get(`/vouchers?funder=${FUNDER}&limit=2`);
    expect(page1.vouchers).toHaveLength(2);

    const cursor = encodeCursor(new Date(page1.vouchers[1].createdAt), page1.vouchers[1].id);
    const { body: page2 } = await get(`/vouchers?funder=${FUNDER}&limit=2&cursor=${cursor}`);
    expect(page2.vouchers.length).toBeGreaterThan(0);

    const page1Ids = page1.vouchers.map((v: { id: string }) => v.id);
    const page2Ids = page2.vouchers.map((v: { id: string }) => v.id);
    expect(page1Ids.filter((id: string) => page2Ids.includes(id))).toEqual([]);
  });

  it('returns null nextCursor on the last page', async () => {
    const { body } = await get(`/vouchers?funder=${FUNDER}&limit=100`);
    expect(body.nextCursor).toBeUndefined();
  });

  it('rejects an invalid cursor', async () => {
    const { status, body } = await get(`/vouchers?funder=${FUNDER}&cursor=not-valid!!`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_cursor');
  });

  it('pages through providers with cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null | undefined;

    // Page through all providers one at a time
    do {
      const url = cursor ? `/providers?limit=1&cursor=${cursor}` : '/providers?limit=1';
      const { body } = await get(url);
      expect(body.providers).toHaveLength(1);
      seen.push(body.providers[0].address);
      cursor = body.nextCursor;
    } while (cursor);

    // Should have visited every provider exactly once
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('pages through receipts with cursor', async () => {
    const { body: page1 } = await get(`/receipts?beneficiaryRef=${REF}&limit=1`);
    expect(page1.receipts).toHaveLength(1);

    const cursor = encodeCursor(new Date(page1.receipts[0].settledAt), page1.receipts[0].voucherId);
    const { body: page2 } = await get(`/receipts?beneficiaryRef=${REF}&limit=1&cursor=${cursor}`);
    expect(page2.receipts).toHaveLength(1);
    expect(page2.receipts[0].voucherId).not.toBe(page1.receipts[0].voucherId);
  });

  it('sends Deprecation header when offset is used', async () => {
    const res = await app.inject({ method: 'GET', url: `/vouchers?funder=${FUNDER}&offset=1` });
    expect(res.headers['deprecation']).toBe('true');
  });
});

describe('GET /providers/:address/history', () => {
  it('returns status transitions oldest first', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/history`);
    expect(status).toBe(200);
    expect(body.history.map((h: { status: string }) => h.status)).toEqual([
      'Active',
      'Suspended',
      'Active',
    ]);
    expect(body.history.map((h: { ledger: number }) => h.ledger)).toEqual([10, 12, 14]);
  });

  it('404s an unknown provider', async () => {
    const { status, body } = await get(`/providers/${FUNDER}/history`);
    expect(status).toBe(404);
    expect(body.error).toBe('provider_not_found');
  });
});

describe('GET /providers/:address/services/:code/history', () => {
  it('returns price changes oldest first', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/services/101/history`);
    expect(status).toBe(200);
    expect(body.history.map((h: { price: string }) => h.price)).toEqual(['30000000', '35000000']);
    expect(body.history[0].priceDisplay).toBe('3.0000000');
  });

  it('rejects a non-numeric service code', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/services/abc/history`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_code');
  });
});

describe('GET /providers/:address/services (#314)', () => {
  it('serves the clinic price list on its own, cheapest first', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/services`);
    expect(status).toBe(200);
    expect(body.providerAddress).toBe(CLINIC);
    expect(body.name).toBe('Ikeja General Clinic');
    // The whole catalogue by default, delisted entries included, so this
    // route can replace the array embedded in GET /providers/:address.
    expect(body.total).toBe(3);
    expect(body.services.map((s: { price: string }) => s.price)).toEqual([
      '10000000',
      '30000000',
      '50000000',
    ]);
    expect(body.services[0]).toMatchObject({
      code: 202,
      label: 'Malaria rapid test',
      priceDisplay: '1.0000000',
      active: true,
    });
  });

  it('sorts by amount, not by the string', async () => {
    // 10^10 stroops is more than 9 x 10^9, but a lexicographic sort of the
    // decimal strings — what a database ORDER BY on a String column does —
    // would put them the other way round.
    await prisma.service.create({
      data: {
        id: `${CLINIC}:707`,
        code: 707,
        label: 'Imaging',
        price: '9000000000',
        providerAddress: CLINIC,
      },
    });
    await prisma.service.create({
      data: {
        id: `${CLINIC}:708`,
        code: 708,
        label: 'Surgery',
        price: '10000000000',
        providerAddress: CLINIC,
      },
    });

    const { body } = await get(`/providers/${CLINIC}/services`);
    const big = body.services.filter((s: { code: number }) => s.code >= 707);
    expect(big.map((s: { price: string }) => s.price)).toEqual(['9000000000', '10000000000']);
  });

  it('filters the catalogue by listed or delisted', async () => {
    const listed = await get(`/providers/${CLINIC}/services?active=true`);
    expect(listed.body.total).toBe(2);
    expect(listed.body.services.every((s: { active: boolean }) => s.active)).toBe(true);

    const delisted = await get(`/providers/${CLINIC}/services?active=false`);
    expect(delisted.body.services.map((s: { code: number }) => s.code)).toEqual([303]);
  });

  it('reorders by code, and reverses', async () => {
    const { body } = await get(`/providers/${CLINIC}/services?sort=code&order=desc`);
    expect(body.services.map((s: { code: number }) => s.code)).toEqual([303, 202, 101]);
  });

  it('404s an unknown clinic', async () => {
    const { status, body } = await get(`/providers/${FUNDER}/services`);
    expect(status).toBe(404);
    expect(body.error).toBe('provider_not_found');
  });

  it('returns an empty list for a clinic without services', async () => {
    const { status, body } = await get(`/providers/${PENDING_CLINIC}/services`);
    expect(status).toBe(200);
    expect(body.total).toBe(0);
    expect(body.services).toEqual([]);
  });

  it('rejects an unknown filter value with the house error code', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/services?sort=name`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('is cacheable, so a price refresh does not have to refetch the clinic record', async () => {
    const res = await app.inject({ method: 'GET', url: `/providers/${CLINIC}/services` });
    expect(res.headers['cache-control']).toContain('max-age=');
    expect(res.headers.etag).toBeDefined();
  });
});

describe('scheduled price changes in the API (#315)', () => {
  /** A schedule taking effect an hour from `now`. */
  async function scheduleFuture(price: string, now: number): Promise<void> {
    await prisma.service.update({
      where: { id: `${CLINIC}:101` },
      data: { upcomingPrice: price, upcomingFrom: new Date(now + 60 * 60 * 1000) },
    });
  }

  it('shows a scheduled change before it takes effect', async () => {
    const now = Date.now();
    await scheduleFuture('45000000', now);

    const { body } = await get(`/providers/${CLINIC}/services`);
    const consult = body.services.find((s: { code: number }) => s.code === 101);
    expect(consult.price).toBe('30000000');
    expect(consult.upcomingPrice).toBe('45000000');
    expect(consult.upcomingFrom).toBe(new Date(now + 60 * 60 * 1000).toISOString());
  });

  it('applies a schedule that has come due and stops showing it as upcoming', async () => {
    await prisma.service.update({
      where: { id: `${CLINIC}:101` },
      data: {
        upcomingPrice: '45000000',
        upcomingFrom: new Date(Date.now() - 60 * 1000),
      },
    });

    const { body } = await get(`/providers/${CLINIC}/services`);
    const consult = body.services.find((s: { code: number }) => s.code === 101);
    // The contract swaps the pending price into `price` on the first read at
    // or after `effective_at` and emits nothing, so the pending columns clear.
    expect(consult.price).toBe('45000000');
    expect(consult.priceDisplay).toBe('4.5000000');
    expect(consult.upcomingPrice).toBeNull();
    expect(consult.upcomingFrom).toBeNull();
  });

  it('sorts on the price in effect, not the one still pending', async () => {
    // 101 is about to become the most expensive thing the clinic sells;
    // until it does, it must not sort above 303.
    await scheduleFuture('90000000', Date.now());

    const { body } = await get(`/providers/${CLINIC}/services`);
    expect(body.services.map((s: { code: number }) => s.code)).toEqual([202, 101, 303]);
  });

  it('reports the same prices as the clinic record and the embedded catalogue', async () => {
    await scheduleFuture('45000000', Date.now());

    const standalone = await get(`/providers/${CLINIC}/services?active=true`);
    const detail = await get(`/providers/${CLINIC}`);
    const list = await get('/providers');

    const priceOf = (entries: { code: number; price: string; upcomingPrice: string }[]) =>
      entries.filter((s) => s.code === 101).map((s) => [s.price, s.upcomingPrice])[0];

    const listed = list.body.providers.find((p: { address: string }) => p.address === CLINIC);
    expect(priceOf(detail.body.services)).toEqual(priceOf(standalone.body.services));
    expect(priceOf(listed.services)).toEqual(priceOf(standalone.body.services));
  });

  it('prices the service bands by what a funder would pay now', async () => {
    // SECOND_CLINIC stays at 40000000 for code 101; CLINIC is scheduled to
    // move to 90000000 but has not yet.
    await scheduleFuture('90000000', Date.now());

    const { body } = await get('/services');
    const consult = body.services.find((s: { code: number }) => s.code === 101);
    expect(consult.minPrice).toBe('30000000');
    expect(consult.maxPrice).toBe('40000000');
  });

  it('shows the pending change on the per-code clinic list too', async () => {
    await scheduleFuture('45000000', Date.now());

    const { body } = await get('/services/101');
    const clinic = body.clinics.find((c: { address: string }) => c.address === CLINIC);
    expect(clinic.price).toBe('30000000');
    expect(clinic.upcomingPrice).toBe('45000000');
  });

  it('leaves a deployment with no scheduling unchanged', async () => {
    // The columns are nullable and never written by an older registry, so a
    // row predating them reads as an ordinary price with nothing pending.
    const { body } = await get(`/providers/${CLINIC}/services`);
    expect(body.services[0].upcomingPrice).toBeNull();
    expect(body.services[0].upcomingFrom).toBeNull();
  });
});

describe('GET /services filters and sorting (#239, #240)', () => {
  const SORT_CLINIC = `G${'E'.repeat(55)}`;
  const BIG_CLINIC = `G${'F'.repeat(55)}`;

  async function seedCatalogueClinic(
    address: string,
    name: string,
    services: { id: string; code: number; label: string; price: string }[],
  ) {
    await prisma.provider.create({
      data: {
        address,
        name,
        country: 'ZZ',
        status: 'Active',
        registeredAt: new Date('2026-01-01T00:00:00Z'),
        services: { create: services },
      },
    });
  }

  it('searches labels case-insensitively', async () => {
    const lower = await get('/services?q=malaria');
    expect(lower.status).toBe(200);
    expect(lower.body.services.map((s: { code: number }) => s.code)).toEqual([202]);
    expect(lower.body.services[0].labels).toEqual(['Malaria rapid test']);

    const upper = await get('/services?q=MALARIA');
    expect(upper.body.services.map((s: { code: number }) => s.code)).toEqual([202]);

    const none = await get('/services?q=no-such-service&count=true');
    expect(none.body.total).toBe(0);
  });

  it('compares prices exactly above 2^53', async () => {
    await seedCatalogueClinic(BIG_CLINIC, 'Precision Clinic', [
      {
        id: `${BIG_CLINIC}:901`,
        code: 901,
        label: 'Precision procedure one',
        price: '9007199254740993', // 2^53 + 1
      },
      {
        id: `${BIG_CLINIC}:902`,
        code: 902,
        label: 'Precision procedure two',
        price: '9007199254740992', // 2^53
      },
    ]);

    const atOrAbove = await get('/services?q=precision&minPrice=9007199254740993');
    expect(atOrAbove.body.services.map((s: { code: number }) => s.code)).toEqual([901]);

    // A float parse would round 2^53+1 down to 2^53 and include both.
    const atOrBelow = await get('/services?q=precision&maxPrice=9007199254740992');
    expect(atOrBelow.body.services.map((s: { code: number }) => s.code)).toEqual([902]);

    const between = await get(
      '/services?q=precision&minPrice=9007199254740992&maxPrice=9007199254740993',
    );
    expect(between.body.services.map((s: { code: number }) => s.code)).toEqual([901, 902]);
  });

  it('filters by price range without losing the rest of the catalogue', async () => {
    // 202 costs 10,000,000–15,000,000, so a 16,000,000 budget covers it while
    // 101 (30,000,000–40,000,000) is out of range.
    const { body } = await get('/services?minPrice=12000000&maxPrice=16000000&count=true');
    expect(body.services.map((s: { code: number }) => s.code)).toEqual([202]);
    expect(body.total).toBe(1);
  });

  it('sorts by price numerically, not by the string', async () => {
    await seedCatalogueClinic(SORT_CLINIC, 'Sorting Clinic', [
      { id: `${SORT_CLINIC}:811`, code: 811, label: 'Sorting nine', price: '9' },
      { id: `${SORT_CLINIC}:812`, code: 812, label: 'Sorting ten', price: '10' },
      { id: `${SORT_CLINIC}:813`, code: 813, label: 'Sorting hundred', price: '100' },
    ]);

    const ascending = await get('/services?q=sorting&sort=price');
    expect(ascending.body.services.map((s: { minPrice: string }) => s.minPrice)).toEqual([
      '9',
      '10',
      '100',
    ]);

    const descending = await get('/services?q=sorting&sort=price&order=desc');
    expect(descending.body.services.map((s: { minPrice: string }) => s.minPrice)).toEqual([
      '100',
      '10',
      '9',
    ]);
  });

  it('sorts by label and code, in both directions', async () => {
    await seedCatalogueClinic(SORT_CLINIC, 'Sorting Clinic', [
      { id: `${SORT_CLINIC}:811`, code: 811, label: 'Sorting nine', price: '9' },
      { id: `${SORT_CLINIC}:812`, code: 812, label: 'Sorting ten', price: '10' },
      { id: `${SORT_CLINIC}:813`, code: 813, label: 'Sorting hundred', price: '100' },
    ]);

    const labels = await get('/services?q=sorting&sort=label');
    expect(labels.body.services.map((s: { labels: string[] }) => s.labels[0])).toEqual([
      'Sorting hundred',
      'Sorting nine',
      'Sorting ten',
    ]);

    const codes = await get('/services?q=sorting&sort=code&order=desc');
    expect(codes.body.services.map((s: { code: number }) => s.code)).toEqual([813, 812, 811]);
  });

  it('rejects malformed search and price parameters', async () => {
    for (const query of [
      'q=',
      `q=${'a'.repeat(65)}`,
      'minPrice=abc',
      'maxPrice=-1',
      'minPrice=1000000000000000000000000000000000000000',
      'minPrice=10&maxPrice=9',
      'sort=name',
      'order=sideways',
    ]) {
      const { status, body } = await get(`/services?${query}`);
      expect(status, query).toBe(400);
      expect(body.error).toBe('invalid_query');
    }
  });
});

describe('response hardening', () => {
  it('sends the standard security headers, without a CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['strict-transport-security']).toContain('max-age=');
    expect(res.headers['content-security-policy']).toBeUndefined();
  });

  it('gzip-compresses responses above the threshold when asked', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/vouchers?funder=${FUNDER}&count=true`,
      headers: {
        'accept-encoding': 'gzip',
        'x-forwarded-for': nextTestClientIp(),
      },
    });
    expect(res.headers['content-encoding']).toBe('gzip');
    const body = JSON.parse(gunzipSync(res.rawPayload).toString('utf8'));
    expect(body.total).toBe(5);
  });

  it('leaves responses below the threshold uncompressed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('rate limits list routes but leaves health free', async () => {
    const isolated = await buildApp({ logger: false });
    try {
      for (let i = 0; i < LIST_ROUTE_RATE_LIMIT.max; i++) {
        const res = await isolated.inject({
          method: 'GET',
          url: `/vouchers?funder=${FUNDER}`,
        });
        expect(res.statusCode).toBe(200);
      }

      const blocked = await isolated.inject({
        method: 'GET',
        url: `/vouchers?funder=${FUNDER}`,
      });
      expect(blocked.statusCode).toBe(429);

      const health = await isolated.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(200);
    } finally {
      await isolated.close();
    }
  });
});

describe('HTTP caching', () => {
  /** A request from a fresh client so the list-route rate limit never bites. */
  async function cached(url: string, headers: Record<string, string> = {}) {
    return app.inject({
      method: 'GET',
      url,
      headers: { 'x-forwarded-for': nextTestClientIp(), ...headers },
    });
  }

  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: 500 },
      update: {
        lastLedger: 500,
        leaseOwner: null,
        leaseExpiresAt: null,
        gap: false,
        gapOldestLedger: null,
        gapCursorLedger: null,
      },
    });
  });

  it('marks list and detail responses reusable and tags them with an ETag', async () => {
    for (const url of ['/providers', `/providers/${CLINIC}`, `/vouchers?funder=${FUNDER}`]) {
      const res = await cached(url);
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=30');
      expect(res.headers['etag']).toMatch(/^W\/"500-[A-Za-z0-9_-]+"$/);
    }
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const first = await cached('/providers');
    expect(first.statusCode).toBe(200);
    const etag = first.headers['etag'] as string;

    const second = await cached('/providers', { 'if-none-match': etag });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe('');
    expect(second.headers['etag']).toBe(etag);
  });

  it('accepts a weak or list-valued If-None-Match', async () => {
    const first = await cached('/providers');
    const etag = first.headers['etag'] as string;

    expect((await cached('/providers', { 'if-none-match': '*' })).statusCode).toBe(304);
    expect((await cached('/providers', { 'if-none-match': `"other", ${etag}` })).statusCode).toBe(
      304,
    );
    // Weak comparison: the strong form of the same tag also validates.
    expect(
      (await cached('/providers', { 'if-none-match': etag.replace(/^W\//, '') })).statusCode,
    ).toBe(304);
  });

  it('invalidates the tag when a new ledger is indexed', async () => {
    const first = await cached('/providers');
    const etag = first.headers['etag'] as string;

    await prisma.indexerState.update({ where: { id: 1 }, data: { lastLedger: 501 } });

    const revalidated = await cached('/providers', { 'if-none-match': etag });
    expect(revalidated.statusCode).toBe(200);
    expect(revalidated.headers['etag']).not.toBe(etag);
  });

  it('treats each path and query as its own resource', async () => {
    const list = await cached('/providers');
    const listEtag = list.headers['etag'] as string;

    const filtered = await cached('/providers?status=Active', { 'if-none-match': listEtag });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.headers['etag']).not.toBe(listEtag);

    const detail = await cached(`/providers/${CLINIC}`, { 'if-none-match': listEtag });
    expect(detail.statusCode).toBe(200);

    // The /v1 alias serves the same body but is a different URL, so a tag
    // from one path must not validate the other.
    const versioned = await cached('/v1/providers', { 'if-none-match': listEtag });
    expect(versioned.statusCode).toBe(200);
  });

  it('never caches health or readiness, on either path', async () => {
    vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 500 } as never);

    for (const url of ['/health', '/v1/health', '/ready', '/v1/ready']) {
      const res = await cached(url);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['etag']).toBeUndefined();
    }
  });

  it('never caches an error response', async () => {
    const res = await cached(`/providers/${FUNDER}`);
    expect(res.statusCode).toBe(404);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['etag']).toBeUndefined();
  });

  it('does not serve 304 without a matching validator', async () => {
    const res = await cached('/providers', { 'if-none-match': 'W/"123-not-ours"' });
    expect(res.statusCode).toBe(200);
  });
});

describe('Stellar address validation (#171)', () => {
  // FUNDER with its last character changed: still 56 base32 characters,
  // but the strkey checksum no longer matches.
  const corrupted = FUNDER.slice(0, -1) + (FUNDER.endsWith('A') ? 'B' : 'A');

  it('rejects an address with a bad checksum on every filter that takes one', async () => {
    for (const url of [
      `/vouchers?funder=${corrupted}`,
      `/vouchers?provider=${corrupted}`,
      `/vouchers/due?funder=${corrupted}&within=72h`,
      `/receipts?provider=${corrupted}`,
    ]) {
      const { status, body } = await get(url);
      expect(status, url).toBe(400);
      expect(body.error, url).toBe('invalid_query');
      expect(JSON.stringify(body.details), url).toContain(
        'must be a valid Stellar account address',
      );
    }
    expect((await getCsv(`/vouchers.csv?funder=${corrupted}`)).status).toBe(400);
  });

  it('still accepts a valid address', async () => {
    expect((await get(`/vouchers?funder=${FUNDER}`)).status).toBe(200);
  });
});

describe('query parameter length limits', () => {
  it('rejects an over-long q parameter in /providers', async () => {
    const longQ = 'a'.repeat(65);
    const { status, body } = await get(`/providers?q=${longQ}`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('rejects an over-long cursor parameter in /providers', async () => {
    const longCursor = 'c'.repeat(257);
    const { status, body } = await get(`/providers?cursor=${longCursor}`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('rejects an over-long minAmount in /vouchers', async () => {
    const longAmount = '1'.repeat(65);
    const { status, body } = await get(`/vouchers?funder=${FUNDER}&minAmount=${longAmount}`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('rejects an over-long status parameter in /vouchers', async () => {
    const longStatus = 'Funded,' + 'a'.repeat(260);
    const { status, body } = await get(`/vouchers?funder=${FUNDER}&status=${longStatus}`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('rejects an over-long within parameter in /vouchers/due', async () => {
    const longWithin = '1'.repeat(20) + 'h';
    const { status, body } = await get(`/vouchers/due?funder=${FUNDER}&within=${longWithin}`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });

  it('rejects an over-long beneficiaryRef in /receipts', async () => {
    const longRef = 'a'.repeat(65);
    const { status, body } = await get(`/receipts?beneficiaryRef=${longRef}`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_query');
  });
});

describe('GET /stats/services', () => {
  it('ranks service codes by settled value, highest first', async () => {
    const { status, body } = await get('/stats/services');
    expect(status).toBe(200);
    expect(Array.isArray(body.services)).toBe(true);
    const values = body.services.map((s: { value: string }) => BigInt(s.value));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i - 1]! >= values[i]!).toBe(true);
    }
  });

  it('reports count and value per service code and label', async () => {
    const { body } = await get('/stats/services?limit=2');
    expect(body.services.length).toBeLessThanOrEqual(2);
    for (const s of body.services) {
      expect(s).toHaveProperty('serviceCode');
      expect(s).toHaveProperty('label');
      expect(s).toHaveProperty('count');
      expect(s).toHaveProperty('value');
    }
  });
});

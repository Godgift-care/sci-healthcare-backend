import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { CONTRACTS, env } from '../env.js';
import { CLAIM_GRACE_MS } from '../lib/lifecycle.js';
import { server } from '../stellar/client.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const SECOND_CLINIC = 'GCMDQZBBTZBR3ZDPCEFSDNNWVQFA44VHOJHR2JZTL7CHJHZ3N2LQDW3B';
const PENDING_CLINIC = 'GBWBYKGC5OCRELVP5WHAKEMBSZMNUY3HOKVSYBQGLFNWWQHNH2SD53FZ';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const ADMIN = 'A'.repeat(56);
const NEW_ADMIN = 'B'.repeat(56);
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const OTHER_REF = 'a'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const REGISTRY = CONTRACTS.find((c) => c.contract === 'registry')!.contractId;
const VOUCHER = CONTRACTS.find((c) => c.contract === 'voucher')!.contractId;

let app: FastifyInstance;

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
}

async function getCsv(url: string) {
  const res = await app.inject({ method: 'GET', url });
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
          { id: `${SECOND_CLINIC}:101`, code: 101, label: 'General consultation', price: '40000000' },
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
      // Attested with the dispute window closed: settleable.
      {
        ...base,
        id: '4',
        serviceCode: 101,
        amount: '30000000',
        status: 'Attested',
        createdAt: new Date(now - 5 * DAY),
        expiresAt: new Date(now + 25 * DAY),
        disputeDeadline: new Date(now - 60_000),
      },
      // Disputed, for someone else, with a reason.
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
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.governanceEvent.deleteMany();
  await prisma.providerStatusChange.deleteMany();
  await prisma.servicePriceChange.deleteMany();
  await seed();
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
      receipts: 2,
    });
  });
});

describe('GET /ready', () => {
  afterEach(() => vi.restoreAllMocks());

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
    });
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
});

describe('GET /providers', () => {
  it('filters by status and lists only active services', async () => {
    const { body } = await get('/providers?status=Active');
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

describe('GET /providers/:address/stats', () => {
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

  it('404s an unknown provider', async () => {
    const { status, body } = await get(`/providers/${FUNDER}/stats`);
    expect(status).toBe(404);
    expect(body.error).toBe('provider_not_found');
  });
});

describe('GET /stats/daily', () => {
  const sum = (body: { series: Array<Record<string, { count: number; amount: string }>> }, key: string) =>
    body.series.reduce(
      (acc, row) => {
        const bucket = row[key]!;
        return { count: acc.count + bucket.count, amount: (BigInt(acc.amount) + BigInt(bucket.amount)).toString() };
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
      expect(Date.parse(`${dates[i]}T00:00:00Z`) - Date.parse(`${dates[i - 1]}T00:00:00Z`)).toBe(DAY);
    }
    expect(dates[dates.length - 1]).toBe(new Date().toISOString().slice(0, 10));

    // Days with nothing on them are present and zeroed, so charts need no gaps filled.
    const empty = body.series.find(
      (r: { funded: { count: number } }) => r.funded.count === 0,
    );
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
    const { body } = await get(`/vouchers?funder=${FUNDER}&limit=2`);
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

    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=amount&order=asc`);
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
    const { body } = await get(`/vouchers?funder=${FUNDER}&sort=amount&order=asc&limit=2&offset=1`);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['1', '4']);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.total).toBe(5);
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
    const tricky = 'G'.repeat(56);
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
});

describe('GET /receipts', () => {
  it('returns care history and total spend for one beneficiary', async () => {
    const { body } = await get(`/receipts?beneficiaryRef=${REF}`);
    expect(body.total).toBe(2);
    expect(body.totalSpend).toBe('40000000');
    expect(body.totalSpendDisplay).toBe('4.0000000');
    expect(body.receipts.map((r: { voucherId: string }) => r.voucherId)).toEqual(['9', '1']);
    expect(body.receipts[0].serviceLabel).toBe('Malaria rapid test');
  });

  it('returns nothing for a reference with no receipts', async () => {
    const { body } = await get(`/receipts?beneficiaryRef=${OTHER_REF}`);
    expect(body).toMatchObject({ total: 0, totalSpend: '0', receipts: [] });
  });

  it('requires a beneficiary reference', async () => {
    const { status } = await get('/receipts');
    expect(status).toBe(400);
  });

  it('lists receipts by provider, omitting beneficiaryRef', async () => {
    const { body } = await get(`/receipts?provider=${CLINIC}`);
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

    const { status: s2, body: b2 } = await get(`/receipts?beneficiaryRef=${REF}&provider=${CLINIC}`);
    expect(s2).toBe(400);
    expect(b2.error).toBe('invalid_query');
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

  it('404s for an unknown voucher', async () => {
    const { status, body } = await get('/receipts/999');
    expect(status).toBe(404);
    expect(body.error).toBe('receipt_not_found');
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
    expect(body.history.map((h: { price: string }) => h.price)).toEqual([
      '30000000',
      '35000000',
    ]);
    expect(body.history[0].priceDisplay).toBe('3.0000000');
  });

  it('rejects a non-numeric service code', async () => {
    const { status, body } = await get(`/providers/${CLINIC}/services/abc/history`);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_code');
  });
});

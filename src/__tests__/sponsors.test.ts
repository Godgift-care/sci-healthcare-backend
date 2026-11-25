import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { prisma, queryStats } from '../db.js';
import { feeFor } from '../lib/amounts.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const SPONSOR_A = 'GDFEKR6EXP5WZERLLVT7FE5ZT7W7VRMG63ZBW2DXIXYNXISXJBSXEMWO';
const SPONSOR_B = 'GCSMG45VZYIB7UEYBHPRAUIAFB7AVCCUET33EC74Y6CSRFANXC47PP2A';
const OUTSIDER = 'GBN3U6C2NDHCNA33TKKGRGOQ3VFZQCNZTQOTAHQ6DSYAOTGCWSMYAXEU';
/** Valid addresses, only ever used as keys — enough rows to size a page. */
const EXTRA_SPONSORS = [
  'GCAGMNYXNSPAVKKJ26X5454NSXDWPB76R5JZWS4LQSEK5NHOVZ5VHFBL',
  'GAKTY3B4VKYOEWU34ONFQ4MV7P6MT26ESAXBKYZSFK6ELWKMXWZ4RSZD',
  'GAB4DBSKFSFIWF6GLHUD7OPTLALEJ36IGANX3ZFCN25CUIKYURRKLVRQ',
  'GDHPO7FRQE6VZBK4ZSPUTM45AQS6KHYCYZ7DRJJF7LSY3NKYK33KBFAN',
  'GBKWLJB6MIPKB3JQOKSSHIRZN2OVNMYJSYQ3JD53V5VMZWQSGEKXQCK7',
];
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const DAY = 24 * 60 * 60 * 1000;

/**
 * The matching-funding desk read model (#317).
 *
 * The projections themselves are in `indexer-projections.test.ts`; this is the
 * other half: what the two new routes answer, and what a voucher page says
 * about the sponsor that matched it. The rows are written directly rather than
 * through the indexer so the route is tested against states the event order
 * cannot produce on its own — a sponsor with a match but no budget movement,
 * which is what a start-ledger gap looks like.
 */

let app: FastifyInstance;
let testClientId = 2000;

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
        ],
      },
    },
  });

  const now = Date.now();
  await prisma.voucher.createMany({
    data: [
      {
        id: '1',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '30000000',
        status: 'Settled',
        createdAt: new Date(now - 10 * DAY),
        expiresAt: new Date(now + 20 * DAY),
      },
      {
        // Never matched, and still open, so the due route carries it too.
        id: '7',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '1000000',
        status: 'Claimed',
        claimedAt: new Date(now - DAY),
        createdAt: new Date(now - 3 * DAY),
        expiresAt: new Date(now + 4 * DAY),
      },
    ],
  });

  await prisma.sponsor.createMany({
    data: [
      {
        address: SPONSOR_A,
        available: '75000000',
        matchBps: 20000,
        capPerVoucher: '6000000',
        minVoucherAmount: '1000000',
        minVoucherAgeSecs: '3600',
        rulesAt: new Date('2026-10-01T02:00:00Z'),
        lastMovementAt: new Date('2026-10-01T03:00:00Z'),
        firstSeenAt: new Date('2026-10-01T01:00:00Z'),
      },
      {
        // Terms and budget not yet indexed: every derived field must stay null
        // rather than reading as a sponsor that matches nothing.
        address: SPONSOR_B,
        available: null,
        firstSeenAt: new Date('2026-10-02T01:00:00Z'),
      },
    ],
  });

  await prisma.sponsorBudgetEvent.createMany({
    data: [
      {
        id: 'budget_deposited-10',
        sponsorAddress: SPONSOR_A,
        kind: 'Deposited',
        amount: '100000000',
        available: '100000000',
        ledger: 10,
        occurredAt: new Date('2026-10-01T02:30:00Z'),
      },
      {
        id: 'budget_withdrawn-11',
        sponsorAddress: SPONSOR_A,
        kind: 'Withdrawn',
        amount: '25000000',
        available: '75000000',
        ledger: 11,
        occurredAt: new Date('2026-10-01T03:00:00Z'),
      },
    ],
  });

  await prisma.sponsorMatch.createMany({
    data: [
      {
        matchedVoucherId: '2',
        originalVoucherId: '1',
        sponsorAddress: SPONSOR_A,
        providerAddress: CLINIC,
        serviceCode: 101,
        // 30000000 at 20000 bps would be 60000000; the 6000000 cap binds.
        amount: '6000000',
        status: 'Settled',
        matchedAt: new Date('2026-10-01T04:00:00Z'),
        settledAt: new Date('2026-10-02T04:00:00Z'),
      },
      {
        matchedVoucherId: '4',
        originalVoucherId: '3',
        sponsorAddress: SPONSOR_A,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '1500000',
        status: 'Open',
        matchedAt: new Date('2026-10-01T05:00:00Z'),
      },
      {
        matchedVoucherId: '6',
        originalVoucherId: '5',
        sponsorAddress: SPONSOR_A,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '2000000',
        status: 'Refunded',
        matchedAt: new Date('2026-10-01T06:00:00Z'),
        refundedAt: new Date('2026-10-03T06:00:00Z'),
      },
    ],
  });
}

async function clear() {
  await prisma.sponsorMatch.deleteMany();
  await prisma.sponsorBudgetEvent.deleteMany();
  await prisma.sponsor.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
}, 30_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clear();
  await seed();
});

describe('GET /sponsors', () => {
  it('lists every sponsor, most recently seen first, with its totals', async () => {
    const { status, body } = await get('/sponsors');
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.sponsors.map((s: { address: string }) => s.address)).toEqual([
      SPONSOR_B,
      SPONSOR_A,
    ]);

    const [b, a] = body.sponsors;
    expect(a).toMatchObject({
      address: SPONSOR_A,
      available: '75000000',
      availableDisplay: '7.5000000',
      matchBps: 20000,
      capPerVoucher: '6000000',
      minVoucherAgeSecs: '3600',
      deposited: '100000000',
      withdrawn: '25000000',
      matchCount: 3,
      openMatchCount: 1,
      settledMatchCount: 1,
      refundedMatchCount: 1,
      matchedAmount: '9500000',
      settledMatchedAmount: '6000000',
      refundedMatchedAmount: '2000000',
    });
    expect(a.availableAsOf).toBe('2026-10-01T03:00:00.000Z');
    expect(a.rulesAt).toBe('2026-10-01T02:00:00.000Z');
    expect(b).toMatchObject({
      address: SPONSOR_B,
      available: null,
      availableDisplay: null,
      matchBps: null,
      deposited: '0',
      withdrawn: '0',
      matchCount: 0,
      matchedAmount: '0',
    });
  });

  it('answers an empty directory when no sponsor contract is indexed', async () => {
    // The AC is "with SPONSOR_CONTRACT_ID unset nothing changes": the routes
    // exist and report nothing, which is true, rather than 503-ing.
    await prisma.sponsor.deleteMany();

    const { status, body } = await get('/sponsors');
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 0, sponsors: [] });
  });

  it('projects onto the requested fields', async () => {
    const { status, body } = await get(`/sponsors?fields=address,matchCount,matchedAmount`);
    expect(status).toBe(200);
    expect(body.sponsors).toEqual([
      { address: SPONSOR_B, matchCount: 0, matchedAmount: '0' },
      { address: SPONSOR_A, matchCount: 3, matchedAmount: '9500000' },
    ]);
  });

  it('rejects an unknown field with the name that failed', async () => {
    const { status, body } = await get('/sponsors?fields=address,nope');
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_fields');
    expect(body.details.unknown).toEqual(['nope']);
  });

  it('pages with a cursor that walks the whole directory once', async () => {
    const first = await get('/sponsors?limit=1');
    expect(first.body.sponsors.map((s: { address: string }) => s.address)).toEqual([SPONSOR_B]);
    expect(first.body.nextCursor).toBeTruthy();

    const second = await get(`/sponsors?limit=1&cursor=${first.body.nextCursor}`);
    expect(second.body.sponsors.map((s: { address: string }) => s.address)).toEqual([SPONSOR_A]);

    // The cursor branch says "past the end" with null, so a caller can stop
    // without re-reading the last row and guessing from a repeat.
    expect(second.body.nextCursor).toBeNull();
    expect(
      [...first.body.sponsors, ...second.body.sponsors].map((s: { address: string }) => s.address),
    ).toEqual([SPONSOR_B, SPONSOR_A]);
  });

  it('rejects a cursor that is not one', async () => {
    const { status, body } = await get('/sponsors?cursor=not-a-cursor');
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_cursor');
  });
});

describe('GET /sponsors/:address', () => {
  it('serves the same shape as the list for one sponsor', async () => {
    const { status, body } = await get(`/sponsors/${SPONSOR_A}`);
    const listed = (await get('/sponsors')).body.sponsors.find(
      (s: { address: string }) => s.address === SPONSOR_A,
    );

    expect(status).toBe(200);
    expect(body).toEqual(listed);
  });

  it('says 404 for an address the desk never saw', async () => {
    const { status, body } = await get(`/sponsors/${OUTSIDER}`);
    expect(status).toBe(404);
    expect(body.error).toBe('sponsor_not_found');
  });
});

describe('sponsor matches on the voucher routes', () => {
  it('carries the match on the voucher it funded and nulls on the ones it did not', async () => {
    const { status, body } = await get(`/vouchers?funder=${FUNDER}`);
    expect(status).toBe(200);

    const matched = body.vouchers.find((v: { id: string }) => v.id === '1');
    expect(matched).toMatchObject({
      matchedAmount: '6000000',
      matchedAmountDisplay: '0.6000000',
      matchedBy: SPONSOR_A,
      matchStatus: 'Settled',
    });
    expect(matched.matchedAt).toBe('2026-10-01T04:00:00.000Z');

    const unmatched = body.vouchers.find((v: { id: string }) => v.id === '7');
    expect(unmatched).toMatchObject({
      matchedAmount: null,
      matchedAmountDisplay: null,
      matchedBy: null,
      matchStatus: null,
      matchedAt: null,
    });
  });

  it('agrees with the sponsor route on what a match was worth', async () => {
    const voucher = (await get('/vouchers/1')).body;
    const sponsor = (await get(`/sponsors/${SPONSOR_A}`)).body;
    const rows = await prisma.sponsorMatch.findMany({
      where: { sponsorAddress: SPONSOR_A },
      orderBy: { matchedVoucherId: 'asc' },
    });

    // The AC is that matches reconcile with the voucher amounts: the figure on
    // the voucher is one of the rows summed into the sponsor's totals. Readded
    // here from the rows, because the amounts are i128s kept as text and no SQL
    // aggregate can do it — so this is the read model's own arithmetic checked
    // against its own data, not a restatement of it.
    const sum = (xs: { amount: string }[]) =>
      xs.reduce((total, m) => (BigInt(total) + BigInt(m.amount)).toString(), '0');

    expect(sponsor.matchCount).toBe(rows.length);
    expect(sponsor.matchedAmount).toBe(sum(rows));
    expect(sponsor.settledMatchedAmount).toBe(sum(rows.filter((m) => m.status === 'Settled')));
    expect(voucher.matchedAmount).toBe(rows.find((m) => m.originalVoucherId === '1')?.amount);
  });

  it('reconciles with the terms the sponsor set', async () => {
    const voucher = (await get('/vouchers/1')).body;
    const sponsor = (await get(`/sponsors/${SPONSOR_A}`)).body;

    // What the contract publishes as `amount` is the capped basis-point share
    // of the voucher, so the read model must not contradict its own rules.
    const uncapped = feeFor(voucher.amount, sponsor.matchBps);
    const capped =
      BigInt(uncapped) < BigInt(sponsor.capPerVoucher) ? uncapped : sponsor.capPerVoucher;
    expect(voucher.matchedAmount).toBe(capped);
    expect(BigInt(capped)).toBe(BigInt(sponsor.capPerVoucher));
  });

  it('answers the same object for the single-voucher route and the page', async () => {
    const detail = (await get('/vouchers/1')).body;
    const listed = (await get(`/vouchers?funder=${FUNDER}`)).body.vouchers.find(
      (v: { id: string }) => v.id === '1',
    );

    expect(detail.matchedAmount).toEqual(listed.matchedAmount);
    expect(detail.matchedBy).toEqual(listed.matchedBy);
    expect(detail.matchStatus).toEqual(listed.matchStatus);
    expect(detail.matchedAt).toEqual(listed.matchedAt);
  });

  it('joins the match on the due list too, the third serialiser', async () => {
    const { status, body } = await get(`/vouchers/due?funder=${FUNDER}&within=30d`);
    expect(status).toBe(200);
    expect(body.vouchers.map((v: { id: string }) => v.id)).toEqual(['7']);
    expect(body.vouchers[0].matchedAmount).toBeNull();
  });

  it('keeps the funded voucher of a match distinct from the original', async () => {
    // Voucher '2' is the sponsor's own voucher, indexed separately as a
    // `voucher_created` with the desk as funder. It has no match of its own.
    await prisma.voucher.create({
      data: {
        id: '2',
        funder: SPONSOR_A,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '6000000',
        status: 'Settled',
        createdAt: new Date(Date.now() - 2 * DAY),
        expiresAt: new Date(Date.now() + 20 * DAY),
      },
    });

    const { body } = await get('/vouchers/2');
    expect(body).toMatchObject({ id: '2', amount: '6000000', matchedAmount: null });
  });
});

describe('GET /sponsors query cost', () => {
  it('serves a page of sponsors in a fixed number of queries, not one per sponsor', async () => {
    // Every sponsor gets a match and a budget movement, so all seven rows take
    // the same code path and the only thing that varies between the two
    // requests is the row count. `queryStats` counts the Prisma operations the
    // route asks for (`src/db.ts`, test-only): a per-sponsor totals lookup
    // would show up here as 1 + 2 for one row against 7 + 2 for the page.
    await prisma.sponsor.createMany({
      data: EXTRA_SPONSORS.map((address, i) => ({
        address,
        available: '5000000',
        matchBps: 10000,
        capPerVoucher: '5000000',
        rulesAt: new Date(Date.UTC(2026, 9, 3)),
        lastMovementAt: new Date(Date.UTC(2026, 9, 3)),
        firstSeenAt: new Date(Date.UTC(2026, 9, 3 + i)),
      })),
    });
    await prisma.sponsorBudgetEvent.createMany({
      data: EXTRA_SPONSORS.map((address) => ({
        id: `budget_deposited-${address.slice(1, 8)}`,
        sponsorAddress: address,
        kind: 'Deposited',
        amount: '5000000',
        available: '5000000',
        ledger: 20,
        occurredAt: new Date('2026-10-03T00:00:00Z'),
      })),
    });
    await prisma.sponsorMatch.createMany({
      data: EXTRA_SPONSORS.map((address, i) => ({
        matchedVoucherId: String(100 + i),
        originalVoucherId: String(200 + i),
        sponsorAddress: address,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '1000000',
        status: 'Open',
        matchedAt: new Date('2026-10-04T00:00:00Z'),
      })),
    });

    const beforeOne = queryStats.queries;
    const one = await get('/sponsors?limit=1');
    expect(one.body.sponsors).toHaveLength(1);
    const forOneRow = queryStats.queries - beforeOne;
    expect(forOneRow).toBeGreaterThan(0);

    const beforePage = queryStats.queries;
    const page = await get('/sponsors?limit=7');
    expect(page.body.sponsors).toHaveLength(7);
    expect(queryStats.queries - beforePage).toBe(forOneRow);
  });
});

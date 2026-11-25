import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { onQuery, prisma } from '../db.js';
import { parseFields, applyFields, columnSelect, includesField } from '../lib/fields.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const SPONSOR = 'GDFEKR6EXP5WZERLLVT7FE5ZT7W7VRMG63ZBW2DXIXYNXISXJBSXEMWO';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let testClientId = 1000;

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
  await prisma.voucher.create({
    data: {
      id: '1',
      funder: FUNDER,
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      status: 'Settled',
      createdAt: new Date(now - 10 * DAY),
      expiresAt: new Date(now + 20 * DAY),
      settledNet: '29700000',
      settledFee: '300000',
    },
  });
  await prisma.receipt.create({
    data: {
      voucherId: '1',
      providerAddress: CLINIC,
      beneficiaryRef: REF,
      serviceCode: 101,
      amount: '30000000',
      settledAt: new Date(now - 5 * DAY),
    },
  });
}

/** The sponsor half of voucher 1's funding: 6000000 matched against 30000000. */
async function seedMatch() {
  await prisma.sponsorMatch.create({
    data: {
      matchedVoucherId: '2',
      originalVoucherId: '1',
      sponsorAddress: SPONSOR,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '6000000',
      status: 'Settled',
      matchedAt: new Date('2026-10-01T04:00:00Z'),
    },
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
  await prisma.sponsorMatch.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await seed();
});

describe('parseFields / applyFields', () => {
  it('returns null when fields is omitted', () => {
    expect(parseFields(undefined, ['a'], 'GET /x')).toBeNull();
  });

  it('returns null for a blank value', () => {
    expect(parseFields('  ', ['a'], 'GET /x')).toBeNull();
  });

  it('dedupes repeated fields', () => {
    expect(parseFields('id,id,status', ['id', 'status'], 'GET /x')).toEqual(['id', 'status']);
  });

  it('throws 400 naming the unknown fields', () => {
    try {
      parseFields('id,nope,alsono', ['id'], 'GET /x');
      expect.unreachable();
    } catch (err) {
      const apiErr = err as { statusCode: number; code: string; details: { unknown: string[] } };
      expect(apiErr.statusCode).toBe(400);
      expect(apiErr.code).toBe('unknown_fields');
      expect(apiErr.details.unknown).toEqual(['nope', 'alsono']);
    }
  });

  it('projects onto the requested keys', () => {
    expect(applyFields({ a: 1, b: 2 }, ['a'])).toEqual({ a: 1 });
  });
});

describe('columnSelect / includesField', () => {
  it('maps a derived field onto the columns it is built from', () => {
    expect(
      columnSelect(['id', 'provider'], ['id', 'provider'], ['id'], {
        provider: ['providerAddress'],
      }),
    ).toEqual({ id: true, providerAddress: true });
  });

  it('reads every column when the client asked for nothing', () => {
    expect(columnSelect(null, ['id', 'funder'], ['id'])).toEqual({ id: true, funder: true });
  });

  it('treats a field with no derived entry as a column of its own name', () => {
    expect(columnSelect(['status'], ['status', 'funder'], [])).toEqual({ status: true });
  });

  it('never drops a column the cursor needs', () => {
    expect(columnSelect([], ['id'], ['id', 'createdAt'])).toEqual({ id: true, createdAt: true });
  });

  it('skips a field that is a separate read, not a column', () => {
    expect(columnSelect(['receipt'], ['id', 'receipt'], ['id'], { receipt: [] })).toEqual({
      id: true,
    });
  });

  it('asks for a related read only when the field naming it is in play', () => {
    expect(includesField(['id'], 'provider')).toBe(false);
    expect(includesField(['id', 'provider'], 'provider')).toBe(true);
    expect(includesField(null, 'provider')).toBe(true);
  });
});

describe('GET /vouchers sparse fieldsets (#166)', () => {
  const base = `/vouchers?funder=${FUNDER}`;

  it('returns the full row when fields is omitted', async () => {
    const { status, body } = await get(base);
    expect(status).toBe(200);
    const v = body.vouchers[0];
    expect(v.id).toBe('1');
    expect(v.status).toBe('Settled');
    expect(v.amount).toBe('30000000');
    expect(v.provider.address).toBe(CLINIC);
  });

  it('returns only the requested fields', async () => {
    const { status, body } = await get(`${base}&fields=id,status,amount`);
    expect(status).toBe(200);
    expect(body.vouchers[0]).toEqual({ id: '1', status: 'Settled', amount: '30000000' });
  });

  it('keeps nested objects whole', async () => {
    const { status, body } = await get(`${base}&fields=id,provider`);
    expect(status).toBe(200);
    expect(body.vouchers[0]).toEqual({
      id: '1',
      provider: { address: CLINIC, name: 'Ikeja General Clinic', country: 'NG' },
    });
  });

  it('rejects unknown fields with 400', async () => {
    const { status, body } = await get(`${base}&fields=id,bogus`);
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_fields');
    expect(body.details.unknown).toEqual(['bogus']);
  });

  it('still paginates metadata alongside sparse rows', async () => {
    const { status, body } = await get(`${base}&fields=id&limit=10&count=true`);
    expect(status).toBe(200);
    expect(body.total).toBe(1);
    expect(body.vouchers[0]).toEqual({ id: '1' });
  });

  it('accepts claimedWithProof and sends null when it was never read (#318)', async () => {
    const { status, body } = await get(`${base}&fields=id,claimedWithProof`);
    expect(status).toBe(200);
    expect(body.vouchers[0]).toEqual({ id: '1', claimedWithProof: null });
  });

  it('reads claimedWithProof back from the row, not a constant', async () => {
    await prisma.voucher.update({ where: { id: '1' }, data: { claimedWithProof: true } });

    const { body } = await get(`${base}&fields=id,claimedWithProof`);
    expect(body.vouchers[0]).toEqual({ id: '1', claimedWithProof: true });
  });

  it('serves the sponsor match keys on their own (#317)', async () => {
    // A caller that only wants who funded the top-up must be able to ask for
    // it: the match keys are in the allow-list, so `fields=` is not a reason
    // to lose them, and the lookup is the same one the full row uses.
    await seedMatch();

    const { status, body } = await get(`${base}&fields=id,matchedAmount,matchedBy,matchStatus`);
    expect(status).toBe(200);
    expect(body.vouchers[0]).toEqual({
      id: '1',
      matchedAmount: '6000000',
      matchedBy: SPONSOR,
      matchStatus: 'Settled',
    });
  });

  it('keeps a matched voucher and an unmatched one distinct under fields=', async () => {
    // Both rows are projected onto the same key set, so the only way to tell
    // "nobody matched this" from "a sponsor matched nothing" is the null.
    await seedMatch();
    await prisma.voucher.create({
      data: {
        id: '3',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '1000000',
        status: 'Active',
        createdAt: new Date(Date.now() - DAY),
        expiresAt: new Date(Date.now() + 20 * DAY),
      },
    });

    const { body } = await get(`${base}&fields=id,matchedAmount&limit=2`);
    expect(body.vouchers).toEqual([
      { id: '3', matchedAmount: null },
      { id: '1', matchedAmount: '6000000' },
    ]);
  });
});

describe('GET /providers sparse fieldsets (#166)', () => {
  it('returns only the requested fields', async () => {
    const { status, body } = await get('/providers?fields=address,name');
    expect(status).toBe(200);
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toEqual({ address: CLINIC, name: 'Ikeja General Clinic' });
  });

  it('returns the full row when fields is omitted', async () => {
    const { status, body } = await get('/providers');
    expect(status).toBe(200);
    const p = body.providers[0];
    expect(p.address).toBe(CLINIC);
    expect(p.services).toHaveLength(1);
  });

  it('rejects unknown fields with 400', async () => {
    const { status, body } = await get('/providers?fields=address,nope');
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_fields');
  });
});

describe('GET /receipts sparse fieldsets (#166)', () => {
  const patient = `/receipts?beneficiaryRef=${REF}`;

  it('returns only the requested fields on the patient view', async () => {
    const { status, body } = await get(`${patient}&fields=voucherId,amount`);
    expect(status).toBe(200);
    expect(body.receipts[0]).toEqual({ voucherId: '1', amount: '30000000' });
  });

  it('returns the full row when fields is omitted', async () => {
    const { status, body } = await get(patient);
    expect(status).toBe(200);
    const r = body.receipts[0];
    expect(r.voucherId).toBe('1');
    expect(r.beneficiaryRef).toBe(REF);
  });

  it('never leaks beneficiaryRef to the provider view', async () => {
    const { status, body } = await get(
      `/receipts?provider=${CLINIC}&fields=voucherId,beneficiaryRef`,
    );
    expect(status).toBe(200);
    expect(body.receipts[0]).toEqual({ voucherId: '1' });
  });

  it('rejects unknown fields with 400', async () => {
    const { status, body } = await get(`${patient}&fields=voucherId,nope`);
    expect(status).toBe(400);
    expect(body.error).toBe('unknown_fields');
  });
});

/**
 * #321: `?fields=` has to change the SQL, not only the JSON.
 *
 * `onQuery` collects every statement the client runs, so these tests read the
 * select list the database actually received. The quoting is stripped and the
 * schema prefix ignored because the two CI test jobs disagree about both:
 * SQLite names things `` `main`.`Voucher`.`id` `` and Postgres
 * `"public"."Voucher"."id" AS "public"."Voucher"."id"`.
 */
function statementsFor(table: string): string[] {
  const fromTable = new RegExp(`\\bFROM\\s+(?:\\w+\\.)?${table}\\b`);
  return statements
    .map((raw) => raw.replace(/[`"]/g, ''))
    .filter((sql) => fromTable.test(sql) && !sql.startsWith('SELECT COUNT'));
}

/** The columns one SELECT list names, without their table prefix or alias. */
function columnsOfSelect(sql: string): string[] {
  const list = sql.slice(sql.indexOf('SELECT ') + 'SELECT '.length, sql.indexOf(' FROM '));
  return list
    .split(',')
    .map((entry) => entry.trim().split(/\s+AS\s+/i)[0] as string)
    .map((entry) => entry.slice(entry.lastIndexOf('.') + 1))
    .filter((column) => column.length > 0);
}

/** The columns the page query (the one that orders) reads from `table`. */
function pageColumns(table: string): Set<string> {
  const pages = statementsFor(table).filter((sql) => sql.includes(' ORDER BY '));
  expect(pages, `expected one page query on ${table}`).toHaveLength(1);
  return new Set(columnsOfSelect(pages[0] as string));
}

/** Every column any statement in the request read from `table`. */
function columnsRead(table: string): Set<string> {
  return new Set(statementsFor(table).flatMap(columnsOfSelect));
}

function readsTable(table: string): boolean {
  return statementsFor(table).length > 0;
}

let statements: string[] = [];
let stopListening: () => void;

describe('the SQL a sparse page generates (#321)', () => {
  beforeAll(() => {
    stopListening = onQuery((sql) => statements.push(sql));
  });

  afterAll(() => {
    stopListening();
  });

  beforeEach(() => {
    statements = [];
  });

  it('names only the columns the voucher page was asked for', async () => {
    const { status } = await get(`/vouchers?funder=${FUNDER}&fields=id,status`);
    expect(status).toBe(200);
    // The cursor (`createdAt`, and `id` as its tie-break) and the amount and
    // timing columns the serialiser reads before it knows what was asked for
    // stay; a requested field the row does not already carry does not.
    expect([...pageColumns('Voucher')].sort()).toEqual(
      [
        'id',
        'createdAt',
        'amount',
        'status',
        'expiresAt',
        'disputeDeadline',
        'providerAddress',
        'serviceCode',
      ].sort(),
    );
    for (const column of [
      'funder',
      'beneficiaryRef',
      'claimedAt',
      // The presence-proof flag (#318): a column like any other, so a page
      // that did not ask for it does not read it.
      'claimedWithProof',
      'attestedAt',
      'settledNet',
      'settledFee',
      'disputeReason',
      // The funding-time options (#319): a response field like any other, so
      // a page that did not ask for them does not read their columns.
      'disputeWindowSecs',
      'presenceCommitment',
      // Columns no response field can ever ask for.
      'seq',
      'amountKey',
      'refundedAt',
      'updatedAt',
      'deploymentId',
    ]) {
      expect(pageColumns('Voucher').has(column), column).toBe(false);
    }
  });

  it('still reads only what the response is built from when nothing is asked for', async () => {
    const { status } = await get(`/vouchers?funder=${FUNDER}`);
    expect(status).toBe(200);
    expect([...pageColumns('Voucher')].sort()).toEqual(
      [
        'id',
        'createdAt',
        'amount',
        'status',
        'expiresAt',
        'disputeDeadline',
        'providerAddress',
        'serviceCode',
        'funder',
        'beneficiaryRef',
        'claimedAt',
        'claimedWithProof',
        'attestedAt',
        'attestedBy',
        'disputeReason',
        'disputeWindowSecs',
        'presenceCommitment',
        'disputeResolvedAt',
        'disputeResolvedBy',
        'disputeOutcome',
        'settledNet',
        'settledFee',
      ].sort(),
    );
  });

  it('reads the clinic row only when the response carries it', async () => {
    await get(`/vouchers?funder=${FUNDER}&fields=id,status`);
    expect(readsTable('Provider'), 'provider summary').toBe(false);
    expect(readsTable('Service'), 'service label').toBe(false);

    statements = [];
    await get(`/vouchers?funder=${FUNDER}&fields=id,provider`);
    expect([...columnsRead('Provider')].sort()).toEqual(['address', 'country', 'name']);
    expect(readsTable('Service'), 'service label').toBe(false);

    statements = [];
    await get(`/vouchers?funder=${FUNDER}&fields=id,serviceLabel`);
    expect([...columnsRead('Service')].sort()).toEqual(['id', 'label']);
    expect(readsTable('Provider'), 'provider summary').toBe(false);
  });

  it('skips an embed the fieldset projects away', async () => {
    await get(`/vouchers?funder=${FUNDER}&include=receipt,provider&fields=id`);
    expect(readsTable('Receipt'), 'receipt batch').toBe(false);
    expect(readsTable('Provider'), 'provider batch').toBe(false);

    statements = [];
    const { status, body } = await get(
      `/vouchers?funder=${FUNDER}&include=receipt&fields=id,receipt`,
    );
    expect(status).toBe(200);
    expect(readsTable('Receipt'), 'receipt batch').toBe(true);
    expect(body.vouchers[0]).toEqual({ id: '1', receipt: body.vouchers[0].receipt });
    expect(body.vouchers[0].receipt).not.toBeNull();
  });

  it('leaves the cached metadata document out of a directory page that did not ask for it', async () => {
    const { status } = await get('/providers?fields=address,name');
    expect(status).toBe(200);
    expect([...pageColumns('Provider')].sort()).toEqual(['address', 'name', 'registeredAt']);
    for (const column of ['metadata', 'metadataUri', 'metadataFetchedAt', 'deploymentId']) {
      expect(columnsRead('Provider').has(column), column).toBe(false);
    }
    // The price list is its own round trip, and this page cannot show it.
    expect(readsTable('Service'), 'service catalogue').toBe(false);

    statements = [];
    await get('/providers?fields=address,metadata');
    expect(pageColumns('Provider').has('metadata')).toBe(true);

    statements = [];
    await get('/providers?fields=address,services');
    expect(readsTable('Service'), 'service catalogue').toBe(true);
    expect([...columnsRead('Service')].sort()).toEqual(
      ['code', 'id', 'label', 'price', 'providerAddress', 'upcomingFrom', 'upcomingPrice'].sort(),
    );
  });

  it('never reads the beneficiary reference for a provider-view page', async () => {
    const { status } = await get(`/receipts?provider=${CLINIC}&fields=voucherId`);
    expect(status).toBe(200);
    expect([...pageColumns('Receipt')].sort()).toEqual(
      ['voucherId', 'settledAt', 'providerAddress', 'serviceCode', 'amount'].sort(),
    );
    expect(columnsRead('Receipt').has('beneficiaryRef')).toBe(false);
    expect(readsTable('Provider'), 'clinic batch').toBe(false);
    expect(readsTable('Service'), 'label batch').toBe(false);

    statements = [];
    await get(`/receipts?beneficiaryRef=${REF}&fields=amount`);
    expect(columnsRead('Receipt').has('beneficiaryRef')).toBe(false);

    statements = [];
    await get(`/receipts?beneficiaryRef=${REF}`);
    expect(pageColumns('Receipt').has('beneficiaryRef')).toBe(true);
  });

  it('narrows the cursor page the same way as the offset page', async () => {
    await prisma.voucher.create({
      data: {
        id: '2',
        funder: FUNDER,
        beneficiaryRef: REF,
        providerAddress: CLINIC,
        serviceCode: 101,
        amount: '15000000',
        status: 'Funded',
        createdAt: new Date(Date.now() - 20 * DAY),
        expiresAt: new Date(Date.now() + 20 * DAY),
      },
    });
    const first = await get(`/vouchers?funder=${FUNDER}&limit=1&fields=id,status`);
    expect(first.status).toBe(200);
    expect(first.body.nextCursor).toBeTruthy();
    expect(first.body.vouchers).toEqual([{ id: '1', status: 'Settled' }]);

    statements = [];
    const second = await get(
      `/vouchers?funder=${FUNDER}&limit=1&fields=id,status&cursor=${first.body.nextCursor}`,
    );
    expect(second.status).toBe(200);
    expect(second.body.vouchers).toEqual([{ id: '2', status: 'Funded' }]);
    expect(pageColumns('Voucher').has('beneficiaryRef')).toBe(false);
    expect(pageColumns('Voucher').has('settledNet')).toBe(false);
  });
});

/**
 * "Responses are unchanged": the projection has to be the same list the full
 * row carries, field by field, so a column the narrowed read forgot cannot
 * arrive at a client as a silently missing value.
 */
describe('every fieldable field is identical under ?fields= (#321)', () => {
  const cases = [
    { name: 'GET /vouchers', url: `/vouchers?funder=${FUNDER}`, list: 'vouchers' },
    { name: 'GET /providers', url: '/providers', list: 'providers' },
    {
      name: 'GET /receipts (patient view)',
      url: `/receipts?beneficiaryRef=${REF}`,
      list: 'receipts',
    },
    {
      name: 'GET /receipts (provider view)',
      url: `/receipts?provider=${CLINIC}`,
      list: 'receipts',
    },
  ] as const;

  for (const testCase of cases) {
    it(`${testCase.name} serves each field alone, identical to the full row`, async () => {
      const full = await get(testCase.url);
      expect(full.status).toBe(200);
      const row = full.body[testCase.list][0] as Record<string, unknown>;
      for (const field of Object.keys(row)) {
        const separator = testCase.url.includes('?') ? '&' : '?';
        const sparse = await get(`${testCase.url}${separator}fields=${field}`);
        expect(sparse.status, field).toBe(200);
        expect(sparse.body[testCase.list][0], `${testCase.name} ${field}`).toEqual({
          [field]: row[field],
        });
      }
    });
  }
});

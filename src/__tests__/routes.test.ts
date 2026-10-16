import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { CONTRACTS, env } from '../env.js';
import { CLAIM_GRACE_MS } from '../lib/lifecycle.js';
import { server } from '../stellar/client.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const PENDING_CLINIC = 'GBWBYKGC5OCRELVP5WHAKEMBSZMNUY3HOKVSYBQGLFNWWQHNH2SD53FZ';
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

async function get(url: string) {
  const res = await app.inject({ method: 'GET', url });
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
});

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
      providers: 2,
      activeProviders: 1,
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
    expect(body.total).toBe(1);
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

  it('exposes the attester and the dispute outcome in the list view', async () => {
    const { body } = await get(`/vouchers?provider=${CLINIC}`);
    const v = (id: string) => body.vouchers.find((x: { id: string }) => x.id === id);

    expect(v('4').attestedBy).toBe(ATTESTER);
    expect(v('5')).toMatchObject({ disputeOutcome: 'Provider', disputeResolvedBy: ADMIN });
    expect(v('2').attestedBy).toBeNull();
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

    const former = body.attesters.find(
      (a: { address: string }) => a.address === FORMER_ATTESTER,
    );
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

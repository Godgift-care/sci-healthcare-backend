import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { server } from '../stellar/client.js';
import { Indexer } from '../stellar/indexer.js';
import { collectEvents } from '../stellar/paging.js';

vi.mock('../stellar/paging.js', () => ({
  collectEvents: vi.fn(),
}));

/**
 * Replay safety for the indexer.
 *
 * The cursor is saved in the same transaction as the writes, so a crash
 * before that commit replays the same page on restart. That is only
 * harmless if every handler is idempotent — an `increment` or an `insert`
 * keyed on something other than the on-chain event id would double-apply.
 *
 * This test replays a full lifecycle and compares every table before and
 * after. It is deliberately a snapshot of the database rather than a check
 * per handler: a new handler that is not idempotent fails here without
 * anyone remembering to add a case.
 */

const PROVIDER = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const ATTESTER = 'GBWBYKGC5OCRELVP5WHAKEMBSZMNUY3HOKVSYBQGLFNWWQHNH2SD53FZ';
const SPONSOR = 'GDFEKR6EXP5WZERLLVT7FE5ZT7W7VRMG63ZBW2DXIXYNXISXJBSXEMWO';
const BENEFICIARY_REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';

const START_LEDGER = 100;
const AT = 1788352637; // Fixed timestamp: snapshots must not depend on now.

function sym(name: string): xdr.ScVal {
  return nativeToScVal(name, { type: 'symbol' });
}

function address(value: string): xdr.ScVal {
  return Address.fromString(value).toScVal();
}

function rawEvent(
  name: string,
  ledger: number,
  contractId: string,
  topics: xdr.ScVal[],
  value: xdr.ScVal,
) {
  return {
    id: `${name}-${ledger}`,
    contractId,
    txHash: `${ledger}`.padStart(64, 'c'),
    ledger,
    ledgerClosedAt: new Date(AT * 1000).toISOString(),
    topic: [sym(name), ...topics],
    value,
  };
}

/** One page of events covering every handler shape the indexer projects. */
function lifecycleEvents() {
  const registry = env.REGISTRY_CONTRACT_ID;
  const voucherContract = env.VOUCHER_CONTRACT_ID;
  const receiptContract = env.RECEIPT_CONTRACT_ID;

  return [
    rawEvent(
      'provider_registered',
      100,
      registry,
      [address(PROVIDER)],
      nativeToScVal({
        name: 'Kisumu Health Post',
        country: 'KE',
        registered_at: AT,
      }),
    ),
    rawEvent(
      'provider_status_changed',
      101,
      registry,
      [address(PROVIDER)],
      nativeToScVal({
        status: 1, // Active
      }),
    ),
    rawEvent(
      'service_upserted',
      102,
      registry,
      [address(PROVIDER), nativeToScVal(101, { type: 'u32' })],
      nativeToScVal({
        label: 'Outpatient consult',
        price: 30000000n,
      }),
    ),
    rawEvent(
      'voucher_created',
      103,
      voucherContract,
      [address(FUNDER), address(PROVIDER), nativeToScVal(Buffer.from(BENEFICIARY_REF, 'hex'))],
      nativeToScVal({
        voucher_id: 1n,
        service_code: 101,
        amount: 30000000n,
        created_at: AT,
        expires_at: AT + 30 * 86_400,
      }),
    ),
    rawEvent(
      'voucher_claimed',
      104,
      voucherContract,
      [address(PROVIDER)],
      nativeToScVal({
        voucher_id: 1n,
        claimed_at: AT + 60,
      }),
    ),
    rawEvent(
      'voucher_attested',
      105,
      voucherContract,
      [address(ATTESTER)],
      nativeToScVal({
        voucher_id: 1n,
        attested_at: AT + 120,
        dispute_deadline: AT + 7 * 86_400,
      }),
    ),
    rawEvent(
      'receipt_minted',
      106,
      receiptContract,
      [nativeToScVal(Buffer.from(BENEFICIARY_REF, 'hex')), address(PROVIDER)],
      nativeToScVal({
        voucher_id: 1n,
        service_code: 101,
        amount: 30000000n,
        settled_at: AT + 180,
      }),
    ),
    rawEvent(
      'voucher_settled',
      107,
      voucherContract,
      [address(PROVIDER)],
      nativeToScVal({
        voucher_id: 1n,
        net: 29700000n,
        fee: 300000n,
      }),
    ),
    rawEvent(
      'admin_proposed',
      108,
      registry,
      [address(FUNDER)],
      nativeToScVal({
        pending_admin: ATTESTER,
      }),
    ),
    rawEvent(
      'admin_changed',
      109,
      registry,
      [],
      nativeToScVal({
        new_admin: ATTESTER,
      }),
    ),
    rawEvent(
      'dripped',
      110,
      registry,
      [address(FUNDER)],
      nativeToScVal({
        amount: 100000000n,
      }),
    ),
    rawEvent('service_removed', 111, registry, [address(PROVIDER)], nativeToScVal({ code: 101 })),
    // The matching desk (#317), published on the registry contract id for the
    // same reason `dripped` is: the test environment has no sponsor deployment
    // id, and the projector keys off the event name, not the contract.
    //
    // The amounts are the contract's own arithmetic: voucher 1 is 30000000 and
    // 20000 bps would match 60000000 of it, so the 6000000 cap binds and that
    // is what `match_created` publishes.
    rawEvent(
      'budget_deposited',
      112,
      registry,
      [address(SPONSOR)],
      nativeToScVal({
        amount: 100000000n,
        available: 100000000n,
      }),
    ),
    rawEvent(
      'rules_set',
      113,
      registry,
      [address(SPONSOR)],
      nativeToScVal({
        match_bps: 20000,
        cap_per_voucher: 6000000n,
        min_voucher_amount: 1000000n,
        min_voucher_age_secs: 3600n,
      }),
    ),
    rawEvent(
      'match_created',
      114,
      registry,
      [address(SPONSOR), nativeToScVal(1n, { type: 'u64' })],
      nativeToScVal({
        matched_voucher_id: 2n,
        provider: address(PROVIDER),
        service_code: 101,
        amount: 6000000n,
        matched_at: AT + 200,
      }),
    ),
    rawEvent(
      'match_settled',
      115,
      registry,
      [address(SPONSOR)],
      nativeToScVal({
        matched_voucher_id: 2n,
        amount: 6000000n,
      }),
    ),
    rawEvent(
      'budget_withdrawn',
      116,
      registry,
      [address(SPONSOR)],
      nativeToScVal({
        amount: 25000000n,
        available: 75000000n,
      }),
    ),
    rawEvent(
      'match_created',
      117,
      registry,
      [address(SPONSOR), nativeToScVal(3n, { type: 'u64' })],
      nativeToScVal({
        matched_voucher_id: 4n,
        provider: address(PROVIDER),
        service_code: 101,
        amount: 1500000n,
        matched_at: AT + 300,
      }),
    ),
    rawEvent(
      'match_refunded',
      118,
      registry,
      [address(SPONSOR)],
      nativeToScVal({
        matched_voucher_id: 4n,
        amount: 1500000n,
      }),
    ),
  ];
}

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

/**
 * Every table, with server-managed `updatedAt` columns removed.
 *
 * `@updatedAt` is bookkeeping that Prisma rewrites on an update even when
 * the projected columns are unchanged; it says when the row was last
 * written, not what it contains, and a replay is allowed to touch it.
 */
async function snapshot() {
  const [
    providers,
    services,
    vouchers,
    receipts,
    governanceEvents,
    providerStatusChanges,
    servicePriceChanges,
    failedEvents,
    faucetDrips,
    sponsors,
    sponsorBudgetEvents,
    sponsorMatches,
    indexerState,
    dailyStats,
  ] = await Promise.all([
    prisma.provider.findMany({ orderBy: { address: 'asc' } }),
    prisma.service.findMany({ orderBy: { id: 'asc' } }),
    prisma.voucher.findMany({ orderBy: { id: 'asc' } }),
    prisma.receipt.findMany({ orderBy: { voucherId: 'asc' } }),
    prisma.governanceEvent.findMany({ orderBy: { id: 'asc' } }),
    prisma.providerStatusChange.findMany({ orderBy: { id: 'asc' } }),
    prisma.servicePriceChange.findMany({ orderBy: { id: 'asc' } }),
    prisma.failedEvent.findMany({ orderBy: { id: 'asc' } }),
    prisma.faucetDrip.findMany({ orderBy: { id: 'asc' } }),
    prisma.sponsor.findMany({ orderBy: { address: 'asc' } }),
    prisma.sponsorBudgetEvent.findMany({ orderBy: { id: 'asc' } }),
    prisma.sponsorMatch.findMany({ orderBy: { matchedVoucherId: 'asc' } }),
    prisma.indexerState.findMany(),
    prisma.dailyStat.findMany({ orderBy: { date: 'asc' } }),
  ]);

  return {
    providers: providers.map(({ updatedAt: _updatedAt, ...row }) => row),
    services,
    vouchers: vouchers.map(({ updatedAt: _updatedAt, ...row }) => row),
    receipts,
    governanceEvents,
    providerStatusChanges,
    servicePriceChanges,
    failedEvents,
    faucetDrips,
    sponsors: sponsors.map(({ updatedAt: _updatedAt, ...row }) => row),
    sponsorBudgetEvents,
    sponsorMatches,
    indexerState: indexerState.map(({ updatedAt: _updatedAt, ...row }) => row),
    dailyStats: dailyStats.map(({ updatedAt: _updatedAt, ...row }) => row),
  };
}

beforeEach(async () => {
  vi.mocked(collectEvents).mockReset();
  vi.spyOn(server, 'getHealth').mockResolvedValue({
    oldestLedger: 1,
    latestLedger: 1000,
  } as never);

  // Start from an empty read model: the snapshot compares whole tables.
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.servicePriceChange.deleteMany();
  await prisma.providerStatusChange.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.governanceEvent.deleteMany();
  await prisma.failedEvent.deleteMany();
  await prisma.faucetDrip.deleteMany();
  await prisma.sponsorMatch.deleteMany();
  await prisma.sponsorBudgetEvent.deleteMany();
  await prisma.sponsor.deleteMany();
  await prisma.reconcileMismatch.deleteMany();
  await prisma.dailyStat.deleteMany();

  await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastLedger: START_LEDGER },
    update: {
      lastLedger: START_LEDGER,
      leaseOwner: null,
      leaseExpiresAt: null,
      gap: false,
      gapOldestLedger: null,
      gapCursorLedger: null,
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('indexer replay', () => {
  it('processing the same page of events twice changes nothing', async () => {
    vi.mocked(collectEvents).mockResolvedValue({
      events: lifecycleEvents(),
      throughLedger: START_LEDGER + 18,
      hasMore: false,
    } as never);

    const indexer = new Indexer(fakeLog());

    await indexer.tick();
    const afterFirst = await snapshot();

    // A crash after the writes but before the cursor commit looks exactly
    // like this: the same range is read again on the next cycle.
    await prisma.indexerState.update({
      where: { id: 1 },
      data: { lastLedger: START_LEDGER },
    });
    await indexer.tick();
    const afterReplay = await snapshot();

    expect(afterReplay).toEqual(afterFirst);
  });

  it('keeps one row per on-chain event id after replay', async () => {
    vi.mocked(collectEvents).mockResolvedValue({
      events: lifecycleEvents(),
      throughLedger: START_LEDGER + 18,
      hasMore: false,
    } as never);

    const indexer = new Indexer(fakeLog());
    await indexer.tick();
    await prisma.indexerState.update({ where: { id: 1 }, data: { lastLedger: START_LEDGER } });
    await indexer.tick();

    // The sanity check behind the snapshot above: if the replay silently
    // projected nothing, identical state would pass for the wrong reason.
    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: PROVIDER } });
    expect(provider).toMatchObject({
      name: 'Kisumu Health Post',
      country: 'KE',
      status: 'Active',
    });

    const service = await prisma.service.findUniqueOrThrow({
      where: { id: `${PROVIDER}:101` },
    });
    // Upserted and then removed by the last event in the page.
    expect(service).toMatchObject({ price: '30000000', active: false });

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher).toMatchObject({
      funder: FUNDER,
      providerAddress: PROVIDER,
      beneficiaryRef: BENEFICIARY_REF,
      serviceCode: 101,
      amount: '30000000',
      status: 'Settled',
      settledNet: '29700000',
      settledFee: '300000',
    });

    expect(await prisma.receipt.count()).toBe(1);
    expect(await prisma.governanceEvent.count()).toBe(2);
    expect(await prisma.providerStatusChange.count()).toBe(1);
    expect(await prisma.servicePriceChange.count()).toBe(1);
    expect(await prisma.faucetDrip.count()).toBe(1);
    expect(await prisma.sponsor.count()).toBe(1);
    expect(await prisma.sponsorBudgetEvent.count()).toBe(2);
    expect(await prisma.sponsorMatch.count()).toBe(2);
    expect(await prisma.failedEvent.count()).toBe(0);

    // One row per on-chain id: the counters behind /stats must not double.
    expect(
      await prisma.governanceEvent.findUnique({ where: { id: 'admin_proposed-108' } }),
    ).not.toBeNull();
    expect(await prisma.faucetDrip.findUnique({ where: { id: 'dripped-110' } })).not.toBeNull();

    // The sponsor's balance is the snapshot the last movement reported, not a
    // running total: adding the replayed movements would double them.
    const sponsor = await prisma.sponsor.findUniqueOrThrow({ where: { address: SPONSOR } });
    expect(sponsor).toMatchObject({
      available: '75000000',
      matchBps: 20000,
      capPerVoucher: '6000000',
      minVoucherAgeSecs: '3600',
    });

    // Each match keeps the status its resolution event gave it. A handler that
    // re-ran the create on replay would reset these to Open, and the snapshot
    // above would catch it only because the count stays at two.
    expect(
      await prisma.sponsorMatch.findMany({ orderBy: { matchedVoucherId: 'asc' } }),
    ).toMatchObject([
      { matchedVoucherId: '2', originalVoucherId: '1', status: 'Settled' },
      { matchedVoucherId: '4', originalVoucherId: '3', status: 'Refunded' },
    ]);
  });
});

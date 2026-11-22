/**
 * Projection tests: one per handled event in the indexer switch
 * (`project()` in `src/stellar/indexer.ts`), asserting the rows each handler
 * writes to the read model.
 *
 * `src/__tests__/indexer.test.ts` covers decoding failures, backoff, the
 * lease and shutdown; `src/__tests__/events.test.ts` covers the decoder.
 * What was untested until now is the actual subject of most data bugs: what
 * a successfully decoded event writes. Each test builds a raw RPC-shaped
 * event, decodes it with the real decoder (so topic-field naming is part of
 * what is asserted), applies it through `Indexer.applyEvent` — the entry
 * point designed for exactly this — and reads the rows back from the
 * throwaway database created by `test/`.
 */
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { Indexer, type IndexerOptions } from '../stellar/indexer.js';
import { decodeEvent, type DecodedEvent } from '../stellar/events.js';
import type { ChainVoucherOptions } from '../stellar/reconcile.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const OTHER_CLINIC = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const FUNDER = 'GAVOC64Q4HF3MIIL5X6J2ZNB4IHIG2RT5NR3XPOIPVGNTV5V5B5L4PFO';
const ATTESTER = 'GBN3U6C2NDHCNA33TKKGRGOQ3VFZQCNZTQOTAHQ6DSYAOTGCWSMYAXEU';
const SPONSOR = 'GDFEKR6EXP5WZERLLVT7FE5ZT7W7VRMG63ZBW2DXIXYNXISXJBSXEMWO';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const LEDGER_CLOSED_AT = '2026-10-01T00:00:00.000Z';

function sym(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: 'symbol' });
}

/** One raw RPC-shaped contract event: `sym(name)` topic, then payload. */
function rawEvent(
  name: string,
  ledger: number,
  data: Record<string, unknown> = {},
  topics: xdr.ScVal[] = [],
  contractId: string = env.REGISTRY_CONTRACT_ID,
): DecodedEvent {
  const decoded = decodeEvent({
    id: `${name}-${ledger}`,
    contractId,
    txHash: 'a'.repeat(64),
    ledger,
    ledgerClosedAt: LEDGER_CLOSED_AT,
    topic: [sym(name), ...topics],
    value: nativeToScVal(data),
  });
  if (!decoded) throw new Error(`fixture event ${name} did not decode`);
  return decoded;
}

function fakeLog(): FastifyBaseLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as FastifyBaseLogger;
}

function apply(e: DecodedEvent, opts?: IndexerOptions): Promise<void> {
  return new Indexer(fakeLog(), opts).applyEvent(e);
}

const addr = (a: string): xdr.ScVal => Address.fromString(a).toScVal();
const refBytes = (): xdr.ScVal => nativeToScVal(Buffer.from(REF, 'hex'));
const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: 'u32' });

beforeEach(async () => {
  await prisma.$transaction([
    prisma.reconcileMismatch.deleteMany(),
    prisma.failedEvent.deleteMany(),
    prisma.faucetDrip.deleteMany(),
    prisma.sponsorMatch.deleteMany(),
    prisma.sponsorBudgetEvent.deleteMany(),
    prisma.sponsor.deleteMany(),
    prisma.receipt.deleteMany(),
    prisma.servicePriceChange.deleteMany(),
    prisma.service.deleteMany(),
    prisma.providerStatusChange.deleteMany(),
    prisma.governanceEvent.deleteMany(),
    prisma.voucher.deleteMany(),
    prisma.provider.deleteMany(),
    prisma.deployment.deleteMany(),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('provider_registered projection', () => {
  it('writes the clinic row as Pending and attributes it to its deployment', async () => {
    const deployment = await prisma.deployment.create({
      data: { type: 'registry', contractId: env.REGISTRY_CONTRACT_ID, fromLedger: 10 },
    });

    await apply(
      rawEvent(
        'provider_registered',
        101,
        { name: 'Katibangcuo Health Post', country: 'CF', registered_at: 1_759_276_800n },
        [addr(CLINIC)],
      ),
    );

    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider).toMatchObject({
      name: 'Katibangcuo Health Post',
      country: 'CF',
      status: 'Pending',
      deploymentId: deployment.id,
    });
    expect(provider.registeredAt.toISOString()).toBe('2025-10-01T00:00:00.000Z');
  });

  it('re-registration refreshes the profile without duplicating the row', async () => {
    await apply(
      rawEvent('provider_registered', 101, { name: 'Old Name', country: 'CF', registered_at: 1n }, [
        addr(CLINIC),
      ]),
    );
    await apply(
      rawEvent('provider_registered', 102, { name: 'New Name', country: 'NG', registered_at: 1n }, [
        addr(CLINIC),
      ]),
    );

    expect(await prisma.provider.count()).toBe(1);
    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider).toMatchObject({ name: 'New Name', country: 'NG', status: 'Pending' });
  });
});

describe('provider_status_changed projection', () => {
  it('updates the clinic status and appends the transition to history', async () => {
    await apply(
      rawEvent('provider_registered', 101, { name: 'Clinic', country: 'CF', registered_at: 1n }, [
        addr(CLINIC),
      ]),
    );

    await apply(rawEvent('provider_status_changed', 105, { status: u32(1) }, [addr(CLINIC)]));

    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider.status).toBe('Active');
    const change = await prisma.providerStatusChange.findUniqueOrThrow({
      where: { id: 'provider_status_changed-105' },
    });
    expect(change).toMatchObject({
      providerAddress: CLINIC,
      status: 'Active',
      ledger: 105,
    });
    expect(change.changedAt.toISOString()).toBe(LEDGER_CLOSED_AT);
  });
});

describe('capacity_changed projection', () => {
  // registry `set_capacity` requires the clinic to be registered first, so
  // the fixtures mirror that order.
  async function registerClinic(): Promise<void> {
    await apply(
      rawEvent('provider_registered', 101, { name: 'Clinic', country: 'CF', registered_at: 1n }, [
        addr(CLINIC),
      ]),
    );
  }

  it('leaves capacity null for a clinic that never set one', async () => {
    await registerClinic();
    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider.capacity).toBeNull();
  });

  it('stores the max_outstanding cap the registry emits', async () => {
    await registerClinic();
    await apply(rawEvent('capacity_changed', 102, { max_outstanding: u32(3) }, [addr(CLINIC)]));
    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider.capacity).toBe(3);
  });

  it('stores the contract\'s "0 means unlimited" literally', async () => {
    await registerClinic();
    await apply(rawEvent('capacity_changed', 102, { max_outstanding: u32(5) }, [addr(CLINIC)]));
    await apply(rawEvent('capacity_changed', 103, { max_outstanding: u32(0) }, [addr(CLINIC)]));
    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider.capacity).toBe(0);
  });

  it('is replay-idempotent: re-applying the same cap is a no-op', async () => {
    await registerClinic();
    await apply(rawEvent('capacity_changed', 102, { max_outstanding: u32(4) }, [addr(CLINIC)]));
    await apply(rawEvent('capacity_changed', 102, { max_outstanding: u32(4) }, [addr(CLINIC)]));
    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider.capacity).toBe(4);
  });
});

describe('service_upserted projection', () => {
  // `Service.provider` is a required relation: on chain a clinic registers
  // before it can upsert a service, so the fixtures mirror that order.
  async function registerClinic(ledger = 100): Promise<void> {
    await apply(
      rawEvent(
        'provider_registered',
        ledger,
        { name: 'Katibangcuo Health Post', country: 'CF', registered_at: 1_759_276_800n },
        [addr(CLINIC)],
      ),
    );
  }

  it('writes the service and starts its price history', async () => {
    await registerClinic();
    await apply(
      rawEvent('service_upserted', 102, { label: 'Outpatient consult', price: 30_000_000n }, [
        addr(CLINIC),
        u32(101),
      ]),
    );

    const service = await prisma.service.findUniqueOrThrow({ where: { id: `${CLINIC}:101` } });
    expect(service).toMatchObject({
      code: 101,
      label: 'Outpatient consult',
      price: '30000000',
      active: true,
      providerAddress: CLINIC,
    });
    const history = await prisma.servicePriceChange.findMany();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ price: '30000000', code: 101, ledger: 102 });
  });

  it('records a price change but not a relabel', async () => {
    await registerClinic();
    await apply(
      rawEvent('service_upserted', 102, { label: 'Outpatient consult', price: 30_000_000n }, [
        addr(CLINIC),
        u32(101),
      ]),
    );
    // Same price, new label: history must not grow.
    await apply(
      rawEvent('service_upserted', 103, { label: 'OPD consult', price: 30_000_000n }, [
        addr(CLINIC),
        u32(101),
      ]),
    );
    expect(await prisma.servicePriceChange.count()).toBe(1);

    await apply(
      rawEvent('service_upserted', 104, { label: 'OPD consult', price: 25_000_000n }, [
        addr(CLINIC),
        u32(101),
      ]),
    );
    expect(await prisma.servicePriceChange.count()).toBe(2);
    const service = await prisma.service.findUniqueOrThrow({ where: { id: `${CLINIC}:101` } });
    expect(service.price).toBe('25000000');
  });
});

describe('service_price_scheduled projection (#315)', () => {
  // Every fixture event here closes at `LEDGER_CLOSED_AT` (1790812800), so a
  // schedule at that instant has come due and one a week later is still
  // pending.
  const DUE_AT = 1_790_812_800n;
  const PENDING_AT = 1_791_417_600n;

  const serviceRow = () => prisma.service.findUniqueOrThrow({ where: { id: `${CLINIC}:101` } });

  async function registerClinic(): Promise<void> {
    await apply(
      rawEvent(
        'provider_registered',
        100,
        { name: 'Katibangcuo Health Post', country: 'CF', registered_at: 1_759_276_800n },
        [addr(CLINIC)],
      ),
    );
  }

  async function upsert(
    ledger: number,
    price: bigint,
    label = 'Outpatient consult',
  ): Promise<void> {
    await apply(rawEvent('service_upserted', ledger, { label, price }, [addr(CLINIC), u32(101)]));
  }

  async function schedule(ledger: number, price: bigint, effectiveAt: bigint): Promise<void> {
    await apply(
      rawEvent('service_price_scheduled', ledger, { price, effective_at: effectiveAt }, [
        addr(CLINIC),
        u32(101),
      ]),
    );
  }

  it('stores the schedule without touching the current price', async () => {
    await registerClinic();
    await upsert(102, 30_000_000n);
    await schedule(103, 45_000_000n, PENDING_AT);

    const row = await serviceRow();
    expect(row).toMatchObject({ price: '30000000', upcomingPrice: '45000000' });
    expect(row.upcomingFrom?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    // Nothing has changed on chain yet — a schedule is not a price change, so
    // it does not start a history row of its own.
    expect(await prisma.servicePriceChange.count()).toBe(1);
  });

  it('keeps a still-pending schedule through a later upsert', async () => {
    await registerClinic();
    await upsert(102, 30_000_000n);
    await schedule(103, 45_000_000n, PENDING_AT);
    await upsert(104, 30_000_000n, 'OPD consult');

    const row = await serviceRow();
    expect(row).toMatchObject({
      label: 'OPD consult',
      price: '30000000',
      upcomingPrice: '45000000',
    });
    expect(row.upcomingFrom?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(await prisma.servicePriceChange.count()).toBe(1);
  });

  it('consumes a schedule that has come due before writing the upsert', async () => {
    await registerClinic();
    await upsert(102, 30_000_000n);
    await schedule(103, 45_000_000n, DUE_AT);
    await upsert(104, 25_000_000n);

    // `upsert_service` reads through `apply_due_price` first, so 45000000 was
    // already the current price when the clinic lowered it again. The
    // projection has to agree or the old schedule would resurrect itself.
    const row = await serviceRow();
    expect(row).toMatchObject({ price: '25000000', upcomingPrice: null });
    expect(row.upcomingFrom).toBeNull();

    const history = await prisma.servicePriceChange.findMany({ orderBy: { ledger: 'asc' } });
    expect(history.map((h) => h.price)).toEqual(['30000000', '25000000']);
  });

  it('indexes a schedule for an unknown service and a service with no schedule', async () => {
    // Nothing to point at: the row does not exist yet.
    await schedule(101, 45_000_000n, PENDING_AT);
    expect(await prisma.service.count()).toBe(0);

    // Indexing continues normally afterwards, and a service that never had a
    // schedule — which is every service on a deployment predating the event —
    // reads with both columns null.
    await registerClinic();
    await upsert(104, 30_000_000n);
    const row = await serviceRow();
    expect(row).toMatchObject({ price: '30000000', upcomingPrice: null });
    expect(row.upcomingFrom).toBeNull();
  });
});

describe('service_removed projection', () => {
  it('deactivates the service row instead of deleting it', async () => {
    await apply(
      rawEvent('provider_registered', 100, { name: 'Clinic', country: 'CF', registered_at: 1n }, [
        addr(CLINIC),
      ]),
    );
    await apply(
      rawEvent('service_upserted', 102, { label: 'Consult', price: 1n }, [addr(CLINIC), u32(101)]),
    );

    await apply(rawEvent('service_removed', 106, { code: 101 }, [addr(CLINIC)]));

    const service = await prisma.service.findUniqueOrThrow({ where: { id: `${CLINIC}:101` } });
    expect(service.active).toBe(false);
  });
});

describe('admin_proposed projection', () => {
  it('keeps the nomination as a Proposed governance row with both admins', async () => {
    await apply(
      rawEvent(
        'admin_proposed',
        107,
        { pending_admin: OTHER_CLINIC },
        [addr(CLINIC)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    const row = await prisma.governanceEvent.findUniqueOrThrow({
      where: { id: 'admin_proposed-107' },
    });
    expect(row).toMatchObject({
      contractId: env.VOUCHER_CONTRACT_ID,
      contract: 'voucher',
      kind: 'Proposed',
      admin: CLINIC,
      pendingAdmin: OTHER_CLINIC,
      ledger: 107,
    });
  });
});

describe('admin_changed projection', () => {
  it('records the handover as a Changed row and clears the nominee', async () => {
    await apply(
      rawEvent('admin_changed', 108, { new_admin: OTHER_CLINIC }, [], env.RECEIPT_CONTRACT_ID),
    );

    const row = await prisma.governanceEvent.findUniqueOrThrow({
      where: { id: 'admin_changed-108' },
    });
    expect(row).toMatchObject({
      contract: 'receipt',
      kind: 'Changed',
      admin: OTHER_CLINIC,
      pendingAdmin: null,
    });
  });
});

describe('voucher lifecycle projections', () => {
  /** The created event every later transition in this block builds on. */
  async function createVoucher(id = 1): Promise<void> {
    await apply(
      rawEvent(
        'voucher_created',
        110,
        {
          voucher_id: BigInt(id),
          service_code: 101,
          amount: 30_000_000n,
          created_at: 1_759_276_800n,
          expires_at: 1_790_944_632n,
        },
        [addr(FUNDER), addr(CLINIC), refBytes()],
        env.VOUCHER_CONTRACT_ID,
      ),
    );
  }

  it('voucher_created writes the funded voucher and its seq mirror', async () => {
    const deployment = await prisma.deployment.create({
      data: { type: 'voucher', contractId: env.VOUCHER_CONTRACT_ID, fromLedger: 10 },
    });

    await createVoucher(9);

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '9' } });
    expect(voucher).toMatchObject({
      funder: FUNDER,
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      status: 'Funded',
      deploymentId: deployment.id,
    });
    // Numeric mirror of the id so voucher 9 sorts before voucher 10 (#61).
    expect(voucher.seq).toBe(9n);
    expect(voucher.createdAt.toISOString()).toBe('2025-10-01T00:00:00.000Z');
    expect(voucher.expiresAt.toISOString()).toBe('2026-10-02T12:37:12.000Z');
  });

  it('voucher_created backfills a stub provider so the relation holds', async () => {
    await createVoucher();

    const provider = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
    expect(provider).toMatchObject({ name: 'Unknown provider', country: '??', status: 'Active' });
  });

  it('voucher_claimed moves the row to Claimed with its timestamp', async () => {
    await createVoucher();

    await apply(
      rawEvent(
        'voucher_claimed',
        111,
        { voucher_id: 1n, claimed_at: 1_759_363_200n },
        [addr(CLINIC)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Claimed');
    expect(voucher.claimedAt?.toISOString()).toBe('2025-10-02T00:00:00.000Z');
  });

  it('voucher_attested stamps the attestation and the dispute deadline', async () => {
    await createVoucher();
    await apply(
      rawEvent(
        'voucher_claimed',
        111,
        { voucher_id: 1n, claimed_at: 1n },
        [addr(CLINIC)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    await apply(
      rawEvent(
        'voucher_attested',
        112,
        { voucher_id: 1n, attested_at: 1_759_449_600n, dispute_deadline: 1_760_054_400n },
        [addr(ATTESTER)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Attested');
    expect(voucher.attestedAt?.toISOString()).toBe('2025-10-03T00:00:00.000Z');
    expect(voucher.disputeDeadline?.toISOString()).toBe('2025-10-10T00:00:00.000Z');
  });

  it('voucher_disputed stores the reason code the funder gave', async () => {
    await createVoucher();

    await apply(
      rawEvent(
        'voucher_disputed',
        113,
        { voucher_id: 1n, reason_code: u32(2) },
        [addr(FUNDER)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Disputed');
    expect(voucher.disputeReason).toBe(2);
  });

  it('voucher_settled stores the net and fee split from chain', async () => {
    await createVoucher();

    await apply(
      rawEvent(
        'voucher_settled',
        114,
        { voucher_id: 1n, net: 28_500_000n, fee: 1_500_000n },
        [addr(CLINIC)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Settled');
    // i128s kept as decimal strings, never rounded through Number.
    expect(voucher.settledNet).toBe('28500000');
    expect(voucher.settledFee).toBe('1500000');
  });

  it('voucher_refunded flips the status and keeps the settled columns untouched', async () => {
    await createVoucher();
    await apply(
      rawEvent(
        'voucher_settled',
        114,
        { voucher_id: 1n, net: 28_500_000n, fee: 1_500_000n },
        [addr(CLINIC)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    await apply(
      rawEvent(
        'voucher_refunded',
        115,
        { voucher_id: 1n },
        [addr(FUNDER)],
        env.VOUCHER_CONTRACT_ID,
      ),
    );

    const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
    expect(voucher.status).toBe('Refunded');
    expect(voucher.settledNet).toBe('28500000');
  });

  it('a replayed voucher_created does not duplicate or overwrite the row', async () => {
    await createVoucher();
    await createVoucher();

    expect(await prisma.voucher.count({ where: { id: '1' } })).toBe(1);
  });

  /**
   * Whether the claim revealed a presence secret is not in the claim event —
   * `claim` and `claim_with_proof` emit it identically — so the projection
   * asks the voucher's funding options instead (#318). `applyEvent` still runs
   * the real decoder here, so the topic naming of `voucher_claimed` is part of
   * what these tests prove.
   */
  describe('voucher_claimed presence proof', () => {
    const COMMITMENT = new Uint8Array(Array(32).fill(7));

    /** What `get_voucher_options` answers for a voucher with/without a commitment. */
    function options(withCommitment: boolean): ChainVoucherOptions {
      return { presence_commitment: withCommitment ? COMMITMENT : null, dispute_window: null };
    }

    const claimEvent = (): DecodedEvent =>
      rawEvent(
        'voucher_claimed',
        111,
        { voucher_id: 1n, claimed_at: 1_759_363_200n },
        [addr(CLINIC)],
        env.VOUCHER_CONTRACT_ID,
      );

    /** Options the chain would answer with, plus the ids it was asked for. */
    function fakeOptions(withCommitment: boolean) {
      const reads: string[] = [];
      const optionsReader: NonNullable<IndexerOptions['optionsReader']> = async (
        voucherId,
        contractId,
      ) => {
        reads.push(`${voucherId}@${contractId}`);
        return options(withCommitment);
      };
      return { reads, optionsReader };
    }

    it('records true when the voucher can only have been claimed with a proof', async () => {
      await createVoucher();
      const chain = fakeOptions(true);

      await apply(claimEvent(), chain);

      const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
      expect(voucher.status).toBe('Claimed');
      expect(voucher.claimedWithProof).toBe(true);
      // Asked of the voucher's own contract, once, by id.
      expect(chain.reads).toEqual([`1@${env.VOUCHER_CONTRACT_ID}`]);
    });

    it('records false for a claim that carried no proof', async () => {
      await createVoucher();

      await apply(claimEvent(), fakeOptions(false));

      const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
      expect(voucher.claimedWithProof).toBe(false);
    });

    it('asks once: a replayed claim is answered by the row, not the chain', async () => {
      await createVoucher();
      const chain = fakeOptions(true);

      await apply(claimEvent(), chain);
      await apply(claimEvent(), chain);

      expect(chain.reads).toHaveLength(1);
      expect(await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } })).toMatchObject({
        claimedWithProof: true,
      });
    });

    it('applies the claim and leaves the proof unknown when the read fails', async () => {
      await createVoucher();

      await apply(claimEvent(), {
        optionsReader: async () => {
          throw new Error('rpc is down');
        },
      });

      // A detail of the claim is missing; the claim itself is not up for grabs.
      const voucher = await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } });
      expect(voucher.status).toBe('Claimed');
      expect(voucher.claimedAt?.toISOString()).toBe('2025-10-02T00:00:00.000Z');
      expect(voucher.claimedWithProof).toBeNull();
    });

    it('stays null when the indexer was built without a chain reader', async () => {
      await createVoucher();

      // What every other test here gets: `NODE_ENV=test` leaves the reader
      // unset so the suite never reaches for an RPC endpoint.
      await apply(claimEvent());

      expect(await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } })).toMatchObject({
        status: 'Claimed',
        claimedWithProof: null,
      });
    });
  });
});

describe('receipt_minted projection', () => {
  it('writes the receipt keyed by its voucher with the minted amounts', async () => {
    const deployment = await prisma.deployment.create({
      data: { type: 'receipt', contractId: env.RECEIPT_CONTRACT_ID, fromLedger: 10 },
    });

    await apply(
      rawEvent(
        'receipt_minted',
        120,
        { voucher_id: 1n, service_code: 101, amount: 30_000_000n, settled_at: 1_759_536_000n },
        [refBytes(), addr(CLINIC)],
        env.RECEIPT_CONTRACT_ID,
      ),
    );

    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { voucherId: '1' } });
    expect(receipt).toMatchObject({
      beneficiaryRef: REF,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '30000000',
      deploymentId: deployment.id,
    });
    expect(receipt.settledAt.toISOString()).toBe('2025-10-04T00:00:00.000Z');
  });
});

describe('dripped projection', () => {
  // Replay/idempotency semantics live in indexer.test.ts; this asserts the
  // row shape so the switch is covered end to end in one place.
  it('records the wallet, amount and ledger of the drip', async () => {
    await apply(rawEvent('dripped', 130, { amount: 100_000_000n }, [addr(FUNDER)]));

    const drip = await prisma.faucetDrip.findUniqueOrThrow({ where: { id: 'dripped-130' } });
    expect(drip).toMatchObject({ wallet: FUNDER, amount: '100000000', ledger: 130 });
    expect(drip.drippedAt.toISOString()).toBe(LEDGER_CLOSED_AT);
  });
});

/**
 * The matching-funding desk (#317).
 *
 * These events reach the projector only when `SPONSOR_CONTRACT_ID` is set in
 * deployment, but the projector itself keys off the event name, so — as with
 * the faucet above — the rows are asserted by publishing the event on the
 * registry contract id.
 */
describe('sponsor projections', () => {
  const u64 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: 'u64' });
  const deposit = (ledger: number, amount: bigint, available: bigint) =>
    rawEvent('budget_deposited', ledger, { amount, available }, [addr(SPONSOR)]);

  it('keeps the balance the desk reported across deposits instead of adding them', async () => {
    // A top-up: the contract publishes the balance *after* each movement, so
    // the second event already contains the first. Summing the amounts here
    // would read 160.0000000 for a budget of 100.0000000 — and would double
    // again on every replay.
    await apply(deposit(140, 60_000_000n, 60_000_000n));
    await apply(deposit(141, 40_000_000n, 100_000_000n));

    const sponsor = await prisma.sponsor.findUniqueOrThrow({ where: { address: SPONSOR } });
    expect(sponsor).toMatchObject({ available: '100000000', matchBps: null, capPerVoucher: null });
    expect(sponsor.firstSeenAt.toISOString()).toBe(LEDGER_CLOSED_AT);
    expect(sponsor.lastMovementAt?.toISOString()).toBe(LEDGER_CLOSED_AT);

    const movement = await prisma.sponsorBudgetEvent.findUniqueOrThrow({
      where: { id: 'budget_deposited-140' },
    });
    expect(movement).toMatchObject({
      sponsorAddress: SPONSOR,
      kind: 'Deposited',
      amount: '60000000',
      available: '60000000',
      ledger: 140,
    });
    expect(await prisma.sponsorBudgetEvent.count()).toBe(2);
  });

  it('budget_withdrawn replaces the balance instead of adding to it', async () => {
    await apply(deposit(140, 100_000_000n, 100_000_000n));
    await apply(
      rawEvent('budget_withdrawn', 141, { amount: 25_000_000n, available: 75_000_000n }, [
        addr(SPONSOR),
      ]),
    );

    // `available` is the contract's own post-movement figure. Summing the
    // movements here would double-count the first time a page replayed, and a
    // drift of one ledger would put the API at a balance the desk never had.
    const sponsor = await prisma.sponsor.findUniqueOrThrow({ where: { address: SPONSOR } });
    expect(sponsor).toMatchObject({ available: '75000000' });
    expect(await prisma.sponsorBudgetEvent.count()).toBe(2);
  });

  it('rules_set stores all four terms as one snapshot', async () => {
    await apply(
      rawEvent(
        'rules_set',
        142,
        {
          match_bps: 20_000,
          cap_per_voucher: 6_000_000n,
          min_voucher_amount: 1_000_000n,
          min_voucher_age_secs: 3_600n,
        },
        [addr(SPONSOR)],
      ),
    );

    const sponsor = await prisma.sponsor.findUniqueOrThrow({ where: { address: SPONSOR } });
    expect(sponsor).toMatchObject({
      matchBps: 20000,
      capPerVoucher: '6000000',
      minVoucherAmount: '1000000',
      // u64 does not fit a Postgres integer, so it stays text.
      minVoucherAgeSecs: '3600',
      available: null,
    });
    expect(sponsor.rulesAt?.toISOString()).toBe(LEDGER_CLOSED_AT);
  });

  it('match_created keeps the voucher it matched and the one it funded apart', async () => {
    await apply(
      rawEvent(
        'match_created',
        143,
        {
          matched_voucher_id: 2n,
          provider: addr(CLINIC),
          service_code: 101,
          amount: 6_000_000n,
          matched_at: 1_759_536_000n,
        },
        [addr(SPONSOR), u64(1n)],
      ),
    );

    // The original id is a topic and the funded id is data; reading either
    // from the wrong slot produces a row that looks valid and joins nothing.
    const match = await prisma.sponsorMatch.findUniqueOrThrow({
      where: { matchedVoucherId: '2' },
    });
    expect(match).toMatchObject({
      originalVoucherId: '1',
      sponsorAddress: SPONSOR,
      providerAddress: CLINIC,
      serviceCode: 101,
      amount: '6000000',
      status: 'Open',
      settledAt: null,
      refundedAt: null,
    });
    expect(match.matchedAt.toISOString()).toBe('2025-10-04T00:00:00.000Z');

    // A match can be the first event seen for a sponsor, so the row is created
    // here too — with no balance, which the API must not render as zero.
    const sponsor = await prisma.sponsor.findUniqueOrThrow({ where: { address: SPONSOR } });
    expect(sponsor).toMatchObject({ available: null, lastMovementAt: null });
  });

  it('match_settled and match_refunded move the match and stamp the ledger', async () => {
    const created = rawEvent(
      'match_created',
      144,
      {
        matched_voucher_id: 5n,
        provider: addr(CLINIC),
        service_code: 101,
        amount: 2_000_000n,
        matched_at: 1_759_536_000n,
      },
      [addr(SPONSOR), u64(1n)],
    );

    await apply(created);
    await apply(
      rawEvent('match_settled', 145, { matched_voucher_id: 5n, amount: 2_000_000n }, [
        addr(SPONSOR),
      ]),
    );
    const settled = await prisma.sponsorMatch.findUniqueOrThrow({
      where: { matchedVoucherId: '5' },
    });
    expect(settled).toMatchObject({ status: 'Settled', refundedAt: null });
    expect(settled.settledAt?.toISOString()).toBe(LEDGER_CLOSED_AT);

    await apply(
      rawEvent(
        'match_created',
        146,
        {
          matched_voucher_id: 6n,
          provider: addr(CLINIC),
          service_code: 101,
          amount: 2_000_000n,
          matched_at: 1_759_536_000n,
        },
        [addr(SPONSOR), u64(3n)],
      ),
    );
    await apply(
      rawEvent('match_refunded', 147, { matched_voucher_id: 6n, amount: 2_000_000n }, [
        addr(SPONSOR),
      ]),
    );
    const refunded = await prisma.sponsorMatch.findUniqueOrThrow({
      where: { matchedVoucherId: '6' },
    });
    expect(refunded).toMatchObject({ status: 'Refunded', settledAt: null });
    expect(refunded.refundedAt?.toISOString()).toBe(LEDGER_CLOSED_AT);
  });

  it('a settlement for a match older than the start ledger creates no row', async () => {
    // Known gap, stated rather than papered over: `match_settled` names only
    // the matched voucher, so it cannot supply the original id a create needs.
    // `indexer:reconcile` repairs vouchers, not matches.
    await apply(
      rawEvent('match_settled', 148, { matched_voucher_id: 77n, amount: 1n }, [addr(SPONSOR)]),
    );

    expect(await prisma.sponsorMatch.findUnique({ where: { matchedVoucherId: '77' } })).toBeNull();
    expect(await prisma.sponsorMatch.count()).toBe(0);
  });
});

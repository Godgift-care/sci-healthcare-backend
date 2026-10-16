import type { Prisma } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '../db.js';
import { contractName, env, INDEXED_CONTRACTS } from '../env.js';
import { server } from './client.js';
import {
  asAddress,
  asAmount,
  asBoolean,
  asHex,
  asId,
  asNumber,
  asTimestamp,
  decodeEvent,
  providerStatusName,
  serialiseEventData,
  type DecodedEvent,
} from './events.js';
import { IndexerLease } from './lease.js';
import { collectEvents } from './paging.js';

/**
 * Contract events that are known but deliberately not part of the read
 * model. Anything else reaching `applyEvent`'s default branch is a name this
 * backend has never seen, which is worth one warning per process: a silent
 * ignore would hide a contract upgrade that emits something new.
 */
const IGNORED_EVENTS = new Set(['initialized', 'minter_changed']);

/**
 * The voucher an event is about, if any. Events without a `voucher_id`
 * (providers, services, governance, attesters) log with a null voucher so
 * the append-only history can still be stored for them.
 */
function voucherIdOf(fields: Record<string, unknown>): string | null {
  const id = fields.voucher_id;
  if (id === undefined || id === null) return null;
  try {
    return asId(id);
  } catch {
    return null;
  }
}

/**
 * Polls Soroban RPC for contract events and projects them into the read
 * model.
 *
 * Design notes:
 *
 * - The database is a projection, never a source of truth. Deleting it and
 *   replaying from the deploy ledger reproduces it exactly.
 * - Cursor progress is committed only after a batch is applied, so a crash
 *   mid-batch replays rather than skips. Handlers are written to be
 *   idempotent (upserts keyed by on-chain id) so replay is safe.
 * - Soroban RPC retains only a rolling window of ledgers (roughly 7 days on
 *   testnet). An indexer that falls further behind than the window cannot
 *   catch up, which is surfaced loudly rather than silently skipped.
 */
/**
 * How long to wait before the next poll.
 *
 * A cycle that exhausted its page budget still has events to read, so it
 * runs again immediately rather than waiting out the poll interval. Once
 * caught up, the normal interval resumes.
 */
export function nextPollDelay(hasMore: boolean, pollMs: number): number {
  return hasMore ? 0 : pollMs;
}

export type IndexerOptions = {
  /** Overridable for tests; defaults to a lease over this database. */
  lease?: IndexerLease;
};

export class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  /** Set by the last poll: true when a full page suggests a backlog. */
  private hasMore = false;
  /** True while this instance holds the single-writer lease. */
  private holdsLease = false;
  /** Unknown event names already warned about; one warning per process. */
  private readonly unknownEvents = new Set<string>();
  private readonly lease: IndexerLease;

  constructor(
    private readonly log: FastifyBaseLogger,
    opts: IndexerOptions = {},
  ) {
    this.lease = opts.lease ?? new IndexerLease();
  }

  async start(): Promise<void> {
    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
    if (!state) {
      const from =
        env.INDEXER_START_LEDGER > 0
          ? env.INDEXER_START_LEDGER
          : (await server.getLatestLedger()).sequence;
      // upsert, not create: two instances booting together must not race to
      // insert the one row.
      await prisma.indexerState.upsert({
        where: { id: 1 },
        create: { id: 1, lastLedger: from },
        update: {},
      });
      this.log.info({ from }, 'indexer initialised');
    }
    this.holdsLease = await this.acquireLease();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.holdsLease) {
      this.holdsLease = false;
      await this.lease.release();
    }
  }

  /**
   * Runs one scheduled cycle: renew or take the lease, then poll. A standby
   * instance does not touch the cursor; it just retries until the lease is
   * free or expired.
   */
  private async cycle(): Promise<void> {
    if (this.stopped) return;
    try {
      if (this.holdsLease && !(await this.lease.refresh())) {
        this.holdsLease = false;
        this.log.warn('indexer lease lost; standing by');
      }
      if (!this.holdsLease) {
        this.holdsLease = await this.acquireLease();
      }
      // Shutdown may have raced the awaits above; never start work after
      // stop(), and hand the lease back if it was taken mid-cycle.
      if (this.stopped) {
        if (this.holdsLease) {
          this.holdsLease = false;
          await this.lease.release();
        }
        return;
      }
      if (this.holdsLease) await this.tick();
    } catch (err) {
      this.log.error({ err }, 'indexer lease check failed');
      this.hasMore = false;
    } finally {
      this.schedule();
    }
  }

  private async acquireLease(): Promise<boolean> {
    if (this.stopped) return false;
    if (await this.lease.acquire()) {
      this.log.info(
        { owner: this.lease.owner, ttlMs: this.lease.ttlMs },
        'indexer lease acquired; this instance is active',
      );
      return true;
    }
    this.log.info(
      { owner: this.lease.owner },
      'another indexer holds the lease; standing by',
    );
    return false;
  }

  private schedule(): void {
    if (this.stopped) return;
    const delay = nextPollDelay(this.hasMore && this.holdsLease, env.INDEXER_POLL_MS);
    this.timer = setTimeout(() => {
      void this.cycle();
    }, delay);
  }

  /** Exposed for tests and for a manual catch-up endpoint. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.poll();
    } catch (err) {
      this.log.error({ err }, 'indexer poll failed');
      this.hasMore = false;
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async poll(): Promise<number> {
    // Reset first: any early return below means no backlog was detected.
    this.hasMore = false;

    const state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    const startLedger = state.lastLedger + 1;

    const health = await server.getHealth();
    if (startLedger < health.oldestLedger) {
      this.log.error(
        { startLedger, oldestLedger: health.oldestLedger },
        'indexer has fallen outside the RPC retention window; ' +
          'reindex from a snapshot or a later ledger',
      );
      return 0;
    }
    if (startLedger > health.latestLedger) return 0;

    const { events, throughLedger, hasMore } = await collectEvents(server, {
      startLedger,
      contractIds: INDEXED_CONTRACTS,
    });
    this.hasMore = hasMore;

    let applied = 0;
    for (const raw of events) {
      const decoded = decodeEvent(raw as never);
      if (!decoded) continue;
      try {
        await this.applyEvent(decoded);
        applied += 1;
      } catch (err) {
        // One malformed event must not wedge the whole pipeline. The tx hash
        // and ledger are what make a skipped event reproducible.
        this.log.warn(
          {
            err,
            event: decoded.name,
            id: decoded.id,
            txHash: decoded.txHash,
            ledger: decoded.ledger,
          },
          'event skipped',
        );
      }
    }

    const advanceTo = Math.max(state.lastLedger, throughLedger);
    await prisma.indexerState.update({
      where: { id: 1 },
      data: { lastLedger: advanceTo },
    });

    if (applied > 0) {
      this.log.info({ applied, throughLedger: advanceTo }, 'indexed events');
    }
    return applied;
  }

  /**
   * Projects one decoded event into the read model, and appends it to the
   * event log in the same transaction.
   *
   * Both writes commit together, so the log can never claim an event whose
   * projection was rolled back (or vice versa). The log insert is an upsert
   * on the RPC event id, which keeps replay idempotent.
   *
   * Public so tests can drive handlers directly, with a decoded event, and
   * without an RPC.
   */
  async applyEvent(e: DecodedEvent): Promise<void> {
    await prisma.$transaction(async (tx) => {
      await this.recordEvent(tx, e);
      await this.project(tx, e);
    });
  }

  /** Appends the event to the append-only log. Idempotent on the event id. */
  private async recordEvent(tx: Prisma.TransactionClient, e: DecodedEvent): Promise<void> {
    await tx.contractEvent.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        contractId: e.contractId,
        contract: contractName(e.contractId),
        name: e.name,
        ledger: e.ledger,
        txHash: e.txHash,
        closedAt: e.ledgerClosedAt,
        voucherId: voucherIdOf(e.fields),
        data: serialiseEventData(e.fields),
      },
      update: {},
    });
  }

  private async project(tx: Prisma.TransactionClient, e: DecodedEvent): Promise<void> {
    const d = e.fields;
    switch (e.name) {
      case 'provider_registered':
        await this.onProviderRegistered(tx, d);
        break;
      case 'provider_status_changed':
        await this.onProviderStatus(tx, e);
        break;
      case 'service_upserted':
        await this.onServiceUpserted(tx, e);
        break;
      case 'service_removed':
        await this.onServiceRemoved(tx, d);
        break;
      case 'attester_added':
        await this.onAttesterAdded(tx, e);
        break;
      case 'attester_removed':
        await this.onAttesterRemoved(tx, e);
        break;
      case 'admin_proposed':
        await this.onAdminProposed(tx, e);
        break;
      case 'admin_changed':
        await this.onAdminChanged(tx, e);
        break;
      case 'voucher_created':
        await this.onVoucherCreated(tx, d);
        break;
      case 'voucher_claimed':
        await this.onVoucherStatus(tx, d, 'Claimed', { claimedAt: asTimestamp(d.claimed_at) });
        break;
      case 'voucher_attested':
        await this.onVoucherStatus(tx, d, 'Attested', {
          attestedAt: asTimestamp(d.attested_at),
          attestedBy: asAddress(d.attester),
          disputeDeadline: asTimestamp(d.dispute_deadline),
        });
        break;
      case 'voucher_disputed':
        await this.onVoucherStatus(tx, d, 'Disputed', {
          disputeReason: asNumber(d.reason_code),
        });
        break;
      case 'dispute_resolved':
        await this.onDisputeResolved(tx, e);
        break;
      case 'voucher_settled':
        await this.onVoucherStatus(tx, d, 'Settled', {
          settledNet: asAmount(d.net),
          settledFee: asAmount(d.fee),
        });
        break;
      case 'voucher_refunded':
        await this.onVoucherStatus(tx, d, 'Refunded', {});
        break;
      case 'receipt_minted':
        await this.onReceiptMinted(tx, d);
        break;
      default:
        // Known-but-unprojected events stay silent; anything else is a name
        // this backend has never seen and is reported once per process.
        this.noteUnknown(e);
        break;
    }
  }

  private noteUnknown(e: DecodedEvent): void {
    if (IGNORED_EVENTS.has(e.name) || this.unknownEvents.has(e.name)) return;
    this.unknownEvents.add(e.name);
    this.log.warn(
      {
        event: e.name,
        id: e.id,
        txHash: e.txHash,
        ledger: e.ledger,
        unknownEventNames: this.unknownEvents.size,
      },
      'unknown event ignored; this name will not be logged again',
    );
  }

  private async onProviderRegistered(
    tx: Prisma.TransactionClient,
    d: Record<string, unknown>,
  ): Promise<void> {
    const address = asAddress(d.provider);
    await tx.provider.upsert({
      where: { address },
      create: {
        address,
        name: String(d.name),
        country: String(d.country),
        status: 'Pending',
        registeredAt: asTimestamp(d.registered_at),
      },
      update: { name: String(d.name), country: String(d.country) },
    });
  }

  private async onProviderStatus(
    tx: Prisma.TransactionClient,
    e: DecodedEvent,
  ): Promise<void> {
    const address = asAddress(e.fields.provider);
    const status = providerStatusName(e.fields.status);
    // The status update and its history row share the caller's transaction,
    // so a crash cannot leave the provider and its history disagreeing.
    await tx.provider.updateMany({ where: { address }, data: { status } });
    await tx.providerStatusChange.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        providerAddress: address,
        status,
        ledger: e.ledger,
        changedAt: e.ledgerClosedAt,
      },
      update: {},
    });
  }

  /**
   * An attester was added to the registry.
   *
   * Re-adding an attester that was previously removed reactivates the row
   * and clears `removedAt`, matching the contract, where an address is
   * either in the set or not.
   */
  private async onAttesterAdded(
    tx: Prisma.TransactionClient,
    e: DecodedEvent,
  ): Promise<void> {
    const address = asAddress(e.fields.attester);
    await tx.attester.upsert({
      where: { address },
      create: { address, active: true, addedAt: e.ledgerClosedAt },
      update: { active: true, removedAt: null },
    });
  }

  private async onAttesterRemoved(
    tx: Prisma.TransactionClient,
    e: DecodedEvent,
  ): Promise<void> {
    const address = asAddress(e.fields.attester);
    // Upsert rather than update: a removal can be the first event this
    // indexer sees for an attester added before its start ledger.
    await tx.attester.upsert({
      where: { address },
      create: {
        address,
        active: false,
        addedAt: e.ledgerClosedAt,
        removedAt: e.ledgerClosedAt,
      },
      update: { active: false, removedAt: e.ledgerClosedAt },
    });
  }

  private async onServiceUpserted(
    tx: Prisma.TransactionClient,
    e: DecodedEvent,
  ): Promise<void> {
    const d = e.fields;
    const providerAddress = asAddress(d.provider);
    const code = asNumber(d.code);
    const id = `${providerAddress}:${code}`;
    const price = asAmount(d.price);
    const label = String(d.label);

    const existing = await tx.service.findUnique({
      where: { id },
      select: { price: true },
    });
    await tx.service.upsert({
      where: { id },
      create: { id, code, label, price, active: true, providerAddress },
      update: { label, price, active: true },
    });
    // Only a price change is history; a relabelled service is not.
    if (!existing || existing.price !== price) {
      await tx.servicePriceChange.upsert({
        where: { id: e.id },
        create: {
          id: e.id,
          providerAddress,
          code,
          price,
          ledger: e.ledger,
          changedAt: e.ledgerClosedAt,
        },
        update: {},
      });
    }
  }

  private async onAdminProposed(
    tx: Prisma.TransactionClient,
    e: DecodedEvent,
  ): Promise<void> {
    await tx.governanceEvent.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        contractId: e.contractId,
        contract: contractName(e.contractId),
        kind: 'Proposed',
        admin: asAddress(e.fields.admin),
        pendingAdmin: asAddress(e.fields.pending_admin),
        ledger: e.ledger,
        occurredAt: e.ledgerClosedAt,
      },
      update: {},
    });
  }

  private async onAdminChanged(
    tx: Prisma.TransactionClient,
    e: DecodedEvent,
  ): Promise<void> {
    await tx.governanceEvent.upsert({
      where: { id: e.id },
      create: {
        id: e.id,
        contractId: e.contractId,
        contract: contractName(e.contractId),
        kind: 'Changed',
        admin: asAddress(e.fields.new_admin),
        pendingAdmin: null,
        ledger: e.ledger,
        occurredAt: e.ledgerClosedAt,
      },
      update: {},
    });
  }

  private async onServiceRemoved(
    tx: Prisma.TransactionClient,
    d: Record<string, unknown>,
  ): Promise<void> {
    const id = `${asAddress(d.provider)}:${asNumber(d.code)}`;
    await tx.service.updateMany({ where: { id }, data: { active: false } });
  }

  private async onVoucherCreated(
    tx: Prisma.TransactionClient,
    d: Record<string, unknown>,
  ): Promise<void> {
    const id = asId(d.voucher_id);
    const providerAddress = asAddress(d.provider);

    // A voucher references a provider row; if the indexer started after the
    // provider was registered, backfill a stub so the relation holds.
    await tx.provider.upsert({
      where: { address: providerAddress },
      create: {
        address: providerAddress,
        name: 'Unknown provider',
        country: '??',
        status: 'Active',
        registeredAt: new Date(0),
      },
      update: {},
    });

    await tx.voucher.upsert({
      where: { id },
      create: {
        id,
        funder: asAddress(d.funder),
        beneficiaryRef: asHex(d.beneficiary_ref),
        providerAddress,
        serviceCode: asNumber(d.service_code),
        amount: asAmount(d.amount),
        status: 'Funded',
        createdAt: asTimestamp(d.created_at),
        expiresAt: asTimestamp(d.expires_at),
      },
      update: {},
    });
  }

  private async onVoucherStatus(
    tx: Prisma.TransactionClient,
    d: Record<string, unknown>,
    status: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const id = asId(d.voucher_id);
    await tx.voucher.updateMany({
      where: { id },
      data: { status, ...extra },
    });
  }

  /**
   * How a dispute ended: who resolved it, when, and in whose favour.
   *
   * The payout that follows (`voucher_settled` or `voucher_refunded`) is a
   * separate event in the same transaction and may be processed before or
   * after this one. This handler touches only the dispute fields and the
   * status handler touches only `status`, so either order converges on the
   * same row; neither reads the other's result.
   */
  private async onDisputeResolved(
    tx: Prisma.TransactionClient,
    e: DecodedEvent,
  ): Promise<void> {
    const id = asId(e.fields.voucher_id);
    await tx.voucher.updateMany({
      where: { id },
      data: {
        disputeResolvedAt: e.ledgerClosedAt,
        disputeResolvedBy: asAddress(e.fields.admin),
        disputeOutcome: asBoolean(e.fields.refunded_funder) ? 'Funder' : 'Provider',
      },
    });
  }

  private async onReceiptMinted(
    tx: Prisma.TransactionClient,
    d: Record<string, unknown>,
  ): Promise<void> {
    const voucherId = asId(d.voucher_id);
    await tx.receipt.upsert({
      where: { voucherId },
      create: {
        voucherId,
        beneficiaryRef: asHex(d.beneficiary_ref),
        providerAddress: asAddress(d.provider),
        serviceCode: asNumber(d.service_code),
        amount: asAmount(d.amount),
        settledAt: asTimestamp(d.settled_at),
      },
      update: {},
    });
  }
}

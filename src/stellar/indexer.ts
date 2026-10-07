import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '../db.js';
import { env, INDEXED_CONTRACTS } from '../env.js';
import { server } from './client.js';
import {
  asAddress,
  asAmount,
  asHex,
  asId,
  asNumber,
  asTimestamp,
  decodeEvent,
  providerStatusName,
  type DecodedEvent,
} from './events.js';
import { collectEvents } from './paging.js';

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
export class Indexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(private readonly log: FastifyBaseLogger) {}

  async start(): Promise<void> {
    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
    if (!state) {
      const from =
        env.INDEXER_START_LEDGER > 0
          ? env.INDEXER_START_LEDGER
          : (await server.getLatestLedger()).sequence;
      await prisma.indexerState.create({ data: { id: 1, lastLedger: from } });
      this.log.info({ from }, 'indexer initialised');
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, env.INDEXER_POLL_MS);
  }

  /** Exposed for tests and for a manual catch-up endpoint. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.poll();
    } catch (err) {
      this.log.error({ err }, 'indexer poll failed');
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async poll(): Promise<number> {
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

    const { events, throughLedger } = await collectEvents(server, {
      startLedger,
      contractIds: INDEXED_CONTRACTS,
    });

    let applied = 0;
    for (const raw of events) {
      const decoded = decodeEvent(raw as never);
      if (!decoded) continue;
      try {
        await this.apply(decoded);
        applied += 1;
      } catch (err) {
        // One malformed event must not wedge the whole pipeline.
        this.log.warn({ err, event: decoded.name, id: decoded.id }, 'event skipped');
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

  private async apply(e: DecodedEvent): Promise<void> {
    const d = e.fields;
    switch (e.name) {
      case 'provider_registered':
        await this.onProviderRegistered(d);
        break;
      case 'provider_status_changed':
        await this.onProviderStatus(d);
        break;
      case 'service_upserted':
        await this.onServiceUpserted(d);
        break;
      case 'service_removed':
        await this.onServiceRemoved(d);
        break;
      case 'voucher_created':
        await this.onVoucherCreated(d);
        break;
      case 'voucher_claimed':
        await this.onVoucherStatus(d, 'Claimed', { claimedAt: asTimestamp(d.claimed_at) });
        break;
      case 'voucher_attested':
        await this.onVoucherStatus(d, 'Attested', {
          attestedAt: asTimestamp(d.attested_at),
          disputeDeadline: asTimestamp(d.dispute_deadline),
        });
        break;
      case 'voucher_disputed':
        await this.onVoucherStatus(d, 'Disputed', { disputeReason: asNumber(d.reason_code) });
        break;
      case 'voucher_settled':
        await this.onVoucherStatus(d, 'Settled', {
          settledNet: asAmount(d.net),
          settledFee: asAmount(d.fee),
        });
        break;
      case 'voucher_refunded':
        await this.onVoucherStatus(d, 'Refunded', {});
        break;
      case 'receipt_minted':
        await this.onReceiptMinted(d);
        break;
      default:
        // Initialized, admin_proposed, admin_changed, minter_changed and
        // token events are not part of the read model.
        break;
    }
  }

  private async onProviderRegistered(d: Record<string, unknown>): Promise<void> {
    const address = asAddress(d.provider);
    await prisma.provider.upsert({
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

  private async onProviderStatus(d: Record<string, unknown>): Promise<void> {
    const address = asAddress(d.provider);
    const status = providerStatusName(d.status);
    await prisma.provider.updateMany({ where: { address }, data: { status } });
  }

  private async onServiceUpserted(d: Record<string, unknown>): Promise<void> {
    const providerAddress = asAddress(d.provider);
    const code = asNumber(d.code);
    const id = `${providerAddress}:${code}`;
    const price = asAmount(d.price);
    const label = String(d.label);
    await prisma.service.upsert({
      where: { id },
      create: { id, code, label, price, active: true, providerAddress },
      update: { label, price, active: true },
    });
  }

  private async onServiceRemoved(d: Record<string, unknown>): Promise<void> {
    const id = `${asAddress(d.provider)}:${asNumber(d.code)}`;
    await prisma.service.updateMany({ where: { id }, data: { active: false } });
  }

  private async onVoucherCreated(d: Record<string, unknown>): Promise<void> {
    const id = asId(d.voucher_id);
    const providerAddress = asAddress(d.provider);

    // A voucher references a provider row; if the indexer started after the
    // provider was registered, backfill a stub so the relation holds.
    await prisma.provider.upsert({
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

    await prisma.voucher.upsert({
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
    d: Record<string, unknown>,
    status: string,
    extra: Record<string, unknown>,
  ): Promise<void> {
    const id = asId(d.voucher_id);
    await prisma.voucher.updateMany({
      where: { id },
      data: { status, ...extra },
    });
  }

  private async onReceiptMinted(d: Record<string, unknown>): Promise<void> {
    const voucherId = asId(d.voucher_id);
    await prisma.receipt.upsert({
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

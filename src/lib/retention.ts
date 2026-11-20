import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '../db.js';
import { env } from '../env.js';

export type PurgeResult = {
  deletedWebhooks: number;
  deletedFailedEvents: number;
  cutoff: Date;
};

export type PurgeOptions = {
  retentionDays?: number;
  now?: Date;
  client?: PrismaClient | Prisma.TransactionClient;
};

/**
 * Purges operational rows older than `retentionDays`:
 * 1. WebhookDelivery rows with `deliveredAt` older than the cutoff.
 * 2. FailedEvent rows with `resolvedAt` older than the cutoff.
 *
 * Unresolved failed events (`resolvedAt == null`) and pending webhook deliveries
 * (`deliveredAt == null`) are never deleted by this cleanup, so actionable
 * failures remain visible to operators until resolved.
 */
export async function purgeExpiredOperationalData(opts: PurgeOptions = {}): Promise<PurgeResult> {
  const retentionDays =
    opts.retentionDays ?? (process.env.RETENTION_DAYS ? Number(process.env.RETENTION_DAYS) : 30);
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const client = opts.client ?? defaultPrisma;

  const [webhooks, failedEvents] = await Promise.all([
    client.webhookDelivery.deleteMany({
      where: {
        deliveredAt: {
          not: null,
          lt: cutoff,
        },
      },
    }),
    client.failedEvent.deleteMany({
      where: {
        resolvedAt: {
          not: null,
          lt: cutoff,
        },
      },
    }),
  ]);

  return {
    deletedWebhooks: webhooks.count,
    deletedFailedEvents: failedEvents.count,
    cutoff,
  };
}

/** Voucher statuses after which no further events can arrive for the voucher. */
export const FINAL_VOUCHER_STATUSES = ['Settled', 'Refunded'] as const;

/** Rows examined and deleted per round trip, so no single statement is unbounded. */
export const EVENT_PRUNE_BATCH_SIZE = 500;

export type PruneEventsResult = {
  enabled: boolean;
  deleted: number;
  batches: number;
  cutoff: Date | null;
};

export type PruneEventsOptions = {
  /** Defaults to `EVENT_RETENTION_DAYS`. 0, negative or NaN disables pruning. */
  retentionDays?: number;
  now?: Date;
  batchSize?: number;
  client?: PrismaClient | Prisma.TransactionClient;
};

/**
 * Prunes the `ContractEvent` log (#275). Off unless `EVENT_RETENTION_DAYS` is
 * a positive number: with the default it returns without touching the table.
 *
 * Only events whose `closedAt` is older than the cutoff are candidates, and of
 * those only:
 * - events of vouchers in a final status (`Settled`, `Refunded`), and
 * - events that belong to no voucher (`voucherId` null).
 *
 * Events of open vouchers, and of vouchers this database has no row for, are
 * never deleted, so per-voucher history stays intact until the voucher is
 * final. Work is done in batches of `batchSize`: each pass reads one page of
 * candidate ids (keyset-paged by id, so rows that are kept are not re-read),
 * decides which may go, and deletes them by primary key.
 */
export async function pruneContractEvents(
  opts: PruneEventsOptions = {},
): Promise<PruneEventsResult> {
  const days = opts.retentionDays ?? env.EVENT_RETENTION_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    return { enabled: false, deleted: 0, batches: 0, cutoff: null };
  }
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? EVENT_PRUNE_BATCH_SIZE));
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const client = opts.client ?? defaultPrisma;

  let deleted = 0;
  let batches = 0;
  let after: string | undefined;
  for (;;) {
    const page = await client.contractEvent.findMany({
      where: { closedAt: { lt: cutoff }, ...(after !== undefined ? { id: { gt: after } } : {}) },
      select: { id: true, voucherId: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (page.length === 0) break;
    after = page[page.length - 1]!.id;
    batches += 1;

    const voucherIds = [...new Set(page.flatMap((e) => (e.voucherId ? [e.voucherId] : [])))];
    const final = new Set(
      voucherIds.length === 0
        ? []
        : (
            await client.voucher.findMany({
              where: { id: { in: voucherIds }, status: { in: [...FINAL_VOUCHER_STATUSES] } },
              select: { id: true },
            })
          ).map((v) => v.id),
    );
    const ids = page.filter((e) => e.voucherId === null || final.has(e.voucherId)).map((e) => e.id);
    if (ids.length > 0) {
      deleted += (await client.contractEvent.deleteMany({ where: { id: { in: ids } } })).count;
    }
    if (page.length < batchSize) break;
  }
  return { enabled: true, deleted, batches, cutoff };
}

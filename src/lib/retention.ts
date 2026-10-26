import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '../db.js';

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
export async function purgeExpiredOperationalData(
  opts: PurgeOptions = {},
): Promise<PurgeResult> {
  const retentionDays =
    opts.retentionDays ??
    (process.env.RETENTION_DAYS ? Number(process.env.RETENTION_DAYS) : 30);
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

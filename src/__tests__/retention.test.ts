import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { purgeExpiredOperationalData } from '../lib/retention.js';
import { recordFailure, retryFailed } from '../stellar/failed.js';

describe('Operational data retention (#142)', () => {
  beforeEach(async () => {
    await prisma.webhookDelivery.deleteMany();
    await prisma.failedEvent.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('purges old delivered webhooks and resolved failed events while keeping recent ones', async () => {
    const now = new Date('2026-10-25T10:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    const oldDate = new Date(now.getTime() - 40 * day); // 40 days ago (> 30)
    const recentDate = new Date(now.getTime() - 5 * day); // 5 days ago (< 30)

    // 1. Seed webhooks:
    // - Old delivered webhook (should be purged)
    // - Recent delivered webhook (should be kept)
    // - Old pending webhook (should be kept because it is not delivered)
    // - Recent pending webhook (should be kept)
    await prisma.webhookDelivery.createMany({
      data: [
        {
          id: 'wh-old-delivered',
          url: 'https://example.com/webhook',
          event: 'voucher_settled',
          voucherId: 'v-1',
          status: 'Settled',
          ledger: 100,
          payload: '{}',
          attempts: 1,
          nextAttemptAt: oldDate,
          deliveredAt: oldDate,
          createdAt: oldDate,
        },
        {
          id: 'wh-recent-delivered',
          url: 'https://example.com/webhook',
          event: 'voucher_settled',
          voucherId: 'v-2',
          status: 'Settled',
          ledger: 200,
          payload: '{}',
          attempts: 1,
          nextAttemptAt: recentDate,
          deliveredAt: recentDate,
          createdAt: recentDate,
        },
        {
          id: 'wh-old-pending',
          url: 'https://example.com/webhook',
          event: 'voucher_created',
          voucherId: 'v-3',
          status: 'Funded',
          ledger: 100,
          payload: '{}',
          attempts: 0,
          nextAttemptAt: oldDate,
          deliveredAt: null,
          createdAt: oldDate,
        },
        {
          id: 'wh-recent-pending',
          url: 'https://example.com/webhook',
          event: 'voucher_created',
          voucherId: 'v-4',
          status: 'Funded',
          ledger: 200,
          payload: '{}',
          attempts: 0,
          nextAttemptAt: recentDate,
          deliveredAt: null,
          createdAt: recentDate,
        },
      ],
    });

    // 2. Seed failed events:
    // - Old resolved failure (should be purged)
    // - Recent resolved failure (should be kept)
    // - Old unresolved failure (should be kept!)
    // - Recent unresolved failure (should be kept!)
    await prisma.failedEvent.createMany({
      data: [
        {
          id: 'fe-old-resolved',
          name: 'voucher_created',
          ledger: 100,
          raw: '{}',
          error: 'Transient error',
          attempts: 2,
          firstSeen: oldDate,
          lastSeen: oldDate,
          resolvedAt: oldDate,
        },
        {
          id: 'fe-recent-resolved',
          name: 'voucher_created',
          ledger: 200,
          raw: '{}',
          error: 'Transient error',
          attempts: 2,
          firstSeen: recentDate,
          lastSeen: recentDate,
          resolvedAt: recentDate,
        },
        {
          id: 'fe-old-unresolved',
          name: 'voucher_created',
          ledger: 100,
          raw: '{}',
          error: 'Unresolved error',
          attempts: 5,
          firstSeen: oldDate,
          lastSeen: oldDate,
          resolvedAt: null,
        },
        {
          id: 'fe-recent-unresolved',
          name: 'voucher_created',
          ledger: 200,
          raw: '{}',
          error: 'Unresolved error',
          attempts: 1,
          firstSeen: recentDate,
          lastSeen: recentDate,
          resolvedAt: null,
        },
      ],
    });

    const result = await purgeExpiredOperationalData({ retentionDays: 30, now });

    expect(result.deletedWebhooks).toBe(1);
    expect(result.deletedFailedEvents).toBe(1);

    // Verify remaining webhooks
    const remainingWhIds = (await prisma.webhookDelivery.findMany({ select: { id: true } })).map((w) => w.id);
    expect(remainingWhIds).not.toContain('wh-old-delivered');
    expect(remainingWhIds).toContain('wh-recent-delivered');
    expect(remainingWhIds).toContain('wh-old-pending');
    expect(remainingWhIds).toContain('wh-recent-pending');

    // Verify remaining failed events
    const remainingFeIds = (await prisma.failedEvent.findMany({ select: { id: true } })).map((f) => f.id);
    expect(remainingFeIds).not.toContain('fe-old-resolved');
    expect(remainingFeIds).toContain('fe-recent-resolved');
    expect(remainingFeIds).toContain('fe-old-unresolved');
    expect(remainingFeIds).toContain('fe-recent-unresolved');
  });

  it('stamps resolvedAt on successful retryFailed instead of hard deletion', async () => {
    const raw = {
      id: 'test-event-1',
      contractId: 'C'.repeat(56),
      ledger: 50,
      ledgerClosedAt: '2026-10-01T00:00:00Z',
      topic: ['AAAADwAAAA92b3VjaGVyX2NyZWF0ZWQA'], // symbol voucher_created
      value: 'AAAAEQAAAAEAAAAFAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAABycOAAAAADwAAAApjcmVhdGVkX2F0AAAAAAAFAAAAAGraLtQAAAAPAAAACmV4cGlyZXNfYXQAAAAAAAUAAAAAatovRwAAAA8AAAAMc2VydmljZV9jb2RlAAAAAwAAAGUAAAAPAAAACnZvdWNoZXJfaWQAAAAAAAUAAAAAAAAAAw==',
    };

    await recordFailure(
      prisma,
      raw as never,
      { id: 'test-event-1', name: 'voucher_created', ledger: 50, contractId: 'C'.repeat(56), txHash: 'a'.repeat(64), ledgerClosedAt: new Date(), fields: {} },
      new Error('boom'),
    );

    const initial = await prisma.failedEvent.findUniqueOrThrow({ where: { id: 'test-event-1' } });
    expect(initial.resolvedAt).toBeNull();

    // Retry successfully
    let applied = false;
    const res = await retryFailed(async () => {
      applied = true;
    });

    expect(applied).toBe(true);
    expect(res.recovered).toBe(1);
    expect(res.remaining).toBe(0);

    const afterRetry = await prisma.failedEvent.findUniqueOrThrow({ where: { id: 'test-event-1' } });
    expect(afterRetry.resolvedAt).toBeInstanceOf(Date);

    // Re-running retryFailed should not re-attempt already resolved events
    const secondRes = await retryFailed(async () => {});
    expect(secondRes.retried).toBe(0);
  });
});

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import {
  backfillDailyStats,
  recordDailyStatFunded,
  recordDailyStatRefunded,
  recordDailyStatSettled,
  utcDateString,
} from '../lib/daily-stats.js';
import { recordEventLatency, registry } from '../lib/metrics.js';
import { resetStatsCache } from '../routes/health.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
}, 30_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.dailyStat.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.servicePriceChange.deleteMany();
  await prisma.service.deleteMany();
  await prisma.providerStatusChange.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.indexerState.deleteMany();
  resetStatsCache();
});

describe('Issue #135: Pre-aggregated daily stats table maintained by indexer', () => {
  it('increments funded, settled, and refunded daily stats via helpers', async () => {
    const today = '2026-10-22';

    await prisma.$transaction(async (tx) => {
      await recordDailyStatFunded(tx, today, '50000000');
      await recordDailyStatFunded(tx, today, '25000000');
    });

    let stat = await prisma.dailyStat.findUnique({ where: { date: today } });
    expect(stat).not.toBeNull();
    expect(stat?.fundedCount).toBe(2);
    expect(stat?.fundedAmount).toBe('75000000');
    expect(stat?.settledCount).toBe(0);
    expect(stat?.settledAmount).toBe('0');
    expect(stat?.refundedCount).toBe(0);
    expect(stat?.refundedAmount).toBe('0');

    await prisma.$transaction(async (tx) => {
      await recordDailyStatSettled(tx, today, '50000000');
      await recordDailyStatRefunded(tx, today, '25000000');
    });

    stat = await prisma.dailyStat.findUnique({ where: { date: today } });
    expect(stat?.fundedCount).toBe(2);
    expect(stat?.fundedAmount).toBe('75000000');
    expect(stat?.settledCount).toBe(1);
    expect(stat?.settledAmount).toBe('50000000');
    expect(stat?.refundedCount).toBe(1);
    expect(stat?.refundedAmount).toBe('25000000');
  });

  it('backfills daily stats from vouchers and receipts idempotently', async () => {
    const d1 = new Date('2026-10-18T10:00:00Z');
    const d2 = new Date('2026-10-19T12:00:00Z');

    // Create provider first due to foreign key constraints if any
    await prisma.provider.create({
      data: {
        address: 'p1',
        name: 'Clinic One',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date('2026-09-01T00:00:00Z'),
      },
    });

    // Seed vouchers across different statuses and dates
    await prisma.voucher.createMany({
      data: [
        {
          id: 'v1',
          funder: 'funder1',
          beneficiaryRef: 'b1',
          providerAddress: 'p1',
          serviceCode: 1,
          amount: '10000000',
          status: 'Funded',
          createdAt: d1,
          expiresAt: new Date('2026-11-01T00:00:00Z'),
        },
        {
          id: 'v2',
          funder: 'funder1',
          beneficiaryRef: 'b1',
          providerAddress: 'p1',
          serviceCode: 1,
          amount: '20000000',
          status: 'Settled',
          createdAt: d1,
          expiresAt: new Date('2026-11-01T00:00:00Z'),
        },
        {
          id: 'v3',
          funder: 'funder1',
          beneficiaryRef: 'b1',
          providerAddress: 'p1',
          serviceCode: 1,
          amount: '15000000',
          status: 'Refunded',
          createdAt: d1,
          refundedAt: d2,
          expiresAt: new Date('2026-11-01T00:00:00Z'),
        },
      ],
    });

    // Create receipt for settled voucher v2
    await prisma.receipt.create({
      data: {
        voucherId: 'v2',
        beneficiaryRef: 'b1',
        providerAddress: 'p1',
        serviceCode: 1,
        amount: '20000000',
        settledAt: d2,
      },
    });

    // Run backfill
    await backfillDailyStats(prisma);

    const stats = await prisma.dailyStat.findMany({ orderBy: { date: 'asc' } });
    expect(stats.length).toBe(2);

    const day1 = stats.find((s) => s.date === '2026-10-18');
    expect(day1).toBeDefined();
    expect(day1?.fundedCount).toBe(3);
    expect(day1?.fundedAmount).toBe('45000000');
    expect(day1?.settledCount).toBe(0);
    expect(day1?.settledAmount).toBe('0');
    expect(day1?.refundedCount).toBe(0);
    expect(day1?.refundedAmount).toBe('0');

    const day2 = stats.find((s) => s.date === '2026-10-19');
    expect(day2).toBeDefined();
    expect(day2?.fundedCount).toBe(0);
    expect(day2?.fundedAmount).toBe('0');
    expect(day2?.settledCount).toBe(1);
    expect(day2?.settledAmount).toBe('20000000');
    expect(day2?.refundedCount).toBe(1);
    expect(day2?.refundedAmount).toBe('15000000');

    // Run backfill a second time - verify idempotency
    await backfillDailyStats(prisma);
    const statsAfterReplay = await prisma.dailyStat.findMany({ orderBy: { date: 'asc' } });
    const stripUpdatedAt = (items: typeof stats) => items.map(({ updatedAt: _, ...rest }) => rest);
    expect(stripUpdatedAt(statsAfterReplay)).toEqual(stripUpdatedAt(stats));
  }, 30_000);

  it('GET /stats/daily queries DailyStat and returns filled days with zero defaults', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await prisma.dailyStat.create({
      data: {
        date: today,
        fundedCount: 5,
        fundedAmount: '500000000',
        settledCount: 2,
        settledAmount: '200000000',
        refundedCount: 1,
        refundedAmount: '100000000',
      },
    });

    const res = await app.inject({ method: 'GET', url: '/stats/daily?days=7' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.series).toHaveLength(7);
    const todayEntry = body.series.find((d: { date: string }) => d.date === today);
    expect(todayEntry).toBeDefined();
    expect(todayEntry.funded).toEqual({ count: 5, amount: '500000000' });
    expect(todayEntry.settled).toEqual({ count: 2, amount: '200000000' });
    expect(todayEntry.refunded).toEqual({ count: 1, amount: '100000000' });

    // Other days in the 7-day range should be default zeros
    const emptyDays = body.series.filter((d: { date: string }) => d.date !== today);
    expect(emptyDays.length).toBe(6);
    for (const empty of emptyDays) {
      expect(empty.funded).toEqual({ count: 0, amount: '0' });
      expect(empty.settled).toEqual({ count: 0, amount: '0' });
      expect(empty.refunded).toEqual({ count: 0, amount: '0' });
    }
  }, 30_000);
});

/**
 * Issue #306: CI used to run only in UTC, so a day boundary that drifted in
 * Lagos or Nairobi was invisible until it was deployed. These pin the two
 * places a local calendar could leak in — which day an instant is billed to,
 * and where the response window starts and ends — under every zone the CI
 * matrix runs, rather than trusting the ambient one.
 *
 * The matrix pair east of UTC is not enough on its own. UTC midnight plus a
 * positive offset is still the same calendar date, so a window built from
 * local fields reads correctly in Lagos and Kiritimati alike; only a zone
 * west of UTC, where the instant just after midnight UTC belongs to
 * yesterday, can see that bug. It costs nothing to assert here, so it is in
 * the loop even though it is not a CI entry.
 */
describe('Issue #306: day boundaries are UTC in every time zone', () => {
  const realTz = process.env.TZ;
  const ZONES = ['UTC', 'Africa/Lagos', 'Pacific/Kiritimati', 'America/New_York'] as const;

  afterEach(() => {
    vi.useRealTimers();
    if (realTz === undefined) delete process.env.TZ;
    else process.env.TZ = realTz;
  });

  it('reads a date string as the instant it names, not as its own prefix', () => {
    // Two in the morning with a +05:00 offset is still the previous UTC
    // evening. Slicing the first ten characters off the string answers the
    // 2nd, and that day then reaches `/stats/daily`.
    expect(utcDateString('2026-10-02T02:00:00+05:00')).toBe('2026-10-01');
    // A bare calendar date denotes the UTC midnight it is already at.
    expect(utcDateString('2026-10-01')).toBe('2026-10-01');

    for (const tz of ZONES) {
      process.env.TZ = tz;
      expect(utcDateString('2026-10-02T02:00:00+05:00')).toBe('2026-10-01');
    }
  });

  it('bills an instant to its UTC day wherever the process runs', async () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      // Late on 1 October UTC is already 2 October in Lagos (UTC+1), and
      // 12:30 on 2 October in Kiritimati (UTC+14).
      const late = new Date('2026-10-01T23:30:00Z');
      const early = new Date('2026-10-02T00:30:00Z');

      expect(utcDateString(late)).toBe('2026-10-01');
      expect(utcDateString(early)).toBe('2026-10-02');

      await prisma.$transaction(async (tx) => {
        await recordDailyStatFunded(tx, late, '10000000');
        await recordDailyStatFunded(tx, early, '20000000');
        await recordDailyStatSettled(tx, late, '9000000');
        await recordDailyStatRefunded(tx, early, '1000000');
      });

      expect(await prisma.dailyStat.findUnique({ where: { date: '2026-10-01' } })).toMatchObject({
        fundedCount: 1,
        fundedAmount: '10000000',
        settledCount: 1,
        refundedCount: 0,
      });
      expect(await prisma.dailyStat.findUnique({ where: { date: '2026-10-02' } })).toMatchObject({
        fundedCount: 1,
        fundedAmount: '20000000',
        settledCount: 0,
        refundedCount: 1,
      });
      await prisma.dailyStat.deleteMany();
    }
  }, 30_000);

  it('backfills vouchers and receipts onto their UTC days in every zone', async () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      await prisma.provider.create({
        data: {
          address: 'p306',
          name: 'Boundary Clinic',
          country: 'NG',
          status: 'Active',
          registeredAt: new Date('2026-09-01T00:00:00Z'),
        },
      });
      await prisma.voucher.create({
        data: {
          id: 'v306',
          funder: 'funder306',
          beneficiaryRef: 'b306',
          providerAddress: 'p306',
          serviceCode: 1,
          amount: '30000000',
          status: 'Refunded',
          createdAt: new Date('2026-10-01T23:30:00Z'),
          refundedAt: new Date('2026-10-02T00:30:00Z'),
          expiresAt: new Date('2026-11-01T00:00:00Z'),
        },
      });

      expect(await backfillDailyStats(prisma)).toBe(2);
      const rows = await prisma.dailyStat.findMany({ orderBy: { date: 'asc' } });
      expect(rows.map((r) => r.date)).toEqual(['2026-10-01', '2026-10-02']);
      expect(rows[0]).toMatchObject({ fundedCount: 1, refundedCount: 0 });
      expect(rows[1]).toMatchObject({ fundedCount: 0, refundedCount: 1 });

      await prisma.receipt.deleteMany();
      await prisma.voucher.deleteMany();
      await prisma.provider.deleteMany();
      await prisma.dailyStat.deleteMany();
    }
  }, 30_000);

  it('builds the /stats/daily window from UTC days in every zone', async () => {
    for (const tz of ZONES) {
      process.env.TZ = tz;
      // The clock is fixed at an instant where Lagos and Kiritimati are
      // already on 2 October, so a window anchored on the local calendar is
      // a different three days there; New York is where a window *labelled*
      // from local fields drops a day. Fixing the clock also means the
      // assertion is not a race with when the job happened to run.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-01T23:30:00Z'));
      resetStatsCache();

      const res = await app.inject({ method: 'GET', url: '/stats/daily?days=3' });
      vi.useRealTimers();

      expect(res.statusCode).toBe(200);
      const dates = (res.json() as { series: { date: string }[] }).series.map((d) => d.date);
      expect(dates).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
    }
  }, 30_000);
});

describe('Issue #136: In-memory cache for /stats between ledgers', () => {
  it('serves repeated /stats requests from memory within the same ledger', async () => {
    // Set indexer state
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: 100, updatedAt: new Date() },
      update: { lastLedger: 100, updatedAt: new Date() },
    });

    const providerCountSpy = vi.spyOn(prisma.provider, 'count');

    // First request - populates cache
    const res1 = await app.inject({ method: 'GET', url: '/stats' });
    expect(res1.statusCode).toBe(200);
    const callsAfterFirst = providerCountSpy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second request with same ledger - served from cache
    const res2 = await app.inject({ method: 'GET', url: '/stats' });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toEqual(res1.json());
    // Provider count shouldn't have been called again
    expect(providerCountSpy.mock.calls.length).toBe(callsAfterFirst);

    // Advance ledger
    await prisma.indexerState.update({
      where: { id: 1 },
      data: { lastLedger: 101 },
    });

    // Third request - ledger changed, cache invalidated and recomputed
    const res3 = await app.inject({ method: 'GET', url: '/stats' });
    expect(res3.statusCode).toBe(200);
    expect(providerCountSpy.mock.calls.length).toBeGreaterThan(callsAfterFirst);

    // Resetting cache also forces recomputation
    const callsAfterThird = providerCountSpy.mock.calls.length;
    resetStatsCache();
    const res4 = await app.inject({ method: 'GET', url: '/stats' });
    expect(res4.statusCode).toBe(200);
    expect(providerCountSpy.mock.calls.length).toBeGreaterThan(callsAfterThird);

    providerCountSpy.mockRestore();
  }, 30_000);
});

describe('Issue #137: Measure ledger-to-indexed latency', () => {
  it('records event latency into indexerEventLatency histogram', async () => {
    const closedAt = new Date(Date.now() - 3500); // 3.5s ago
    const now = Date.now();

    recordEventLatency(closedAt, now);

    // Metric should be populated in registry
    const metricsText = await registry.metrics();
    expect(metricsText).toContain('indexer_event_latency_seconds_bucket');
    expect(metricsText).toContain('indexer_event_latency_seconds_count');
    expect(metricsText).toContain('indexer_event_latency_seconds_sum');
  });

  it('exposes indexer_event_latency_seconds on GET /metrics', async () => {
    recordEventLatency(new Date(Date.now() - 1000));

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('indexer_event_latency_seconds');
  });
});

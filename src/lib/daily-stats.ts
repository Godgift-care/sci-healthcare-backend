import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '../db.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** Formats a Date or date string as YYYY-MM-DD in UTC. */
export function utcDateString(date: Date | string): string {
  // A string goes through `Date` rather than a prefix: `'…T02:00:00+05:00'`
  // starts on the 2nd locally and on the 1st in UTC, and the first is the
  // kind of day that shows up in a Lagos deployment.
  const instant = typeof date === 'string' ? new Date(date) : date;
  return instant.toISOString().slice(0, 10);
}

/** The bucket size `GET /stats/daily` can answer. */
export type Granularity = 'day' | 'week' | 'month';

/** One `DailyStat` row, as the aggregation needs it. */
export type DailyStatRow = {
  date: string;
  fundedCount: number;
  fundedAmount: string;
  settledCount: number;
  settledAmount: string;
  refundedCount: number;
  refundedAmount: string;
};

/** One point of the response series. */
export type DailySeriesPoint = {
  date: string;
  funded: { count: number; amount: string };
  settled: { count: number; amount: string };
  refunded: { count: number; amount: string };
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The first day of the bucket a UTC day belongs to.
 *
 * Weeks are ISO 8601 weeks, which start on Monday and are computed in UTC so
 * a server west of Greenwich cannot shift a day into the previous week. The
 * label of a week is its Monday; the label of a month is its first day.
 */
export function periodStart(date: string, granularity: Granularity): string {
  if (granularity === 'month') return `${date.slice(0, 7)}-01`;
  if (granularity === 'day') return date;

  const instant = new Date(`${date}T00:00:00.000Z`);
  const daysSinceMonday = (instant.getUTCDay() + 6) % 7;
  return new Date(instant.getTime() - daysSinceMonday * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Sums `DailyStat` rows into day, week or month buckets, exactly.
 *
 * Amounts are i128 base-unit strings, so every sum stays in `BigInt`; a
 * bucket equal to the sum of its underlying days is the acceptance criterion,
 * and floating-point addition cannot promise that above 2^53.
 *
 * With `fill`, every bucket the window touches is returned in ascending date
 * order, zeroed when no row exists. Without it only buckets backed by at least
 * one row are returned, which is the sparse shape clients used to receive.
 */
export function aggregateDailySeries(
  rows: readonly DailyStatRow[],
  fromDate: string,
  toDate: string,
  granularity: Granularity,
  fill: boolean,
): DailySeriesPoint[] {
  const buckets = new Map<
    string,
    {
      fundedCount: number;
      fundedAmount: bigint;
      settledCount: number;
      settledAmount: bigint;
      refundedCount: number;
      refundedAmount: bigint;
    }
  >();

  for (const row of rows) {
    const key = periodStart(row.date, granularity);
    const bucket = buckets.get(key) ?? {
      fundedCount: 0,
      fundedAmount: 0n,
      settledCount: 0,
      settledAmount: 0n,
      refundedCount: 0,
      refundedAmount: 0n,
    };
    bucket.fundedCount += row.fundedCount;
    bucket.fundedAmount += BigInt(row.fundedAmount);
    bucket.settledCount += row.settledCount;
    bucket.settledAmount += BigInt(row.settledAmount);
    bucket.refundedCount += row.refundedCount;
    bucket.refundedAmount += BigInt(row.refundedAmount);
    buckets.set(key, bucket);
  }

  const series: DailySeriesPoint[] = [];
  const start = Date.parse(`${fromDate}T00:00:00.000Z`);
  const end = Date.parse(`${toDate}T00:00:00.000Z`);
  const seen = new Set<string>();

  for (let instant = start; instant <= end; instant += MS_PER_DAY) {
    const date = new Date(instant).toISOString().slice(0, 10);
    const key = periodStart(date, granularity);
    if (seen.has(key)) continue;
    seen.add(key);

    const bucket = buckets.get(key);
    if (bucket === undefined && !fill) continue;
    series.push({
      date: key,
      funded: {
        count: bucket?.fundedCount ?? 0,
        amount: (bucket?.fundedAmount ?? 0n).toString(),
      },
      settled: {
        count: bucket?.settledCount ?? 0,
        amount: (bucket?.settledAmount ?? 0n).toString(),
      },
      refunded: {
        count: bucket?.refundedCount ?? 0,
        amount: (bucket?.refundedAmount ?? 0n).toString(),
      },
    });
  }

  return series;
}

export async function recordDailyStatFunded(
  db: Prisma.TransactionClient,
  date: Date | string,
  amount: string,
): Promise<void> {
  const dateStr = utcDateString(date);
  const existing = await db.dailyStat.findUnique({ where: { date: dateStr } });
  await db.dailyStat.upsert({
    where: { date: dateStr },
    create: {
      date: dateStr,
      fundedCount: 1,
      fundedAmount: amount,
    },
    update: {
      fundedCount: (existing?.fundedCount ?? 0) + 1,
      fundedAmount: (BigInt(existing?.fundedAmount ?? '0') + BigInt(amount)).toString(),
    },
  });
}

export async function recordDailyStatSettled(
  db: Prisma.TransactionClient,
  date: Date | string,
  amount: string,
): Promise<void> {
  const dateStr = utcDateString(date);
  const existing = await db.dailyStat.findUnique({ where: { date: dateStr } });
  await db.dailyStat.upsert({
    where: { date: dateStr },
    create: {
      date: dateStr,
      settledCount: 1,
      settledAmount: amount,
    },
    update: {
      settledCount: (existing?.settledCount ?? 0) + 1,
      settledAmount: (BigInt(existing?.settledAmount ?? '0') + BigInt(amount)).toString(),
    },
  });
}

export async function recordDailyStatRefunded(
  db: Prisma.TransactionClient,
  date: Date | string,
  amount: string,
): Promise<void> {
  const dateStr = utcDateString(date);
  const existing = await db.dailyStat.findUnique({ where: { date: dateStr } });
  await db.dailyStat.upsert({
    where: { date: dateStr },
    create: {
      date: dateStr,
      refundedCount: 1,
      refundedAmount: amount,
    },
    update: {
      refundedCount: (existing?.refundedCount ?? 0) + 1,
      refundedAmount: (BigInt(existing?.refundedAmount ?? '0') + BigInt(amount)).toString(),
    },
  });
}

/**
 * Rebuilds the DailyStat table from all vouchers and receipts.
 * Returns the number of distinct UTC dates backfilled.
 */
export async function backfillDailyStats(db: Db = prisma): Promise<number> {
  const [vouchers, receipts] = await Promise.all([
    db.voucher.findMany({
      select: { amount: true, createdAt: true, refundedAt: true },
    }),
    db.receipt.findMany({
      select: { amount: true, settledAt: true },
    }),
  ]);

  type Accumulator = {
    fundedCount: number;
    fundedAmount: bigint;
    settledCount: number;
    settledAmount: bigint;
    refundedCount: number;
    refundedAmount: bigint;
  };

  const byDate = new Map<string, Accumulator>();
  const getOrCreate = (dateStr: string): Accumulator => {
    let entry = byDate.get(dateStr);
    if (!entry) {
      entry = {
        fundedCount: 0,
        fundedAmount: 0n,
        settledCount: 0,
        settledAmount: 0n,
        refundedCount: 0,
        refundedAmount: 0n,
      };
      byDate.set(dateStr, entry);
    }
    return entry;
  };

  for (const v of vouchers) {
    const fundedDate = utcDateString(v.createdAt);
    const f = getOrCreate(fundedDate);
    f.fundedCount += 1;
    f.fundedAmount += BigInt(v.amount);

    if (v.refundedAt) {
      const refundedDate = utcDateString(v.refundedAt);
      const r = getOrCreate(refundedDate);
      r.refundedCount += 1;
      r.refundedAmount += BigInt(v.amount);
    }
  }

  for (const rc of receipts) {
    const settledDate = utcDateString(rc.settledAt);
    const s = getOrCreate(settledDate);
    s.settledCount += 1;
    s.settledAmount += BigInt(rc.amount);
  }

  await db.dailyStat.deleteMany();

  for (const [date, acc] of byDate) {
    await db.dailyStat.create({
      data: {
        date,
        fundedCount: acc.fundedCount,
        fundedAmount: acc.fundedAmount.toString(),
        settledCount: acc.settledCount,
        settledAmount: acc.settledAmount.toString(),
        refundedCount: acc.refundedCount,
        refundedAmount: acc.refundedAmount.toString(),
      },
    });
  }

  return byDate.size;
}

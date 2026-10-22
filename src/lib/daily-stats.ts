import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma } from '../db.js';

type Db = Prisma.TransactionClient | PrismaClient;

/** Formats a Date or date string as YYYY-MM-DD in UTC. */
export function utcDateString(date: Date | string): string {
  if (typeof date === 'string') {
    return date.slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
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

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { server } from '../stellar/client.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const dailyQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

/** Count and summed base units for one activity type on one day. */
type DailyBucket = { count: number; amount: string };

type DailyRow = {
  date: string;
  funded: DailyBucket;
  settled: DailyBucket;
  refunded: DailyBucket;
};

/** The `YYYY-MM-DD` UTC day a timestamp falls on. */
function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  /**
   * Readiness, including how far the indexer trails the chain. A large or
   * growing lag is the first symptom of nearly every problem this service
   * can have, so it is surfaced rather than buried in logs.
   */
  app.get('/ready', async (_req, reply) => {
    const checks: Record<string, unknown> = {};
    let healthy = true;

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch (err) {
      healthy = false;
      checks.database = `error: ${(err as Error).message}`;
    }

    try {
      const [latest, state] = await Promise.all([
        server.getLatestLedger(),
        prisma.indexerState.findUnique({ where: { id: 1 } }),
      ]);
      const lag = state ? latest.sequence - state.lastLedger : null;
      checks.rpc = 'ok';
      checks.latestLedger = latest.sequence;
      checks.indexedLedger = state?.lastLedger ?? null;
      checks.lagLedgers = lag;
      // Configurable: roughly 5s per ledger, so the default of 120 ledgers
      // is about 10 minutes behind.
      checks.maxLagLedgers = env.READY_MAX_LAG_LEDGERS;
      if (lag !== null && lag > env.READY_MAX_LAG_LEDGERS) {
        healthy = false;
        checks.indexer = 'lagging';
      } else {
        checks.indexer = 'ok';
      }
    } catch (err) {
      healthy = false;
      checks.rpc = `error: ${(err as Error).message}`;
    }

    checks.network = env.STELLAR_NETWORK;
    checks.contracts = {
      registry: env.REGISTRY_CONTRACT_ID,
      voucher: env.VOUCHER_CONTRACT_ID,
      receipt: env.RECEIPT_CONTRACT_ID,
    };

    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'degraded', checks });
  });

  /** Aggregate counters for the dashboard. */
  app.get('/stats', async () => {
    const [providers, activeProviders, vouchers, settled, receipts] = await Promise.all([
      prisma.provider.count(),
      prisma.provider.count({ where: { status: 'Active' } }),
      prisma.voucher.count(),
      prisma.voucher.findMany({
        where: { status: 'Settled' },
        select: { amount: true },
      }),
      prisma.receipt.count(),
    ]);

    const settledValue = settled
      .reduce((acc, v) => acc + BigInt(v.amount), 0n)
      .toString();

    return {
      providers,
      activeProviders,
      vouchers,
      settledVouchers: settled.length,
      settledValue,
      receipts,
    };
  });

  /**
   * Protocol activity as a per-UTC-day time series.
   *
   * Counters are cumulative, which hides whether anything happened this
   * month. This is the same funded / settled / refunded split as the totals,
   * but bucketed by day so growth is visible.
   *
   * Days with no activity are present with zero counts and a "0" amount, so
   * a chart does not have to fill gaps itself. Amounts are exact base-unit
   * strings, summed with BigInt — never floats.
   */
  app.get('/stats/daily', async (req, reply) => {
    const parsed = dailyQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { days } = parsed.data;

    // Anchor the window to UTC midnight so a day boundary is a day boundary
    // regardless of the server's timezone. `to` is exclusive for the query.
    const now = new Date();
    const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const fromMs = todayUtcMs - (days - 1) * MS_PER_DAY;
    const from = new Date(fromMs);
    const to = new Date(todayUtcMs + MS_PER_DAY);

    const [funded, settled, refunded] = await Promise.all([
      prisma.voucher.findMany({
        where: { createdAt: { gte: from, lt: to } },
        select: { amount: true, createdAt: true },
      }),
      prisma.receipt.findMany({
        where: { settledAt: { gte: from, lt: to } },
        select: { amount: true, settledAt: true },
      }),
      prisma.voucher.findMany({
        where: { refundedAt: { gte: from, lt: to } },
        select: { amount: true, refundedAt: true },
      }),
    ]);

    const series: DailyRow[] = [];
    const byDate = new Map<string, DailyRow>();
    for (let i = 0; i < days; i += 1) {
      const row: DailyRow = {
        date: utcDate(new Date(fromMs + i * MS_PER_DAY)),
        funded: { count: 0, amount: '0' },
        settled: { count: 0, amount: '0' },
        refunded: { count: 0, amount: '0' },
      };
      series.push(row);
      byDate.set(row.date, row);
    }

    const add = (at: Date, amount: string, key: 'funded' | 'settled' | 'refunded'): void => {
      const row = byDate.get(utcDate(at));
      if (!row) return;
      const bucket = row[key];
      bucket.count += 1;
      bucket.amount = (BigInt(bucket.amount) + BigInt(amount)).toString();
    };

    for (const v of funded) add(v.createdAt, v.amount, 'funded');
    for (const r of settled) add(r.settledAt, r.amount, 'settled');
    for (const v of refunded) if (v.refundedAt) add(v.refundedAt, v.amount, 'refunded');

    return {
      days,
      from: from.toISOString(),
      to: new Date(todayUtcMs).toISOString(),
      series,
    };
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env, WEBHOOKS_ENABLED } from '../env.js';
import { lastIndexedLedger } from '../lib/cache.js';
import { isPostgres } from '../lib/database.js';
import { webhookBacklog } from '../lib/webhooks.js';
import { APP_VERSION, deployedCommit, STARTED_AT } from '../lib/version.js';
import { server } from '../stellar/client.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const dailyQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const funnelQuery = z.object({
  country: z.string().length(2).transform((country) => country.toUpperCase()).optional(),
  clinic: z.string().min(1).max(56).optional(),
});

const funnelResponse = z.object({
  country: z.string().nullable(),
  clinic: z.string().nullable(),
  counts: z.object({
    funded: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
    attested: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
  }),
  medianHours: z.object({
    fundedToClaimed: z.number().nonnegative().nullable(),
    claimedToAttested: z.number().nonnegative().nullable(),
    attestedToSettled: z.number().nonnegative().nullable(),
  }),
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

/** Median elapsed hours; incomplete and reversed timestamps are excluded. */
function medianHours(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1
    ? values[middle]!
    : (values[middle - 1]! + values[middle]!) / 2;
}

function elapsedHours(from: Date, to: Date): number | null {
  const hours = (to.getTime() - from.getTime()) / 3_600_000;
  return hours >= 0 ? hours : null;
}

/** Settled-voucher totals for `GET /stats` (issue #60). */
type SettledTotals = {
  settledVouchers: number;
  settledValue: string;
  feesCollected: string;
};

/**
 * Count and summed base units of settled vouchers, in exact i128 strings.
 *
 * On Postgres the sums are computed **in SQL** (#60): `SUM(x::numeric)` is
 * arbitrary-precision, so it is exact for every amount the chain can
 * produce, and the route stops fetching every settled voucher just to add
 * them up in JavaScript — the scaling problem the issue names. The cast
 * also works today, while the deploy columns are still `text` (decimal
 * strings), and is a no-op once
 * `prisma/postgres-pending/20260107000000_amount_numeric_to_decimal`
 * lands, so this query needs no change when the migration is promoted.
 *
 * On SQLite the BigInt pass stays: SQLite's arithmetic caps integers at
 * 2^63-1 and promotes larger sums to float64, so a SQL sum there would be
 * inexact for exactly the values these columns exist to hold ("i128 as
 * strings, never numbers"). Dropping this branch is the maintainers' call
 * once dev/test run on Postgres (issue #14); see
 * `docs/amount-numeric-migration-plan.md`.
 */
async function settledTotals(): Promise<SettledTotals> {
  if (isPostgres) {
    const [row] = await prisma.$queryRaw<SettledTotals[]>`
      SELECT
        COUNT(*)::int AS "settledVouchers",
        COALESCE(SUM("amount"::numeric), 0)::text AS "settledValue",
        COALESCE(SUM("settledFee"::numeric), 0)::text AS "feesCollected"
      FROM "Voucher"
      WHERE "status" = 'Settled'`;
    // An aggregate SELECT without GROUP BY returns exactly one row. If the
    // driver ever says otherwise, that is a bug in this query or the
    // connection; fail loud rather than serve a fabricated zero.
    if (!row) throw new Error('settledTotals: Postgres aggregate returned no row');
    return row;
  }

  const settled = await prisma.voucher.findMany({
    where: { status: 'Settled' },
    select: { amount: true, settledFee: true },
  });
  return {
    settledVouchers: settled.length,
    settledValue: settled.reduce((acc, v) => acc + BigInt(v.amount), 0n).toString(),
    // #52: what the protocol has earned, in the same exact i128 base-unit
    // string as every other amount. Summed with BigInt because settled fees
    // can exceed Number.MAX_SAFE_INTEGER; a settled voucher from before the
    // fee column existed carries no fee and contributes nothing.
    feesCollected: settled.reduce((acc, v) => acc + BigInt(v.settledFee ?? '0'), 0n).toString(),
  };
}

type StatsResponse = {
  providers: number;
  activeProviders: number;
  vouchers: number;
  settledVouchers: number;
  settledValue: string;
  feesCollected: string;
  receipts: number;
  faucetDrips: number;
  faucetWallets: number;
};

type CachedStats = {
  ledger: number;
  data: StatsResponse;
};

let statsCache: CachedStats | null = null;

export function resetStatsCache(): void {
  statsCache = null;
}

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // The app-level onSend hook sends `Cache-Control: no-store` on this and
  // /ready; both are probed continuously and must reflect the current state.
  app.get('/health', {
    schema: { tags: ['health'], summary: 'Liveness check' },
  }, async () => ({ status: 'ok' }));

  /**
   * Version and deployment metadata.
   *
   * The first question in an incident is which build is running and which
   * chain and contracts it indexes. This answers it without shell access:
   * the package version, the deployed commit when the platform exposes one,
   * the network, the RPC endpoints in use, the contract ids, the ledger the
   * indexer was configured to start from, and when this process started.
   *
   * Response fields are deliberately allow-listed. Nothing from the
   * environment is spread wholesale, so a new secret variable cannot leak
   * here by accident; `DATABASE_URL` and any credential in an RPC URL are
   * never included.
   */
  app.get('/version', {
    schema: {
      tags: ['health'],
      summary: 'Version and deployment info',
      description:
        'Reports the build version and commit, the configured Stellar network, ' +
        'the RPC endpoints in use (redacted), the indexed contract ids, the ' +
        'configured indexer start ledger, and when this process started.',
    },
  }, async () => {
    return {
      // Read from package.json at startup, so it always matches the code.
      version: APP_VERSION,
      // RENDER_GIT_COMMIT on Render, GIT_COMMIT elsewhere; null when neither
      // is set rather than a fabricated value.
      commit: deployedCommit(),
      network: env.STELLAR_NETWORK,
      // The endpoint currently in use, which failover may have moved.
      rpcUrl: server.activeUrl,
      rpcUrls: server.allUrls,
      contracts: {
        registry: env.REGISTRY_CONTRACT_ID,
        voucher: env.VOUCHER_CONTRACT_ID,
        receipt: env.RECEIPT_CONTRACT_ID,
        usdc: env.USDC_CONTRACT_ID ?? null,
        faucet: env.FAUCET_CONTRACT_ID ?? null,
      },
      // The configured first ledger for this deployment. 0 means "the tip
      // when the indexer first ran", which is why the cursor itself stays
      // on /ready as checks.indexedLedger.
      indexerStartLedger: env.INDEXER_START_LEDGER,
      // Process start, not the build time: with several replicas this tells
      // an operator which one they are looking at and how long it has run.
      startedAt: STARTED_AT,
    };
  });

  /**
   * Readiness, including how far the indexer trails the chain. A large or
   * growing lag is the first symptom of nearly every problem this service
   * can have, so it is surfaced rather than buried in logs.
   */
  app.get('/ready', {
    schema: {
      tags: ['health'],
      summary: 'Readiness check',
      description:
        'Reports indexer lag, RPC retention gaps, database connectivity, failed ' +
        'events and the webhook outbox backlog.',
    },
  }, async (_req, reply) => {
    const checks: Record<string, unknown> = {};
    let healthy = true;

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
      // A failed event is missing data in the read model, so it is a
      // degradation until someone retries or investigates it.
      const failedEvents = await prisma.failedEvent.count();
      checks.failedEvents = failedEvents;
      if (failedEvents > 0) healthy = false;

      // Drift found by `npm run indexer:reconcile`. Reported but not fatal:
      // unlike a failed event, which is a write the indexer knows it lost,
      // a stale mismatch row says nothing about whether this instance can
      // serve traffic, and 503 would pull a working API out of rotation.
      const reconcileMismatches = await prisma.reconcileMismatch.count();
      checks.reconcileMismatches = reconcileMismatches;
      checks.reconcile = reconcileMismatches > 0 ? 'drift' : 'ok';

      // Failed or stuck webhook deliveries pile up in the outbox without
      // failing anything else: the indexer keeps indexing and the API keeps
      // serving while clinics stop being notified. A delivery older than
      // `READY_WEBHOOK_MAX_AGE_MS` cannot be normal retry traffic — every
      // attempt resolves inside the backoff ceiling — so it is degraded.
      const backlog = await webhookBacklog();
      const webhookState = !WEBHOOKS_ENABLED
        ? 'disabled'
        : backlog.stale > 0
          ? 'backlog'
          : 'ok';
      checks.webhooks = {
        state: webhookState,
        enabled: WEBHOOKS_ENABLED,
        pending: backlog.pending,
        abandoned: backlog.abandoned,
        oldestPendingAgeSeconds: backlog.oldestPendingAgeSeconds,
        maxPendingAgeSeconds: env.READY_WEBHOOK_MAX_AGE_MS / 1000,
      };
      if (webhookState === 'backlog') healthy = false;
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
      checks.rpcUrl = server.activeUrl;
      checks.latestLedger = latest.sequence;
      checks.indexedLedger = state?.lastLedger ?? null;
      checks.lagLedgers = lag;
      checks.maxLagLedgers = env.READY_MAX_LAG_LEDGERS;
      checks.paused = state?.paused ?? false;

      if (state?.paused) {
        healthy = false;
        checks.indexer = 'paused';
      } else if (state?.gap) {
        healthy = false;
        checks.indexer = 'gap';
        checks.gap = {
          detected: true,
          cursorLedger: state.gapCursorLedger,
          oldestAvailable: state.gapOldestLedger,
          message:
            'Indexer cursor fell outside the RPC retention window. ' +
            'Restore a database snapshot at the cursor ledger, or ' +
            'accept the gap and resume from the oldest available ledger. ' +
            'See docs/RUNBOOK.md.',
        };
      } else if (lag !== null && lag > env.READY_MAX_LAG_LEDGERS) {
        healthy = false;
        checks.indexer = 'lagging';
      } else {
        checks.indexer = 'ok';
      }
    } catch (err) {
      healthy = false;
      // Every configured endpoint failed, not just the active one.
      checks.rpc = `error: ${(err as Error).message}`;
      checks.rpcUrl = server.activeUrl;
      checks.rpcUrls = server.allUrls;
    }

    checks.network = env.STELLAR_NETWORK;
    checks.contracts = {
      registry: env.REGISTRY_CONTRACT_ID,
      voucher: env.VOUCHER_CONTRACT_ID,
      receipt: env.RECEIPT_CONTRACT_ID,
    };

    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'degraded', checks });
  });

  app.get('/stats', {
    schema: { tags: ['health'], summary: 'Aggregate dashboard counters' },
  }, async () => {
    const currentLedger = await lastIndexedLedger();
    if (statsCache !== null && currentLedger !== null && statsCache.ledger === currentLedger) {
      return statsCache.data;
    }

    const [providers, activeProviders, vouchers, totals, receipts, faucetDrips, faucetWallets] =
      await Promise.all([
        prisma.provider.count(),
        prisma.provider.count({ where: { status: 'Active' } }),
        prisma.voucher.count(),
        settledTotals(),
        prisma.receipt.count(),
        prisma.faucetDrip.count(),
        // Distinct wallets, which is the figure worth reporting: one person
        // pressing the faucet button four times is not four people.
        prisma.faucetDrip.groupBy({ by: ['wallet'] }),
      ]);

    const result: StatsResponse = {
      providers,
      activeProviders,
      vouchers,
      settledVouchers: totals.settledVouchers,
      settledValue: totals.settledValue,
      feesCollected: totals.feesCollected,
      receipts,
      // Both are 0 when no FAUCET_CONTRACT_ID is configured, because no
      // drip event ever reaches the indexer.
      faucetDrips,
      faucetWallets: faucetWallets.length,
    };

    if (currentLedger !== null) {
      statsCache = { ledger: currentLedger, data: result };
    }

    return result;
  });

  /** Voucher stages and median time between them, optionally scoped to a country or clinic. */
  app.get('/stats/funnel', {
    schema: {
      tags: ['health'],
      summary: 'Voucher funnel counts and median stage times',
      querystring: funnelQuery,
      response: { 200: funnelResponse },
    },
  }, async (req) => {
    const { country, clinic } = funnelQuery.parse(req.query);
    const providerAddresses = country !== undefined || clinic !== undefined
      ? (await prisma.provider.findMany({
          where: { ...(country ? { country } : {}), ...(clinic ? { address: clinic } : {}) },
          select: { address: true },
        })).map((provider) => provider.address)
      : undefined;
    const providerFilter = providerAddresses === undefined
      ? {}
      : { providerAddress: { in: providerAddresses } };

    const [vouchers, receipts] = await Promise.all([
      prisma.voucher.findMany({
        where: providerFilter,
        select: { id: true, createdAt: true, claimedAt: true, attestedAt: true },
      }),
      prisma.receipt.findMany({
        where: providerAddresses === undefined
          ? {}
          : { providerAddress: { in: providerAddresses } },
        select: { voucherId: true, settledAt: true },
      }),
    ]);

    const byVoucherId = new Map(vouchers.map((voucher) => [voucher.id, voucher]));
    const claimTimes = vouchers.flatMap((voucher) => {
      if (!voucher.claimedAt) return [];
      const hours = elapsedHours(voucher.createdAt, voucher.claimedAt);
      return hours === null ? [] : [hours];
    });
    const attestationTimes = vouchers.flatMap((voucher) => {
      if (!voucher.claimedAt || !voucher.attestedAt) return [];
      const hours = elapsedHours(voucher.claimedAt, voucher.attestedAt);
      return hours === null ? [] : [hours];
    });
    const settlementTimes = receipts.flatMap((receipt) => {
      const voucher = byVoucherId.get(receipt.voucherId);
      if (!voucher?.attestedAt) return [];
      const hours = elapsedHours(voucher.attestedAt, receipt.settledAt);
      return hours === null ? [] : [hours];
    });

    return {
      country: country ?? null,
      clinic: clinic ?? null,
      counts: {
        funded: vouchers.length,
        claimed: vouchers.filter((voucher) => voucher.claimedAt !== null).length,
        attested: vouchers.filter((voucher) => voucher.attestedAt !== null).length,
        settled: receipts.length,
      },
      medianHours: {
        fundedToClaimed: medianHours(claimTimes),
        claimedToAttested: medianHours(attestationTimes),
        attestedToSettled: medianHours(settlementTimes),
      },
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

    const fromDateStr = utcDate(from);
    const toDateStr = utcDate(new Date(todayUtcMs));

    const stats = await prisma.dailyStat.findMany({
      where: {
        date: {
          gte: fromDateStr,
          lte: toDateStr,
        },
      },
    });

    const byDate = new Map<string, (typeof stats)[number]>();
    for (const s of stats) {
      byDate.set(s.date, s);
    }

    const series: DailyRow[] = [];
    for (let i = 0; i < days; i += 1) {
      const dateStr = utcDate(new Date(fromMs + i * MS_PER_DAY));
      const stat = byDate.get(dateStr);
      series.push({
        date: dateStr,
        funded: {
          count: stat?.fundedCount ?? 0,
          amount: stat?.fundedAmount ?? '0',
        },
        settled: {
          count: stat?.settledCount ?? 0,
          amount: stat?.settledAmount ?? '0',
        },
        refunded: {
          count: stat?.refundedCount ?? 0,
          amount: stat?.refundedAmount ?? '0',
        },
      });
    }

    return {
      days,
      from: from.toISOString(),
      to: new Date(todayUtcMs).toISOString(),
      series,
    };
  });
}

import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env, WEBHOOKS_ENABLED } from '../env.js';
import { clearLedgerMemos, lastIndexedLedger, ledgerMemo } from '../lib/cache.js';
import { aggregateDailySeries, utcDateString } from '../lib/daily-stats.js';
import { isPostgres } from '../lib/database.js';
import { webhookBacklog, webhookCircuitSnapshot } from '../lib/webhooks.js';
import { APP_VERSION, deployedCommit, STARTED_AT } from '../lib/version.js';
import { server } from '../stellar/client.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const dailyQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
  fill: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

const funnelQuery = z.object({
  country: z
    .string()
    .length(2)
    .transform((country) => country.toUpperCase())
    .optional(),
  clinic: z.string().min(1).max(56).optional(),
});

/** The precision `GET /stats/disputes` uses for its rate string. */
const DISPUTE_RATE_PRECISION = 4;

/** A status that can only have been reached after attestation. */
const ATTESTED_STATUSES = ['Attested', 'Settled', 'Disputed'] as const;

const disputeResponse = z.object({
  count: z.number().int().nonnegative().describe('Vouchers that were ever disputed.'),
  attestedVouchers: z
    .number()
    .int()
    .nonnegative()
    .describe('Vouchers that reached attestation, the denominator of the rate.'),
  rate: z
    .string()
    .describe(
      `Disputes divided by attested vouchers, fixed to ${DISPUTE_RATE_PRECISION} decimal places.`,
    ),
  byReason: z
    .record(z.string(), z.number().int().nonnegative())
    .describe('Disputed vouchers keyed by the contract reason code.'),
  byOutcome: z
    .record(z.string(), z.number().int().nonnegative())
    .describe('Resolved disputes keyed by Funder or Provider, plus unresolved disputes.'),
  medianResolutionHours: z
    .number()
    .nonnegative()
    .nullable()
    .describe(
      'Median hours from attestation (or creation when never attested) to dispute resolution; null when none resolved.',
    ),
});

/**
 * A ratio as a fixed-precision decimal string, without ever dividing in
 * floating point. Both engines see the same string, and a zero denominator
 * is "0.0000" rather than NaN.
 */
function fixedRate(numerator: number, denominator: number): string {
  const scale = 10n ** BigInt(DISPUTE_RATE_PRECISION);
  if (denominator === 0) return `0.${'0'.repeat(DISPUTE_RATE_PRECISION)}`;
  // Round half up at the last fixed digit; integer arithmetic keeps it exact.
  const scaled = (BigInt(numerator) * scale + BigInt(denominator) / 2n) / BigInt(denominator);
  const whole = scaled / scale;
  const fraction = (scaled % scale).toString().padStart(DISPUTE_RATE_PRECISION, '0');
  return `${whole}.${fraction}`;
}

const funnelResponse = z.object({
  country: z.string().nullable(),
  clinic: z.string().nullable(),
  counts: z.object({
    funded: z.number().int().nonnegative().nullable(),
    claimed: z.number().int().nonnegative().nullable(),
    attested: z.number().int().nonnegative().nullable(),
    settled: z.number().int().nonnegative().nullable(),
  }),
  suppressed: z.boolean(),
  medianHours: z.object({
    fundedToClaimed: z.number().nonnegative().nullable(),
    claimedToAttested: z.number().nonnegative().nullable(),
    attestedToSettled: z.number().nonnegative().nullable(),
  }),
});

/** Median elapsed hours; incomplete and reversed timestamps are excluded. */
function medianHours(values: number[]): number | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2;
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
 * them up in JavaScript — the scaling problem the issue names. The columns
 * are `NUMERIC(39,0)` since migration
 * `20261119000001_amount_numeric_to_decimal` (#273); the `::numeric` cast is
 * a no-op there and keeps the query valid on a not-yet-migrated `text` column.
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

/**
 * The computed answers for the aggregate routes, each tagged with the ledger
 * it was computed from (#320).
 *
 * `GET /stats` and `GET /stats/funnel` are the same numbers a dashboard asks
 * for on every visit, and both are full scans of the voucher and receipt
 * tables. The cursor is what makes caching them safe rather than clever:
 * nothing in the read model can change without the indexer advancing it.
 */
const statsMemo = ledgerMemo<StatsResponse>();
const funnelMemo = ledgerMemo<Awaited<ReturnType<typeof funnelStats>>>();

/**
 * Forgets every cached aggregate, so the next request recomputes.
 *
 * Exported for tests, which run against a fixture cursor that hardly moves:
 * without this, a case would be answered from the previous case's data.
 */
export function resetStatsCache(): void {
  clearLedgerMemos();
}

/**
 * Dispute counts, rate, breakdowns and resolution time (#245).
 *
 * A voucher counts as disputed when the contract moved it to `Disputed` or
 * when a reason code was recorded; the status alone would stop counting it
 * once a resolution moved it on to `Settled` or `Refunded`. Attested is the
 * denominator the issue asks for: a voucher can only be disputed after
 * attestation, so dividing by every funded voucher would understate the
 * rate. `attestedAt` is the normal signal; a row whose projection predates
 * it but whose status is past attestation still counts.
 */
async function disputeStats() {
  const disputed: Prisma.VoucherWhereInput = {
    OR: [{ status: 'Disputed' }, { disputeReason: { not: null } }],
  };
  const attested: Prisma.VoucherWhereInput = {
    OR: [{ attestedAt: { not: null } }, { status: { in: [...ATTESTED_STATUSES] } }],
  };

  const [count, attestedVouchers, reasons, outcomes, resolved] = await Promise.all([
    prisma.voucher.count({ where: disputed }),
    prisma.voucher.count({ where: attested }),
    prisma.voucher.groupBy({
      by: ['disputeReason'],
      where: { disputeReason: { not: null } },
      _count: { _all: true },
    }),
    prisma.voucher.groupBy({
      by: ['disputeOutcome'],
      where: { disputeOutcome: { not: null } },
      _count: { _all: true },
    }),
    prisma.voucher.findMany({
      where: { disputeResolvedAt: { not: null } },
      select: { createdAt: true, attestedAt: true, disputeResolvedAt: true },
    }),
  ]);

  const byReason: Record<string, number> = {};
  for (const row of reasons) {
    if (row.disputeReason === null) continue;
    byReason[String(row.disputeReason)] = row._count._all;
  }

  const byOutcome: Record<string, number> = { Funder: 0, Provider: 0 };
  let resolvedCount = 0;
  for (const row of outcomes) {
    if (row.disputeOutcome === null) continue;
    byOutcome[row.disputeOutcome] = row._count._all;
    resolvedCount += row._count._all;
  }
  // A disputed voucher with no resolution yet is neither outcome; show it so
  // Funder + Provider is not silently less than `count`.
  byOutcome.Unresolved = Math.max(0, count - resolvedCount);

  const resolutionHours = resolved.flatMap((row) => {
    const end = row.disputeResolvedAt;
    if (!end) return [];
    const start = row.attestedAt ?? row.createdAt;
    const hours = (end.getTime() - start.getTime()) / 3_600_000;
    return hours >= 0 ? [hours] : [];
  });

  return {
    count,
    attestedVouchers,
    rate: fixedRate(count, attestedVouchers),
    byReason,
    byOutcome,
    medianResolutionHours: medianHours(resolutionHours),
  };
}

/**
 * Voucher stages and median time between them for one ledger, optionally
 * scoped to a country or a clinic.
 *
 * The whole response is a function of the cursor plus these two filters, which
 * is what lets `funnelMemo` answer a repeated question without a read.
 */
async function funnelStats(country?: string, clinic?: string) {
  const providerAddresses =
    country !== undefined || clinic !== undefined
      ? (
          await prisma.provider.findMany({
            where: { ...(country ? { country } : {}), ...(clinic ? { address: clinic } : {}) },
            select: { address: true },
          })
        ).map((provider) => provider.address)
      : undefined;
  const providerFilter =
    providerAddresses === undefined ? {} : { providerAddress: { in: providerAddresses } };

  const [vouchers, receipts] = await Promise.all([
    prisma.voucher.findMany({
      where: providerFilter,
      select: { id: true, createdAt: true, claimedAt: true, attestedAt: true },
    }),
    prisma.receipt.findMany({
      where: providerAddresses === undefined ? {} : { providerAddress: { in: providerAddresses } },
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

  const rawCounts = {
    funded: vouchers.length,
    claimed: vouchers.filter((voucher) => voucher.claimedAt !== null).length,
    attested: vouchers.filter((voucher) => voucher.attestedAt !== null).length,
    settled: receipts.length,
  };

  // Small-cell suppression: apply only to scoped queries, not the global
  // aggregate, so dashboard totals are never null (#256). Zero is never
  // suppressed — it reveals nothing about individuals.
  const isScoped = country !== undefined || clinic !== undefined;
  const minCell = isScoped ? env.STATS_MIN_CELL : 0;
  const suppress = (n: number): number | null => (minCell > 0 && n > 0 && n < minCell ? null : n);
  const counts = {
    funded: suppress(rawCounts.funded),
    claimed: suppress(rawCounts.claimed),
    attested: suppress(rawCounts.attested),
    settled: suppress(rawCounts.settled),
  };
  const suppressed =
    counts.funded === null ||
    counts.claimed === null ||
    counts.attested === null ||
    counts.settled === null;

  return {
    country: country ?? null,
    clinic: clinic ?? null,
    counts,
    suppressed,
    medianHours: {
      fundedToClaimed: medianHours(claimTimes),
      claimedToAttested: medianHours(attestationTimes),
      attestedToSettled: medianHours(settlementTimes),
    },
  };
}

export function healthRoutes(app: FastifyInstance): void {
  // The app-level onSend hook sends `Cache-Control: no-store` on this and
  // /ready; both are probed continuously and must reflect the current state.
  app.get(
    '/health',
    {
      schema: { tags: ['health'], summary: 'Liveness check' },
    },
    () => ({ status: 'ok' }),
  );

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
  app.get(
    '/version',
    {
      schema: {
        tags: ['health'],
        summary: 'Version and deployment info',
        description:
          'Reports the build version and commit, the configured Stellar network, ' +
          'the RPC endpoints in use (redacted), the indexed contract ids, the ' +
          'configured indexer start ledger, and when this process started.',
      },
    },
    () => {
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
    },
  );

  /**
   * Readiness, including how far the indexer trails the chain. A large or
   * growing lag is the first symptom of nearly every problem this service
   * can have, so it is surfaced rather than buried in logs.
   */
  app.get(
    '/ready',
    {
      schema: {
        tags: ['health'],
        summary: 'Readiness check',
        description:
          'Reports indexer lag, RPC retention gaps, database connectivity, failed ' +
          'events, the webhook outbox backlog and per-endpoint circuit breakers.',
      },
    },
    async (_req, reply) => {
      const checks: Record<string, unknown> = {};
      let healthy = true;

      try {
        await prisma.$queryRaw`SELECT 1`;
        checks.database = 'ok';
        // A failed event is missing data in the read model, so it is a
        // degradation until someone retries or investigates it.
        const failedEvents = await prisma.failedEvent.count({ where: { resolvedAt: null } });
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
        const webhookState = !WEBHOOKS_ENABLED ? 'disabled' : backlog.stale > 0 ? 'backlog' : 'ok';
        checks.webhooks = {
          state: webhookState,
          enabled: WEBHOOKS_ENABLED,
          pending: backlog.pending,
          abandoned: backlog.abandoned,
          oldestPendingAgeSeconds: backlog.oldestPendingAgeSeconds,
          maxPendingAgeSeconds: env.READY_WEBHOOK_MAX_AGE_MS / 1000,
          // Per-endpoint breakers (#265). A tripped breaker is reported, not
          // degraded: the outbox is still holding those deliveries, and a
          // clinic outage must not pull a working API out of rotation.
          breakers: webhookCircuitSnapshot(),
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

      return reply
        .code(healthy ? 200 : 503)
        .send({ status: healthy ? 'ready' : 'degraded', checks });
    },
  );

  /**
   * Public indexer status. This is a single database snapshot plus one latest-
   * ledger RPC read, not a readiness dependency probe.
   */
  app.get(
    '/indexer',
    {
      schema: {
        tags: ['health'],
        summary: 'Public indexer status',
        description:
          'Returns the persisted indexer cursor and gap/pause state together with the latest RPC ledger.',
      },
    },
    async () => {
      const [state, latest] = await Promise.all([
        prisma.indexerState.findUnique({ where: { id: 1 } }),
        server.getLatestLedger(),
      ]);
      const lastLedger = state?.lastLedger ?? 0;
      return {
        lastLedger,
        latestLedger: latest.sequence,
        lagLedgers: latest.sequence - lastLedger,
        paused: state?.paused ?? false,
        gap: state?.gap ?? false,
        gapOldestLedger: state?.gapOldestLedger ?? null,
        updatedAt: state?.updatedAt.toISOString() ?? null,
      };
    },
  );

  app.get(
    '/stats',
    {
      schema: { tags: ['health'], summary: 'Aggregate dashboard counters' },
    },
    async () => {
      const currentLedger = await lastIndexedLedger();
      const cached = statsMemo.peek('', currentLedger);
      if (cached !== undefined) return cached;

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

      statsMemo.remember('', currentLedger, result);
      return result;
    },
  );

  /**
   * Dispute rate and how disputes end (#245).
   *
   * The count, the rate against attested vouchers, reason and outcome
   * breakdowns, and the median time to resolution. Counts are exact integers
   * and the rate is a fixed-precision string, so nothing here depends on the
   * database engine's numeric formatting.
   */
  app.get(
    '/stats/disputes',
    {
      schema: {
        tags: ['health'],
        summary: 'Dispute counts, rate, breakdowns and median resolution time',
        response: { 200: disputeResponse },
      },
    },
    async () => disputeStats(),
  );

  /** Voucher stages and median time between them, optionally scoped to a country or clinic. */
  app.get(
    '/stats/funnel',
    {
      schema: {
        tags: ['health'],
        summary: 'Voucher funnel counts and median stage times',
        querystring: funnelQuery,
        response: { 200: funnelResponse },
      },
    },
    async (req) => {
      const { country, clinic } = funnelQuery.parse(req.query);
      const currentLedger = await lastIndexedLedger();
      // The filters are part of the key: `?country=NG` and `?clinic=G…` are two
      // different questions, and answering either from the other's cache would
      // be a wrong number on a dashboard rather than a slow one.
      const key = `${country ?? ''}|${clinic ?? ''}`;
      const cached = funnelMemo.peek(key, currentLedger);
      if (cached !== undefined) return cached;

      const result = await funnelStats(country, clinic);
      funnelMemo.remember(key, currentLedger, result);
      return result;
    },
  );

  /**
   * Protocol activity as a time series.
   *
   * Counters are cumulative, which hides whether anything happened this
   * month. This is the same funded / settled / refunded split as the totals,
   * bucketed by UTC day, ISO week (Monday start) or calendar month, so a
   * year-long chart can ask for 12 points instead of 365.
   *
   * Days with no activity are present with zero counts and a "0" amount by
   * default, so a chart does not have to fill gaps itself; `fill=false`
   * returns only buckets that have a row. Amounts are exact base-unit
   * strings, summed with BigInt — never floats.
   */
  app.get('/stats/daily', async (req, reply) => {
    const parsed = dailyQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const { days, granularity, fill } = parsed.data;

    // Anchor the window to UTC midnight so a day boundary is a day boundary
    // regardless of the server's timezone. `to` is exclusive for the query.
    const now = new Date();
    const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const fromMs = todayUtcMs - (days - 1) * MS_PER_DAY;

    const fromDateStr = utcDateString(new Date(fromMs));
    const toDateStr = utcDateString(new Date(todayUtcMs));

    const stats = await prisma.dailyStat.findMany({
      where: {
        date: {
          gte: fromDateStr,
          lte: toDateStr,
        },
      },
      orderBy: { date: 'asc' },
    });

    return {
      days,
      granularity,
      fill,
      from: new Date(fromMs).toISOString(),
      to: new Date(todayUtcMs).toISOString(),
      series: aggregateDailySeries(stats, fromDateStr, toDateStr, granularity, fill),
    };
  });
}

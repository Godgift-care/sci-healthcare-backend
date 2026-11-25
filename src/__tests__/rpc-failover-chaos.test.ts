import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { rpc } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { Indexer } from '../stellar/indexer.js';
import { FailoverRpcServer, RpcPool } from '../stellar/rpc-pool.js';
import type { RecordedPage } from '../scripts/record-rpc-fixtures.js';

/**
 * #307 — chaos test for RPC failover.
 *
 * `rpc-pool.test.ts` proves the pool rotates, and `indexer-replay.test.ts`
 * proves the recorded pages project through one healthy endpoint. Neither
 * covers the interesting case: a failover in the middle of a paged read,
 * where the cursor page one produced is the page the next endpoint is asked
 * to continue from.
 *
 * So this replays the recorded log through two endpoints and deals the modes
 * a public endpoint actually runs into: a transport error, a timeout, and a
 * replica that is behind on indexing. The seed decides where each lands.
 *
 * The claim, for every seed: once the indexer has converged, the read model
 * is identical to the same log read through one healthy endpoint, and no
 * event was applied twice or skipped. That is the invariant a failover bug
 * breaks.
 *
 * Two things are deliberately not modelled, because a fake that did either
 * would be asserting behaviour this backend does not have:
 *
 * - An endpoint whose `latestLedger` is ahead of the events it returns.
 *   `collectEvents` takes `throughLedger` from the response and reads a short
 *   page as "this range is drained"; nothing in one call tells a lying server
 *   apart from one that genuinely has nothing left, so the only way to "catch"
 *   it here would be to assume the answer.
 * - An endpoint that re-serves events from below the cursor. Soroban filters
 *   by `startLedger` server-side, so a lagging or restarted replica returns
 *   fewer events, never ones it already handed over. What the chaos does
 *   replay is a whole range: a cycle that throws commits nothing, so the next
 *   cycle reads the same ledgers again, and the event-id-keyed upserts are
 *   what make that harmless. `DailyStat` counters are summed per event, so a
 *   duplicate delivered *inside* one drained range would double-count them —
 *   which is why the bullet above is a scope limit and not something to
 *   "handle".
 */

const FIXTURES_DIR = path.resolve(fileURLToPath(import.meta.url), '../fixtures/rpc-replay');

/** The highest ledger in the recorded log; what a caught-up cursor reads. */
const LATEST = 105;

/** The recorded events, in ledger order — the log every endpoint serves from. */
const LOG: rpc.Api.EventResponse[] = [1, 2].flatMap((page) => {
  const raw: RecordedPage = JSON.parse(
    readFileSync(path.join(FIXTURES_DIR, `page-${page}.json`), 'utf8'),
  );
  return raw.response.events;
});

const PAGE_SIZE = 3;

const CHAOS_URLS = ['https://rpc-a.test/', 'https://rpc-b.test/'];

type Outcome = 'ok' | 'fail' | 'timeout' | 'stale';

/**
 * What each call draws, and how often: the two failures the pool rotates for,
 * a replica that is behind, and an endpoint that answers normally.
 */
const ODDS: readonly (readonly [Outcome, number])[] = [
  ['fail', 0.25],
  ['timeout', 0.45],
  ['stale', 0.7],
  ['ok', 1],
];

/**
 * The call index of the first cursor continuation: a cycle opens with
 * `getHealth`, then reads page one, then page two — and page two is the call
 * that carries page one's cursor to whichever endpoint the pool is on.
 *
 * Failing exactly there, once, is the handover this test exists to cover. It
 * is forced rather than left to chance so no seed can pass by never failing
 * at all, and the rest of the run stays seeded.
 */
const MID_READ_CALL = 2;

/** mulberry32: a named deterministic generator, so a seed reproduces a run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks an outcome by cumulative weight, so the odds stay in `ODDS`. */
function draw(roll: number, odds: readonly (readonly [Outcome, number])[]): Outcome {
  for (const [outcome, until] of odds) {
    if (roll < until) return outcome;
  }
  return 'ok';
}

type Chaos = {
  calls: number;
  next: () => number;
  seen: Record<Outcome, number>;
  rotations: number;
};

function makeChaos(seed: number): Chaos {
  return {
    calls: 0,
    next: random(seed),
    seen: { ok: 0, fail: 0, timeout: 0, stale: 0 },
    rotations: 0,
  };
}

type FakeServer = Pick<rpc.Server, 'getEvents' | 'getLatestLedger' | 'getHealth'>;

/**
 * One Soroban RPC endpoint over the recorded log.
 *
 * `chaos` is shared by both endpoints, because the deck describes what this
 * client runs into, not which server is ill. Without it the endpoint is the
 * healthy reference `indexer-replay.test.ts` already uses.
 *
 * Every answer is self-consistent — the events served, the `latestLedger`
 * reported and the cursor position all describe the same prefix of the log —
 * so a lagging endpoint is behind rather than wrong.
 */
function endpoint(chaos: Chaos | null): FakeServer {
  const deal = (): Outcome => {
    if (!chaos) return 'ok';
    // The mid-read handover is forced; everything around it is the seed's.
    const outcome = chaos.calls === MID_READ_CALL ? 'fail' : draw(chaos.next(), ODDS);
    chaos.calls += 1;
    chaos.seen[outcome] += 1;
    return outcome;
  };

  return {
    async getHealth() {
      const outcome = deal();
      if (outcome === 'fail') throw new Error('connection refused');
      if (outcome === 'timeout') throw new Error('request timed out');
      return { oldestLedger: 1, latestLedger: LATEST } as never;
    },

    async getLatestLedger() {
      deal();
      return { sequence: LATEST } as never;
    },

    async getEvents(opts) {
      const outcome = deal();
      if (outcome === 'fail') throw new Error('connection refused');
      if (outcome === 'timeout') {
        throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' });
      }

      // A lagging replica has indexed up to its own latest ledger and no
      // further, and says so.
      const latest = outcome === 'stale' ? LATEST - (1 + Math.floor(chaos!.next() * 3)) : LATEST;
      const served = LOG.filter((e) => e.ledger <= latest);
      const limit = opts.limit ?? PAGE_SIZE;

      // `startLedger` is a ledger filter; a cursor is the position the
      // previous page stopped at. Positions are absolute in the full log, so
      // page two asked of one endpoint continues page one read from another
      // that had already served more.
      const from = opts.cursor
        ? Number.parseInt(opts.cursor.slice(1), 10)
        : LOG.filter((e) => e.ledger < (opts.startLedger ?? 0)).length;

      const events = served.slice(from, from + limit);
      return { events, cursor: `p${from + events.length}`, latestLedger: latest } as never;
    },
  };
}

function fakeLog(): FastifyBaseLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as FastifyBaseLogger;
}

async function reset(): Promise<void> {
  await prisma.webhookDelivery.deleteMany();
  await prisma.receipt.deleteMany();
  await prisma.contractEvent.deleteMany();
  await prisma.failedEvent.deleteMany();
  await prisma.dailyStat.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastLedger: 99 },
    update: {
      lastLedger: 99,
      leaseOwner: null,
      leaseExpiresAt: null,
      gap: false,
      gapOldestLedger: null,
      gapCursorLedger: null,
    },
  });
}

/** A pool over `urls`, each endpoint an independent copy of the recorded log. */
function indexerFor(urls: readonly string[], chaos: Chaos | null): Indexer {
  const pool = new RpcPool(urls, {
    maxFailures: 1,
    // One failed call is enough to rotate: the point is the mid-read handover,
    // and a streak of three would hide it behind a single endpoint's outage.
    factory: () => endpoint(chaos) as unknown as rpc.Server,
    log: {
      info: () => {},
      warn: (obj, msg) => {
        if (msg === 'soroban rpc endpoint failing; switching to the next one' && chaos) {
          chaos.rotations += 1;
        }
        void obj;
      },
    },
  });
  return new Indexer(fakeLog(), {
    rpcServer: new FailoverRpcServer(pool),
    pageSize: PAGE_SIZE,
  });
}

/**
 * Cycles the indexer until its cursor reaches `LATEST`.
 *
 * A cycle that exhausts every endpoint throws — that is what the indexer's
 * own backoff exists for, and the next poll resumes from the committed
 * cursor. The counts say "converged, and this many polls is what the chaos
 * cost".
 */
async function converge(
  indexer: Indexer,
  maxCycles = 24,
): Promise<{ cycles: number; failedCycles: number }> {
  let failedCycles = 0;
  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    try {
      await indexer.tick();
    } catch {
      failedCycles += 1;
    }
    const state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    if (state.lastLedger >= LATEST) return { cycles: cycle, failedCycles };
  }
  const stuck = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
  throw new Error(
    `indexer stalled at ledger ${stuck.lastLedger} of ${LATEST} after ${maxCycles} cycles`,
  );
}

/**
 * A row as the chain produced it: dates as ISO strings, bigints as decimal
 * strings, and nothing that records when this process happened to write it.
 *
 * `updatedAt` is Prisma's `@updatedAt` stamp, and `@default(now())` columns
 * are the same problem — both are wall clock, so leaving them in would compare
 * the two runs' stopwatches rather than their projections.
 */
function projectionOf(row: object, ingestColumns: readonly string[] = ['updatedAt']): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (ingestColumns.includes(key)) continue;
    out[key] =
      typeof value === 'bigint'
        ? value.toString()
        : value instanceof Date
          ? value.toISOString()
          : value;
  }
  return JSON.stringify(out);
}

/**
 * The read model the recorded log produces, compared for equality against the
 * same log read through one healthy endpoint. Any drift in *what* the events
 * projected shows up here, whatever order they arrived in.
 */
async function readModel() {
  const [providers, services, vouchers, receipts, contractEvents, dailyStats, outbox, failed] =
    await Promise.all([
      prisma.provider.findMany({ orderBy: { address: 'asc' } }),
      prisma.service.findMany({ orderBy: { id: 'asc' } }),
      prisma.voucher.findMany({ orderBy: { id: 'asc' } }),
      prisma.receipt.findMany({ orderBy: { voucherId: 'asc' } }),
      prisma.contractEvent.findMany({ orderBy: { id: 'asc' } }),
      prisma.dailyStat.findMany({ orderBy: { date: 'asc' } }),
      prisma.webhookDelivery.findMany({ orderBy: { ledger: 'asc' } }),
      prisma.failedEvent.findMany({ orderBy: { ledger: 'asc' } }),
    ]);

  return {
    providers: providers.map((row) => projectionOf(row)),
    services: services.map((row) => projectionOf(row)),
    vouchers: vouchers.map((row) => projectionOf(row)),
    receipts: receipts.map((row) => projectionOf(row)),
    // One row per on-chain event id, holding the decoded payload: a replayed
    // range cannot put an event here twice, an event skipped by a cursor that
    // trusted a stale response is missing, and a page spliced together from
    // two endpoints differs field by field. `closedAt` is the ledger close
    // time, so nothing here is ingest time.
    contractEvents: contractEvents.map((row) => projectionOf(row, [])),
    dailyStats: dailyStats.map((row) => projectionOf(row)),
    // Enqueued in the same transaction as the projection, so a second
    // projection of one event would announce it twice. The row id is a
    // `randomUUID()` and the payload carries ingest time, so what is compared
    // is the announced fact, and the count is the duplicate detector.
    outbox: outbox.map((o) => `${o.url}|${o.event}|${o.status}|${o.voucherId}@${o.ledger}`),
    // Nothing should reach here, and if it does the payload is the bug report:
    // the attempt count and error text are what say why.
    failed: failed.map((row) => projectionOf(row, ['firstSeen', 'lastSeen', 'raw'])),
  };
}

const SEEDS = [1, 7, 2026, 424242, 99991, 2 ** 31 - 1];

/** Accumulated across every seed in this file, asserted once at the end. */
const totals = { fail: 0, timeout: 0, stale: 0, rotations: 0 };

type ReadModel = Awaited<ReturnType<typeof readModel>>;

/** The log read through one endpoint that never fails: what the chaos must match. */
async function referenceModel(): Promise<ReadModel> {
  await reset();
  await converge(indexerFor([CHAOS_URLS[0]!], null));
  return readModel();
}

describe('RPC failover chaos (#307)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('projects the recorded log through one healthy endpoint', async () => {
    const model = await referenceModel();

    // The baseline the chaos runs are compared against, and its own sanity:
    // six events, one provider, one settled voucher, nothing dead-lettered.
    expect(model.contractEvents).toHaveLength(6);
    expect(model.providers).toHaveLength(1);
    expect(model.vouchers).toHaveLength(1);
    expect(model.receipts).toHaveLength(1);
    expect(model.failed).toEqual([]);
    expect(JSON.stringify(model)).toContain('Settled');

    // The DailyStat counters are summed per event, which makes them the
    // loudest "applied twice" alarm available: this log funds one voucher and
    // settles it, so a count above 1 anywhere means a duplicate reached the
    // database. The fund and the settle fall on different UTC days, hence the
    // per-day rows.
    const stats = model.dailyStats.map((row) => JSON.parse(row) as Record<string, number>);
    const total = (key: string) => stats.reduce((sum, s) => sum + s[key]!, 0);
    expect(total('fundedCount')).toBe(1);
    expect(total('settledCount')).toBe(1);
  });

  for (const seed of SEEDS) {
    it(`seed ${seed}: failover mid-read lands the reference read model`, async () => {
      const reference = await referenceModel();

      await reset();
      const chaos = makeChaos(seed);
      const { cycles, failedCycles } = await converge(indexerFor(CHAOS_URLS, chaos));
      const model = await readModel();

      expect(model).toEqual(reference);

      // The cursor landed exactly on the end of the log: a lagging endpoint
      // may stop a read early, but it cannot pull the cursor backwards or
      // talk it past a ledger it never served.
      const state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
      expect(state.lastLedger).toBe(LATEST);

      // Failover engaged rather than the run quietly staying on one endpoint.
      expect(chaos.rotations).toBeGreaterThan(0);

      totals.fail += chaos.seen.fail;
      totals.timeout += chaos.seen.timeout;
      totals.stale += chaos.seen.stale;
      totals.rotations += chaos.rotations;

      // Determinism, the first acceptance criterion: the same seed deals the
      // same failure order, costs the same number of polls, and leaves the
      // same database behind.
      await reset();
      const again = await converge(indexerFor(CHAOS_URLS, makeChaos(seed)));
      expect({ cycles: again.cycles, failedCycles: again.failedCycles }).toEqual({
        cycles,
        failedCycles,
      });
      expect(await readModel()).toEqual(model);
    });
  }

  it('deals every mode the chaos is there to exercise', () => {
    // Without this the suite could pass because no seed ever failed anything.
    // The deck cycles, so each mode is dealt within the first four calls of
    // any run that makes them.
    expect(totals.fail).toBeGreaterThan(0);
    expect(totals.timeout).toBeGreaterThan(0);
    expect(totals.stale).toBeGreaterThan(0);
    expect(totals.rotations).toBeGreaterThan(0);
  });
});

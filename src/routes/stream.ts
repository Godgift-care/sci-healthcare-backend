import type { ServerResponse } from 'node:http';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { env } from '../env.js';
import {
  acquireStreamSlot,
  releaseStreamSlot,
  subscribeVoucherSignals,
  type VoucherSignal,
} from '../lib/event-bus.js';
import { ApiError } from '../lib/errors.js';
import { accountAddress } from '../lib/stellar-address.js';

/**
 * How many committed events a reconnect may replay before it is told to
 * refetch instead. Replaying is one indexed query over the append-only log;
 * the bound is what keeps a client that has been away for a week from turning
 * one connection into an unbounded response.
 */
const REPLAY_LIMIT = 500;

/** The status each replayable event leaves the voucher in. */
const REPLAY_STATUS: Readonly<Record<string, string>> = {
  voucher_created: 'Funded',
  voucher_claimed: 'Claimed',
  voucher_attested: 'Attested',
  voucher_disputed: 'Disputed',
  voucher_settled: 'Settled',
  voucher_refunded: 'Refunded',
};

/** One SSE frame carrying a signal, with the contract event id to resume from. */
function signalFrame(signal: VoucherSignal): string {
  // A newline in an `id:` value would start another field, so it is stripped
  // even though the RPC's event ids never contain one.
  const id = signal.id.replace(/[\r\n]/g, '');
  return `id: ${id}\ndata: ${JSON.stringify(signal)}\n\n`;
}

/** The frame that tells a client its cursor is unusable and to refetch. */
function resetFrame(reason: string): string {
  return `event: reset\ndata: ${JSON.stringify({ type: 'reset', reason })}\n\n`;
}

type ReplayFilter = { voucher: string } | { provider: string };

type ReplayResult = { signals: VoucherSignal[]; reset: string | null };

/**
 * Replays the events that happened after `lastEventId`, oldest first.
 *
 * Ordering is the same keyset the voucher history route uses — ledger, then
 * the RPC's event id — so a client sees exactly the order the projection saw.
 * An anchor that is no longer retained, belongs to something other than the
 * requested filter, or has more than `REPLAY_LIMIT` events behind it is not a
 * gap that can be filled here: the caller sends a `reset` frame instead, and
 * the client refetches the JSON routes as it did before this existed.
 */
async function replayAfter(filter: ReplayFilter, lastEventId: string): Promise<ReplayResult> {
  const anchor = await prisma.contractEvent.findUnique({
    where: { id: lastEventId },
    select: { id: true, ledger: true, voucherId: true },
  });
  if (!anchor) return { signals: [], reset: 'last_event_id_expired' };

  let voucherIds: string[];
  const providerById = new Map<string, string>();

  if ('voucher' in filter) {
    if (anchor.voucherId !== filter.voucher) {
      return { signals: [], reset: 'last_event_id_expired' };
    }
    const voucher = await prisma.voucher.findUnique({
      where: { id: filter.voucher },
      select: { providerAddress: true },
    });
    // The log has events for a voucher the projection never wrote (possible
    // only for a hand-edited database), so there is nothing truthful to send.
    if (!voucher) return { signals: [], reset: null };
    voucherIds = [filter.voucher];
    providerById.set(filter.voucher, voucher.providerAddress);
  } else {
    const vouchers = await prisma.voucher.findMany({
      where: { providerAddress: filter.provider },
      select: { id: true },
    });
    voucherIds = vouchers.map((v) => v.id);
    for (const id of voucherIds) providerById.set(id, filter.provider);
    if (anchor.voucherId === null || !providerById.has(anchor.voucherId)) {
      return { signals: [], reset: 'last_event_id_expired' };
    }
  }

  if (voucherIds.length === 0) return { signals: [], reset: null };

  const rows = await prisma.contractEvent.findMany({
    where: {
      voucherId: { in: voucherIds },
      name: { in: Object.keys(REPLAY_STATUS) },
      OR: [{ ledger: { gt: anchor.ledger } }, { ledger: anchor.ledger, id: { gt: anchor.id } }],
    },
    orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
    take: REPLAY_LIMIT + 1,
  });
  if (rows.length > REPLAY_LIMIT) {
    return { signals: [], reset: 'replay_limit_exceeded' };
  }

  const signals: VoucherSignal[] = [];
  for (const row of rows) {
    const status = REPLAY_STATUS[row.name];
    const providerAddress = row.voucherId ? providerById.get(row.voucherId) : undefined;
    if (!status || !row.voucherId || !providerAddress) continue;
    signals.push({
      id: row.id,
      type: row.name,
      voucherId: row.voucherId,
      providerAddress,
      status,
      ledger: row.ledger,
      txHash: row.txHash,
      at: row.closedAt.toISOString(),
    });
  }
  return { signals, reset: null };
}

/**
 * Live voucher updates over server-sent events (#50).
 *
 * The read model is a projection of the chain, so the thing a page cannot
 * know on its own is *when* it changed. Before this route the only answer was
 * to poll or reload, which is why a transaction could look like it had made
 * no difference. Here the indexer tells this process what it just committed
 * and the route forwards it, so a wallet view updates on the ledger that
 * settled the voucher.
 *
 * What a client is told is exactly what the JSON routes already expose for
 * the same transition: voucher id, new status, clinic address, ledger, tx
 * hash and the ledger close time. There is deliberately **no beneficiary
 * reference**, even though `voucher_created` carries one on chain — the
 * reference is an HMAC of a patient identifier, and a long-lived push channel
 * is the last place it should appear. Live frames are built only from the
 * signal the indexer publishes after committing; the one database read this
 * route does is the bounded replay of those same events on a resume, so the
 * stream still cannot become a second way to walk the read model.
 */
const streamQuery = z
  .object({
    voucher: z.string().min(1).max(64).optional(),
    provider: accountAddress.optional(),
  })
  .refine((data) => Boolean(data.voucher) !== Boolean(data.provider), {
    message: 'Provide exactly one of: voucher, provider',
    path: ['voucher', 'provider'],
  });

export function streamRoutes(app: FastifyInstance): void {
  /** The responses this scope is holding open, so closing can release them. */
  const open = new Set<ServerResponse>();

  // A stream never ends by itself, and a response that is still open keeps its
  // socket busy, so `server.close()` — which only waits for idle connections —
  // would never return. `preClose` is the application hook that Fastify runs
  // *before* it touches the server; `onClose` is too late, because the root's
  // own close hook (the one that closes the server) is registered after the
  // plugins and therefore runs first, and the wait happens inside it.
  // Without this, a SIGTERM during a deploy — or the end of a test — would sit
  // on a perfectly healthy idle stream until the shutdown timer fired.
  app.addHook('preClose', () => {
    for (const res of open) {
      if (!res.writableEnded && !res.destroyed) res.end();
    }
    open.clear();
  });

  /**
   * Subscribes to voucher updates for one voucher or one clinic.
   *
   * A filter is required, like every other route that carries patient
   * context: an unfiltered firehose of care-state transitions would turn a
   * read-only API into a way to watch a clinic's patient volume in real time.
   * `?provider=` is still only the public half of that — the clinic, the
   * voucher id and the status — and it is what a clinic's own dashboard needs.
   */
  app.get(
    '/stream',
    {
      schema: {
        tags: ['stream'],
        summary: 'Live voucher updates (server-sent events)',
        description:
          'Streams voucher state transitions as the indexer commits them. ' +
          'Requires exactly one of `voucher` or `provider`. Each frame ' +
          'carries the on-chain event id in an `id:` line; send it back as the ' +
          '`Last-Event-ID` header on reconnect to replay up to 500 later events ' +
          'in order before going live. If that cursor is too old to replay, ' +
          'the server sends one `event: reset` frame with ' +
          '`{"type":"reset","reason":...}` and the client must refetch. Each ' +
          '`data:` frame is one JSON object with `id`, `type`, `voucherId`, ' +
          '`providerAddress`, `status`, `ledger`, `txHash` and `at`; it never ' +
          'contains a beneficiary reference. Comment lines are heartbeats.',
      },
    },
    async (req, reply) => {
      const parsed = streamQuery.safeParse(req.query);
      if (!parsed.success) {
        throw new ApiError(400, 'invalid_query', 'Invalid query parameters', parsed.error.issues);
      }
      const { voucher, provider } = parsed.data;

      // Checked before hijacking: past this point Fastify no longer owns the
      // response, so an error would have to be framed by hand.
      if (!acquireStreamSlot(env.SSE_MAX_CONNECTIONS)) {
        throw new ApiError(
          503,
          'stream_full',
          `This instance is holding its ${env.SSE_MAX_CONNECTIONS} open streams; try again shortly`,
        );
      }

      // The reply leaves the request lifecycle: a stream has no body to
      // return, and the app-level `onSend` hook (cache headers, ETag, error
      // envelope) and the compressor both assume a response that finishes.
      reply.hijack();
      const res = reply.raw;
      open.add(res);

      // Hijacking also skips the legacy scope's `onSend` hook, so the
      // unversioned alias has to mark itself as deprecated here like every
      // other response on it does. Control characters are stripped before the
      // URL is echoed into a header, as in `app.ts`.
      const aliasHeaders: Record<string, string> = {};
      if (!req.url.startsWith('/v1/')) {
        const target = req.url.replace(/[\r\n]/g, '');
        aliasHeaders['deprecation'] = 'true';
        aliasHeaders['link'] = `</v1${target}>; rel="successor-version"`;
      }

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-store, must-revalidate',
        connection: 'keep-alive',
        // A proxy that buffers would hold every frame until it filled a page.
        'x-accel-buffering': 'no',
        // Normally added by the app-level hook that this response bypasses; a
        // stream needs its id for support just as much as any other request.
        'x-request-id': req.id,
        'x-stellar-network': env.STELLAR_NETWORK,
        ...aliasHeaders,
      });

      let heartbeat: NodeJS.Timeout | null = null;
      let unsubscribe: (() => void) | null = null;
      let released = false;

      /** Detaches from the bus and gives the slot back, at most once. */
      const cleanup = (): void => {
        if (released) return;
        released = true;
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) unsubscribe();
        open.delete(res);
        releaseStreamSlot();
      };

      /** Ends the response, then cleans up. Called on every teardown path. */
      const drop = (): void => {
        if (!res.writableEnded && !res.destroyed) res.end();
        cleanup();
      };

      const write = (frame: string): void => {
        try {
          // `false` means the client is not draining what it was already
          // given. For a live feed the newest state is the only useful one, so
          // a client that cannot keep up is disconnected — and it will
          // reconnect and read the current state from the JSON routes — rather
          // than allowed to pin an unbounded write buffer in this process.
          if (!res.write(frame)) drop();
        } catch {
          // A socket that died between the write and the flush. Its handler
          // below releases everything; the indexer is owed nothing.
          drop();
        }
      };

      // Any of these can be the first to fire, depending on how the
      // connection died, and `drop` is idempotent.
      req.raw.on('close', drop);
      res.on('close', drop);
      res.on('error', drop);

      // Flushed immediately: those bytes are what move a client from
      // "connecting" to "open", and they prove the headers got through.
      write(': connected\n\n');

      // An idle stream must not be a reason for the process to stay alive:
      // tests and shutdown would wait on a socket nobody is watching. Started
      // before replay so a slow read of the log cannot look like a dead socket.
      heartbeat = setInterval(() => write(': heartbeat\n\n'), env.SSE_HEARTBEAT_MS);
      heartbeat.unref();

      // The browser or typed client sends the last `id:` it received here. It
      // is a header rather than a query parameter so EventSource can carry it
      // without the application rewriting the URL.
      const lastEventIdHeader = req.headers['last-event-id'];
      const lastEventId =
        typeof lastEventIdHeader === 'string' && lastEventIdHeader.length > 0
          ? lastEventIdHeader
          : null;

      // Subscribe before reading the log, and hold live signals while the
      // replay is in flight. Doing it the other way round leaves a gap: an
      // event committed after the query but before the subscription would be
      // in neither. Signals that also appear in the replay are dropped by id,
      // which is what makes the resume exactly-once rather than at-least-once.
      let replaying = lastEventId !== null;
      const buffered: VoucherSignal[] = [];
      const delivered = new Set<string>();

      const deliver = (signal: VoucherSignal): void => {
        if (delivered.has(signal.id)) return;
        delivered.add(signal.id);
        write(signalFrame(signal));
      };

      unsubscribe = subscribeVoucherSignals((signal) => {
        const wanted = voucher ? signal.voucherId === voucher : signal.providerAddress === provider;
        if (!wanted) return;
        if (replaying) {
          buffered.push(signal);
          return;
        }
        deliver(signal);
      });

      if (lastEventId !== null) {
        let outcome: ReplayResult;
        try {
          const filter: ReplayFilter = voucher ? { voucher } : { provider: provider as string };
          outcome = await replayAfter(filter, lastEventId);
        } catch (err) {
          // A stream that is already open cannot be answered with an error
          // response; a reset is the honest answer, and it matches what a
          // client would do if its cursor were too old.
          req.log.error({ err }, 'stream replay failed');
          outcome = { signals: [], reset: 'replay_failed' };
        }
        if (outcome.reset) write(resetFrame(outcome.reset));
        for (const signal of outcome.signals) deliver(signal);
      }

      replaying = false;
      for (const signal of buffered) deliver(signal);
    },
  );
}

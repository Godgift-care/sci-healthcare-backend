import { ApiError } from './client.js';

/**
 * One voucher transition, exactly as `GET /stream` frames it.
 *
 * There is no beneficiary reference here on purpose: the route builds each
 * frame from the fields the JSON endpoints already publish, because a
 * long-lived push channel is the last place an HMAC of a patient identifier
 * should appear.
 */
export type VoucherStreamEvent = {
  /** On-chain event id, also framed as the SSE `id:` used to resume. */
  id: string;
  /** Contract event name, e.g. `voucher_settled`. */
  type: string;
  voucherId: string;
  providerAddress: string;
  /** Status the event leaves the voucher in, one of `VOUCHER_STATUS`. */
  status: string;
  ledger: number;
  txHash: string;
  /** When the ledger closed, ISO 8601. */
  at: string;
};

/** Which transitions the caller wants. Exactly one must be set. */
/**
 * Sent as an SSE `event: reset` frame when a `Last-Event-ID` is too old to
 * replay. The gap cannot be filled from the stream, so the caller must refetch
 * the JSON routes; the handle clears its cursor so the next reconnect starts
 * live rather than asking for the same unusable id forever.
 */
export type StreamResetEvent = {
  type: 'reset';
  reason: string;
};

export type StreamFilters = {
  voucher?: string;
  provider?: string;
};

export type StreamReconnectInfo = {
  /** 1 for the first retry after the connection that worked. */
  attempt: number;
  delayMs: number;
  lastEventId: string | null;
};

export type StreamHandlers = {
  /** One per `data:` frame whose JSON body parsed. */
  onEvent?: (event: VoucherStreamEvent) => void;
  /** One per connection that reached the server, including the first. */
  onOpen?: () => void;
  onReconnect?: (info: StreamReconnectInfo) => void;
  /**
   * The server could not replay from the cursor the handle sent. Refetch the
   * JSON routes; the stream itself stays open and live from here.
   */
  onReset?: (reset: StreamResetEvent) => void;
  /**
   * A connection dropped, a frame failed to parse, or the server answered an
   * error. The stream keeps running after everything except a `fatal` error;
   * `onError` is the only place a caller learns why the handle closed.
   */
  onError?: (error: unknown, info: { fatal: boolean }) => void;
};

export type StreamOptions = {
  /** Aborting this closes the stream, exactly like `handle.close()`. */
  signal?: AbortSignal;
  /**
   * Reconnect when no byte at all has arrived for this long, which is how a
   * silently dead socket — one a proxy dropped without a FIN — is noticed.
   * Must exceed the server's `SSE_HEARTBEAT_MS` (15s by default) or a healthy
   * idle stream is torn down and rebuilt forever.
   */
  heartbeatTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * How long a connection must stay open before a later drop restarts the
   * backoff from the minimum. A server that accepts a socket and closes it
   * again at once would otherwise be retried at the minimum delay forever,
   * which is the reconnect storm the growing backoff exists to prevent.
   */
  stableAfterMs?: number;
  /** Overrides the client's own `fetch` for this stream only. */
  fetch?: typeof fetch;
  /** Injectable for tests; jitter draws from here. */
  random?: () => number;
};

export type StreamHandle = {
  /** Stops reconnecting and abandons the current connection. Idempotent. */
  close(): void;
  /** Resolves once the stream will do nothing further. */
  readonly done: Promise<void>;
  readonly closed: boolean;
  /**
   * The most recent SSE `id:` the server sent, resent as `Last-Event-ID` on
   * the next reconnect so the route can replay what was missed. Cleared when
   * the server answers with a `reset` event, because that cursor is unusable.
   */
  readonly lastEventId: string | null;
};

/** Statuses where reconnecting identically would be a loop, not a retry. */
const FATAL_STATUS = new Set([400, 401, 403, 404, 405, 406, 410, 412, 415, 422]);

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_MIN_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_STABLE_AFTER_MS = 5_000;

/** Whether the loop reconnects, and whether the drop followed a stable run. */
type Outcome = { again: boolean; stable: boolean };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Incremental `text/event-stream` reader.
 *
 * `EventSource` is not usable here: it does not exist on Node 22, and even
 * where it does it cannot set a header, so it could not send `Last-Event-ID`
 * on a reconnect driven by application code. This parses the same wire format
 * over `fetch`, which is native in browsers and in Node 22.
 */
class FrameParser {
  private buffer = '';
  private data: string[] = [];
  private eventType = '';

  constructor(
    private readonly onData: (payload: string, eventType: string) => void,
    private readonly onId: (id: string | null) => void,
    private readonly onRetry: (ms: number) => void,
  ) {}

  /** Feeds one decoded chunk; `flush` settles a trailing unterminated line. */
  push(chunk: string, flush = false): void {
    this.buffer += chunk;
    for (;;) {
      const match = /\r\n|\n|\r/.exec(this.buffer);
      if (!match) break;
      // A CR at the very end may be the first half of a CRLF arriving in the
      // next chunk; claiming it now would swallow a line terminator.
      if (match[0] === '\r' && match.index === this.buffer.length - 1 && !flush) break;

      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.handleLine(line);
    }
    if (flush && this.buffer !== '') {
      const line = this.buffer;
      this.buffer = '';
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return; // a comment, i.e. the server's heartbeat

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    switch (field) {
      case 'data':
        this.data.push(value);
        break;
      case 'event':
        this.eventType = value;
        break;
      case 'id':
        // An id containing NUL is ignored, as the event-stream format requires.
        this.onId(value.includes('\u0000') ? null : value);
        break;
      case 'retry': {
        const ms = Number(value);
        if (Number.isInteger(ms) && ms >= 0) this.onRetry(ms);
        break;
      }
      default:
        // Unknown fields are ignored rather than treated as corruption.
        break;
    }
  }

  private dispatch(): void {
    if (this.data.length === 0) {
      this.eventType = '';
      return;
    }
    // A single trailing newline is part of the framing, not the payload.
    if (this.data[this.data.length - 1] === '') this.data.pop();
    this.onData(this.data.join('\n'), this.eventType);
    this.data = [];
    this.eventType = '';
  }
}

/**
 * Opens `GET /stream` and keeps it open.
 *
 * `baseUrl` is already trailing-slash-trimmed by `Client`. The returned handle
 * is synchronous so a caller can close it before the first connect resolves.
 *
 * Resume resends the last `id:` it was given. The route replays the events
 * committed after it (bounded) before going live, and answers a cursor too old
 * for that window with a `reset` event, at which point the caller refetches
 * the JSON routes. Frames are only ever written after the transaction that
 * produced them commits, so the state those routes serve is never behind the
 * last frame seen.
 */
export function subscribe(
  baseUrl: string,
  defaultHeaders: Record<string, string>,
  clientFetch: typeof fetch,
  filters: StreamFilters,
  handlers: StreamHandlers = {},
  options: StreamOptions = {},
): StreamHandle {
  const hasVoucher = Boolean(filters.voucher);
  const hasProvider = Boolean(filters.provider);
  if (hasVoucher === hasProvider) {
    throw new ApiError(
      0,
      'invalid_query',
      'Provide exactly one of: voucher, provider',
      'The stream requires one filter: an unfiltered feed of care transitions would expose a clinic patient volume.',
    );
  }

  const fetchImpl = options.fetch ?? clientFetch;
  const random = options.random ?? Math.random;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
  const maxBackoffMs = Math.max(minBackoffMs, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
  const stableAfterMs = options.stableAfterMs ?? DEFAULT_STABLE_AFTER_MS;

  const controller = new AbortController();
  const externalSignal = options.signal;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let closed = externalSignal?.aborted ?? false;
  let lastEventId: string | null = null;
  let attempts = 0;
  let serverRetryMs: number | null = null;
  let abortCurrentRead: (() => void) | null = null;

  let settleDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    settleDone = resolve;
  });

  const report = (error: unknown, fatal: boolean): void => {
    if (handlers.onError) handlers.onError(error, { fatal });
  };

  /** Backoff doubles per attempt, capped, with jitter so a fleet does not sync. */
  const nextDelayMs = (): number => {
    const base = serverRetryMs ?? Math.min(maxBackoffMs, minBackoffMs * 2 ** attempts);
    return Math.round(base * (0.5 + random() * 0.5));
  };

  const params = new URLSearchParams();
  if (filters.voucher) params.set('voucher', filters.voucher);
  if (filters.provider) params.set('provider', filters.provider);
  const url = `${baseUrl}/stream?${params.toString()}`;

  const handle = (frame: string, eventType: string): void => {
    if (eventType === 'reset') {
      let reset: StreamResetEvent;
      try {
        reset = JSON.parse(frame) as StreamResetEvent;
      } catch {
        reset = { type: 'reset', reason: 'unreadable_reset' };
      }
      // Sending the same stale cursor again would produce the same reset, so
      // the next reconnect starts from the live edge instead.
      lastEventId = null;
      if (handlers.onReset) handlers.onReset(reset);
      return;
    }
    if (eventType && eventType !== 'message') return;
    let event: VoucherStreamEvent;
    try {
      event = JSON.parse(frame) as VoucherStreamEvent;
    } catch (cause) {
      // One unreadable frame is not a reason to lose the feed.
      report(new ApiError(0, 'bad_frame', `Stream frame is not JSON: ${frame}`, cause), false);
      return;
    }
    if (handlers.onEvent) handlers.onEvent(event);
  };

  const connectOnce = async (): Promise<Outcome> => {
    const parser = new FrameParser(
      handle,
      (id) => {
        lastEventId = id;
      },
      (ms) => {
        serverRetryMs = Math.min(maxBackoffMs, Math.max(minBackoffMs, ms));
      },
    );

    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      ...defaultHeaders,
    };
    if (lastEventId !== null) headers['last-event-id'] = lastEventId;

    // A per-connection controller, so a stalled read is cancelled without
    // closing the handle: `close()` aborts the outer one.
    const read = new AbortController();
    const onOuterAbort = (): void => read.abort();
    controller.signal.addEventListener('abort', onOuterAbort, { once: true });
    abortCurrentRead = () => read.abort();

    let timer: ReturnType<typeof setTimeout> | null = null;
    let idleMs = heartbeatTimeoutMs;
    let connectedAt = 0;

    /** A connection that lasted its opening is allowed to restart the backoff. */
    const drop = (): Outcome => ({
      again: true,
      stable: connectedAt !== 0 && Date.now() - connectedAt >= stableAfterMs,
    });

    try {
      const res = await fetchImpl(url, { headers, signal: read.signal });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new ApiError(
          res.status,
          `http_${res.status}`,
          `Stream request failed: ${detail || res.statusText}`,
        );
      }
      if (!res.body) {
        throw new ApiError(0, 'stream_unsupported', 'The response carries no body to read');
      }

      connectedAt = Date.now();
      if (handlers.onOpen) handlers.onOpen();

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        // Armed again per read: any byte means the connection is alive, which
        // is what distinguishes an idle stream from a dead one.
        const idle = new Promise<'idle'>((resolve) => {
          timer = setTimeout(() => resolve('idle'), idleMs);
        });
        const next = await Promise.race([reader.read(), idle]);
        if (timer) clearTimeout(timer);
        timer = null;

        if (next === 'idle') {
          report(new ApiError(0, 'heartbeat_timeout', `No stream activity for ${idleMs}ms`), false);
          return drop();
        }
        if (next.done) {
          parser.push('', true);
          return drop();
        }
        idleMs = heartbeatTimeoutMs;
        parser.push(decoder.decode(next.value, { stream: true }));
      }
    } catch (cause) {
      if (cause instanceof ApiError && FATAL_STATUS.has(cause.status)) {
        report(cause, true);
        return { again: false, stable: false };
      }
      if (controller.signal.aborted) return { again: false, stable: false };
      if (cause instanceof Error && cause.name === 'AbortError') {
        return { again: false, stable: false };
      }
      report(cause, false);
      return drop();
    } finally {
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener('abort', onOuterAbort);
      abortCurrentRead = null;
      try {
        read.abort();
      } catch {
        // An already-settled controller needs nothing.
      }
    }
  };

  const run = async (): Promise<void> => {
    try {
      while (!closed && !controller.signal.aborted) {
        const outcome = await connectOnce();
        if (!outcome.again || closed || controller.signal.aborted) break;
        if (outcome.stable) attempts = 0;

        const delayMs = nextDelayMs();
        attempts += 1;
        if (handlers.onReconnect) {
          handlers.onReconnect({ attempt: attempts, delayMs, lastEventId });
        }
        await delay(delayMs);
      }
    } finally {
      closed = true;
      settleDone();
    }
  };

  void run();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      const pending = abortCurrentRead;
      if (pending) pending();
      controller.abort();
    },
    get done(): Promise<void> {
      return done;
    },
    get closed(): boolean {
      return closed;
    },
    get lastEventId(): string | null {
      return lastEventId;
    },
  };
}

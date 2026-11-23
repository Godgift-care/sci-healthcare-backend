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
    onError?: (error: unknown, info: {
        fatal: boolean;
    }) => void;
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
export declare function subscribe(baseUrl: string, defaultHeaders: Record<string, string>, clientFetch: typeof fetch, filters: StreamFilters, handlers?: StreamHandlers, options?: StreamOptions): StreamHandle;

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.subscribe = subscribe;
const client_js_1 = require("./client.js");
/** Statuses where reconnecting identically would be a loop, not a retry. */
const FATAL_STATUS = new Set([400, 401, 403, 404, 405, 406, 410, 412, 415, 422]);
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;
const DEFAULT_MIN_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_STABLE_AFTER_MS = 5_000;
function delay(ms) {
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
    onData;
    onId;
    onRetry;
    buffer = '';
    data = [];
    eventType = '';
    constructor(onData, onId, onRetry) {
        this.onData = onData;
        this.onId = onId;
        this.onRetry = onRetry;
    }
    /** Feeds one decoded chunk; `flush` settles a trailing unterminated line. */
    push(chunk, flush = false) {
        this.buffer += chunk;
        for (;;) {
            const match = /\r\n|\n|\r/.exec(this.buffer);
            if (!match)
                break;
            // A CR at the very end may be the first half of a CRLF arriving in the
            // next chunk; claiming it now would swallow a line terminator.
            if (match[0] === '\r' && match.index === this.buffer.length - 1 && !flush)
                break;
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
    handleLine(line) {
        if (line === '') {
            this.dispatch();
            return;
        }
        if (line.startsWith(':'))
            return; // a comment, i.e. the server's heartbeat
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' '))
            value = value.slice(1);
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
                if (Number.isInteger(ms) && ms >= 0)
                    this.onRetry(ms);
                break;
            }
            default:
                // Unknown fields are ignored rather than treated as corruption.
                break;
        }
    }
    dispatch() {
        if (this.data.length === 0) {
            this.eventType = '';
            return;
        }
        // A single trailing newline is part of the framing, not the payload.
        if (this.data[this.data.length - 1] === '')
            this.data.pop();
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
 * Resume is best effort by necessity: this resends the last `id:` it was
 * given, but the route emits no `id:` line, so against this backend
 * `lastEventId` stays null and a gap between a drop and the reconnect is
 * filled by re-reading the JSON routes, not by replay. Frames are only ever
 * written after the transaction that produced them commits, so the state the
 * routes serve is never behind the last frame seen.
 */
function subscribe(baseUrl, defaultHeaders, clientFetch, filters, handlers = {}, options = {}) {
    const hasVoucher = Boolean(filters.voucher);
    const hasProvider = Boolean(filters.provider);
    if (hasVoucher === hasProvider) {
        throw new client_js_1.ApiError(0, 'invalid_query', 'Provide exactly one of: voucher, provider', 'The stream requires one filter: an unfiltered feed of care transitions would expose a clinic patient volume.');
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
        if (externalSignal.aborted)
            controller.abort();
        else
            externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    let closed = externalSignal?.aborted ?? false;
    let lastEventId = null;
    let attempts = 0;
    let serverRetryMs = null;
    let abortCurrentRead = null;
    let settleDone = () => { };
    const done = new Promise((resolve) => {
        settleDone = resolve;
    });
    const report = (error, fatal) => {
        if (handlers.onError)
            handlers.onError(error, { fatal });
    };
    /** Backoff doubles per attempt, capped, with jitter so a fleet does not sync. */
    const nextDelayMs = () => {
        const base = serverRetryMs ?? Math.min(maxBackoffMs, minBackoffMs * 2 ** attempts);
        return Math.round(base * (0.5 + random() * 0.5));
    };
    const params = new URLSearchParams();
    if (filters.voucher)
        params.set('voucher', filters.voucher);
    if (filters.provider)
        params.set('provider', filters.provider);
    const url = `${baseUrl}/stream?${params.toString()}`;
    const handle = (frame, eventType) => {
        if (eventType && eventType !== 'message')
            return;
        let event;
        try {
            event = JSON.parse(frame);
        }
        catch (cause) {
            // One unreadable frame is not a reason to lose the feed.
            report(new client_js_1.ApiError(0, 'bad_frame', `Stream frame is not JSON: ${frame}`, cause), false);
            return;
        }
        if (handlers.onEvent)
            handlers.onEvent(event);
    };
    const connectOnce = async () => {
        const parser = new FrameParser(handle, (id) => {
            lastEventId = id;
        }, (ms) => {
            serverRetryMs = Math.min(maxBackoffMs, Math.max(minBackoffMs, ms));
        });
        const headers = {
            accept: 'text/event-stream',
            ...defaultHeaders,
        };
        if (lastEventId !== null)
            headers['last-event-id'] = lastEventId;
        // A per-connection controller, so a stalled read is cancelled without
        // closing the handle: `close()` aborts the outer one.
        const read = new AbortController();
        const onOuterAbort = () => read.abort();
        controller.signal.addEventListener('abort', onOuterAbort, { once: true });
        abortCurrentRead = () => read.abort();
        let timer = null;
        let idleMs = heartbeatTimeoutMs;
        let connectedAt = 0;
        /** A connection that lasted its opening is allowed to restart the backoff. */
        const drop = () => ({
            again: true,
            stable: connectedAt !== 0 && Date.now() - connectedAt >= stableAfterMs,
        });
        try {
            const res = await fetchImpl(url, { headers, signal: read.signal });
            if (!res.ok) {
                const detail = await res.text().catch(() => '');
                throw new client_js_1.ApiError(res.status, `http_${res.status}`, `Stream request failed: ${detail || res.statusText}`);
            }
            if (!res.body) {
                throw new client_js_1.ApiError(0, 'stream_unsupported', 'The response carries no body to read');
            }
            connectedAt = Date.now();
            if (handlers.onOpen)
                handlers.onOpen();
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            for (;;) {
                // Armed again per read: any byte means the connection is alive, which
                // is what distinguishes an idle stream from a dead one.
                const idle = new Promise((resolve) => {
                    timer = setTimeout(() => resolve('idle'), idleMs);
                });
                const next = await Promise.race([reader.read(), idle]);
                if (timer)
                    clearTimeout(timer);
                timer = null;
                if (next === 'idle') {
                    report(new client_js_1.ApiError(0, 'heartbeat_timeout', `No stream activity for ${idleMs}ms`), false);
                    return drop();
                }
                if (next.done) {
                    parser.push('', true);
                    return drop();
                }
                idleMs = heartbeatTimeoutMs;
                parser.push(decoder.decode(next.value, { stream: true }));
            }
        }
        catch (cause) {
            if (cause instanceof client_js_1.ApiError && FATAL_STATUS.has(cause.status)) {
                report(cause, true);
                return { again: false, stable: false };
            }
            if (controller.signal.aborted)
                return { again: false, stable: false };
            if (cause instanceof Error && cause.name === 'AbortError') {
                return { again: false, stable: false };
            }
            report(cause, false);
            return drop();
        }
        finally {
            if (timer)
                clearTimeout(timer);
            controller.signal.removeEventListener('abort', onOuterAbort);
            abortCurrentRead = null;
            try {
                read.abort();
            }
            catch {
                // An already-settled controller needs nothing.
            }
        }
    };
    const run = async () => {
        try {
            while (!closed && !controller.signal.aborted) {
                const outcome = await connectOnce();
                if (!outcome.again || closed || controller.signal.aborted)
                    break;
                if (outcome.stable)
                    attempts = 0;
                const delayMs = nextDelayMs();
                attempts += 1;
                if (handlers.onReconnect) {
                    handlers.onReconnect({ attempt: attempts, delayMs, lastEventId });
                }
                await delay(delayMs);
            }
        }
        finally {
            closed = true;
            settleDone();
        }
    };
    void run();
    return {
        close() {
            if (closed)
                return;
            closed = true;
            const pending = abortCurrentRead;
            if (pending)
                pending();
            controller.abort();
        },
        get done() {
            return done;
        },
        get closed() {
            return closed;
        },
        get lastEventId() {
            return lastEventId;
        },
    };
}
//# sourceMappingURL=stream.js.map
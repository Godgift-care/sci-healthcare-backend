"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Client = exports.ApiError = void 0;
exports.providerLocation = providerLocation;
exports.createClient = createClient;
const stream_js_1 = require("./stream.js");
class ApiError extends Error {
    status;
    error;
    details;
    issues;
    /**
     * The error body as the API sent it, typed as the one documented envelope
     * (#296).
     *
     * `message` on this class is a fallback-protected string because `Error`
     * needs one; `envelope` is the honest record, so a route that answers a
     * lookup failure without a localised `message` shows that here rather than
     * inheriting a sentence the server never sent.
     */
    envelope;
    constructor(status, error, message, details, envelope) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.error = error;
        this.details = details;
        this.issues = details;
        this.envelope = envelope ?? { error, message, ...(details === undefined ? {} : { details }) };
    }
}
exports.ApiError = ApiError;
/**
 * Validates and extracts coordinates a clinic has published, or null.
 */
function providerLocation(p) {
    const raw = p.location ?? p.metadata?.location ?? null;
    if (!raw)
        return null;
    const { lat, lng } = raw;
    if (typeof lat !== 'number' ||
        typeof lng !== 'number' ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 ||
        lat > 90 ||
        lng < -180 ||
        lng > 180) {
        return null;
    }
    return { lat, lng };
}
function trimTrailingSlashes(value) {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 47)
        end--;
    return value.slice(0, end);
}
class Client {
    baseUrl;
    fetchImpl;
    defaultHeaders;
    constructor(options) {
        this.baseUrl = trimTrailingSlashes(options.baseUrl);
        this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.defaultHeaders = options.headers ?? {};
    }
    async request(path, params, init) {
        const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);
        if (params) {
            for (const [key, value] of Object.entries(params)) {
                if (value === undefined || value === null)
                    continue;
                if (Array.isArray(value)) {
                    url.searchParams.set(key, value.join(','));
                }
                else {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        const headers = {
            accept: 'application/json',
            ...this.defaultHeaders,
            ...init?.headers,
        };
        let res;
        try {
            res = await this.fetchImpl(url.toString(), {
                ...init,
                headers,
            });
        }
        catch (cause) {
            throw new ApiError(0, 'network_error', `Cannot reach the API at ${this.baseUrl}: ${cause}`, cause);
        }
        if (!res.ok) {
            let body = {};
            try {
                body = (await res.json());
            }
            catch {
                // Not a JSON error body
            }
            const errCode = body.error ?? `http_${res.status}`;
            const message = body.message ?? res.statusText ?? 'Request failed';
            const details = body.details ?? body.issues;
            // `error` is the only required member of the envelope, so a body that
            // does not carry one is not an envelope and is left out rather than
            // dressed up as one.
            const envelope = body.error === undefined ? undefined : body;
            throw new ApiError(res.status, errCode, message, details, envelope);
        }
        return (await res.json());
    }
    async health() {
        return this.request('/health');
    }
    async version() {
        return this.request('/version');
    }
    async ready() {
        return this.request('/ready');
    }
    async stats() {
        return this.request('/stats');
    }
    async dailyStats(days = 30) {
        return this.request('/stats/daily', { days });
    }
    async providers(params) {
        return this.request('/providers', params);
    }
    async provider(address) {
        return this.request(`/providers/${encodeURIComponent(address)}`);
    }
    /**
     * One clinic's price list on its own (issue #314), sorted by price
     * ascending by default.
     *
     * Priced separately from the clinic record because the catalogue changes
     * far more often than the profile around it, so refreshing prices does not
     * refetch — or revalidate — the whole provider.
     */
    async providerServices(address, params) {
        return this.request(`/providers/${encodeURIComponent(address)}/services`, params);
    }
    async providerHistory(address) {
        return this.request(`/providers/${encodeURIComponent(address)}/history`);
    }
    async providerServiceHistory(address, code) {
        return this.request(`/providers/${encodeURIComponent(address)}/services/${code}/history`);
    }
    async countries() {
        return this.request('/countries');
    }
    async services() {
        return this.request('/services');
    }
    async service(code) {
        return this.request(`/services/${code}`);
    }
    async vouchers(params) {
        return this.request('/vouchers', params);
    }
    async voucher(id) {
        return this.request(`/vouchers/${encodeURIComponent(id)}`);
    }
    async vouchersDue(params) {
        return this.request('/vouchers/due', params);
    }
    async vouchersCsv(params) {
        const url = new URL(`${this.baseUrl}/vouchers.csv`);
        if (params) {
            for (const [key, value] of Object.entries(params)) {
                if (value === undefined || value === null)
                    continue;
                if (Array.isArray(value)) {
                    url.searchParams.set(key, value.join(','));
                }
                else {
                    url.searchParams.set(key, String(value));
                }
            }
        }
        const res = await this.fetchImpl(url.toString(), {
            headers: { ...this.defaultHeaders },
        });
        if (!res.ok) {
            throw new ApiError(res.status, `http_${res.status}`, `Failed to export CSV: ${res.statusText}`);
        }
        return res.text();
    }
    async receipts(params) {
        return this.request('/receipts', params);
    }
    async receipt(voucherId) {
        return this.request(`/receipts/${encodeURIComponent(voucherId)}`);
    }
    async governance() {
        return this.request('/governance');
    }
    /**
     * Subscribes to `GET /stream` for one voucher or one clinic.
     *
     * Works in a browser and in Node 22, because it runs on `fetch` rather than
     * `EventSource`: the latter is absent on Node 22 and cannot carry the
     * `Last-Event-ID` header this uses to resume. Exactly one of `voucher` or
     * `provider` is required, matching the route, and the returned `close()`
     * stops reconnecting for good.
     *
     * The server frames no SSE `id:` today, so a drop loses whatever happened
     * while disconnected; re-read the JSON routes after `onReconnect` to be
     * certain of current state.
     */
    stream(filters, handlers = {}, options = {}) {
        return (0, stream_js_1.subscribe)(this.baseUrl, this.defaultHeaders, this.fetchImpl, filters, handlers, options);
    }
    /**
     * The same subscription as an async iterator, for `for await` and for
     * `sci watch` (#290): one event per frame.
     *
     * It wraps `stream()` rather than reading the socket again, so the resume,
     * heartbeat and backoff rules live in one place. Iteration ends when the
     * handle ends — a fatal status, `close()`, or the `signal` aborting — so a
     * stream the server closed is followed by a reconnect, not a quiet finish.
     * A recoverable drop yields nothing at all: the handle is still retrying it.
     *
     * Breaking out of the loop closes the handle before `next()` returns.
     */
    async *streamEvents(filters, options = {}) {
        const queue = [];
        let wake = null;
        const notify = () => {
            const resume = wake;
            wake = null;
            if (resume !== null)
                resume();
        };
        // `stream()` validates the filter synchronously, so a bad request rejects
        // the first `next()` like any other failing async iterator.
        const handle = this.stream(filters, {
            onEvent: (event) => {
                queue.push({ kind: 'event', event });
                notify();
            },
            onError: (error, info) => {
                if (!info.fatal)
                    return;
                queue.push({ kind: 'error', error });
                notify();
            },
        }, options);
        void handle.done.then(notify, notify);
        try {
            while (!handle.closed || queue.length > 0) {
                const next = queue.shift();
                if (next === undefined) {
                    await new Promise((resolve) => {
                        wake = resolve;
                    });
                    continue;
                }
                if (next.kind === 'error')
                    throw next.error;
                yield next.event;
            }
        }
        finally {
            handle.close();
        }
    }
    /**
     * Every voucher across all pages (#286). One request per page, and only
     * when the previous page has been fully consumed: breaking out of the
     * loop makes no further requests.
     */
    vouchersIterate(params) {
        return iteratePages((p) => this.vouchers(p), (res) => res.vouchers, (res) => res.nextCursor, params);
    }
    /** Every clinic across all pages (#286), same paging semantics. */
    providersIterate(params) {
        return iteratePages((p) => this.providers(p), (res) => res.providers, (res) => res.nextCursor, params);
    }
    /** Every receipt across all pages (#286), same paging semantics. */
    receiptsIterate(params) {
        return iteratePages((p) => this.receipts(p), (res) => res.receipts, (res) => res.nextCursor, params);
    }
    /**
     * Every service in the catalogue (#286). `GET /services` is a single
     * uncursored page, so this is one request and a full pass over it.
     */
    async *servicesIterate() {
        const res = await this.services();
        for (const service of res.services)
            yield service;
    }
    async rawGet(path, params) {
        return this.request(path, params);
    }
}
exports.Client = Client;
function createClient(options) {
    return new Client(options);
}
/**
 * The cursor-loop behind the `*Iterate` methods (#286).
 *
 * The next page is requested only after the previous one has been yielded
 * in full, which is what makes `break` cheap: the generator suspends at the
 * `yield`, so leaving the loop never fires the following request.
 */
async function* iteratePages(fetchPage, rowsOf, cursorOf, params) {
    let cursor = params?.cursor;
    for (;;) {
        const page = { ...params };
        if (cursor !== undefined)
            page.cursor = cursor;
        else
            delete page.cursor;
        const res = await fetchPage(page);
        for (const row of rowsOf(res))
            yield row;
        cursor = cursorOf(res) ?? undefined;
        if (cursor === undefined)
            return;
    }
}
//# sourceMappingURL=client.js.map
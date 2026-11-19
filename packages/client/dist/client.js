export class ApiError extends Error {
    status;
    error;
    details;
    issues;
    constructor(status, error, message, details) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.error = error;
        this.details = details;
        this.issues = details;
    }
}
/** Extra attempts after the first one. The hosted API sleeps when idle. */
export const DEFAULT_RETRIES = 2;
/** First backoff ceiling; doubles per attempt. */
export const RETRY_BASE_DELAY_MS = 250;
/** Ceiling on the backoff, so a retry storm cannot stall a caller. */
export const RETRY_MAX_DELAY_MS = 5_000;
/**
 * Statuses worth another attempt, because the server either failed itself
 * or asked to be asked again later. Every other 4xx is a final answer about
 * this request, and repeating it only wastes a round trip.
 */
export function isRetryableStatus(status) {
    return status === 408 || status === 429 || status >= 500;
}
/**
 * Exponential backoff with equal jitter for the 1-based `attempt`: half of
 * the ceiling is fixed and half is random, so clients that failed together
 * do not retry together.
 */
export function backoffMs(attempt, random = Math.random, base = RETRY_BASE_DELAY_MS, max = RETRY_MAX_DELAY_MS) {
    const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
    return Math.round(ceiling / 2 + (ceiling / 2) * random());
}
/**
 * `Retry-After` as milliseconds, from either the delta-seconds form or the
 * HTTP-date form, or null when the header is absent or unparseable. Unlike
 * the backoff this is honoured exactly: the server has said when it can
 * serve the request, and arriving earlier only adds load.
 */
export function retryAfterMs(value, nowMs) {
    const trimmed = value?.trim();
    if (!trimmed)
        return null;
    if (/^\d+$/.test(trimmed))
        return Number(trimmed) * 1000;
    const stamped = Date.parse(trimmed);
    if (Number.isNaN(stamped))
        return null;
    return Math.max(0, stamped - nowMs);
}
/** True for the error a fetch rejects with once its signal has fired. */
export function isAbortError(error) {
    if (typeof error !== 'object' || error === null || !('name' in error))
        return false;
    const name = error.name;
    return name === 'AbortError' || name === 'TimeoutError';
}
/** The rejection a caller sees when the signal it passed has fired. */
function abortFailure(signal) {
    const reason = signal.reason;
    if (reason instanceof Error)
        return reason;
    return new DOMException('The operation was aborted.', 'AbortError');
}
/** Resolves after `ms`, early and rejected when `signal` fires. */
async function sleep(ms, signal) {
    const delay = Math.max(0, ms);
    if (!signal) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return;
    }
    if (signal.aborted)
        throw abortFailure(signal);
    await new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(handle);
            reject(abortFailure(signal));
        };
        const handle = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, delay);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}
/**
 * Validates and extracts coordinates a clinic has published, or null.
 */
export function providerLocation(p) {
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
export class Client {
    baseUrl;
    fetchImpl;
    defaultHeaders;
    retries;
    signal;
    random;
    now;
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
        this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
        this.defaultHeaders = options.headers ?? {};
        this.retries = Math.max(0, Math.trunc(options.retries ?? DEFAULT_RETRIES));
        this.signal = options.signal ?? null;
        this.random = options.random ?? Math.random;
        this.now = options.now ?? (() => Date.now());
    }
    urlFor(path, params) {
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
        return url.toString();
    }
    /**
     * One GET through the retry loop. The response is returned whatever its
     * status — only the caller knows whether it wants JSON or CSV, so the
     * loop stops at the transport and not at the body.
     */
    async get(path, params, headers, init) {
        const url = this.urlFor(path, params);
        const signal = init?.signal ?? this.signal;
        for (let attempt = 1;; attempt += 1) {
            // An already-cancelled caller never sees a request leave.
            if (signal?.aborted)
                throw abortFailure(signal);
            try {
                const res = await this.fetchImpl(url, {
                    ...init,
                    headers,
                    ...(signal ? { signal } : {}),
                });
                if (attempt > this.retries || !isRetryableStatus(res.status))
                    return res;
                // The server's own wait beats our guess at one.
                const wait = retryAfterMs(res.headers.get('retry-after'), this.now()) ??
                    backoffMs(attempt, this.random);
                // Nobody reads a response we are throwing away, so release its
                // stream: an unread body pins the connection until it is collected,
                // which is the opposite of what a retry during an outage needs.
                await res.body?.cancel();
                await sleep(wait, signal);
            }
            catch (cause) {
                // A cancelled fetch is the caller's decision, not a failure to retry.
                if (isAbortError(cause))
                    throw cause;
                if (attempt > this.retries) {
                    throw new ApiError(0, 'network_error', `Cannot reach the API at ${this.baseUrl}: ${cause}`, cause);
                }
                await sleep(backoffMs(attempt, this.random), signal);
            }
        }
    }
    async request(path, params, init) {
        const headers = {
            accept: 'application/json',
            ...this.defaultHeaders,
            ...init?.headers,
        };
        const res = await this.get(path, params, headers, init);
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
            throw new ApiError(res.status, errCode, message, details);
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
        // Same retry loop as the JSON reads, without the JSON accept header the
        // route does not ask for.
        const res = await this.get('/vouchers.csv', params, { ...this.defaultHeaders }, undefined);
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
    async rawGet(path, params) {
        return this.request(path, params);
    }
}
export function createClient(options) {
    return new Client(options);
}
//# sourceMappingURL=client.js.map
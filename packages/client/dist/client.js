export class ApiError extends Error {
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
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/+$/, '');
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
    async rawGet(path, params) {
        return this.request(path, params);
    }
}
export function createClient(options) {
    return new Client(options);
}
//# sourceMappingURL=client.js.map
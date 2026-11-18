import type { CountryStats, CsvVouchersParams, DailyStats, DueVouchersParams, GovernanceResponse, HealthStatus, ListProvidersParams, ListReceiptsParams, ListVouchersParams, Provider, ProviderHistory, ProviderLocation, ProvidersResponse, Receipt, ReceiptsResponse, ReadyStatus, ServiceCatalogueItem, ServicePriceChangeHistory, ServicesResponse, Stats, VersionInfo, Voucher, VoucherDetail, VouchersResponse } from './types.js';
export declare class ApiError extends Error {
    readonly status: number;
    readonly error: string;
    readonly details?: unknown;
    readonly issues?: unknown;
    constructor(status: number, error: string, message: string, details?: unknown);
}
/** Extra attempts after the first one. The hosted API sleeps when idle. */
export declare const DEFAULT_RETRIES = 2;
/** First backoff ceiling; doubles per attempt. */
export declare const RETRY_BASE_DELAY_MS = 250;
/** Ceiling on the backoff, so a retry storm cannot stall a caller. */
export declare const RETRY_MAX_DELAY_MS = 5000;
/**
 * Statuses worth another attempt, because the server either failed itself
 * or asked to be asked again later. Every other 4xx is a final answer about
 * this request, and repeating it only wastes a round trip.
 */
export declare function isRetryableStatus(status: number): boolean;
/**
 * Exponential backoff with equal jitter for the 1-based `attempt`: half of
 * the ceiling is fixed and half is random, so clients that failed together
 * do not retry together.
 */
export declare function backoffMs(attempt: number, random?: () => number, base?: number, max?: number): number;
/**
 * `Retry-After` as milliseconds, from either the delta-seconds form or the
 * HTTP-date form, or null when the header is absent or unparseable. Unlike
 * the backoff this is honoured exactly: the server has said when it can
 * serve the request, and arriving earlier only adds load.
 */
export declare function retryAfterMs(value: string | null | undefined, nowMs: number): number | null;
/** True for the error a fetch rejects with once its signal has fired. */
export declare function isAbortError(error: unknown): boolean;
/**
 * Validates and extracts coordinates a clinic has published, or null.
 */
export declare function providerLocation(p: Provider): ProviderLocation | null;
export interface ClientOptions {
    baseUrl: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
    /**
     * Attempts after the first for a request that fails with a network error,
     * a 408, a 429 or a 5xx. Defaults to 2; 0 disables retrying.
     */
    retries?: number;
    /** Cancels every in-flight and later request made through this client. */
    signal?: AbortSignal;
    /** Jitter source for the backoff; overridable so tests can be exact. */
    random?: () => number;
    /** Clock for `Retry-After` HTTP dates; overridable for tests. */
    now?: () => number;
}
export declare class Client {
    private readonly baseUrl;
    private readonly fetchImpl;
    private readonly defaultHeaders;
    private readonly retries;
    private readonly signal;
    private readonly random;
    private readonly now;
    constructor(options: ClientOptions);
    private urlFor;
    /**
     * One GET through the retry loop. The response is returned whatever its
     * status — only the caller knows whether it wants JSON or CSV, so the
     * loop stops at the transport and not at the body.
     */
    private get;
    private request;
    health(): Promise<HealthStatus>;
    version(): Promise<VersionInfo>;
    ready(): Promise<ReadyStatus>;
    stats(): Promise<Stats>;
    dailyStats(days?: number): Promise<DailyStats>;
    providers(params?: ListProvidersParams): Promise<ProvidersResponse>;
    provider(address: string): Promise<Provider>;
    providerHistory(address: string): Promise<ProviderHistory>;
    providerServiceHistory(address: string, code: number): Promise<ServicePriceChangeHistory>;
    countries(): Promise<{
        countries: CountryStats[];
    }>;
    services(): Promise<ServicesResponse>;
    service(code: number): Promise<ServiceCatalogueItem>;
    vouchers(params?: ListVouchersParams): Promise<VouchersResponse>;
    voucher(id: string): Promise<VoucherDetail>;
    vouchersDue(params: DueVouchersParams): Promise<{
        vouchers: Voucher[];
    }>;
    vouchersCsv(params?: CsvVouchersParams): Promise<string>;
    receipts(params: ListReceiptsParams): Promise<ReceiptsResponse>;
    receipt(voucherId: string): Promise<Receipt>;
    governance(): Promise<GovernanceResponse>;
    rawGet<T>(path: string, params?: Record<string, unknown>): Promise<T>;
}
export declare function createClient(options: ClientOptions): Client;

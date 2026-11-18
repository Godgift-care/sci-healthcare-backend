import type { ApiErrorEnvelope, CountryStats, CsvVouchersParams, DailyStats, DueVouchersParams, DueVouchersResponse, GovernanceResponse, HealthStatus, ListProvidersParams, ListReceiptsParams, ListVouchersParams, Provider, ProviderHistory, ProviderLocation, ProvidersResponse, Receipt, ReceiptsResponse, ReadyStatus, ServiceClinics, ServicePriceChangeHistory, ServicesResponse, Stats, VersionInfo, VoucherDetail, VouchersResponse } from './types.js';
import { type StreamFilters, type StreamHandle, type StreamHandlers, type StreamOptions } from './stream.js';
export declare class ApiError extends Error {
    readonly status: number;
    readonly error: string;
    readonly details?: unknown;
    readonly issues?: unknown;
    /**
     * The error body as the API sent it, typed as the one documented envelope
     * (#296).
     *
     * `message` on this class is a fallback-protected string because `Error`
     * needs one; `envelope` is the honest record, so a route that answers a
     * lookup failure without a localised `message` shows that here rather than
     * inheriting a sentence the server never sent.
     */
    readonly envelope: ApiErrorEnvelope;
    constructor(status: number, error: string, message: string, details?: unknown, envelope?: ApiErrorEnvelope);
}
/**
 * Validates and extracts coordinates a clinic has published, or null.
 */
export declare function providerLocation(p: Provider): ProviderLocation | null;
export interface ClientOptions {
    baseUrl: string;
    fetch?: typeof fetch;
    headers?: Record<string, string>;
}
export declare class Client {
    private readonly baseUrl;
    private readonly fetchImpl;
    private readonly defaultHeaders;
    constructor(options: ClientOptions);
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
    service(code: number): Promise<ServiceClinics>;
    vouchers(params?: ListVouchersParams): Promise<VouchersResponse>;
    voucher(id: string): Promise<VoucherDetail>;
    vouchersDue(params: DueVouchersParams): Promise<DueVouchersResponse>;
    vouchersCsv(params?: CsvVouchersParams): Promise<string>;
    receipts(params: ListReceiptsParams): Promise<ReceiptsResponse>;
    receipt(voucherId: string): Promise<Receipt>;
    governance(): Promise<GovernanceResponse>;
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
    stream(filters: StreamFilters, handlers?: StreamHandlers, options?: StreamOptions): StreamHandle;
    rawGet<T>(path: string, params?: Record<string, unknown>): Promise<T>;
}
export declare function createClient(options: ClientOptions): Client;

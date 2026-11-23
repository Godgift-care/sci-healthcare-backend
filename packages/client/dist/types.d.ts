/**
 * Typed models representing the SCI Healthcare API schemas and read model.
 * These types match the backend's OpenAPI contract and serve as the single source
 * of truth for consumers (including the frontend and external tools).
 */
export type Service = {
    code: number;
    label: string;
    price: string;
    priceDisplay: string;
    active?: boolean;
    /**
     * Price scheduled with notice, or null when nothing is pending — and null
     * once the schedule has taken effect, because by then it is `price`
     * (issue #315). Absent from a response served by an older deployment.
     */
    upcomingPrice?: string | null;
    /** ISO instant `upcomingPrice` takes effect; null with no pending schedule. */
    upcomingFrom?: string | Date | null;
};
export type ProviderLocation = {
    lat: number;
    lng: number;
};
/**
 * The clinic's off-chain metadata document (contracts #10), fetched and
 * validated by the backend before it is cached and served. Null until one
 * has been fetched; every field is optional because the schema in
 * `src/lib/provider-metadata.ts` caps, not requires, each of them.
 */
export type ProviderMetadata = {
    name?: string;
    address?: string;
    location?: ProviderLocation | null;
    hours?: string | Record<string, string>;
    phone?: string;
    languages?: string[];
};
export type Provider = {
    address: string;
    name: string;
    country: string;
    status: 'Pending' | 'Active' | 'Suspended';
    registeredAt: string | Date;
    /**
     * The clinic's voucher cap as indexed from the registry's `capacity_changed`
     * event; `0` means unlimited and `null` until the chain has announced one.
     */
    capacity: number | null;
    /** Funded and Claimed vouchers right now; with `capacity`, the headroom. */
    openVouchers: number;
    services: Service[];
    /**
     * Never served by the API: the provider routes emit the coordinates inside
     * `metadata`, and this top-level field exists so a hand-built or
     * pre-normalised object still works with `providerLocation()`.
     */
    location?: ProviderLocation | null;
    metadata?: ProviderMetadata | null;
    /**
     * The metadata fetch state (#271): `pending` after a pointer is announced,
     * `ok` once a document is cached, `failed` when the last attempt was
     * rejected. Null when the clinic never published a pointer.
     */
    metadataStatus?: 'pending' | 'ok' | 'failed' | null;
    /**
     * A short code for the last rejection — never the remote body — or null
     * when the last fetch succeeded or none has run.
     */
    metadataError?: string | null;
};
export type ServicePriceChange = {
    price: string;
    priceDisplay: string;
    ledger: number;
    changedAt: string | Date;
};
export type ServicePriceChangeHistory = {
    providerAddress: string;
    code: number;
    history: ServicePriceChange[];
};
/**
 * One status transition of a clinic, as `GET /providers/{address}/history`
 * serves it: the registry row only ever records the new status, the ledger it
 * was seen on, and when. The clinic's name and country are not part of the
 * history — read them off the provider record itself.
 */
export type ProviderHistoryItem = {
    status: string;
    ledger: number;
    changedAt: string | Date;
};
export type ProviderHistory = {
    address: string;
    history: ProviderHistoryItem[];
};
export type CountryStats = {
    code: string;
    name: string;
    clinicCount: number | null;
    suppressed: boolean;
};
/** One entry of `GET /services`: every clinic price for one service code. */
export type ServiceCatalogueItem = {
    code: number;
    labels: string[];
    clinicCount: number;
    minPrice: string;
    maxPrice: string;
    medianPrice: string;
    minPriceDisplay: string;
    maxPriceDisplay: string;
    medianPriceDisplay: string;
};
/** One clinic offering one service, cheapest first, from `GET /services/{code}`. */
export type ServiceClinic = {
    address: string;
    name: string;
    country: string;
    price: string;
    priceDisplay: string;
    /** Pending schedule for this clinic's price, when one exists (#315). */
    upcomingPrice?: string | null;
    upcomingFrom?: string | Date | null;
};
/**
 * The per-code detail page. Not the same shape as a `GET /services` entry:
 * the list aggregates prices across clinics, this one names them.
 */
export type ServiceClinics = {
    code: number;
    clinicCount: number;
    clinics: ServiceClinic[];
};
export type VoucherStatus = 'Funded' | 'Claimed' | 'Attested' | 'Settled' | 'Disputed' | 'Refunded';
/** The clinic as a voucher or receipt row names it: public registry fields only. */
export type ProviderSummary = {
    address: string;
    name: string;
    country: string;
};
export type Voucher = {
    id: string;
    funder: string;
    beneficiaryRef: string;
    provider: ProviderSummary;
    serviceCode: number;
    serviceLabel?: string | null;
    amount: string;
    amountDisplay: string;
    matchedAmount: string | null;
    matchedAmountDisplay: string | null;
    matchedBy: string | null;
    matchStatus: string | null;
    matchedAt: string | Date | null;
    status: VoucherStatus;
    createdAt: string | Date;
    expiresAt: string | Date;
    claimedAt: string | Date | null;
    claimedWithProof: boolean | null;
    attestedAt: string | Date | null;
    /** The attester that signed, from the `voucher_attested` topic. */
    attestedBy: string | null;
    disputeDeadline: string | Date | null;
    /** The window the funder chose at funding time; null until reconciliation
     *  reads `get_voucher_options` for this voucher (#319). */
    disputeWindowSecs: number | null;
    /** SHA-256 the clinic must reveal to claim; null unless presence-gated (#319). */
    presenceCommitment: string | null;
    disputeReason?: number | null;
    disputeResolvedAt: string | Date | null;
    disputeResolvedBy: string | null;
    /** `'Funder'` when the funder was refunded, otherwise `'Provider'`. */
    disputeOutcome: string | null;
    settledNet: string | null;
    settledFee: string | null;
    refundableAt?: string | Date | null;
    isSettleable: boolean;
    isRefundable: boolean;
};
/**
 * The receipt as `GET /receipts/{voucherId}`, `GET /receipts` and
 * `?include=receipt` serve it. `beneficiaryRef` appears only on the patient
 * view (`GET /receipts?beneficiaryRef=...`): the shared serialiser refuses to
 * put it on a page built for sharing.
 */
export type Receipt = {
    voucherId: string;
    providerAddress: string;
    provider: ReceiptProvider;
    serviceCode: number;
    serviceLabel?: string | null;
    amount: string;
    amountDisplay: string;
    settledAt: string | Date;
    beneficiaryRef?: string;
};
/**
 * The clinic behind a receipt. A receipt whose provider the indexer never saw
 * registered reports `name: null` and `country: null` rather than a guess.
 */
export type ReceiptProvider = {
    address: string;
    name: string | null;
    country: string | null;
};
/**
 * The row `GET /vouchers/{id}` embeds as `receipt` when `?include=receipt` is
 * not asked for — the stored receipt, not the public serialisation. It carries
 * `beneficiaryRef` and `deploymentId` and has no `provider`, `serviceLabel` or
 * `amountDisplay`; request `?include=receipt` through `rawGet` for the shape
 * `GET /receipts/{voucherId}` serves.
 */
export type EmbeddedReceiptRow = {
    voucherId: string;
    beneficiaryRef: string;
    providerAddress: string;
    serviceCode: number;
    amount: string;
    settledAt: string | Date;
    deploymentId: number | null;
};
export type VoucherDetail = Voucher & {
    receipt: EmbeddedReceiptRow | null;
};
export type Stats = {
    providers: number;
    activeProviders: number;
    vouchers: number;
    settledVouchers: number;
    settledValue: string;
    /** Protocol fees collected, exact base units (issue #52). */
    feesCollected: string;
    receipts: number;
    faucetDrips?: number;
    faucetWallets?: number;
};
export type DailyBucket = {
    count: number;
    amount: string;
};
export type DailyRow = {
    date: string;
    funded: DailyBucket;
    settled: DailyBucket;
    refunded: DailyBucket;
};
export type DailyStats = {
    days: number;
    from: string;
    to: string;
    series: DailyRow[];
};
export type Attester = {
    address: string;
    active: boolean;
    addedAt: string;
    removedAt?: string | null;
    attestations: number;
    name?: string | null;
    organisation?: string | null;
};
export type GovernanceHistoryEvent = {
    type: 'Proposed' | 'Accepted' | string;
    admin: string;
    pendingAdmin: string | null;
    ledger: number;
    occurredAt: string | Date;
};
export type GovernanceContract = {
    contract: string;
    contractId: string | null;
    currentAdmin: string | null;
    pendingAdmin: string | null;
    history: GovernanceHistoryEvent[];
};
export type GovernanceResponse = {
    contracts: GovernanceContract[];
};
export type HealthStatus = {
    status: string;
};
export type VersionInfo = {
    version: string;
    commit: string | null;
    network: string;
    rpcUrl: string;
    rpcUrls: string[];
    contracts: {
        registry: string;
        voucher: string;
        receipt: string;
        usdc: string | null;
        faucet: string | null;
    };
    indexerStartLedger: number;
    /** Process start. How long it has run is `Date.now() - startedAt`. */
    startedAt: string;
};
/** One endpoint's circuit breaker as `/ready` reports it (#265). */
export type ReadinessWebhookBreaker = {
    /** Origin and path only; a query string is never reported. */
    endpoint: string;
    state: 'closed' | 'open' | 'half-open';
    consecutiveFailures: number;
    /** When the breaker opened, or null while it is closed. */
    openedAt: string | null;
};
/** The webhook outbox as `/ready` reports it. */
export type ReadinessWebhooks = {
    state: 'ok' | 'backlog' | 'disabled';
    enabled: boolean;
    pending: number;
    abandoned: number;
    oldestPendingAgeSeconds: number | null;
    maxPendingAgeSeconds: number;
    /** Per-endpoint circuit breakers; empty until the dispatcher has seen one. */
    breakers: ReadinessWebhookBreaker[];
};
/**
 * Present only when the indexer cursor has fallen outside the RPC retention
 * window; the range says what was lost and what is still reachable.
 */
export type ReadinessGap = {
    detected: boolean;
    cursorLedger: number | null;
    oldestAvailable: number | null;
    message: string;
};
/**
 * What `/ready` checked, in one object. The fields the indexer branch cannot
 * answer (everything below `rpc`) are absent when every RPC endpoint failed,
 * so they are optional; `rpcUrls` appears only in that failure case.
 */
export type ReadinessChecks = {
    /** `'ok'`, or `'error: <reason>'` when the database probe threw. */
    database: string;
    failedEvents: number;
    reconcileMismatches: number;
    /** Drift is reported but deliberately not fatal: see `docs/RUNBOOK.md`. */
    reconcile: 'ok' | 'drift';
    webhooks: ReadinessWebhooks;
    /** `'ok'`, or `'error: <reason>'` when every RPC endpoint failed. */
    rpc: string;
    rpcUrl: string;
    rpcUrls?: string[];
    latestLedger?: number;
    indexedLedger?: number | null;
    lagLedgers?: number | null;
    maxLagLedgers?: number;
    paused?: boolean;
    indexer?: 'ok' | 'paused' | 'gap' | 'lagging';
    gap?: ReadinessGap;
    network: string;
    contracts: {
        registry: string;
        voucher: string;
        receipt: string;
    };
};
export type ReadyStatus = {
    status: 'ready' | 'degraded';
    checks: ReadinessChecks;
};
/** Public indexer cursor and retention/gap status (`GET /indexer`). */
export type IndexerStatus = {
    lastLedger: number;
    latestLedger: number;
    lagLedgers: number;
    paused: boolean;
    gap: boolean;
    gapOldestLedger: number | null;
    updatedAt: string | null;
};
export type ApiErrorDetail = {
    code?: string;
    message?: string;
    path?: (string | number)[];
    expected?: string;
    received?: string;
    [key: string]: unknown;
};
/**
 * The `error` codes the API documents (#296), read off
 * `components.schemas.ErrorEnvelope` and the examples beside it in
 * `openapi.json`.
 *
 * This is the set a client can switch on today, not a validation: the API
 * answers any code it likes, so a code added later arrives as a string that
 * is simply not in this list. `src/__tests__/openapi-docs.test.ts` fails if
 * the spec ever documents a code that is missing here, which is what keeps
 * the two in step.
 */
export declare const API_ERROR_CODES: readonly ["bad_request", "invalid_query", "invalid_cursor", "invalid_code", "invalid_limit", "filter_required", "provider_not_found", "service_not_found", "voucher_not_found", "receipt_not_found", "attester_not_found", "route_not_found", "method_not_allowed", "rate_limited", "database_unavailable", "internal_error", "stream_full"];
/** One of the documented `error` codes; see `API_ERROR_CODES`. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];
/**
 * The one body every route answers a failure with.
 *
 * `error` is the stable, never-localised code to switch on; `message` is
 * written for a human and follows the request `Accept-Language`, so it is
 * subject to change and is missing on the routes that answer a lookup failure
 * directly; `details` (or `issues`, on two routes) names the offending
 * parameter when the refusal has that information.
 */
export type ApiErrorEnvelope = {
    error: string;
    message?: string;
    details?: unknown;
    issues?: unknown;
};
/** Whether an `ApiError.error` is one of the codes the API documents. */
export declare function isApiErrorCode(code: string): code is ApiErrorCode;
/**
 * Filters for `GET /providers/:address/services` (issue #314).
 *
 * `active` is absent by default, which returns the whole catalogue including
 * the services the clinic has delisted.
 */
export type ClinicServicesParams = {
    active?: boolean;
    sort?: 'price' | 'code';
    order?: 'asc' | 'desc';
};
export type ClinicServicesResponse = {
    providerAddress: string;
    name: string;
    total: number;
    services: Service[];
};
export type ListProvidersParams = {
    status?: 'Pending' | 'Active' | 'Suspended';
    country?: string;
    q?: string;
    cursor?: string;
    limit?: number;
    offset?: number;
};
/**
 * A `GET /providers` page.
 *
 * `total` and `offset` describe the offset page the route takes by default;
 * a `cursor` page carries `limit` and `nextCursor` alone, which is why those
 * two are optional and why `src/__tests__/client-contract.test.ts` records the
 * difference rather than pretending it away.
 */
export type ProvidersResponse = {
    total: number;
    providers: Provider[];
    nextCursor?: string | null;
    limit?: number;
    offset?: number;
};
export type ListVouchersParams = {
    funder?: string;
    provider?: string;
    beneficiaryRef?: string;
    status?: VoucherStatus[] | string;
    createdFrom?: string;
    createdTo?: string;
    minAmount?: string;
    maxAmount?: string;
    sort?: 'createdAt' | 'expiresAt' | 'amount';
    order?: 'asc' | 'desc';
    cursor?: string;
    limit?: number;
    offset?: number;
};
export type VouchersResponse = {
    total?: number;
    vouchers: Voucher[];
    nextCursor?: string | null;
    limit?: number;
    offset?: number;
};
export type DueVouchersResponse = {
    total: number;
    vouchers: Voucher[];
};
export type DueVouchersParams = {
    within: string;
    funder?: string;
    provider?: string;
};
export type CsvVouchersParams = {
    funder?: string;
    provider?: string;
    beneficiaryRef?: string;
    status?: VoucherStatus[] | string;
};
export type ListReceiptsParams = {
    beneficiaryRef?: string;
    provider?: string;
    cursor?: string;
    limit?: number;
    offset?: number;
};
export type ReceiptsResponse = {
    total: number;
    totalSpend?: string;
    totalSpendDisplay?: string;
    receipts: Receipt[];
    nextCursor?: string | null;
    limit?: number;
    offset?: number;
};
export type ServicesResponse = {
    total: number;
    services: ServiceCatalogueItem[];
};

import type {
  ApiErrorEnvelope,
  ClinicServicesParams,
  ClinicServicesResponse,
  CountryStats,
  CsvVouchersParams,
  DailyStats,
  DailyStatsQuery,
  DeploymentsResponse,
  DueVouchersParams,
  DueVouchersResponse,
  GovernanceResponse,
  HealthStatus,
  IndexerStatus,
  ListProvidersParams,
  ListReceiptsParams,
  ListVouchersParams,
  Provider,
  ProviderHistory,
  ProviderLocation,
  ProvidersResponse,
  Receipt,
  ReceiptsResponse,
  ReadyStatus,
  ServiceCatalogueItem,
  ServiceClinics,
  ServicePriceChangeHistory,
  ServicesResponse,
  Stats,
  VersionInfo,
  Voucher,
  VoucherDetail,
  VouchersResponse,
} from './types.js';

import {
  subscribe,
  type StreamFilters,
  type StreamHandle,
  type StreamHandlers,
  type StreamOptions,
  type VoucherStreamEvent,
} from './stream.js';

export class ApiError extends Error {
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

  constructor(
    status: number,
    error: string,
    message: string,
    details?: unknown,
    envelope?: ApiErrorEnvelope,
  ) {
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
export function providerLocation(p: Provider): ProviderLocation | null {
  const raw = p.location ?? p.metadata?.location ?? null;
  if (!raw) return null;
  const { lat, lng } = raw;
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return null;
  }
  return { lat, lng };
}

export interface ClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
}

function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

/**
 * The first page of a list asks for its count (#247).
 *
 * The client has always returned `total`, and making the aggregate query
 * opt-in on the route would otherwise break every caller that reads it. A
 * cursor page does not ask: the count is the size of the whole filtered set,
 * unchanged by paging, and `total` stays absent there, as the response type
 * says.
 */
function firstPageCount<T extends { cursor?: string; count?: boolean }>(
  params: T | undefined,
): (T & { count?: boolean }) | undefined {
  if (params === undefined) return { count: true } as T & { count?: boolean };
  const query = { ...params };
  if (query.cursor === undefined && query.count === undefined) query.count = true;
  return query;
}

export class Client {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;

  constructor(options: ClientOptions) {
    this.baseUrl = trimTrailingSlashes(options.baseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = options.headers ?? {};
  }

  private async request<T>(
    path: string,
    params?: Record<string, unknown>,
    init?: RequestInit,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          url.searchParams.set(key, value.join(','));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.defaultHeaders,
      ...(init?.headers as Record<string, string> | undefined),
    };

    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        ...init,
        headers,
      });
    } catch (cause) {
      throw new ApiError(
        0,
        'network_error',
        `Cannot reach the API at ${this.baseUrl}: ${cause}`,
        cause,
      );
    }

    if (!res.ok) {
      let body: Partial<ApiErrorEnvelope> = {};
      try {
        body = (await res.json()) as Partial<ApiErrorEnvelope>;
      } catch {
        // Not a JSON error body
      }
      const errCode = body.error ?? `http_${res.status}`;
      const message = body.message ?? res.statusText ?? 'Request failed';
      const details = body.details ?? body.issues;
      // `error` is the only required member of the envelope, so a body that
      // does not carry one is not an envelope and is left out rather than
      // dressed up as one.
      const envelope = body.error === undefined ? undefined : (body as ApiErrorEnvelope);
      throw new ApiError(res.status, errCode, message, details, envelope);
    }

    return (await res.json()) as T;
  }

  async health(): Promise<HealthStatus> {
    return this.request<HealthStatus>('/health');
  }

  async version(): Promise<VersionInfo> {
    return this.request<VersionInfo>('/version');
  }

  async ready(): Promise<ReadyStatus> {
    return this.request<ReadyStatus>('/ready');
  }

  async indexer(): Promise<IndexerStatus> {
    return this.request<IndexerStatus>('/indexer');
  }

  async stats(): Promise<Stats> {
    return this.request<Stats>('/stats');
  }

  async dailyStats(days = 30, options: DailyStatsQuery = {}): Promise<DailyStats> {
    return this.request<DailyStats>('/stats/daily', { days, ...options });
  }

  async providers(params?: ListProvidersParams): Promise<ProvidersResponse> {
    return this.request<ProvidersResponse>(
      '/providers',
      firstPageCount(params) as Record<string, unknown>,
    );
  }

  async provider(address: string): Promise<Provider> {
    return this.request<Provider>(`/providers/${encodeURIComponent(address)}`);
  }

  /**
   * One clinic's price list on its own (issue #314), sorted by price
   * ascending by default.
   *
   * Priced separately from the clinic record because the catalogue changes
   * far more often than the profile around it, so refreshing prices does not
   * refetch — or revalidate — the whole provider.
   */
  async providerServices(
    address: string,
    params?: ClinicServicesParams,
  ): Promise<ClinicServicesResponse> {
    return this.request<ClinicServicesResponse>(
      `/providers/${encodeURIComponent(address)}/services`,
      params as Record<string, unknown>,
    );
  }

  async providerHistory(address: string): Promise<ProviderHistory> {
    return this.request<ProviderHistory>(`/providers/${encodeURIComponent(address)}/history`);
  }

  async providerServiceHistory(address: string, code: number): Promise<ServicePriceChangeHistory> {
    return this.request<ServicePriceChangeHistory>(
      `/providers/${encodeURIComponent(address)}/services/${code}/history`,
    );
  }

  async countries(): Promise<{ countries: CountryStats[] }> {
    return this.request<{ countries: CountryStats[] }>('/countries');
  }

  async services(): Promise<ServicesResponse> {
    return this.request<ServicesResponse>('/services', { count: true });
  }

  async service(code: number): Promise<ServiceClinics> {
    return this.request<ServiceClinics>(`/services/${code}`);
  }

  async vouchers(params?: ListVouchersParams): Promise<VouchersResponse> {
    return this.request<VouchersResponse>(
      '/vouchers',
      firstPageCount(params) as Record<string, unknown>,
    );
  }

  async voucher(id: string): Promise<VoucherDetail> {
    return this.request<VoucherDetail>(`/vouchers/${encodeURIComponent(id)}`);
  }

  async vouchersDue(params: DueVouchersParams): Promise<DueVouchersResponse> {
    return this.request<DueVouchersResponse>('/vouchers/due', params as Record<string, unknown>);
  }

  async vouchersCsv(params?: CsvVouchersParams): Promise<string> {
    const url = new URL(`${this.baseUrl}/vouchers.csv`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          url.searchParams.set(key, value.join(','));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const res = await this.fetchImpl(url.toString(), {
      headers: { ...this.defaultHeaders },
    });
    if (!res.ok) {
      throw new ApiError(
        res.status,
        `http_${res.status}`,
        `Failed to export CSV: ${res.statusText}`,
      );
    }
    return res.text();
  }

  async receipts(params: ListReceiptsParams): Promise<ReceiptsResponse> {
    return this.request<ReceiptsResponse>(
      '/receipts',
      firstPageCount(params) as Record<string, unknown>,
    );
  }

  async receipt(voucherId: string): Promise<Receipt> {
    return this.request<Receipt>(`/receipts/${encodeURIComponent(voucherId)}`);
  }

  async governance(): Promise<GovernanceResponse> {
    return this.request<GovernanceResponse>('/governance');
  }

  async deployments(): Promise<DeploymentsResponse> {
    return this.request<DeploymentsResponse>('/deployments');
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
   * Each frame carries the on-chain event id, resent as `Last-Event-ID` on a
   * reconnect so the server replays what was missed. If that cursor is too old
   * for the replay window, `onReset` fires and the JSON routes should be
   * re-read.
   */
  stream(
    filters: StreamFilters,
    handlers: StreamHandlers = {},
    options: StreamOptions = {},
  ): StreamHandle {
    return subscribe(this.baseUrl, this.defaultHeaders, this.fetchImpl, filters, handlers, options);
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
  async *streamEvents(
    filters: StreamFilters,
    options: StreamOptions = {},
  ): AsyncGenerator<VoucherStreamEvent> {
    // One queue for both signals: the handle reports events and fatal errors
    // from its own callbacks, and the consumer decides the order they surface.
    type Frame =
      | { readonly kind: 'event'; readonly event: VoucherStreamEvent }
      | { readonly kind: 'error'; readonly error: unknown };
    const queue: Frame[] = [];
    let wake: (() => void) | null = null;
    const notify = (): void => {
      const resume = wake;
      wake = null;
      if (resume !== null) resume();
    };

    // `stream()` validates the filter synchronously, so a bad request rejects
    // the first `next()` like any other failing async iterator.
    const handle = this.stream(
      filters,
      {
        onEvent: (event) => {
          queue.push({ kind: 'event', event });
          notify();
        },
        onError: (error, info) => {
          if (!info.fatal) return;
          queue.push({ kind: 'error', error });
          notify();
        },
      },
      options,
    );
    void handle.done.then(notify, notify);

    try {
      while (!handle.closed || queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (next.kind === 'error') throw next.error;
        yield next.event;
      }
    } finally {
      handle.close();
    }
  }

  /**
   * Every voucher across all pages (#286). One request per page, and only
   * when the previous page has been fully consumed: breaking out of the
   * loop makes no further requests.
   */
  vouchersIterate(params?: ListVouchersParams): AsyncGenerator<Voucher> {
    return iteratePages<Voucher, ListVouchersParams, VouchersResponse>(
      (p) => this.vouchers(p),
      (res) => res.vouchers,
      (res) => res.nextCursor,
      params,
    );
  }

  /** Every clinic across all pages (#286), same paging semantics. */
  providersIterate(params?: ListProvidersParams): AsyncGenerator<Provider> {
    return iteratePages<Provider, ListProvidersParams, ProvidersResponse>(
      (p) => this.providers(p),
      (res) => res.providers,
      (res) => res.nextCursor,
      params,
    );
  }

  /** Every receipt across all pages (#286), same paging semantics. */
  receiptsIterate(params: ListReceiptsParams): AsyncGenerator<Receipt> {
    return iteratePages<Receipt, ListReceiptsParams, ReceiptsResponse>(
      (p) => this.receipts(p),
      (res) => res.receipts,
      (res) => res.nextCursor,
      params,
    );
  }

  /**
   * Every service in the catalogue (#286). `GET /services` is a single
   * uncursored page, so this is one request and a full pass over it.
   */
  async *servicesIterate(): AsyncGenerator<ServiceCatalogueItem> {
    const res = await this.services();
    for (const service of res.services) yield service;
  }

  async rawGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>(path, params);
  }
}

export function createClient(options: ClientOptions): Client {
  return new Client(options);
}

/**
 * The cursor-loop behind the `*Iterate` methods (#286).
 *
 * The next page is requested only after the previous one has been yielded
 * in full, which is what makes `break` cheap: the generator suspends at the
 * `yield`, so leaving the loop never fires the following request.
 */
async function* iteratePages<T, P extends { cursor?: string; limit?: number }, R>(
  fetchPage: (params: P) => Promise<R>,
  rowsOf: (res: R) => T[],
  cursorOf: (res: R) => string | null | undefined,
  params?: P,
): AsyncGenerator<T> {
  let cursor = params?.cursor;
  for (;;) {
    const page: P = { ...params } as P;
    if (cursor !== undefined) page.cursor = cursor;
    else delete page.cursor;
    const res = await fetchPage(page);
    for (const row of rowsOf(res)) yield row;
    cursor = cursorOf(res) ?? undefined;
    if (cursor === undefined) return;
  }
}

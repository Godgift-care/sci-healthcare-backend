import type {
  CountryStats,
  CsvVouchersParams,
  DailyStats,
  DueVouchersParams,
  GovernanceResponse,
  HealthStatus,
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
  ServicePriceChangeHistory,
  ServicesResponse,
  Stats,
  VersionInfo,
  Voucher,
  VoucherDetail,
  VouchersResponse,
} from './types.js';

export class ApiError extends Error {
  readonly status: number;
  readonly error: string;
  readonly details?: unknown;
  readonly issues?: unknown;

  constructor(status: number, error: string, message: string, details?: unknown) {
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
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Exponential backoff with equal jitter for the 1-based `attempt`: half of
 * the ceiling is fixed and half is random, so clients that failed together
 * do not retry together.
 */
export function backoffMs(
  attempt: number,
  random: () => number = Math.random,
  base = RETRY_BASE_DELAY_MS,
  max = RETRY_MAX_DELAY_MS,
): number {
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random());
}

/**
 * `Retry-After` as milliseconds, from either the delta-seconds form or the
 * HTTP-date form, or null when the header is absent or unparseable. Unlike
 * the backoff this is honoured exactly: the server has said when it can
 * serve the request, and arriving earlier only adds load.
 */
export function retryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const stamped = Date.parse(trimmed);
  if (Number.isNaN(stamped)) return null;
  return Math.max(0, stamped - nowMs);
}

/** True for the error a fetch rejects with once its signal has fired. */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('name' in error)) return false;
  const name = (error as { name: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** The rejection a caller sees when the signal it passed has fired. */
function abortFailure(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** Resolves after `ms`, early and rejected when `signal` fires. */
async function sleep(ms: number, signal: AbortSignal | null): Promise<void> {
  const delay = Math.max(0, ms);
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    return;
  }
  if (signal.aborted) throw abortFailure(signal);
  await new Promise<void>((resolve, reject) => {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (handle !== undefined) clearTimeout(handle);
      reject(abortFailure(signal));
    };
    handle = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delay);
    signal.addEventListener('abort', onAbort, { once: true });
  });
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

export class Client {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultHeaders: Record<string, string>;
  private readonly retries: number;
  private readonly signal: AbortSignal | null;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultHeaders = options.headers ?? {};
    this.retries = Math.max(0, Math.trunc(options.retries ?? DEFAULT_RETRIES));
    this.signal = options.signal ?? null;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => Date.now());
  }

  private urlFor(path: string, params?: Record<string, unknown>): string {
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

    return url.toString();
  }

  /**
   * One GET through the retry loop. The response is returned whatever its
   * status — only the caller knows whether it wants JSON or CSV, so the
   * loop stops at the transport and not at the body.
   */
  private async get(
    path: string,
    params: Record<string, unknown> | undefined,
    headers: Record<string, string>,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const url = this.urlFor(path, params);
    const signal = init?.signal ?? this.signal;

    for (let attempt = 1; ; attempt += 1) {
      // An already-cancelled caller never sees a request leave.
      if (signal?.aborted) throw abortFailure(signal);

      try {
        const res = await this.fetchImpl(url, {
          ...init,
          headers,
          ...(signal ? { signal } : {}),
        });
        if (attempt > this.retries || !isRetryableStatus(res.status)) return res;
        // The server's own wait beats our guess at one.
        const wait = retryAfterMs(res.headers.get('retry-after'), this.now()) ?? backoffMs(attempt, this.random);
        // Nobody reads a response we are throwing away, so release its
        // stream: an unread body pins the connection until it is collected,
        // which is the opposite of what a retry during an outage needs.
        await res.body?.cancel();
        await sleep(wait, signal);
      } catch (cause) {
        // A cancelled fetch is the caller's decision, not a failure to retry.
        if (isAbortError(cause)) throw cause;
        if (attempt > this.retries) {
          throw new ApiError(
            0,
            'network_error',
            `Cannot reach the API at ${this.baseUrl}: ${cause}`,
            cause,
          );
        }
        await sleep(backoffMs(attempt, this.random), signal);
      }
    }
  }

  private async request<T>(
    path: string,
    params?: Record<string, unknown>,
    init?: RequestInit,
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.defaultHeaders,
      ...(init?.headers as Record<string, string> | undefined),
    };

    const res = await this.get(path, params, headers, init);

    if (!res.ok) {
      let body: { error?: string; message?: string; details?: unknown; issues?: unknown } = {};
      try {
        body = (await res.json()) as {
          error?: string;
          message?: string;
          details?: unknown;
          issues?: unknown;
        };
      } catch {
        // Not a JSON error body
      }
      const errCode = body.error ?? `http_${res.status}`;
      const message = body.message ?? res.statusText ?? 'Request failed';
      const details = body.details ?? body.issues;
      throw new ApiError(res.status, errCode, message, details);
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

  async stats(): Promise<Stats> {
    return this.request<Stats>('/stats');
  }

  async dailyStats(days = 30): Promise<DailyStats> {
    return this.request<DailyStats>('/stats/daily', { days });
  }

  async providers(params?: ListProvidersParams): Promise<ProvidersResponse> {
    return this.request<ProvidersResponse>('/providers', params as Record<string, unknown>);
  }

  async provider(address: string): Promise<Provider> {
    return this.request<Provider>(`/providers/${encodeURIComponent(address)}`);
  }

  async providerHistory(address: string): Promise<ProviderHistory> {
    return this.request<ProviderHistory>(`/providers/${encodeURIComponent(address)}/history`);
  }

  async providerServiceHistory(
    address: string,
    code: number,
  ): Promise<ServicePriceChangeHistory> {
    return this.request<ServicePriceChangeHistory>(
      `/providers/${encodeURIComponent(address)}/services/${code}/history`,
    );
  }

  async countries(): Promise<{ countries: CountryStats[] }> {
    return this.request<{ countries: CountryStats[] }>('/countries');
  }

  async services(): Promise<ServicesResponse> {
    return this.request<ServicesResponse>('/services');
  }

  async service(code: number): Promise<ServiceCatalogueItem> {
    return this.request<ServiceCatalogueItem>(`/services/${code}`);
  }

  async vouchers(params?: ListVouchersParams): Promise<VouchersResponse> {
    return this.request<VouchersResponse>('/vouchers', params as Record<string, unknown>);
  }

  async voucher(id: string): Promise<VoucherDetail> {
    return this.request<VoucherDetail>(`/vouchers/${encodeURIComponent(id)}`);
  }

  async vouchersDue(params: DueVouchersParams): Promise<{ vouchers: Voucher[] }> {
    return this.request<{ vouchers: Voucher[] }>('/vouchers/due', params as Record<string, unknown>);
  }

  async vouchersCsv(params?: CsvVouchersParams): Promise<string> {
    // Same retry loop as the JSON reads, without the JSON accept header the
    // route does not ask for.
    const res = await this.get(
      '/vouchers.csv',
      params as Record<string, unknown> | undefined,
      { ...this.defaultHeaders },
      undefined,
    );
    if (!res.ok) {
      throw new ApiError(res.status, `http_${res.status}`, `Failed to export CSV: ${res.statusText}`);
    }
    return res.text();
  }

  async receipts(params: ListReceiptsParams): Promise<ReceiptsResponse> {
    return this.request<ReceiptsResponse>('/receipts', params as Record<string, unknown>);
  }

  async receipt(voucherId: string): Promise<Receipt> {
    return this.request<Receipt>(`/receipts/${encodeURIComponent(voucherId)}`);
  }

  async governance(): Promise<GovernanceResponse> {
    return this.request<GovernanceResponse>('/governance');
  }

  async rawGet<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return this.request<T>(path, params);
  }
}

export function createClient(options: ClientOptions): Client {
  return new Client(options);
}

import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { seedLocalData } from '../scripts/seed.js';
import {
  ApiError,
  backoffMs,
  createClient,
  isAbortError,
  isRetryableStatus,
  providerLocation,
  retryAfterMs,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  type Provider,
} from '../../packages/client/dist/index.js';

describe('@sci-healthcare/client', () => {
  let app: FastifyInstance;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();

    await prisma.faucetDrip.deleteMany();
    await prisma.receipt.deleteMany();
    await prisma.voucher.deleteMany();
    await prisma.service.deleteMany();
    await prisma.provider.deleteMany();
    await prisma.governanceEvent.deleteMany();
    await prisma.servicePriceChange.deleteMany();
    await seedLocalData(prisma);

    // Adapter connecting the typed client to app.inject without opening network sockets
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      );
      const method = (init?.method ?? 'GET') as
        | 'GET'
        | 'POST'
        | 'PUT'
        | 'DELETE'
        | 'OPTIONS'
        | 'HEAD'
        | 'PATCH';

      const headers: Record<string, string> = {};
      if (init?.headers) {
        if (Array.isArray(init.headers)) {
          for (const entry of init.headers) {
            const [k, v] = entry as [string, string];
            if (k) headers[k] = v;
          }
        } else if (typeof (init.headers as { forEach?: unknown }).forEach === 'function') {
          (init.headers as { forEach: (cb: (v: string, k: string) => void) => void }).forEach(
            (v: string, k: string) => {
              headers[k] = v;
            },
          );
        } else {
          Object.assign(headers, init.headers);
        }
      }

      const res = await app.inject({
        method,
        url: url.pathname + url.search,
        headers,
        ...(init?.body ? { payload: String(init.body) } : {}),
      });

      return new Response(res.body, {
        status: res.statusCode,
        statusText: res.statusMessage,
      });
    };

    client = createClient({
      baseUrl: 'http://localhost:3000',
      fetch: fetchImpl,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('queries health and version information', async () => {
    const health = await client.health();
    expect(health).toEqual({ status: 'ok' });

    const version = await client.version();
    expect(version.version).toBeDefined();
    expect(version.network).toBeDefined();
    expect(version.contracts.registry).toBeDefined();
  });

  it('queries aggregate stats', async () => {
    const stats = await client.stats();
    expect(stats.providers).toBeGreaterThan(0);
    expect(stats.vouchers).toBeGreaterThan(0);
    expect(typeof stats.settledValue).toBe('string');
  });

  it('queries providers list and single provider', async () => {
    const res = await client.providers({ status: 'Active' });
    expect(res.total).toBeGreaterThan(0);
    expect(res.providers.length).toBeGreaterThan(0);

    const first = res.providers[0]!;
    const provider = await client.provider(first.address);
    expect(provider.address).toBe(first.address);
    expect(provider.name).toBe(first.name);
  });

  it('queries services catalogue and single service by code', async () => {
    const res = await client.services();
    expect(res.total).toBeGreaterThan(0);
    expect(res.services.length).toBeGreaterThan(0);

    const first = res.services[0]!;
    const detail = await client.service(first.code);
    expect(detail.code).toBe(first.code);
    expect(detail.clinicCount).toBeGreaterThan(0);
  });

  it('queries vouchers with filters', async () => {
    const res = await client.vouchers({ status: ['Funded', 'Claimed'] });
    expect(res.vouchers.length).toBeGreaterThan(0);
    const first = res.vouchers[0]!;

    const detail = await client.voucher(first.id);
    expect(detail.id).toBe(first.id);
    expect(detail.funder).toBe(first.funder);
    expect(detail.isSettleable).toBeDefined();
  });

  it('queries governance contracts and audit history', async () => {
    const res = await client.governance();
    expect(res.contracts).toBeDefined();
    expect(Array.isArray(res.contracts)).toBe(true);
  });

  it('queries countries list', async () => {
    const res = await client.countries();
    expect(res.countries).toBeDefined();
    expect(res.countries.length).toBeGreaterThan(0);
  });

  it('throws typed ApiError on validation failures', async () => {
    await expect(
      client.vouchers({ minAmount: '100', maxAmount: '50' }),
    ).rejects.toThrow(ApiError);

    try {
      await client.vouchers({ minAmount: '100', maxAmount: '50' });
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.status).toBe(400);
      expect(apiErr.error).toBe('invalid_query');
      expect(apiErr.issues).toBeDefined();
    }
  });

  it('throws ApiError on 404', async () => {
    await expect(
      client.provider('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
    ).rejects.toThrow(ApiError);
  });

  it('validates providerLocation helper accurately', () => {
    const valid: Provider = {
      address: 'GABC',
      name: 'Test Clinic',
      country: 'KE',
      status: 'Active',
      registeredAt: new Date().toISOString(),
      services: [],
      location: { lat: -1.286389, lng: 36.817223 },
    };
    expect(providerLocation(valid)).toEqual({ lat: -1.286389, lng: 36.817223 });

    const metadataLocation: Provider = {
      address: 'GABC',
      name: 'Test Clinic',
      country: 'KE',
      status: 'Active',
      registeredAt: new Date().toISOString(),
      services: [],
      metadata: { location: { lat: 0.5, lng: 35.2 } },
    };
    expect(providerLocation(metadataLocation)).toEqual({ lat: 0.5, lng: 35.2 });

    const invalidLat: Provider = {
      ...valid,
      location: { lat: 100, lng: 10 },
    };
    expect(providerLocation(invalidLat)).toBeNull();

    const noLocation: Provider = {
      ...valid,
      location: null,
      metadata: null,
    };
    expect(providerLocation(noLocation)).toBeNull();
  });
});

type ResponseFactory = (attempt: number) => Response | Promise<Response>;

/**
 * A fetch that counts its calls and records when each one started, so the
 * retry loop can be judged on how many requests it made and when — none of
 * this needs the API, the database, or a socket.
 */
function scriptedFetch(make: ResponseFactory) {
  const times: number[] = [];
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    times.push(Date.now());
    return make(calls);
  };
  return { fetch: fetchImpl, calls: () => calls, times };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Unavailable',
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const HEALTH_OK = { status: 'ok' };

describe('@sci-healthcare/client retry backoff (#285)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries a 503 and resolves with the response that finally worked', async () => {
    const scripted = scriptedFetch((attempt) =>
      attempt === 1 ? jsonResponse(503, { message: 'cold start' }) : jsonResponse(200, HEALTH_OK),
    );
    const client = createClient({
      baseUrl: 'http://api.invalid',
      fetch: scripted.fetch,
      random: () => 0.5,
    });

    const pending = client.health();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toEqual(HEALTH_OK);
    expect(scripted.calls()).toBe(2);
  });

  it('releases the body of every response it discards', async () => {
    const discarded: Response[] = [];
    const scripted = scriptedFetch((attempt) => {
      const res =
        attempt === 1 ? jsonResponse(503, { message: 'cold start' }) : jsonResponse(200, HEALTH_OK);
      if (attempt === 1) discarded.push(res);
      return res;
    });
    const client = createClient({
      baseUrl: 'http://api.invalid',
      fetch: scripted.fetch,
      random: () => 0.5,
    });

    const pending = client.health();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toEqual(HEALTH_OK);

    // A body nobody reads keeps its connection out of the pool, which is the
    // last thing a client retrying through an outage wants.
    expect(discarded[0]!.bodyUsed).toBe(true);
  });

  it('retries a network error and reports it only once the attempts run out', async () => {
    const scripted = scriptedFetch(() => {
      throw new TypeError('fetch failed');
    });
    const client = createClient({
      baseUrl: 'http://api.invalid',
      fetch: scripted.fetch,
      retries: 1,
      random: () => 1,
    });

    // The expectation is attached before the timers move, so the rejection
    // is handled the moment it happens rather than reported as unhandled.
    const pending = client.health();
    const assertion = expect(pending).rejects.toMatchObject({ status: 0, error: 'network_error' });
    await vi.advanceTimersByTimeAsync(10_000);

    await assertion;
    expect(scripted.calls()).toBe(2);
  });

  it('never retries a 4xx other than 408 and 429 (#285)', async () => {
    for (const status of [400, 401, 403, 404, 405, 409, 422]) {
      const scripted = scriptedFetch(() => jsonResponse(status, { error: 'invalid_query' }));
      const client = createClient({ baseUrl: 'http://api.invalid', fetch: scripted.fetch });

      await expect(client.health()).rejects.toBeInstanceOf(ApiError);
      expect(scripted.calls()).toBe(1);
    }
  });

  it('retries 408 and 429, the two 4xx that say "ask again"', async () => {
    for (const status of [408, 429]) {
      const scripted = scriptedFetch(() => jsonResponse(status, { message: 'slow down' }));
      const client = createClient({
        baseUrl: 'http://api.invalid',
        fetch: scripted.fetch,
        retries: 2,
        random: () => 0,
      });

      const pending = client.health();
      const assertion = expect(pending).rejects.toBeInstanceOf(ApiError);
      await vi.advanceTimersByTimeAsync(60_000);

      await assertion;
      expect(scripted.calls()).toBe(3);
    }
  });

  it('waits exactly the Retry-After seconds the server asked for', async () => {
    const scripted = scriptedFetch((attempt) =>
      attempt === 1
        ? jsonResponse(503, { message: 'wake me up' }, { 'retry-after': '2' })
        : jsonResponse(200, HEALTH_OK),
    );
    const client = createClient({
      baseUrl: 'http://api.invalid',
      fetch: scripted.fetch,
      // The jitter source cannot shorten a wait the server dictated.
      random: () => 1,
    });

    const pending = client.health();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(scripted.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual(HEALTH_OK);
    expect(scripted.times[1]! - scripted.times[0]!).toBe(2_000);
  });

  it('reads an HTTP-date Retry-After against its own clock', async () => {
    const scripted = scriptedFetch((attempt) =>
      attempt === 1
        ? jsonResponse(429, { message: 'later' }, {
            'retry-after': new Date('2026-01-01T00:00:05Z').toUTCString(),
          })
        : jsonResponse(200, HEALTH_OK),
    );
    const client = createClient({
      baseUrl: 'http://api.invalid',
      fetch: scripted.fetch,
      retries: 1,
      now: () => Date.parse('2026-01-01T00:00:00Z'),
    });

    const pending = client.health();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(scripted.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual(HEALTH_OK);
  });

  it('retries a CSV export too, and still hands back the text', async () => {
    const scripted = scriptedFetch((attempt) =>
      attempt === 1 ? jsonResponse(503, { message: 'cold start' }) : new Response('id,status\n', { status: 200 }),
    );
    const client = createClient({
      baseUrl: 'http://api.invalid',
      fetch: scripted.fetch,
      random: () => 0,
    });

    const pending = client.vouchersCsv();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBe('id,status\n');
    expect(scripted.calls()).toBe(2);
  });

  it('stops on an abort that happened before the request was made', async () => {
    const controller = new AbortController();
    controller.abort();
    const scripted = scriptedFetch(() => jsonResponse(200, HEALTH_OK));
    const client = createClient({
      baseUrl: 'http://api.invalid',
      fetch: scripted.fetch,
      signal: controller.signal,
    });

    const outcome = await client.health().catch((err: unknown) => err);
    expect(isAbortError(outcome)).toBe(true);
    expect(scripted.calls()).toBe(0);
  });

  it('stops on an abort raised while waiting between attempts (#285)', async () => {
    const controller = new AbortController();
    const scripted = scriptedFetch((attempt) =>
      attempt === 1 ? jsonResponse(503, { message: 'cold start' }) : jsonResponse(200, HEALTH_OK),
    );
    const client = createClient({
      baseUrl: 'http://api.invalid',
      fetch: scripted.fetch,
      signal: controller.signal,
      random: () => 1,
    });

    const pending = client.health().catch((err: unknown) => err);
    // Halfway through the first backoff, the caller gives up.
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    expect(isAbortError(await pending)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scripted.calls()).toBe(1);
  });

  it('never retries a fetch that was cancelled mid-request', async () => {
    const scripted = scriptedFetch(() => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });
    const client = createClient({
      baseUrl: 'http://api.invalid',
      fetch: scripted.fetch,
      retries: 3,
    });

    const outcome = await client.health().catch((err: unknown) => err);
    expect(isAbortError(outcome)).toBe(true);
    expect(scripted.calls()).toBe(1);
  });
});

describe('@sci-healthcare/client retry helpers (#285)', () => {
  it('treats only 408, 429 and 5xx as worth another attempt', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
    for (const status of [200, 204, 400, 401, 403, 404, 409, 422, 451]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('doubles a capped backoff and keeps half of it fixed', () => {
    expect(backoffMs(1, () => 0)).toBe(RETRY_BASE_DELAY_MS / 2);
    expect(backoffMs(1, () => 1)).toBe(RETRY_BASE_DELAY_MS);
    expect(backoffMs(2, () => 1)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(backoffMs(3, () => 1)).toBe(RETRY_BASE_DELAY_MS * 4);
    // The ceiling stops the doubling; the jitter never falls below half of it.
    for (const value of [0, 0.5, 1]) {
      expect(backoffMs(40, () => value)).toBeGreaterThanOrEqual(RETRY_MAX_DELAY_MS / 2);
      expect(backoffMs(40, () => value)).toBeLessThanOrEqual(RETRY_MAX_DELAY_MS);
    }
  });

  it('parses both Retry-After forms and never a negative wait', () => {
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs('   ', 0)).toBeNull();
    expect(retryAfterMs('nonsense', 0)).toBeNull();
    expect(retryAfterMs(' 7 ', 0)).toBe(7_000);

    const stamp = 'Wed, 21 Oct 2015 07:28:00 GMT';
    expect(retryAfterMs(stamp, Date.parse(stamp))).toBe(0);
    // A date already in the past means "retry now", not "sleep backwards".
    expect(retryAfterMs(stamp, Date.parse(stamp) + 60_000)).toBe(0);
  });
});


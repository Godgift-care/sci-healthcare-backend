import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp, SECURITY_TXT_EXPIRES } from '../app.js';
import { prisma } from '../db.js';

import { expectHealthBody } from './health-body.js';

const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

afterEach(() => vi.restoreAllMocks());

describe('request ids', () => {
  it('echoes a caller-supplied X-Request-Id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'support-123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-request-id']).toBe('support-123');
  });

  it('generates one when the caller does not send one', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('replaces an id that is not log-safe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'spaces and slashes /are not' },
    });
    expect(res.headers['x-request-id']).not.toBe('spaces and slashes /are not');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is present on error responses too', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/no-such-route',
      headers: { 'x-request-id': 'error-id-1' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['x-request-id']).toBe('error-id-1');
  });

  it('matches the reqId in the log line for the same request', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });

    const loggedApp = await buildApp({ logger: { level: 'info', stream } });
    try {
      // A normal route, not a probe: successful probes deliberately write no
      // request log (#224), so they cannot prove reqId correlation.
      const res = await loggedApp.inject({
        method: 'GET',
        url: '/v1/stats',
        headers: { 'x-request-id': 'log-correlation-42' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-request-id']).toBe('log-correlation-42');
    } finally {
      await loggedApp.close();
    }

    expect(lines.join('')).toContain('"reqId":"log-correlation-42"');
  });
});

describe('network header', () => {
  it('includes X-Stellar-Network on every response', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['x-stellar-network']).toBeDefined();
    expect(['testnet', 'public', 'futurenet']).toContain(res.headers['x-stellar-network']);
  });

  it('includes network header on versioned paths', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.headers['x-stellar-network']).toBeDefined();
  });

  it('includes network header on error responses', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.headers['x-stellar-network']).toBeDefined();
  });
});

describe('versioned paths', () => {
  it('serves every route under /v1 without a deprecation header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    expectHealthBody(res.json());
    expect(res.headers['deprecation']).toBeUndefined();
    expect(res.headers['link']).toBeUndefined();
  });

  it('keeps unversioned paths as aliases carrying Deprecation and a successor link', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expectHealthBody(res.json());
    expect(res.headers['deprecation']).toBe('true');
    expect(res.headers['link']).toBe('</v1/health>; rel="successor-version"');
  });

  it('points query strings at their /v1 equivalent', async () => {
    const res = await app.inject({ method: 'GET', url: '/vouchers' });
    expect(res.statusCode).toBe(400);
    expect(res.headers['link']).toBe('</v1/vouchers>; rel="successor-version"');
  });

  it('mounts the same routes under /v1', async () => {
    const legacy = await app.inject({ method: 'GET', url: '/vouchers' });
    const v1 = await app.inject({ method: 'GET', url: '/v1/vouchers' });
    expect(v1.statusCode).toBe(legacy.statusCode);
    expect(v1.json()).toEqual(legacy.json());
    expect(v1.headers['deprecation']).toBeUndefined();
  });
});

describe('error envelope', () => {
  it('404s unknown routes in the envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: 'route_not_found',
      message: 'Route GET /does-not-exist not found',
    });
  });

  it('400s invalid queries with the zod issues as details', async () => {
    const res = await app.inject({ method: 'GET', url: '/vouchers?funder=short' });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe('invalid_query');
    expect(body.message).toBe('Invalid query parameters');
    expect(Array.isArray(body.details)).toBe(true);
  });

  it('400s a missing required filter without details', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/vouchers' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'filter_required',
      message:
        'Provide at least one of: funder, provider, beneficiaryRef, status, createdFrom, createdTo, minAmount, maxAmount',
    });
  });

  it('500s unexpected failures as internal_error without leaking the cause', async () => {
    vi.spyOn(prisma.voucher, 'count').mockRejectedValue(
      new Error('connection reset by peer at 10.0.0.7'),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/vouchers?funder=${FUNDER}&count=true`,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Internal server error' });
  });
});

describe('rate-limit headers (#249)', () => {
  it('responds with IETF draft RateLimit headers on a normal request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-forwarded-for': '10.1.2.3' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
    expect(res.headers['ratelimit-reset']).toBeDefined();
  });

  it('exposes the RateLimit headers in CORS', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'GET',
      },
    });
    const exposed = res.headers['access-control-expose-headers'] ?? '';
    expect(String(exposed).toLowerCase()).toContain('ratelimit-limit');
    expect(String(exposed).toLowerCase()).toContain('ratelimit-remaining');
    expect(String(exposed).toLowerCase()).toContain('ratelimit-reset');
  });
});

describe('security.txt (#250)', () => {
  it('serves /.well-known/security.txt with the required RFC 9116 fields', async () => {
    const res = await app.inject({ method: 'GET', url: '/.well-known/security.txt' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    const body = res.body;
    expect(body).toContain('Contact:');
    expect(body).toContain('Policy:');
    expect(body).toContain('Expires:');
  });

  it('Expires date is at least 30 days in the future', () => {
    const expires = new Date(SECURITY_TXT_EXPIRES);
    const thirtyDaysFromNow = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(expires.getTime()).toBeGreaterThan(thirtyDaysFromNow.getTime());
  });
});

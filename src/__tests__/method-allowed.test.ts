import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { allowedMethods, routePatterns } from '../lib/method-allowed.js';

let app: FastifyInstance;

/** Rotating client addresses: the app rate-limits per IP, one test is not a flood. */
let clientId = 0;
function nextIp(): string {
  const id = ++clientId;
  return `10.${(id >>> 16) & 255}.${(id >>> 8) & 255}.${id & 255}`;
}

async function call(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown; allow: string | undefined; headers: Record<string, string> }> {
  const res = await app.inject({
    method: method as 'GET',
    url,
    headers: { ...headers, 'x-forwarded-for': nextIp() },
  });
  return {
    status: res.statusCode,
    // A HEAD response carries no body to parse.
    body: res.payload === '' ? undefined : res.json(),
    allow: res.headers.allow as string | undefined,
    headers: res.headers as Record<string, string>,
  };
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe('allowedMethods', () => {
  const patterns = routePatterns([
    { method: 'GET', url: '/vouchers' },
    { method: ['GET', 'HEAD'], url: '/vouchers/:id' },
    { method: 'GET', url: '/receipts' },
    // Swagger UI's assets, and the preflight catch-all `@fastify/cors` adds.
    { method: 'GET', url: '/docs/*' },
    { method: 'OPTIONS', url: '/*' },
  ]);

  it('lists the methods a matching pattern accepts', () => {
    expect(allowedMethods(patterns, 'POST', '/vouchers')).toEqual(['GET']);
    expect(allowedMethods(patterns, 'DELETE', '/vouchers/9')).toEqual(['GET', 'HEAD']);
  });

  it('says nothing when the method is one the path accepts', () => {
    expect(allowedMethods(patterns, 'GET', '/vouchers')).toBeNull();
    expect(allowedMethods(patterns, 'HEAD', '/vouchers/9')).toBeNull();
  });

  it('says nothing for a path no pattern covers', () => {
    expect(allowedMethods(patterns, 'POST', '/nope')).toBeNull();
    expect(allowedMethods(patterns, 'POST', '/vouchers/9/extra')).toBeNull();
  });

  it('treats a trailing slash the way the router does', () => {
    // Routes answer with and without it, so the path is known and the verb is
    // the only thing wrong.
    expect(allowedMethods(patterns, 'POST', '/vouchers/')).toEqual(['GET']);
  });

  it('ignores the query string and the fragment', () => {
    expect(allowedMethods(patterns, 'POST', '/vouchers?funder=GA')).toEqual(['GET']);
    expect(allowedMethods(patterns, 'POST', '/vouchers#top')).toEqual(['GET']);
  });

  it('will not let a parameter match an empty segment', () => {
    expect(allowedMethods(patterns, 'POST', '/vouchers//x')).toBeNull();
  });

  it('leaves a catch-all pattern out of the table', () => {
    // Counting `/*` would answer 405 for every unknown path there is, and a
    // `/docs/*` asset route says nothing about a verb on a real endpoint.
    expect(patterns.map((p) => p.pattern)).toEqual([
      '/vouchers',
      '/vouchers/:id',
      '/receipts',
    ]);
    expect(allowedMethods(patterns, 'POST', '/nothing-here')).toBeNull();
    expect(allowedMethods(patterns, 'POST', '/docs/swagger-ui.js')).toBeNull();
  });

  it('unions the methods of every pattern that covers the path', () => {
    const overlapping = routePatterns([
      { method: 'GET', url: '/vouchers/due' },
      // A second version of the same path answers a different verb.
      { method: 'POST', url: '/vouchers/:id' },
    ]);
    expect(allowedMethods(overlapping, 'DELETE', '/vouchers/due')).toEqual(['GET', 'POST']);
  });

  it('says nothing about a path that is not absolute', () => {
    expect(allowedMethods(patterns, 'POST', 'vouchers')).toBeNull();
  });

  it('merges the same pattern registered more than once', () => {
    expect(routePatterns([{ method: 'GET', url: '/a' }, { method: 'GET', url: '/a' }])).toEqual([
      { pattern: '/a', methods: ['GET'] },
    ]);
  });
});

describe('405 for a known path with an unsupported method', () => {
  it('answers POST /vouchers with 405 and an Allow header', async () => {
    const res = await call('POST', '/vouchers');
    expect(res.status).toBe(405);
    expect(res.allow).toBe('GET, HEAD');
    expect(res.body).toEqual({
      error: 'method_not_allowed',
      message: `Method POST not allowed for /vouchers; allowed: ${res.allow}`,
    });
  });

  it('answers the versioned alias too', async () => {
    const res = await call('PUT', '/v1/vouchers/5');
    expect(res.status).toBe(405);
    expect(res.allow).toContain('GET');
    expect((res.body as { error: string }).error).toBe('method_not_allowed');
  });

  it('names the path without its query string', async () => {
    const res = await call('POST', '/receipts?beneficiaryRef=' + 'a'.repeat(64));
    expect(res.status).toBe(405);
    expect((res.body as { message: string }).message).toContain(' for /receipts;');
  });

  it('keeps the envelope headers every response carries', async () => {
    const res = await call('POST', '/vouchers', { 'x-request-id': 'method-405-1' });
    expect(res.status).toBe(405);
    expect(res.headers['x-request-id']).toBe('method-405-1');
    expect(res.headers['x-stellar-network']).toBeDefined();
  });

  it('localises the message without touching the code', async () => {
    const res = await call('POST', '/vouchers', { 'accept-language': 'fr' });
    expect(res.status).toBe(405);
    expect((res.body as { error: string }).error).toBe('method_not_allowed');
    expect((res.body as { message: string }).message).toBe(
      `La méthode POST n’est pas autorisée pour /vouchers ; méthodes autorisées : ${res.allow}`,
    );
  });

  it('still answers 404 for a path that does not exist', async () => {
    const res = await call('POST', '/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: 'route_not_found',
      message: 'Route POST /does-not-exist not found',
    });
  });

  it('leaves the GET routes alone', async () => {
    const res = await call('GET', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('serves a HEAD request from its GET route', async () => {
    const res = await call('HEAD', '/health');
    expect(res.status).toBe(200);
  });
});

import { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import {
  DATABASE_RETRY_AFTER_SECONDS,
  errorEnvelope,
  isDatabaseUnavailable,
} from '../lib/errors.js';

/**
 * Issue #133: a database that is briefly unreachable has to look different
 * from a request that is broken, or a client retries the wrong thing. The
 * distinction is made in `errorEnvelope`, so it is tested there and then
 * through the real app to prove the handler sends the header.
 */

const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';

function initializationError(message: string): Error {
  return new Prisma.PrismaClientInitializationError(message, '6.19.3');
}

function knownRequestError(code: string): Error {
  return new Prisma.PrismaClientKnownRequestError(`Prisma failed with code ${code}`, {
    code,
    clientVersion: '6.19.3',
  });
}

describe('isDatabaseUnavailable', () => {
  it('calls an unreachable server and a failed client start an outage', () => {
    expect(
      isDatabaseUnavailable(initializationError("Can't reach database server at `localhost:5432`")),
    ).toBe(true);
    // No engine binary is a deployment that cannot answer right now either.
    expect(isDatabaseUnavailable(initializationError('Client not found.'))).toBe(true);
  });

  it('calls the connection-timeout and pool codes an outage', () => {
    for (const code of ['P1001', 'P1003', 'P1008', 'P1009', 'P2024']) {
      expect(isDatabaseUnavailable(knownRequestError(code)), code).toBe(true);
    }
  });

  it('leaves every other failure alone', () => {
    // A query that is wrong fails the same way tomorrow, so it is a 500.
    expect(isDatabaseUnavailable(knownRequestError('P2002'))).toBe(false);
    expect(isDatabaseUnavailable(knownRequestError('P2025'))).toBe(false);
    expect(isDatabaseUnavailable(new Error('connection reset by peer at 10.0.0.7'))).toBe(false);
    // A handler can reject with anything at all.
    expect(isDatabaseUnavailable(undefined)).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
    expect(isDatabaseUnavailable('P1001')).toBe(false);
    // Fastify's own errors carry string codes that are not Prisma's.
    expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code: 'FST_ERR_CTP_BODY_TOO_LARGE' }))).toBe(
      false,
    );
  });
});

describe('errorEnvelope for a database outage', () => {
  it('answers 503 database_unavailable with a Retry-After', () => {
    const res = errorEnvelope(initializationError("Can't reach database server"));
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: 'database_unavailable',
      message: `Database is unavailable, retry in ${DATABASE_RETRY_AFTER_SECONDS} seconds`,
    });
    expect(res.headers).toEqual({ 'retry-after': String(DATABASE_RETRY_AFTER_SECONDS) });
  });

  it('names the pool running out of connections the same way', () => {
    const res = errorEnvelope(knownRequestError('P2024'));
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('database_unavailable');
  });

  it('says nothing about the cause', () => {
    // The message Prisma builds contains the host and port. The code and the
    // wait time are what a client needs; the rest belongs in the log line.
    const res = errorEnvelope(initializationError("Can't reach database server at `db:5432`"));
    expect(JSON.stringify(res.body)).not.toContain('db:5432');
  });

  it('localises the message without changing the code', () => {
    const res = errorEnvelope(knownRequestError('P1001'), 'fr');
    expect(res.body).toEqual({
      error: 'database_unavailable',
      message: 'La base de données est indisponible, réessayez dans 5 secondes',
    });
    const sw = errorEnvelope(knownRequestError('P1001'), 'sw');
    expect(sw.body.message).toBe('Hifadhidata haipatikani, jaribu tena baada ya sekunde 5');
  });

  it('keeps every other failure exactly as it was', () => {
    expect(errorEnvelope(new Error('boom'))).toEqual({
      statusCode: 500,
      body: { error: 'internal_error', message: 'Internal server error' },
    });
    // A duplicate-key error is a bad write, not an unreachable database.
    expect(errorEnvelope(knownRequestError('P2002'))).toEqual({
      statusCode: 500,
      body: { error: 'internal_error', message: 'Internal server error' },
    });
    // A route's own rejection is untouched by any of this.
    expect(errorEnvelope(Object.assign(new Error('nope'), { statusCode: 429 })).statusCode).toBe(
      429,
    );
  });
});

let app: FastifyInstance;
let testClientId = 0;

function nextIp(): string {
  testClientId += 1;
  return `10.77.${(testClientId >>> 8) & 255}.${testClientId & 255}`;
}

beforeAll(async () => {
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

afterEach(() => vi.restoreAllMocks());

describe('GET /vouchers while the database is down', () => {
  it('answers 503 with Retry-After instead of a generic 500', async () => {
    vi.spyOn(prisma.voucher, 'count').mockRejectedValue(
      initializationError("Can't reach database server at `localhost:5432`"),
    );

    const res = await app.inject({
      method: 'GET',
      url: `/vouchers?funder=${FUNDER}`,
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(DATABASE_RETRY_AFTER_SECONDS));
    expect(res.json()).toEqual({
      error: 'database_unavailable',
      message: `Database is unavailable, retry in ${DATABASE_RETRY_AFTER_SECONDS} seconds`,
    });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('is never cacheable, so a retry actually reaches the API', async () => {
    vi.spyOn(prisma.voucher, 'count').mockRejectedValue(knownRequestError('P1001'));

    const res = await app.inject({
      method: 'GET',
      url: `/v1/vouchers?funder=${FUNDER}`,
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers.etag).toBeUndefined();
  });

  it('still 500s a failure that is not an outage', async () => {
    vi.spyOn(prisma.voucher, 'count').mockRejectedValue(new Error('syntax error at "SELECT"'));

    const res = await app.inject({
      method: 'GET',
      url: `/vouchers?funder=${FUNDER}`,
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(500);
    expect(res.headers['retry-after']).toBeUndefined();
    expect(res.json()).toEqual({ error: 'internal_error', message: 'Internal server error' });
  });
});

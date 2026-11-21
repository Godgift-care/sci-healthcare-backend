import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { MAINTENANCE_RETRY_AFTER_SECONDS } from '../lib/errors.js';

describe('MAINTENANCE_MODE (#322)', () => {
  let app: FastifyInstance;
  let testClientId = 0;

  function nextIp(): string {
    testClientId += 1;
    return `10.99.${(testClientId >>> 8) & 255}.${testClientId & 255}`;
  }

  beforeAll(async () => {
    app = await buildApp({ logger: false, maintenanceMode: true });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health stays 200 OK during maintenance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/v1/health stays 200 OK during maintenance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/metrics remains accessible during maintenance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/metrics',
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(res.statusCode).toBe(200);
  });

  it('data routes answer 503 maintenance_mode with Retry-After', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vouchers',
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS));
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      error: 'maintenance_mode',
      message: `Service is undergoing maintenance, retry in ${MAINTENANCE_RETRY_AFTER_SECONDS} seconds`,
    });
  });

  it('unversioned legacy data route aliases also answer 503', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/providers',
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS));
    expect(res.json()).toEqual({
      error: 'maintenance_mode',
      message: `Service is undergoing maintenance, retry in ${MAINTENANCE_RETRY_AFTER_SECONDS} seconds`,
    });
  });

  it('stats data routes answer 503 during maintenance', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/stats',
      headers: { 'x-forwarded-for': nextIp() },
    });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS));
  });

  it('localises the maintenance message according to Accept-Language', async () => {
    const frRes = await app.inject({
      method: 'GET',
      url: '/v1/vouchers',
      headers: {
        'x-forwarded-for': nextIp(),
        'accept-language': 'fr-FR,fr;q=0.9',
      },
    });
    expect(frRes.statusCode).toBe(503);
    expect(frRes.json()).toEqual({
      error: 'maintenance_mode',
      message: `Le service est en maintenance, réessayez dans ${MAINTENANCE_RETRY_AFTER_SECONDS} secondes`,
    });

    const swRes = await app.inject({
      method: 'GET',
      url: '/v1/vouchers',
      headers: {
        'x-forwarded-for': nextIp(),
        'accept-language': 'sw',
      },
    });
    expect(swRes.statusCode).toBe(503);
    expect(swRes.json()).toEqual({
      error: 'maintenance_mode',
      message: `Huduma inafanyiwa matengenezo, jaribu tena baada ya sekunde ${MAINTENANCE_RETRY_AFTER_SECONDS}`,
    });
  });
});

describe('Normal mode (MAINTENANCE_MODE false)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ logger: false, maintenanceMode: false });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('does not return 503 maintenance_mode on data routes', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/vouchers',
      headers: { 'x-forwarded-for': '10.99.1.1' },
    });
    // In normal mode without query params, /vouchers returns 400 filter_required, not 503 maintenance_mode
    expect(res.statusCode).not.toBe(503);
    expect(res.json()).toHaveProperty('error', 'filter_required');
  });
});

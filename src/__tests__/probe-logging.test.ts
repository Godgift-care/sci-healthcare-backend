import { Writable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { server } from '../stellar/client.js';

/**
 * Probe traffic is most of the log volume on an idle deployment (#224). These
 * tests capture the app's real pino stream rather than inspecting the log
 * controller in isolation: the behaviour that matters is what an operator
 * actually sees, including the 503 that must not disappear with the noise.
 */
type LogLine = {
  msg?: string;
  reqId?: string;
  res?: { statusCode?: number };
};

let lines: string[];
let app: FastifyInstance;
let clientId = 0;

function nextIp(): string {
  clientId += 1;
  return `10.78.${(clientId >>> 8) & 255}.${clientId & 255}`;
}

function captured(): LogLine[] {
  return lines.filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as LogLine);
}

/** Pins every readiness input so the probe's status is deterministic. */
function stubReadiness(paused: boolean): void {
  vi.spyOn(prisma.failedEvent, 'count').mockResolvedValue(0);
  vi.spyOn(prisma.reconcileMismatch, 'count').mockResolvedValue(0);
  vi.spyOn(prisma.webhookDelivery, 'count').mockResolvedValue(0);
  vi.spyOn(prisma.webhookDelivery, 'findFirst').mockResolvedValue(null);
  vi.spyOn(prisma.indexerState, 'findUnique').mockResolvedValue({
    id: 1,
    lastLedger: 100,
    paused,
    gap: false,
    gapCursorLedger: null,
    gapOldestLedger: null,
    updatedAt: new Date(),
  } as never);
  vi.spyOn(server, 'getLatestLedger').mockResolvedValue({ sequence: 100 } as never);
}

beforeAll(async () => {
  lines = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  app = await buildApp({ logger: { level: 'info', stream } });
  await app.ready();
});

afterEach(() => {
  vi.restoreAllMocks();
  lines.length = 0;
});

afterAll(async () => {
  await app.close();
});

describe('successful health probes write nothing (#224)', () => {
  it.each(['/health', '/v1/health', '/metrics', '/v1/ready'])(
    '%s is silent at 200',
    async (url) => {
      stubReadiness(false);
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { 'x-forwarded-for': nextIp() },
      });

      expect(res.statusCode, url).toBe(200);
      expect(captured(), url).toEqual([]);
    },
  );

  it('ignores a query string when deciding whether a path is a probe', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health?from=uptime-monitor',
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(200);
    expect(captured()).toEqual([]);
  });

  it('still logs an ordinary application request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/version',
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(200);
    expect(captured().map((line) => line.msg)).toContain('request completed');
  });
});

describe('failed probes stay visible (#224)', () => {
  it('logs both request lines and the 503 from a degraded /ready', async () => {
    stubReadiness(true);
    const res = await app.inject({
      method: 'GET',
      url: '/ready',
      headers: { 'x-forwarded-for': nextIp(), 'x-request-id': 'paused-probe-1' },
    });

    expect(res.statusCode).toBe(503);
    const logged = captured();
    expect(logged.map((line) => line.msg)).toContain('incoming request');
    expect(logged.map((line) => line.msg)).toContain('request completed');
    const completion = logged.find((line) => line.msg === 'request completed');
    expect(completion?.res?.statusCode).toBe(503);
    expect(completion?.reqId).toBe('paused-probe-1');
  });

  it('logs a probe called with the wrong method', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/health',
      headers: { 'x-forwarded-for': nextIp() },
    });

    expect(res.statusCode).toBe(405);
    const completion = captured().find((line) => line.msg === 'request completed');
    expect(completion?.res?.statusCode).toBe(405);
  });
});

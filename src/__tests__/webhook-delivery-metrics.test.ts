import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { registry, webhookDeliveriesTotal, webhookDeliveryDuration } from '../lib/metrics.js';
import { WebhookCircuit, WebhookDispatcher } from '../lib/webhooks.js';

const SLOW = 'https://slow.example.test/hooks?token=private-slow-secret';
const FAIL = 'https://fail.example.test/hooks?token=private-fail-secret';
const urls = [SLOW, FAIL];
const endpointHash = (index: number) => createHash('sha256').update(String(index)).digest('hex').slice(0, 8);

beforeEach(async () => {
  webhookDeliveriesTotal.reset();
  webhookDeliveryDuration.reset();
  await prisma.webhookDelivery.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function enqueue(id: string, url: string): Promise<void> {
  await prisma.webhookDelivery.create({
    data: {
      id,
      url,
      event: 'voucher_created',
      voucherId: id,
      status: 'Funded',
      ledger: 1,
      payload: JSON.stringify({ event: 'voucher_created', voucherId: id, status: 'Funded', ledger: 1 }),
      nextAttemptAt: new Date(Date.now() - 1000),
    },
  });
}

describe('webhook delivery metrics (#217)', () => {
  it('exposes slow success and HTTP failure outcomes without URL or secret labels', async () => {
    await enqueue('slow', SLOW);
    await enqueue('fail', FAIL);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url) === SLOW) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response('ok', { status: 200 });
      }
      return new Response('unavailable', { status: 503 });
    }) as unknown as typeof fetch;
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
    const dispatcher = new WebhookDispatcher(log, { urls, secret: 'metric-test-secret', fetchImpl, circuit: new WebhookCircuit() });

    expect(await dispatcher.deliverPending()).toBe(1);
    const metrics = await registry.metrics();
    expect(metrics).toContain('webhook_delivery_duration_seconds_bucket');
    expect(metrics).toContain('webhook_deliveries_total');
    expect(metrics).toContain('endpoint="' + endpointHash(0) + '",outcome="success"');
    expect(metrics).toContain('endpoint="' + endpointHash(1) + '",outcome="http_error"');
    expect(metrics).not.toContain(SLOW);
    expect(metrics).not.toContain(FAIL);
    expect(metrics).not.toContain('private-slow-secret');
    expect(metrics).not.toContain('private-fail-secret');
    expect(metrics).not.toContain('metric-test-secret');
    const observations = await webhookDeliveryDuration.get();
    expect(observations.values.some((v) => v.metricName.endsWith('_sum') && v.value >= 0.025)).toBe(true);
  });

  it('counts rejected network attempts as network_error', async () => {
    await enqueue('network', SLOW);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger;
    const fetchImpl = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    const dispatcher = new WebhookDispatcher(log, { urls, secret: 'metric-test-secret', fetchImpl, circuit: new WebhookCircuit() });
    expect(await dispatcher.deliverPending()).toBe(0);
    const metrics = await registry.metrics();
    expect(metrics).toContain('endpoint="' + endpointHash(0) + '",outcome="network_error"');
  });
});

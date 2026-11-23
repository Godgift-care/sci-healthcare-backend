import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { registry } from '../lib/metrics.js';
import {
  endpointLabel,
  WebhookCircuit,
  WebhookDispatcher,
  WEBHOOK_BREAKER_COOLDOWN_MS,
  WEBHOOK_BREAKER_FAILURE_THRESHOLD,
} from '../lib/webhooks.js';

/**
 * Per-endpoint circuit breaker (#265).
 *
 * A dead endpoint used to be retried for every event, so one outage burned
 * the whole dispatcher and grew a backlog of rows that would each be
 * abandoned separately. These cases pin the replacement behaviour:
 *
 * - the breaker opens after the configured streak and then stops contacting
 *   the endpoint, without spending the held rows' attempts;
 * - after the cooldown a single probe decides whether to resume;
 * - held rows are delivered in their original order after recovery;
 * - other endpoints keep delivering while one is tripped.
 *
 * The clock is faked (`Date` only, real timers) so the cooldown is exact and
 * Prisma's own timers keep working.
 */

const DEAD = 'https://dead.example.test/hooks';
const HEALTHY = 'https://healthy.example.test/hooks';
const SECRET = 'breaker-test-secret';
const T0 = new Date('2026-11-23T00:00:00.000Z');

function fakeLog(): FastifyBaseLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

function dispatcherWith(
  fetchImpl: typeof fetch,
  circuit: WebhookCircuit,
  opts: object = {},
): WebhookDispatcher {
  return new WebhookDispatcher(fakeLog(), {
    fetchImpl,
    circuit,
    secret: SECRET,
    intervalMs: 60_000,
    now: () => new Date(),
    ...opts,
  });
}

/**
 * Writes one due outbox row. `offsetSeconds` only ages `createdAt`, which is
 * the tiebreaker among rows that became due together — so the fake clock does
 * not have to move for every row to be deliverable.
 */
async function enqueue(id: string, url: string = DEAD, offsetSeconds = 0): Promise<Date> {
  const createdAt = new Date(T0.getTime() + offsetSeconds * 1_000);
  const payload = JSON.stringify({
    event: 'voucher_created',
    voucherId: id,
    status: 'Funded',
    ledger: 1,
  });
  await prisma.webhookDelivery.create({
    data: {
      id,
      url,
      event: 'voucher_created',
      voucherId: id,
      status: 'Funded',
      ledger: 1,
      payload,
      nextAttemptAt: T0,
      createdAt,
    },
  });
  return createdAt;
}

function deliveredId(init: RequestInit): string {
  return (JSON.parse(String(init.body)) as { voucherId: string }).voucherId;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  await prisma.webhookDelivery.deleteMany();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('circuit breaker defaults', () => {
  it('waits for a streak and a short cooldown rather than one blip', () => {
    expect(WEBHOOK_BREAKER_FAILURE_THRESHOLD).toBe(5);
    expect(WEBHOOK_BREAKER_COOLDOWN_MS).toBe(30_000);
  });
});

describe('WebhookDispatcher circuit breaker (#265)', () => {
  it('opens after the threshold and holds later deliveries without spending attempts', async () => {
    const fetchImpl = vi.fn(async () => new Response('down', { status: 503 }));
    const circuit = new WebhookCircuit(2, 30_000);
    const dispatcher = dispatcherWith(fetchImpl, circuit);

    // a and b fail in this cycle; the second failure trips the breaker, so c
    // must not be attempted at all.
    await enqueue('a', DEAD, 0);
    await enqueue('b', DEAD, 1);
    await enqueue('c', DEAD, 2);
    expect(await dispatcher.deliverPending()).toBe(0);
    expect(circuit.state(DEAD)).toBe('open');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const held = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: 'c' } });
    expect(held.attempts).toBe(0);
    // Held, not rescheduled: the row is still due and will go out with the
    // rest once the breaker recovers.
    expect(held.nextAttemptAt).toEqual(T0);

    const callsBefore = fetchImpl.mock.calls.length;
    expect(await dispatcher.deliverPending()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(callsBefore);
  });

  it('sends held deliveries in order after a successful probe', async () => {
    let remainingFailures = 2;
    const delivered: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        return new Response('down', { status: 503 });
      }
      delivered.push(deliveredId(init));
      return new Response(null, { status: 204 });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;

    const circuit = new WebhookCircuit(2, 30_000);
    const dispatcher = dispatcherWith(fetchImpl, circuit);
    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
      await enqueue(id, DEAD, index);
    }

    // a and b fail; the breaker opens and c and d stay queued untouched.
    expect(await dispatcher.deliverPending()).toBe(0);
    expect(circuit.state(DEAD)).toBe('open');
    const held = await prisma.webhookDelivery.findMany({
      where: { id: { in: ['c', 'd'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(held.map((row) => row.attempts)).toEqual([0, 0]);

    vi.setSystemTime(new Date(T0.getTime() + 30_000));
    expect(await dispatcher.deliverPending()).toBe(4);

    // c is the probe and goes first; d follows, then the earlier retries.
    expect(delivered).toEqual(['c', 'd', 'a', 'b']);
    expect(circuit.state(DEAD)).toBe('closed');
  });

  it('re-opens when the probe fails and keeps holding', async () => {
    let endpointUp = false;
    const fetchMock = vi.fn(async () =>
      endpointUp ? new Response(null, { status: 204 }) : new Response('down', { status: 503 }),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const circuit = new WebhookCircuit(1, 10_000);
    const dispatcher = dispatcherWith(fetchImpl, circuit);

    await enqueue('a');
    await dispatcher.deliverPending();
    expect(circuit.state(DEAD)).toBe('open');

    await enqueue('b', DEAD, 1);
    vi.setSystemTime(new Date(T0.getTime() + 10_000));
    expect(await dispatcher.deliverPending()).toBe(0);
    expect(circuit.state(DEAD)).toBe('open');
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: 'b' } })).attempts).toBe(
      1,
    );

    await enqueue('c', DEAD, 2);
    const callsBefore = fetchMock.mock.calls.length;
    expect(await dispatcher.deliverPending()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(callsBefore);
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: 'c' } })).attempts).toBe(
      0,
    );

    endpointUp = true;
    vi.setSystemTime(new Date(T0.getTime() + 20_000));
    expect(await dispatcher.deliverPending()).toBeGreaterThanOrEqual(1);
    expect(circuit.state(DEAD)).toBe('closed');
  });

  it('leaves other endpoints unaffected while one is tripped', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      return url === DEAD
        ? new Response('down', { status: 503 })
        : new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const circuit = new WebhookCircuit(1, 30_000);
    const dispatcher = dispatcherWith(fetchImpl, circuit);

    await enqueue('dead', DEAD);
    await dispatcher.deliverPending();
    expect(circuit.state(DEAD)).toBe('open');

    // A held endpoint must not crowd a healthy one out of the same batch.
    await enqueue('healthy', HEALTHY);
    await enqueue('held', DEAD, 1);
    expect(await dispatcher.deliverPending()).toBe(1);

    expect(
      (await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: 'healthy' } })).deliveredAt,
    ).not.toBeNull();
    expect(
      (await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: 'held' } })).attempts,
    ).toBe(0);
  });

  it('reports breaker state, redacted, on the snapshot and the metrics', async () => {
    const url = 'https://clinic.example/hooks?token=super-secret';
    const circuit = new WebhookCircuit(1, 30_000);

    circuit.recordFailure(url);

    expect(circuit.snapshot()).toEqual([
      {
        endpoint: 'https://clinic.example/hooks',
        state: 'open',
        consecutiveFailures: 1,
        openedAt: T0.toISOString(),
      },
    ]);

    const metrics = await registry.metrics();
    expect(metrics).toContain('webhook_circuit_state{endpoint="https://clinic.example/hooks"} 2');
    expect(metrics).toContain(
      'webhook_circuit_consecutive_failures{endpoint="https://clinic.example/hooks"} 1',
    );
    // The query string may be a credential; it must never reach telemetry.
    expect(metrics).not.toContain('super-secret');
  });

  it('closes again after a reachable response and forgets the streak', () => {
    const circuit = new WebhookCircuit(2, 30_000);
    circuit.recordFailure(DEAD);
    circuit.recordFailure(DEAD);
    expect(circuit.state(DEAD)).toBe('open');
    circuit.recordSuccess(DEAD);
    expect(circuit.state(DEAD)).toBe('closed');
    expect(circuit.snapshot()[0]?.consecutiveFailures).toBe(0);
    expect(circuit.blockedUrls()).toEqual([]);
  });
});

describe('endpointLabel', () => {
  it('keeps origin and path and drops query and fragment', () => {
    expect(endpointLabel('https://clinic.example/hooks?a=1#frag')).toBe(
      'https://clinic.example/hooks',
    );
  });

  it('does not echo an unparseable value', () => {
    expect(endpointLabel('not a url')).toBe('<invalid-url>');
  });
});

import { collectDefaultMetrics, Counter, Gauge, Histogram } from 'prom-client';

import { registry } from './metrics-registry.js';
export { registry } from './metrics-registry.js';

import { prisma } from '../db.js';

/**
 * Prometheus metrics, exposed at `/metrics`.
 *
 * Indexer figures are updated by the indexer, so they are populated in the
 * process that runs it (combined mode, or the worker). A split API process
 * serves the HTTP and process metrics only.
 */
collectDefaultMetrics({ register: registry });

/** Wall-clock ms of the last poll that completed, or null before the first. */
let lastSuccessAt: number | null = null;

export function markIndexerSuccess(now: number = Date.now()): void {
  lastSuccessAt = now;
}

export const indexerLagLedgers = new Gauge({
  name: 'indexer_lag_ledgers',
  help: 'Ledgers between the chain tip and the indexer cursor after the last poll',
  registers: [registry],
});

export const indexerSecondsSinceSuccess = new Gauge({
  name: 'indexer_seconds_since_success',
  help: 'Seconds since the last poll that completed without error',
  registers: [registry],
  collect() {
    if (lastSuccessAt !== null) this.set((Date.now() - lastSuccessAt) / 1000);
  },
});

/**
 * Open reconciliation mismatches (#220).
 *
 * The rows live in the read model, and the reconcile job is a one-shot
 * process, so a gauge set only there would never be scraped. Reading the count
 * when `/metrics` is collected keeps the exposed value honest in whichever
 * process serves HTTP; the explicit setter below makes a run of `reconcile()`
 * visible immediately in that process too.
 */
export const reconcileMismatches = new Gauge({
  name: 'reconcile_mismatches',
  help: 'Reconciliation mismatches currently recorded against the read model',
  registers: [registry],
  async collect() {
    try {
      this.set(await prisma.reconcileMismatch.count());
    } catch {
      // Keep the last known value. A database outage is reported by /ready
      // and the request log; inventing a zero here would silence the alert.
    }
  },
});

/** Updates the gauge in the process that has just finished a reconcile run. */
export function recordReconcileMismatches(count: number): void {
  reconcileMismatches.set(count);
}

/**
 * Whether the indexer is paused (#220): 1 paused, 0 running.
 *
 * `IndexerState.paused` is the authoritative flag, set by the pause/resume
 * scripts. Collecting from the database avoids a process-local gauge that
 * starts at zero and hides a pause that was requested before this process
 * booted. `SciIndexerPausedTooLong` uses `for: 1h`, so a restart does not
 * invent a pause that has lasted an hour.
 */
export const indexerPaused = new Gauge({
  name: 'indexer_paused',
  help: 'Whether the indexer is paused (1) or running (0)',
  registers: [registry],
  async collect() {
    try {
      const state = await prisma.indexerState.findUnique({
        where: { id: 1 },
        select: { paused: true },
      });
      this.set(state?.paused ? 1 : 0);
    } catch {
      // As above: keep the last known value rather than reporting a fake
      // "running" state while the database is unreachable.
    }
  },
});

/** Updates the gauge in the process that changed the pause flag. */
export function recordIndexerPaused(paused: boolean): void {
  indexerPaused.set(paused ? 1 : 0);
}

export const eventsApplied = new Counter({
  name: 'events_applied_total',
  help: 'Contract events projected into the read model',
  labelNames: ['name'],
  registers: [registry],
});

export const eventsSkipped = new Counter({
  name: 'events_skipped_total',
  help: 'Contract events that failed to project and were recorded as failed',
  labelNames: ['name'],
  registers: [registry],
});

export const indexerEventLatency = new Histogram({
  name: 'indexer_event_latency_seconds',
  help: 'Seconds between ledger close and the event being projected in the read model',
  buckets: [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const indexerReconcileDuration = new Histogram({
  name: 'indexer_reconcile_duration_seconds',
  help: 'Duration of scheduled read-model reconciliation passes',
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const indexerReconcileOpenMismatches = new Gauge({
  name: 'indexer_reconcile_open_mismatches',
  help: 'Open voucher mismatches found by the most recent reconciliation pass',
  registers: [registry],
});
indexerReconcileOpenMismatches.set(0);

export function recordEventLatency(ledgerClosedAt: Date, now: number = Date.now()): void {
  const seconds = Math.max(0, (now - ledgerClosedAt.getTime()) / 1000);
  indexerEventLatency.observe(seconds);
}

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'HTTP requests handled',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

/**
 * Open `GET /stream` connections in this process.
 *
 * A stream is held open rather than served and returned, so it costs a socket
 * for as long as the client is watching. This is the series that shows the
 * instance approaching `SSE_MAX_CONNECTIONS`, at which point new viewers get
 * a 503 instead of a queue.
 */
export const streamConnections = new Gauge({
  name: 'stream_connections',
  help: 'Server-sent event streams currently open in this process',
  registers: [registry],
});

/**
 * Webhook outbox backlog, as last measured by the delivery loop.
 *
 * `webhook_deliveries_pending` is the number of rows neither delivered nor
 * abandoned; a value that does not reach zero means the loop is not
 * draining, which is the same condition `/ready` reports as a stale
 * backlog. `webhook_deliveries_abandoned` counts deliveries given up on:
 * those clinics were never told about a voucher event.
 */
export const webhookDeliveriesPending = new Gauge({
  name: 'webhook_deliveries_pending',
  help: 'Webhook deliveries queued but not yet delivered or abandoned',
  registers: [registry],
});

export const webhookDeliveriesAbandoned = new Gauge({
  name: 'webhook_deliveries_abandoned',
  help: 'Webhook deliveries given up on after retries or a permanent response',
  registers: [registry],
});

/**
 * Per-endpoint circuit breaker state (#265): 0 closed, 1 half-open, 2 open.
 * A value of 2 means deliveries to that endpoint are being held, not lost —
 * the outbox keeps them until one probe succeeds.
 */
export const webhookCircuitState = new Gauge({
  name: 'webhook_circuit_state',
  help: 'Webhook circuit breaker state per endpoint (0 closed, 1 half-open, 2 open)',
  labelNames: ['endpoint'],
  registers: [registry],
});

export const webhookCircuitConsecutiveFailures = new Gauge({
  name: 'webhook_circuit_consecutive_failures',
  help: 'Consecutive failed webhook deliveries per endpoint',
  labelNames: ['endpoint'],
  registers: [registry],
});

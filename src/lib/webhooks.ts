import { createHash, randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import type { Span } from '@opentelemetry/api';
import type { FastifyBaseLogger } from 'fastify';

import { prisma } from '../db.js';
import { env, WEBHOOK_URLS, WEBHOOKS_ENABLED } from '../env.js';
import {
  webhookCircuitConsecutiveFailures,
  webhookCircuitState,
  webhookDeliveriesAbandoned,
  webhookDeliveriesPending,
  webhookDeliveriesTotal,
  webhookDeliveryDuration,
} from './metrics.js';
import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from './webhook-signature.js';
import { isTracingEnabled, traceparentHeader, withSpan } from '../tracing.js';

export { signWebhook, WEBHOOK_SIGNATURE_HEADER } from './webhook-signature.js';

/**
 * Signed webhook notifications for voucher, clinic and service events.
 *
 * The API is read-only and has no accounts, so endpoints are configured by
 * the operator (`WEBHOOK_URLS`) rather than self-registered. Each delivery is
 * signed with HMAC-SHA256 under `WEBHOOK_SECRET` over the exact request body,
 * which lets a receiver prove the payload came from this service.
 *
 * Delivery is decoupled from indexing through the `WebhookDelivery` outbox:
 * a clinic with a slow or unreachable endpoint must never stall the cursor.
 */

/** Give up after this many failed attempts. */
export const WEBHOOK_MAX_ATTEMPTS = 6;
/** First retry delay; doubles per attempt. */
export const WEBHOOK_BASE_BACKOFF_MS = 5_000;
/** Ceiling on the retry delay. */
export const WEBHOOK_MAX_BACKOFF_MS = 10 * 60_000;
/** How often the delivery loop looks for due rows. */
export const WEBHOOK_DELIVERY_INTERVAL_MS = 5_000;

/**
 * Consecutive failed deliveries against one endpoint before the breaker
 * opens. A single 500 is a retry, not an outage, so the default waits for a
 * short streak before every delivery to that endpoint is held.
 */
export const WEBHOOK_BREAKER_FAILURE_THRESHOLD = 5;
/** How long a tripped endpoint is left alone before one probe is allowed. */
export const WEBHOOK_BREAKER_COOLDOWN_MS = 30_000;

/** Event names emitted for registry and service changes (#266). */
export const PROVIDER_REGISTERED_EVENT = 'provider.registered';
export const PROVIDER_STATUS_CHANGED_EVENT = 'provider.status_changed';
export const SERVICE_PRICE_CHANGED_EVENT = 'service.price_changed';

/**
 * The event a receiver is told about. There is deliberately no beneficiary
 * reference here: the payload must not carry anything that could identify a
 * patient, even though the reference is itself opaque. The same rule applies
 * to every downstream channel (for example the email notifier in
 * `examples/email-notifier/`), which must never forward beneficiary references.
 */
export type VoucherWebhookEvent = {
  /** Contract event name, e.g. `voucher_settled`. */
  event: string;
  voucherId: string;
  /** Resulting voucher status, e.g. `Settled`. */
  status: string;
  txHash?: string | null;
  ledger: number;
};

/** A clinic was registered, or its registry status changed. */
export type ProviderWebhookEvent = {
  event: typeof PROVIDER_REGISTERED_EVENT | typeof PROVIDER_STATUS_CHANGED_EVENT;
  provider: string;
  /** Resulting registry status, e.g. `Active`. */
  status: string;
  txHash?: string | null;
  ledger: number;
};

/** A clinic's service price changed (including the first listing). */
export type ServicePriceWebhookEvent = {
  event: typeof SERVICE_PRICE_CHANGED_EVENT;
  provider: string;
  serviceCode: number;
  /** New price in exact base units, as the decimal string the API uses. */
  price: string;
  txHash?: string | null;
  ledger: number;
};

/** Everything the outbox can hold. */
export type WebhookEvent = VoucherWebhookEvent | ProviderWebhookEvent | ServicePriceWebhookEvent;

/**
 * The exact object that is serialised, signed and posted.
 *
 * Voucher payloads are unchanged by #266: a receiver that only understands
 * voucher events sees exactly the body it saw before clinic events existed.
 */
export function webhookPayload(event: WebhookEvent): Record<string, unknown> {
  if ('voucherId' in event) {
    return {
      event: event.event,
      voucherId: event.voucherId,
      status: event.status,
      // Omitted, not null, when the RPC did not report a hash.
      ...(event.txHash ? { txHash: event.txHash } : {}),
      ledger: event.ledger,
    };
  }
  if ('serviceCode' in event) {
    return {
      event: event.event,
      provider: event.provider,
      serviceCode: event.serviceCode,
      price: event.price,
      ...(event.txHash ? { txHash: event.txHash } : {}),
      ledger: event.ledger,
    };
  }
  return {
    event: event.event,
    provider: event.provider,
    status: event.status,
    ...(event.txHash ? { txHash: event.txHash } : {}),
    ledger: event.ledger,
  };
}

/**
 * The outbox row for one endpoint. Columns mirror the payload for triage;
 * the stored `payload` stays the source of truth for what is sent.
 */
function deliveryRow(url: string, event: WebhookEvent): Prisma.WebhookDeliveryCreateManyInput {
  const common = {
    id: randomUUID(),
    url,
    event: event.event,
    ledger: event.ledger,
    txHash: event.txHash ?? null,
    payload: JSON.stringify(webhookPayload(event)),
    nextAttemptAt: new Date(),
  };
  if ('voucherId' in event) {
    return { ...common, voucherId: event.voucherId, status: event.status };
  }
  if ('serviceCode' in event) {
    return {
      ...common,
      provider: event.provider,
      serviceCode: event.serviceCode,
      status: null,
    };
  }
  return { ...common, provider: event.provider, status: event.status };
}

/**
 * Queues one delivery per configured endpoint, inside `tx`.
 *
 * Running inside the caller's transaction is the whole point: if the
 * projection that produced the event rolls back, so does the notification.
 * A receiver can therefore trust that everything it is told about is in the
 * read model.
 */
export async function enqueueWebhook(
  tx: Prisma.TransactionClient,
  event: WebhookEvent,
): Promise<void> {
  if (!WEBHOOKS_ENABLED) return;
  await tx.webhookDelivery.createMany({
    data: WEBHOOK_URLS.map((url) => deliveryRow(url, event)),
  });
}

/** Exponential backoff in milliseconds for the given attempt count. */
export function backoffMs(
  attempt: number,
  base = WEBHOOK_BASE_BACKOFF_MS,
  max = WEBHOOK_MAX_BACKOFF_MS,
): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(base * 2 ** exponent, max);
}

/**
 * An endpoint with its secret or token stripped: origin and path only.
 *
 * Used for span attributes and metric labels. A `WEBHOOK_URLS` entry may
 * carry a credential in its query string, and neither telemetry nor `/ready`
 * should copy it anywhere.
 */
export function endpointLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

export type WebhookCircuitState = 'closed' | 'open' | 'half-open';

export type WebhookCircuitStatus = {
  /** Origin and path only; never the query string. */
  endpoint: string;
  state: WebhookCircuitState;
  consecutiveFailures: number;
  /** When the breaker opened, or null while it is closed. */
  openedAt: string | null;
};

type BreakerEntry = {
  failures: number;
  /** Epoch ms when the breaker opened, or null while closed. */
  openedAt: number | null;
  /** True while the single post-cooldown probe is on the wire. */
  probing: boolean;
};

/**
 * Per-endpoint circuit breaker (#265).
 *
 * The dispatcher opens a breaker after `failureThreshold` consecutive failed
 * deliveries to one endpoint and then stops contacting it entirely: the
 * outbox stays queued, the attempts counter is not advanced, and other
 * endpoints keep being delivered. After `cooldownMs` one probe is allowed
 * through; a success closes the breaker and the held rows go out in their
 * original order, a failure opens it again for another cooldown.
 *
 * This is in-memory by design. The outbox already survives a restart, and a
 * fresh process starting closed is correct: it has not seen failures yet and
 * its first delivery to a dead endpoint is the observation it needs.
 */
export class WebhookCircuit {
  private readonly entries = new Map<string, BreakerEntry>();

  constructor(
    private readonly failureThreshold: number = WEBHOOK_BREAKER_FAILURE_THRESHOLD,
    private readonly cooldownMs: number = WEBHOOK_BREAKER_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private entry(url: string): BreakerEntry {
    let entry = this.entries.get(url);
    if (!entry) {
      entry = { failures: 0, openedAt: null, probing: false };
      this.entries.set(url, entry);
    }
    return entry;
  }

  /** The state right now, without changing it. */
  state(url: string): WebhookCircuitState {
    const entry = this.entries.get(url);
    if (!entry || entry.openedAt === null) return 'closed';
    return this.now() - entry.openedAt >= this.cooldownMs ? 'half-open' : 'open';
  }

  /**
   * Whether a request may be sent. In half-open state exactly one call is
   * admitted — the probe — and the rest are held until its outcome is known.
   */
  admit(url: string): boolean {
    const state = this.state(url);
    if (state === 'closed') return true;
    if (state === 'open') return false;
    const entry = this.entry(url);
    if (entry.probing) return false;
    entry.probing = true;
    return true;
  }

  /**
   * Endpoints that must not be selected at all right now. Filtering them out
   * of the batch, rather than fetching and skipping their rows, is what keeps
   * a large held backlog from crowding other endpoints out of a 50-row cycle.
   */
  blockedUrls(): string[] {
    return [...this.entries.keys()].filter((url) => this.state(url) === 'open');
  }

  /** A deliverable response, including a permanent 4xx: the endpoint is up. */
  recordSuccess(url: string): void {
    const entry = this.entry(url);
    entry.failures = 0;
    entry.openedAt = null;
    entry.probing = false;
    this.publish(url, entry);
  }

  recordFailure(url: string): void {
    const entry = this.entry(url);
    entry.failures += 1;
    // A failed probe re-opens immediately, even below the threshold: the
    // cooldown has already been spent proving the endpoint is still down.
    if (entry.probing || entry.failures >= this.failureThreshold) {
      entry.openedAt = this.now();
      entry.probing = false;
    }
    this.publish(url, entry);
  }

  private publish(url: string, entry: BreakerEntry): void {
    const endpoint = endpointLabel(url);
    const state = this.state(url);
    webhookCircuitState.set({ endpoint }, state === 'open' ? 2 : state === 'half-open' ? 1 : 0);
    webhookCircuitConsecutiveFailures.set({ endpoint }, entry.failures);
  }

  /** Every endpoint the circuit has seen, for `/ready` and tests. */
  snapshot(): WebhookCircuitStatus[] {
    return [...this.entries].map(([url, entry]) => ({
      endpoint: endpointLabel(url),
      state: this.state(url),
      consecutiveFailures: entry.failures,
      openedAt: entry.openedAt === null ? null : new Date(entry.openedAt).toISOString(),
    }));
  }

  /** Forgets every breaker. Used by tests that share the module singleton. */
  reset(): void {
    this.entries.clear();
  }
}

/** The breaker set the dispatcher and `/ready` share in a running process. */
export const webhookCircuit = new WebhookCircuit();

/** Breaker states as `/ready` reports them. */
export function webhookCircuitSnapshot(): WebhookCircuitStatus[] {
  return webhookCircuit.snapshot();
}

/**
 * Outbox backlog, as reported by `/ready` and by the gauges on `/metrics`.
 *
 * These are the deliveries a clinic is still waiting on, in the one place an
 * operator already watches. Counting rows rather than reading payloads keeps
 * this free of anything patient-linked.
 */
export type WebhookBacklog = {
  /** Queued rows that are neither delivered nor abandoned. */
  pending: number;
  /** Pending rows older than `READY_WEBHOOK_MAX_AGE_MS`. */
  stale: number;
  /** Rows given up on: retries exhausted, or a permanent 4xx response. */
  abandoned: number;
  /** Age in seconds of the oldest pending row, or null when none is queued. */
  oldestPendingAgeSeconds: number | null;
};

/**
 * Reads the outbox backlog and publishes it to the webhook gauges.
 *
 * The gauge update lives here so `/ready` and the delivery loop cannot
 * report different numbers for the same table: both call this function. A
 * row that stayed pending past the threshold means the loop is not running
 * or cannot reach the database, because every retry of a reachable endpoint
 * resolves inside the backoff ceiling.
 */
export async function webhookBacklog(now: Date = new Date()): Promise<WebhookBacklog> {
  const staleBefore = new Date(now.getTime() - env.READY_WEBHOOK_MAX_AGE_MS);
  const pendingWhere = { deliveredAt: null, abandonedAt: null };

  const [pending, stale, abandoned, oldest] = await Promise.all([
    prisma.webhookDelivery.count({ where: pendingWhere }),
    prisma.webhookDelivery.count({ where: { ...pendingWhere, createdAt: { lt: staleBefore } } }),
    prisma.webhookDelivery.count({ where: { abandonedAt: { not: null } } }),
    prisma.webhookDelivery.findFirst({
      where: pendingWhere,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  webhookDeliveriesPending.set(pending);
  webhookDeliveriesAbandoned.set(abandoned);

  return {
    pending,
    stale,
    abandoned,
    oldestPendingAgeSeconds: oldest
      ? Math.max(0, Math.floor((now.getTime() - oldest.createdAt.getTime()) / 1000))
      : null,
  };
}

type OutboxRow = {
  id: string;
  url: string;
  event: string;
  voucherId: string | null;
  provider: string | null;
  payload: string;
  attempts: number;
};

export type WebhookDispatcherOptions = {
  /** Overridable for tests; defaults to the configured `WEBHOOK_URLS`. */
  urls?: readonly string[];
  /** Overridable for tests; defaults to `WEBHOOK_SECRET`. */
  secret?: string;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overridable for tests; defaults to the shared process breaker set. */
  circuit?: WebhookCircuit;
  intervalMs?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  batchSize?: number;
  now?: () => Date;
};

/**
 * Delivers outbox rows on its own loop.
 *
 * This is intentionally separate from the indexer: a hundred failed
 * deliveries must not slow a single ledger, and a backed-off endpoint must
 * not hold the cursor.
 */
export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private delivering = false;
  private refreshingBacklog = false;

  private readonly urls: readonly string[];
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly circuit: WebhookCircuit;
  private readonly intervalMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly log: FastifyBaseLogger,
    opts: WebhookDispatcherOptions = {},
  ) {
    this.urls = opts.urls ?? WEBHOOK_URLS;
    this.secret = opts.secret ?? env.WEBHOOK_SECRET;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.circuit = opts.circuit ?? webhookCircuit;
    this.intervalMs = opts.intervalMs ?? WEBHOOK_DELIVERY_INTERVAL_MS;
    this.maxAttempts = opts.maxAttempts ?? WEBHOOK_MAX_ATTEMPTS;
    this.baseBackoffMs = opts.baseBackoffMs ?? WEBHOOK_BASE_BACKOFF_MS;
    this.maxBackoffMs = opts.maxBackoffMs ?? WEBHOOK_MAX_BACKOFF_MS;
    this.batchSize = opts.batchSize ?? 50;
    this.now = opts.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.urls.length > 0 && this.secret.length > 0;
  }

  start(): void {
    if (!this.enabled) {
      this.log.info('webhooks disabled; no endpoints configured');
      return;
    }
    this.log.info({ endpoints: this.urls.length }, 'webhook delivery started');
    this.schedule();
  }

  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return Promise.resolve();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.cycle();
    }, this.intervalMs);
    // The API server or the indexer loop is what keeps the process alive;
    // the delivery loop must never be the only reason it cannot exit.
    this.timer.unref();
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.deliverPending();
      // Refresh the gauges even when nothing was due, so `/metrics` reflects
      // the outbox rather than only the cycles that happened to deliver.
      // Deliberately not awaited: a slow count must not delay the next
      // delivery, and an unreadable count is a metrics problem rather than a
      // failed delivery cycle. One refresh in flight at a time keeps a slow
      // database from queueing one query per interval.
      if (!this.refreshingBacklog) {
        this.refreshingBacklog = true;
        void webhookBacklog(this.now())
          .catch((err: unknown) => {
            this.log.warn({ err }, 'webhook backlog metrics could not be refreshed');
          })
          .finally(() => {
            this.refreshingBacklog = false;
          });
      }
    } catch (err) {
      this.log.error({ err }, 'webhook delivery cycle failed');
    } finally {
      this.schedule();
    }
  }

  /**
   * Attempts every delivery whose backoff has elapsed. Returns how many were
   * delivered, which is what tests assert on.
   */
  async deliverPending(): Promise<number> {
    if (this.delivering) return 0;
    this.delivering = true;
    try {
      // Rows for a tripped endpoint are not even selected, so they cannot
      // consume the batch and starve a healthy endpoint.
      const blocked = this.circuit.blockedUrls();
      const due = await prisma.webhookDelivery.findMany({
        where: {
          deliveredAt: null,
          abandonedAt: null,
          nextAttemptAt: { lte: this.now() },
          ...(blocked.length > 0 ? { url: { notIn: blocked } } : {}),
        },
        // Held rows keep an old `nextAttemptAt`, so they come back before
        // newer traffic and a recovered endpoint drains them oldest-first.
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        take: this.batchSize,
      });

      let delivered = 0;
      for (const row of due) {
        // Half-open admits exactly one probe; the rest of this endpoint's
        // rows stay held until that probe reports back.
        if (!this.circuit.admit(row.url)) continue;
        if (await this.attempt(row)) delivered += 1;
      }
      return delivered;
    } finally {
      this.delivering = false;
    }
  }

  /**
   * Posts one row, inside a `webhook.deliver` span when tracing is on.
   *
   * The span carries the event, attempt and endpoint without its query
   * string, and never the payload: a voucher event is not patient data, but
   * the rule about not copying stored bodies into telemetry is easier to keep
   * than to re-argue per field. A W3C `traceparent` is sent only when the span
   * has a real context, so a receiver can join the delivery to the request or
   * indexer cycle that caused it.
   */
  private async post(row: OutboxRow, attempts: number): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: signWebhook(row.payload, this.secret),
    };
    const send = (): Promise<Response> =>
      this.fetchImpl(row.url, {
        method: 'POST',
        headers,
        body: row.payload,
      });

    if (!isTracingEnabled()) return send();

    return withSpan('webhook.deliver', async (span: Span) => {
      span.setAttribute('webhook.event', row.event);
      span.setAttribute('webhook.endpoint', endpointLabel(row.url));
      span.setAttribute('webhook.attempt', attempts);
      const traceparent = traceparentHeader(span);
      if (traceparent !== undefined) headers.traceparent = traceparent;
      return send();
    });
  }

  private async attempt(row: OutboxRow): Promise<boolean> {
    const attempts = row.attempts + 1;
    let error: string | null = null;
    let retryable = true;
    const startedAt = performance.now();
    // Hash the configured endpoint's numeric index, never its URL or credentials.
    const endpointIndex = this.urls.indexOf(row.url);
    const endpoint =
      endpointIndex < 0
        ? 'unknown'
        : createHash('sha256').update(String(endpointIndex)).digest('hex').slice(0, 8);
    let outcome: 'success' | 'http_error' | 'network_error' = 'network_error';

    try {
      const res = await this.post(row, attempts);
      outcome = res.ok ? 'success' : 'http_error';

      if (res.ok) {
        this.circuit.recordSuccess(row.url);
        await prisma.webhookDelivery.update({
          where: { id: row.id },
          data: { attempts, deliveredAt: this.now(), lastError: null },
        });
        this.log.info(
          {
            id: row.id,
            url: endpointLabel(row.url),
            event: row.event,
            voucherId: row.voucherId,
            provider: row.provider,
          },
          'webhook delivered',
        );
        return true;
      }

      error = `HTTP ${res.status}`;
      // 4xx other than 408/429 will not get better by retrying.
      retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      // A permanent 4xx still proves the endpoint is reachable, so it must
      // not trip the breaker; the delivery alone is given up on below.
      if (retryable) this.circuit.recordFailure(row.url);
      else this.circuit.recordSuccess(row.url);
    } catch (err) {
      error = (err as Error).message;
      retryable = true;
      this.circuit.recordFailure(row.url);
    } finally {
      webhookDeliveryDuration.observe(
        { endpoint, outcome },
        Math.max(0, (performance.now() - startedAt) / 1000),
      );
      webhookDeliveriesTotal.inc({ endpoint, outcome });
    }

    const abandoned = !retryable || attempts >= this.maxAttempts;
    await prisma.webhookDelivery.update({
      where: { id: row.id },
      data: {
        attempts,
        lastError: error,
        ...(abandoned
          ? { abandonedAt: this.now() }
          : {
              nextAttemptAt: new Date(
                this.now().getTime() + backoffMs(attempts, this.baseBackoffMs, this.maxBackoffMs),
              ),
            }),
      },
    });

    this.log.warn(
      {
        id: row.id,
        url: endpointLabel(row.url),
        attempts,
        error,
        abandoned,
      },
      'webhook delivery failed',
    );
    return false;
  }
}

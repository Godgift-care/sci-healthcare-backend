# Webhooks

How voucher events are delivered to a clinic endpoint: the outbox, the retry schedule, and what a receiver has to be able to assume.

[Back to the README](../README.md).

Set `WEBHOOK_URLS` to a comma-separated list of endpoints and `WEBHOOK_SECRET`
to sign every delivery. When a voucher-related event is projected, the backend
writes a row to a delivery outbox in the same transaction, then posts it from a
separate loop — a slow or unreachable endpoint therefore never stalls the
indexer. Failed deliveries retry with exponential backoff (five seconds
doubling, capped at ten minutes) and are given up on after six attempts or a
permanent 4xx response. An endpoint that keeps failing is paused by a
per-endpoint circuit breaker rather than retried for every event (#265).

Events are emitted for voucher transitions and, since #266, for clinic and
service changes: `provider.registered`, `provider.status_changed` and
`service.price_changed`.

## Delivery sequence

```mermaid
sequenceDiagram
    participant RPC as Soroban RPC
    participant IDX as Indexer
    participant OUT as Outbox (WebhookDelivery)
    participant DSP as WebhookDispatcher
    participant EP as Your endpoint

    RPC->>IDX: voucher_settled
    Note over IDX,OUT: one transaction: the projection and the outbox row commit or roll back together<br/>so an event that failed to project is never announced
    IDX->>OUT: INSERT row (attempts = 0, nextAttemptAt = now, one row per endpoint)
    loop every WEBHOOK_DELIVERY_INTERVAL_MS (5 s)
        DSP->>OUT: SELECT rows with deliveredAt and abandonedAt null and nextAttemptAt <= now<br/>(ordered by nextAttemptAt, up to 50 per cycle)
        DSP->>EP: POST payload + X-SCI-Signature, X-SCI-Delivery and X-SCI-Attempt
        alt 2xx
            EP-->>DSP: 204 No Content
            Note over OUT: deliveredAt set, lastError cleared, row retired
        else 5xx, 408, 429 or a network error
            EP-->>DSP: 503 / timeout / connection refused
            Note over OUT: attempts++, lastError set, nextAttemptAt = now + backoffMs(attempts)
        else any other 4xx (400, 401, 404, ...)
            EP-->>DSP: 404 Not Found
            Note over OUT: abandonedAt set immediately, never retried again
        end
    end
```

The outbox row is written inside the same transaction as the projection it
describes, and the dispatcher is a separate loop that wakes every
`WEBHOOK_DELIVERY_INTERVAL_MS` (5 s): a slow or dead endpoint can therefore
never stall the indexer, and a rolled-back projection never sends a
notification.

## Retry schedule

Numbers from `src/lib/webhooks.ts`: `WEBHOOK_BASE_BACKOFF_MS = 5_000`,
`WEBHOOK_MAX_BACKOFF_MS = 600_000` (ten minutes),
`WEBHOOK_MAX_ATTEMPTS = 6`, `WEBHOOK_DELIVERY_INTERVAL_MS = 5_000`. The
delay after a failed attempt is `backoffMs(attempt)` = base doubled once per
attempt, capped at ten minutes; because the dispatcher only looks for due
rows every five seconds, the actual retry lands between the backoff and the
backoff plus one poll.

| Failed attempt | Backoff (`backoffMs`) | Retry starts between | Outcome of that attempt |
| --- | --- | --- | --- |
| 1 | 5 s (`5000` ms) | 5 s and 10 s later | retried |
| 2 | 10 s (`10000` ms) | 10 s and 15 s later | retried |
| 3 | 20 s (`20000` ms) | 20 s and 25 s later | retried |
| 4 | 40 s (`40000` ms) | 40 s and 45 s later | retried |
| 5 | 80 s (`80000` ms) | 80 s and 85 s later | retried |
| 6 | n/a | n/a | **abandoned** (`attempts >= WEBHOOK_MAX_ATTEMPTS`) |

With six attempts the largest delay ever reached is 80 s, so the ten-minute
cap only matters for callers that raise `WEBHOOK_MAX_ATTEMPTS`. A permanent
response (any 4xx other than 408 and 429) skips the remaining attempts and
abandons the row on the spot: a 404 will not become a 204 by waiting.

## Endpoint circuit breaker

Numbers from `src/lib/webhooks.ts`: `WEBHOOK_BREAKER_FAILURE_THRESHOLD = 5`
consecutive failed deliveries, then `WEBHOOK_BREAKER_COOLDOWN_MS = 30000`
(thirty seconds) before one probe is allowed through.

While an endpoint's breaker is **open**, its deliveries are not retried:
the dispatcher does not even select them, their `attempts` counter is left
alone, and the rows stay queued. Other configured endpoints keep delivering
normally — the held rows never consume the 50-row batch. After the cooldown
the breaker is **half-open**: exactly one probe, the oldest held row, is
sent. If it succeeds the breaker closes and the remaining held rows go out
in their original order, oldest first. If the probe fails the breaker opens
again for another cooldown.

Only network errors, 5xx, 408 and 429 count as breaker failures — they mean
the endpoint is not answering. A permanent 4xx proves the endpoint is up and
only abandons that one delivery. The breaker is in-memory: a restart starts
closed, which is correct for a process that has not yet observed a failure.

`/ready` reports every endpoint the dispatcher has seen in
`checks.webhooks.breakers`, each as `{ endpoint, state, consecutiveFailures,
openedAt }` where `state` is `closed`, `open` or `half-open` and `endpoint`
is the origin and path with any query string removed. A tripped breaker is
reported but does not make the instance unready: the deliveries are held,
not lost. The same state is on `/metrics` as `webhook_circuit_state`
(0 closed, 1 half-open, 2 open) and
`webhook_circuit_consecutive_failures`, both labelled by `endpoint`.

## Registry and service events

In addition to the voucher events above, three registry events are delivered
with the same signature, outbox, retry and breaker behaviour (#266):

```json
{
  "event": "provider.registered",
  "provider": "G...",
  "status": "Pending",
  "txHash": "deadbeef...",
  "ledger": 123456
}
```

```json
{
  "event": "provider.status_changed",
  "provider": "G...",
  "status": "Suspended",
  "txHash": "deadbeef...",
  "ledger": 123456
}
```

```json
{
  "event": "service.price_changed",
  "provider": "G...",
  "serviceCode": 101,
  "price": "30000000",
  "txHash": "deadbeef...",
  "ledger": 123456
}
```

`price` is the exact base-unit amount as a decimal string, the same form the
API returns, never a float. A first listing counts as a price change. A
`provider.status_changed` is sent only when the status actually differs from
the indexed row, so replaying an event does not notify twice. Voucher payloads
are unchanged by this: a receiver that only understands voucher events sees
exactly the body it saw before.

## Testing an endpoint

```sh
npm run webhooks:ping -- --url https://clinic.example/webhooks
# or, with the secret supplied explicitly
npm run webhooks:ping -- --url https://clinic.example/webhooks --secret "$WEBHOOK_SECRET"
```

`--secret` defaults to `WEBHOOK_SECRET`. The command sends
`{"event":"ping","sentAt":"..."}` with the same raw-body HMAC-SHA256 in
`x-sci-signature` as a real delivery, prints the HTTP status and latency, and
exits non-zero when the answer is not 2xx or the request fails. Usage errors
exit 2. The production script runs the compiled `dist/` entry point; use
`npm run webhooks:ping:dev` to run it from source without a build.

## Tracing

When tracing is configured (`OTEL_EXPORTER_OTLP_ENDPOINT` set), every delivery
attempt is a `webhook.deliver` span with the `webhook.event`,
`webhook.endpoint` (origin and path, query string removed) and
`webhook.attempt` attributes, and the request carries a W3C `traceparent`
header so a receiver can join the delivery to the indexer cycle or request
that produced it (#268). The payload is never copied into a span attribute,
and with tracing off no span is exported and no `traceparent` header is sent.

## What a receiver must assume

- **At-least-once.** A delivery that succeeds after the receiver processed
  it but before the row was marked (a timeout, a crash between the response
  and the commit) is retried. Deduplicate on the `X-SCI-Delivery` header
  (stable across every retry of one delivery), or on `(event, voucherId)`;
  handlers should be idempotent anyway.
- **No cross-event ordering.** Rows are enqueued in ledger order, but a
  failing row backs off while newer rows keep flowing, so a receiver can see
  `voucher_settled` before the `voucher_claimed` retry that precedes it.
  `ledger` in the payload is the ordering key when order matters.
- **Independent endpoints.** Every configured URL gets its own row and its
  own backoff: one dead clinic endpoint never delays another's deliveries.
- **The receiver is the only witness to its own downtime.** The sender only
  knows the HTTP response it got; a 5xx is retried, a 2xx is final, and
  nothing is re-sent once `deliveredAt` or `abandonedAt` is set. There is no
  replay command, so a receiver that lost deliveries should read the state
  from the API (for example `GET /vouchers/:id/events`) rather than wait.
A backlog is visible instead of silent. `GET /ready` reports
`checks.webhooks` — `state` (`ok`, `backlog` or `disabled`), `pending`,
`abandoned`, `oldestPendingAgeSeconds` and `maxPendingAgeSeconds` — and
answers 503 once a delivery has been pending longer than
`READY_WEBHOOK_MAX_AGE_MS` (default fifteen minutes), because a healthy loop
drains every retry far sooner than that. `/metrics` exposes the same counts
as `webhook_deliveries_pending` and `webhook_deliveries_abandoned`, which is
what the `SciWebhookBacklog` rule in `ops/alerts.yml` watches. Abandoned
rows are never retried: those clinics missed those events, which is why the
count is reported separately rather than folded into the log.

Each request is `POST` with a JSON body and these headers:

| Header | Example | Meaning |
| --- | --- | --- |
| `X-SCI-Signature` | `9f2c…` | Hex HMAC-SHA256 of the **raw request body**. With `WEBHOOK_SECRETS`, one digest per key, comma-separated, newest first. |
| `X-SCI-Delivery` | `0b6f1e0a-…` | The outbox row's id. Identical for every retry of this delivery and different for another endpoint or event. |
| `X-SCI-Attempt` | `3` | 1-based attempt number; `1` on the first POST, `2` on the first retry, and so on. |

The payload is:

```json
{
  "event": "voucher_settled",
  "voucherId": "42",
  "status": "Settled",
  "txHash": "deadbeef...",
  "ledger": 123456
}
```

`txHash` is omitted when the RPC did not report one. The payload never contains
a beneficiary reference, so a webhook receiver learns that *a* voucher moved,
never who it was for. The clinic an endpoint is filtered to is likewise not
in the body: filtering happens before the row is written, on the server.

## Delivery headers and deduplication

A retry reuses the same outbox row, so `X-SCI-Delivery` is the same value on
every attempt of one delivery while `X-SCI-Attempt` counts up. Store the ids
you have processed and answer `204` to a repeat without applying it again:

```ts
const seen = new Set<string>(); // backed by your database in production

app.post('/webhooks/sci', (req, res) => {
  const deliveryId = req.header('x-sci-delivery');
  if (!deliveryId) return res.sendStatus(400);
  if (seen.has(deliveryId)) return res.sendStatus(204); // already processed

  // …verify the signature, then apply the event…
  seen.add(deliveryId);
  res.sendStatus(204);
});
```

Use the id, not the body, as the deduplication key: two legitimate
`voucher_settled` events for the same voucher at different ledgers have the
same `(event, voucherId)` but different delivery ids. Conversely a retried
POST has the same id even if `X-SCI-Attempt` has changed. Insert the id and
the applied effect in one database transaction so a crash between applying
and recording cannot process it twice.

## Rotating the signing secret

`WEBHOOK_SECRETS` takes a comma-separated list, **newest first**. Every key
signs each delivery, so `X-SCI-Signature` carries one digest per key:

```
X-SCI-Signature: <hmac with newest key>, <hmac with previous key>
```

A receiver accepts the delivery if any digest matches its configured key, so
rotation needs no synchronised cutover:

1. Add a new key at the front: `WEBHOOK_SECRETS=<new>,<old>`.
2. Give receivers the new key and let them switch at their own pace. Both
   keys verify the same delivery during this window.
3. Once every receiver has the new key, remove the old one:
   `WEBHOOK_SECRETS=<new>`.

Keep a retired key for longer than the longest retry window (six attempts,
under three minutes with default backoff) so an in-flight retry signed before
the removal still verifies. `WEBHOOK_SECRET` on its own still works; when
both are set, both are used and `WEBHOOK_SECRETS` keys come first.

## Endpoints and filters

`WEBHOOK_URLS` is the simple case: every URL is told about every voucher
event and shares the global secret(s). `WEBHOOK_ENDPOINTS` is a JSON array
that gives each partner its own secret and optional filters:

```json
[
  {
    "url": "https://clinic-a.example/hooks",
    "secret": "a-long-random-string",
    "events": ["voucher_created", "voucher_claimed", "voucher_settled"],
    "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK"
  },
  { "url": "https://analytics.example/hooks", "events": ["voucher_settled"] }
]
```

- `secret` is optional; without it the endpoint uses `WEBHOOK_SECRETS` /
  `WEBHOOK_SECRET`.
- `events` limits the endpoint to those contract event names. Omit it for
  all events.
- `provider` limits the endpoint to one clinic's vouchers. Omit it for every
  clinic.
- `url` must be `http(s)` and unique within the list.

When `WEBHOOK_ENDPOINTS` is set it replaces `WEBHOOK_URLS` (which is then
ignored rather than merged, so a URL is never delivered twice). Malformed
JSON, an unknown property, a bad URL or a missing secret fails at startup
with the offending entry named; webhooks never start half-configured.
Filters are applied when the outbox row is written, so a filtered-out event
costs no row and no retry.

## Private destinations

The server refuses to POST to a host that resolves to a loopback, private,
link-local (`169.254.0.0/16`, including `169.254.169.254`), unique-local
(`fc00::/7`) or otherwise reserved address, and abandons that delivery
instead of retrying: such an endpoint is a misconfiguration, not a slow
receiver. The same check guards provider metadata URIs — including every
redirect hop — because those URLs come from on-chain data. Set
`WEBHOOK_ALLOW_PRIVATE=true` for local development only.

Verify a delivery by recomputing the signature over the exact bytes received —
do not parse and re-serialise the JSON first, as that can change the bytes.
With multiple keys, accept if **any** digest matches:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

app.post('/webhooks/sci', (req, res) => {
  const received = (req.header('x-sci-signature') ?? '')
    .split(',')
    .map((digest) => digest.trim())
    .filter(Boolean);
  const expected = createHmac('sha256', process.env.WEBHOOK_SECRET!)
    .update(req.rawBody) // the raw body buffer, not a re-encoded object
    .digest('hex');

  const ok = received.some(
    (digest) =>
      digest.length === expected.length &&
      timingSafeEqual(Buffer.from(digest), Buffer.from(expected)),
  );
  if (!ok) return res.sendStatus(401);

  // Only now trust the body.
  res.sendStatus(204);
});
```

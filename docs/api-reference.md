# API reference

Every route this service serves, with a curl example and its response. The specification is generated from the route schemas and committed as `openapi.json`; `GET /docs` serves the interactive version.

[Back to the README](../README.md).

Every route is served under the canonical `/v1` prefix. The unversioned paths
(`/vouchers`, `/providers`, …) remain as aliases for clients already deployed
against them: each response on those paths carries `Deprecation: true` and a
`Link: </v1/...>; rel="successor-version"` header. New integrations should
target `/v1`.

See the [API versioning and lifecycle policy](api-policy.md) for the
compatibility promise, deprecation headers and notice periods.

Every response carries an `X-Request-Id`. Send one and it is echoed (after
validation); otherwise the server generates a UUID. The same value appears as
`reqId` in the log line for the request, so an id from a user is enough to find
the matching log entry.

Errors all use one envelope, whatever layer rejected the request:

```json
{ "error": "invalid_query", "message": "Invalid query parameters", "details": [] }
```

`details` is present only when there is something structured to add (for
example the Zod issues for a bad query). Error codes: `invalid_query`,
`filter_required`, `invalid_code`, `provider_not_found`, `service_not_found`,
`voucher_not_found`, `receipt_not_found`, `route_not_found`, `method_not_allowed`,
`rate_limited`, `stream_full`, `bad_request`, `internal_error`, `database_unavailable`.
Any other 5xx is `internal_error`; the cause stays in the log, never in the response.

When the database cannot be reached at all — the server is down, the connection pool is
exhausted, a query timed out — the API answers `503 database_unavailable` with a
`Retry-After` header instead of a bare `500`, so a client can tell "try again in a few
seconds" from "this is broken" and back off for the right amount of time:

```json
{ "error": "database_unavailable", "message": "Database is unavailable, retry in 5 seconds" }
```

The API is read-only, so a known path called with another verb answers
`405` with an `Allow` header listing the methods that do work there:

```json
{ "error": "method_not_allowed", "message": "Method POST not allowed for /vouchers; allowed: GET, HEAD" }
```

A path that does not exist stays a `404`, whatever the method.

The `message` is human-readable and is localised: send `Accept-Language` (`fr`, `sw`, or a
regional form such as `fr-CA`) and it is translated, falling back to English for anything
unsupported or absent. `error` is the machine-readable code, is never translated, and is what
to switch on — never `message`. English is unchanged from earlier releases.

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness |
| `GET /ready` | Readiness; 503 once the indexer trails by more than `READY_MAX_LAG_LEDGERS`, a failed event is dead-lettered, or a webhook delivery is stuck in the outbox |
| `GET /version` | Build version and commit, network, RPC endpoints, contract ids, indexer start ledger and process start time |
| `GET /stats` | Protocol counters for the dashboard |
| `GET /stats/daily?days=30` | Funded / settled / refunded counts and value per UTC day, ISO week or month (`days` 1–365; `granularity=day|week|month`, `fill=false` for sparse) |
| `GET /stats/funnel` | Voucher counts and median hours between funded, claimed, attested and settled stages; optionally filter by `country` or clinic address |
| `GET /providers` | Clinics filterable by `status`, `country`, `q` and `serviceCode`, and sortable by `name`, `registered` or `country`; each carries the clinic's cached off-chain `metadata` (`null` until fetched) |
| `GET /providers/:address` | One clinic and its service catalogue, plus its cached off-chain `metadata` |
| `GET /providers/:address/stats` | A clinic's vouchers by status, total settled value, and median claim/attestation times |
| `GET /providers/:address/history` | Every status transition for a clinic, oldest first |
| `GET /providers/:address/services` | A clinic's price list on its own, cheapest first; `active`, `sort` and `order` filters |
| `GET /providers/:address/services/:code/history` | Every observed price for a service, oldest first |
| `GET /attesters` | Attesters trusted to confirm care; `?all=true` includes removed ones |
| `GET /attesters/:address` | One attester with its attestation count |
| `GET /sponsors` | Sponsors of the matching-funding desk, most recently seen first, with what each has matched; empty while `SPONSOR_CONTRACT_ID` is unset |
| `GET /sponsors/:address` | One sponsor: its terms, its last reported balance and its match totals |
| `GET /vouchers` | Vouchers by `funder`, `provider`, `beneficiaryRef` or `status`; `?include=receipt,provider` embeds related records |
| `GET /vouchers/:id` | One voucher, with its care receipt if settled, attester and dispute outcome; `?include=receipt,provider` embeds the canonical forms |
| `GET /vouchers/:id/events` | Every contract event for a voucher, oldest first, with transaction hashes |
| `GET /receipts?beneficiaryRef=` | A patient's settled care history |
| `GET /countries` | Countries with at least one active clinic and their clinic counts |
| `GET /services` | Active services grouped by code: labels, clinic count, min/max/median price; text search, price range, and price/label/code sorting |
| `GET /services/:code` | Active clinics offering a service code with their prices, cheapest first |
| `GET /vouchers` | Vouchers by `funder`, `provider`, `beneficiaryRef` or `status`, sorted by `sort`/`order` |
| `GET /vouchers/due` | Vouchers needing action soon (expiring, refundable or settleable) within `within`, e.g. `72h` |
| `GET /vouchers.csv` | Streamed CSV export matching the same filters as `GET /vouchers` |
| `GET /vouchers/:id` | One voucher, with its care receipt if settled |
| `GET /receipts?beneficiaryRef=` / `?provider=` | A patient's settled care history, or a clinic's receipts; `from`/`to` on `settledAt` and `order=asc|desc` |
| `GET /receipts.csv` | Streamed CSV export of the same filtered receipts, without the beneficiary reference |
| `GET /receipts/:voucherId` | One receipt, for a shareable receipt page |
| `GET /governance` | Current and pending admin per contract, plus the handover history |
| `GET /stream` | Live voucher state transitions as the indexer commits them (server-sent events) |
| `GET /feed.xml` | The latest settled vouchers and newly verified clinics as an Atom 1.0 feed, for feed readers; 20 entries at most, and no patient references |

`GET /vouchers` **requires at least one filter**. An unfiltered dump of every voucher is not a useful endpoint and invites scraping. It accepts `sort=createdAt|expiresAt|amount` and `order=asc|desc` (defaults: `createdAt`, `desc`). Amounts are compared with `BigInt`, so `amount` sorting is numeric rather than lexicographic.

`GET /vouchers` and `GET /vouchers/:id` also accept `?include=receipt,provider`,
so a mobile page renders a voucher's receipt and clinic without one request per
row. `receipt` is the same object `GET /receipts/:voucherId` returns (`null` for
a voucher that has not settled); on `GET /vouchers/:id`, which already carries
the stored receipt row, asking for it returns this canonical shape instead.
`provider` is the same object `GET /providers/:address` returns — `status`,
`registeredAt`, the cached `metadata` and the whole service catalogue — in place
of the `address`/`name`/`country` summary the routes serve by default. Both are
fetched for the entire page in a fixed number of queries (one `Receipt` and one
`Provider` batch, each with its own batched lookups), never one per row. An
unrequested or empty `include` changes nothing, an unknown name is a
`400 invalid_query`, and `?fields=` still projects the top-level keys, so
`?fields=id,receipt&include=receipt` is a valid request.

`GET /vouchers.csv` takes the same `funder`, `provider`, `beneficiaryRef` and
`status` filters (and also requires at least one). Rows are read in batches
with a cursor and streamed as an RFC 4180 download, so the export never has to
fit in memory however many vouchers match. It deliberately has **no beneficiary
reference column**.

`GET /attesters` lists only attesters who can attest today unless `?all=true` is passed, and reports how many vouchers each has confirmed. `/attesters/:address` is the same for one attester.

`GET /vouchers/:id/events` is the receipt trail: each event the indexer processed for that voucher, in ledger order, with the transaction hash that proved it. Events are appended in the same transaction as the state they update and keyed by the RPC event id, so replaying a ledger never duplicates a row.

`/receipts` requires an exact `beneficiaryRef` (or a `provider` for the clinic view). Because the reference is an HMAC under a key held by the patient, the endpoint cannot be walked to enumerate people. `from` and `to` bound `settledAt` for a reconciliation period: **`from` is inclusive and `to` is exclusive**, so adjacent months never double-count a receipt settled at exactly midnight. `order=asc|desc` walks the history oldest- or newest-first (default `desc`), and `nextCursor` is bound to that order — a cursor from the other order answers `400 invalid_cursor`. An unparseable date, or `from` later than `to`, is a `400 invalid_query`.

`GET /receipts.csv` takes the same filters and `order`, reads rows in keyset batches and streams them as an RFC 4180 download, so the export never has to fit in memory. It deliberately has **no beneficiary reference column**, and every cell is escaped against spreadsheet formula injection.

Every receipt — the patient view, the clinic view and `GET /receipts/:voucherId`
— carries the clinic that issued it in a `provider` object (`address`, `name`,
`country`), the same shape `GET /vouchers` uses, so a receipt page no longer has
to resolve the address separately. A receipt whose clinic is not in the registry
reports `name: null` and `country: null` instead of being dropped from its own
history: the settled care still happened. Clinic names and countries are public
on-chain registry data; no receipt response gains a beneficiary reference.

`GET /stream?voucher=<id>` or `GET /stream?provider=<address>` holds the
connection open and forwards each voucher transition as the indexer commits it:
one `data:` frame per event, containing `id`, `type`, `voucherId`,
`providerAddress`, `status`, `ledger`, `txHash` and `at`. Exactly one filter is
required — an unfiltered feed of care-state transitions would be a way to watch
a clinic's patient volume in real time — and a frame never carries a beneficiary
reference, only what the JSON routes already expose for the same transition.
Each frame also carries the on-chain event id in an SSE `id:` line. Send the last
one you received as `Last-Event-ID` when you reconnect: the server replays the
events committed after it, in ledger order, before going live, and drops any
overlap with the live hand-off by id. At most 500 events are replayed. If the
cursor is no longer in the event log, belongs to another voucher or clinic, or
has more than 500 events behind it, the server sends one `event: reset` frame
whose data is `{"type":"reset","reason":...}` instead; refetch the JSON routes
and reconnect with no cursor.
Nothing is read from the database to serve the stream, so it cannot become a
second way to walk the read model: it only reports what just happened.

Operationally: a frame is written only after the transaction that produced it
commits, so the stream cannot announce a state the API cannot yet serve; a
client that cannot drain what it is given is disconnected rather than allowed to
pin a write buffer in this process; idle streams emit a `: heartbeat` comment
every `SSE_HEARTBEAT_MS`; and one instance holds at most
`SSE_MAX_CONNECTIONS` streams, answering `503 stream_full` past that. Shutting
the server down ends the open streams instead of waiting on them. Because the
indexer and the streams have to share a process, the feed is live in combined
mode; in a split deployment an API-only process has nothing to subscribe to and
its streams only beat (see "Running the indexer and the API separately").

`GET /feed.xml` (also `/v1/feed.xml`) is the same activity for a feed reader
rather than a browser: an Atom 1.0 document of at most 20 entries, newest first,
made of settled vouchers — from the `Receipt` the chain minted, so the date is
the settlement rather than the row's last write — and clinics whose status
became `Active`, so a suspension never reads as a verification. Each entry links
to the JSON route that proves it (`/v1/vouchers/<id>`). It is the one route that
must never carry a beneficiary reference, because third-party readers poll,
cache and syndicate it beyond anyone's control, so it reads receipts through the
same serialiser `GET /receipts/:voucherId` uses. Clinic names come from the
on-chain registry and are XML-escaped on the way out.

## Response behaviour

List routes (`/vouchers`, `/vouchers/due`, `/providers`, `/receipts`) and
`/feed.xml` — which scans the same read model — are limited to 30 requests
per minute per client; other routes default to 120, while `/health` and `/ready`
are exempt so a struggling service can always be probed. JSON above 1 KB is
gzip-compressed when the client accepts it, and every response carries the
standard `@fastify/helmet` security headers (no CSP — this API serves JSON, not
HTML).

List and detail routes are cacheable for a short window, as is `/feed.xml` so a
reader that polls every minute costs one read per five seconds. They send
`Cache-Control: public, max-age=5, stale-while-revalidate=30` and a weak `ETag`
derived from the indexer's last ledger and the exact request URL, so a reload
with a matching `If-None-Match` gets `304 Not Modified` without the API touching
the read model. A newly indexed ledger changes every tag, and a different filter
is a different tag. `/health`, `/ready`, `/metrics` and `/openapi.json` are
`Cache-Control: no-store`, as is every error response. Nothing is cached
server-side, so any instance can validate a tag produced by another.

## TypeScript Client

A strongly typed TypeScript client workspace package `@sci-healthcare/client` is generated from the OpenAPI specification:

```bash
npm run client:generate
```

See [`../packages/client/README.md`](../packages/client/README.md) for installation and usage examples.

The package also ships a `sci` command-line client covering the same read
routes, for scripts and cron jobs:

```bash
npx --package @sci-healthcare/client sci stats
npx --package @sci-healthcare/client sci vouchers --provider GDOO... --status Funded
sci vouchers --funder GDUP... --json | jq -r '.vouchers[].id'   # table or JSON output
```

## Examples

- **Telegram Bot for Clinics**: [`../examples/telegram-bot/`](../examples/telegram-bot/README.md) demonstrates how clinic microservices verify `X-SCI-Signature` HMAC-SHA256 signatures on webhook notifications and post real-time voucher alerts without exposing patient/beneficiary data.

- **WhatsApp Notifier for Clinics**: [`../examples/whatsapp-notifier/`](../examples/whatsapp-notifier/README.md) sends the same alerts as approved WhatsApp Business Cloud API template messages, and documents the template-approval step that decides whether a send is accepted at all.
- **SMS Notifier for Clinics**: [`../examples/sms-notifier/`](../examples/sms-notifier/README.md) sends one short message per event through Africa's Talking — the channel that reaches feature phones — with the sandbox steps and the single-segment length rule the gateway actually bills against.

All three verify the signature over the raw request body before any message is
composed or sent, and refuse a payload that carries a beneficiary reference.

## Endpoints and Examples

### 1. Operations & System
- **`GET /health`**: Quick liveness probe.
  ```bash
  curl http://localhost:8080/health
  ```
  ```json
  { "status": "ok", "version": "0.2.0", "commit": "a1b2c3d", "uptimeSeconds": 3600 }
  ```
- **`GET /ready`**: Readiness probe checking database connectivity and indexer sync lag.
  ```bash
  curl http://localhost:8080/ready
  ```
  ```json
  { "status": "ok", "indexer": { "latestLedger": 4465530, "targetLedger": 4465530, "lag": 0 } }
  ```
- **`GET /version`**: Application version and git commit metadata.
  ```bash
  curl http://localhost:8080/version
  ```
  ```json
  { "version": "0.2.0", "commit": "44b3de9" }
  ```
- **`GET /metrics`**: Prometheus metrics for HTTP traffic, latency, and indexer state.
  ```bash
  curl http://localhost:8080/metrics
  ```
  ```text
  # HELP http_requests_total Total number of HTTP requests
  # TYPE http_requests_total counter
  http_requests_total{method="GET",route="/health",status="200"} 42
  ```

### 2. Healthcare Providers

Both provider responses carry a `metadata` object: the clinic's off-chain document (hours, phone, location), fetched once by the indexer, validated, and cached in the read model rather than re-fetched by every client. `metadata` is `null` until a document has been fetched. The pointer is a URI a clinic publishes on chain (contracts #10), so the document follows the schema below; anything else is ignored with the reason logged.

Beside it, `metadataStatus` reports the fetch state — `pending` after a pointer is announced, `ok` once a document is cached, `failed` when the last attempt was rejected — and `metadataError` carries a short code such as `unsupported_scheme`, `timeout`, `http_error`, `too_large`, `invalid_json` or `invalid_document`. The code is never the remote body, so a clinic can show it without leaking content it does not control. Both are `null` for a clinic that never published a pointer.

Pointers may be `http(s)` URLs or content-addressed `ipfs://<cid>` URIs. An IPFS pointer is resolved through `IPFS_GATEWAY_URL` (default `https://ipfs.io/ipfs`), with the CID and any path appended; the timeout and 64 KB cap apply unchanged. An unsupported scheme or malformed URL is recorded as `failed` with `unsupported_scheme`/`invalid_url` and is not retried until the clinic announces a new pointer; every other failure is retried after `PROVIDER_METADATA_TTL_MS` (default one day), with the stored `ETag` sent as `If-None-Match` so an unchanged document costs one `304`.

The document's JSON Schema is published at [`docs/provider-metadata.schema.json`](provider-metadata.schema.json) and served at **`GET /schemas/provider-metadata.json`**, so a clinic can validate a file before publishing it.

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | Optional; ≤200 chars |
| `address` | string | Optional; ≤300 chars |
| `location` | `{ lat, lng }` | Optional; bounded to valid coordinates. Accepted from `location` or `geo` in the source document, served as `location` |
| `hours` | string or object | Optional; a summary string or a per-day object |
| `phone` | string | Optional; ≤50 chars |
| `languages` | string[] | Optional; ≤20 entries |

The fetch is fenced in: http(s) or an `ipfs://` CID through the configured gateway, a 5s timeout, a 64KB cap counted off the stream (a declared `content-length` is checked first, not trusted), JSON only. A document that is invalid, oversized, unreachable or non-JSON is ignored with the reason logged and never fails the cycle; a failed refresh keeps the previously cached document.
- **`GET /v1/providers`**: List registered clinics with active services, filtered by status, country, or name search.
  ```bash
  curl "http://localhost:8080/v1/providers?status=Active&country=NG&limit=10"
  ```
  ```json
  {
    "total": 1,
    "providers": [
      {
        "address": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "name": "Ikeja General Clinic",
        "country": "NG",
        "status": "Active",
        "registeredAt": "2026-09-01T08:00:00.000Z",
        "metadataStatus": "ok",
        "metadataError": null,
        "metadata": {
          "name": "Ikeja General Clinic",
          "address": "12 Allen Avenue, Ikeja, Lagos",
          "location": { "lat": 6.5244, "lng": 3.3792 },
          "hours": { "mon": "08:00-17:00", "tue": "08:00-17:00" },
          "phone": "+2348012345678",
          "languages": ["en", "yo"]
        },
        "services": [
          { "code": 101, "label": "Outpatient consult", "price": "30000000", "priceDisplay": "3.0000000", "upcomingPrice": null, "upcomingFrom": null }
        ]
      }
    ]
  }
  ```
- **`GET /v1/providers/:address`**: Fetch details of a single provider by Stellar address.
  ```bash
  curl http://localhost:8080/v1/providers/GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK
  ```
  ```json
  {
    "address": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
    "name": "Ikeja General Clinic",
    "country": "NG",
    "status": "Active",
    "metadataStatus": "ok",
    "metadataError": null,
    "metadata": {
      "name": "Ikeja General Clinic",
      "address": "12 Allen Avenue, Ikeja, Lagos",
      "location": { "lat": 6.5244, "lng": 3.3792 },
      "hours": { "mon": "08:00-17:00", "tue": "08:00-17:00" },
      "phone": "+2348012345678",
      "languages": ["en", "yo"]
    },
    "services": [
      { "code": 101, "label": "Outpatient consult", "price": "30000000", "priceDisplay": "3.0000000", "upcomingPrice": null, "upcomingFrom": null, "active": true }
    ]
  }
  ```

- **`GET /v1/providers/:address/stats`**: Voucher counts by status, exact settled value, and clinic response times.
  ```bash
  curl http://localhost:8080/v1/providers/GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK/stats
  ```
  ```json
  {
    "address": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
    "name": "Ikeja General Clinic",
    "status": "Active",
    "vouchers": 3,
    "byStatus": { "Funded": 1, "Claimed": 1, "Attested": 0, "Settled": 1, "Disputed": 0, "Refunded": 0 },
    "settledVouchers": 1,
    "settledValue": "30000000",
    "settledValueDisplay": "3.0000000",
    "medianClaimSeconds": 3600,
    "medianAttestationSeconds": 7200
  }
  ```
  `medianClaimSeconds` measures `claimedAt - createdAt`;
  `medianAttestationSeconds` measures `attestedAt - claimedAt`. Both are in
  seconds and use this clinic's vouchers regardless of their current status.
  Each median independently excludes missing timestamps and negative intervals,
  and is `null` when no eligible interval exists. A zero duration is valid;
  an even sample averages its middle two values without rounding. Unknown
  providers return `404 provider_not_found`. The unversioned route is an alias.

- **`GET /v1/providers/:address/services`**: A clinic's price list as its own endpoint, so a price page does not have to fetch the whole provider record.
  ```bash
  curl "http://localhost:8080/v1/providers/GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK/services?active=true&sort=price&order=asc"
  ```
  ```json
  {
    "providerAddress": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
    "name": "Ikeja General Clinic",
    "total": 2,
    "services": [
      {
        "code": 101,
        "label": "Outpatient consult",
        "price": "30000000",
        "priceDisplay": "3.0000000",
        "active": true,
        "upcomingPrice": null,
        "upcomingFrom": null
      },
      {
        "code": 104,
        "label": "Lab panel",
        "price": "80000000",
        "priceDisplay": "8.0000000",
        "active": true,
        "upcomingPrice": "75000000",
        "upcomingFrom": "2026-12-01T00:00:00.000Z"
      }
    ]
  }
  ```
  `active=true` takes only the listed half of the catalogue and `active=false`
  only the delisted half; both by default. `sort=price` (the default) or
  `sort=code`, with `order=asc` (the default) or `desc`. Prices are compared as
  `i128` integers, so `"90000000"` sorts below `"30000000000"`, and equal prices
  always order by code ascending. `total` counts what the filters left, not what
  the clinic has ever listed. A clinic with no services is an empty list rather
  than a 404 — only an unknown clinic is `404 provider_not_found` — and an
  unknown filter value is `400 invalid_query`. The response is cacheable like the
  other read routes, and the unversioned route is an alias.

- **`GET /v1/providers` filters and ordering.** `serviceCode=101` lists only
  clinics with that service active, so a paused or delisted code is not an
  offering; it combines with `status`, `country` and `q`. `sort=name`,
  `registered` (the default, newest first) or `country`, with `order=asc|desc`
  (`asc` is the default for `name` and `country`, `desc` for `registered`). The
  ordering is encoded in `nextCursor`; passing that cursor to another sort or
  order answers `400 invalid_cursor` rather than paging a different column and
  skipping rows. Each ordering tie-breaks on the clinic address, so paging has
  no gaps or repeats.

### 3. Medical Services Catalog
- **`GET /v1/services`**: List all medical services offered across active providers.
  ```bash
  curl "http://localhost:8080/v1/services?provider=GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK"
  ```
  ```json
  {
    "services": [
      {
        "code": 101,
        "label": "Outpatient consult",
        "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "price": "30000000",
        "priceDisplay": "3.0000000",
        "active": true
      }
    ]
  }
  ```
- **`GET /v1/services/:code`**: Look up active offerings for a standard service code.
  ```bash
  curl http://localhost:8080/v1/services/101
  ```
  ```json
  {
    "code": 101,
    "providers": [
      {
        "address": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "name": "Ikeja General Clinic",
        "price": "30000000",
        "priceDisplay": "3.0000000",
        "upcomingPrice": null,
        "upcomingFrom": null
      }
    ]
  }
  ```
  `price` is what the service costs at the moment of the request. A clinic that
  scheduled a price with notice (`schedule_service_price` on the registry) reports
  it in `upcomingPrice`, with the instant it takes effect in `upcomingFrom`; from
  that instant the scheduled amount is `price` and both fields are `null` again,
  because the contract swaps them on the next read and publishes no event — the
  read model resolves it by time instead (`scheduledPriceOf()`, #315). The same
  pair appears on every service entry of `GET /providers`, `GET /providers/:address`,
  `GET /providers/:address/services` and the `?include=provider` embeds, and
  `GET /services` prices its min/max/median band with the schedule already applied.

- **`GET /v1/services` search, price range and ordering.** `q` keeps services
  with a label containing it, case-insensitively, 1–64 characters. `minPrice`
  and `maxPrice` are base-unit decimal strings and are compared with `BigInt`,
  never as JavaScript numbers, so values above 2^53 stay exact. A service is in
  range when its clinic price band overlaps the request: `maxPrice` acts as a
  budget (some clinic charges at or below it) and `minPrice` as a floor (some
  clinic charges at or above it). `sort=code` (the default), `price` (cheapest
  clinic first) or `label`, with `order=asc` (the default) or `desc`; price and
  label ties order by code. Malformed or reversed price bounds and unknown sort
  values are `400 invalid_query`.

### 4. Vouchers & Protocol Statistics
- **`GET /v1/vouchers`**: Filter vouchers by funder, provider, beneficiary reference, or status.
  ```bash
  curl "http://localhost:8080/v1/vouchers?status=Funded&limit=10"
  ```
  ```json
  {
    "total": 1,
    "vouchers": [
      {
        "id": "1",
        "funder": "GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45",
        "beneficiaryRef": "72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745",
        "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "serviceCode": 101,
        "amount": "30000000",
        "amountDisplay": "3.0000000",
        "status": "Funded",
        "createdAt": "2026-09-02T10:00:00.000Z",
        "expiresAt": "2026-09-09T10:00:00.000Z"
      }
    ]
  }
  ```
- **`GET /v1/vouchers/:id`**: Get full state and current lifecycle status of a voucher.
  ```bash
  curl http://localhost:8080/v1/vouchers/1
  ```
  ```json
  {
    "id": "1",
    "funder": "GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45",
    "beneficiaryRef": "72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745",
    "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
    "serviceCode": 101,
    "amount": "30000000",
    "amountDisplay": "3.0000000",
    "status": "Funded",
    "createdAt": "2026-09-02T10:00:00.000Z",
    "expiresAt": "2026-09-09T10:00:00.000Z"
  }
  ```
- **`GET /v1/vouchers/:id/events`**: Chronological event history for a voucher.
  ```bash
  curl http://localhost:8080/v1/vouchers/1/events
  ```
  ```json
  {
    "events": [
      {
        "type": "VoucherCreated",
        "ledger": 4465529,
        "timestamp": "2026-09-02T10:00:00.000Z",
        "txHash": "abc123def456"
      }
    ]
  }
  ```
- **`GET /v1/vouchers/due`**: Unredeemed vouchers nearing expiration.
  ```bash
  curl "http://localhost:8080/v1/vouchers/due?withinHours=24"
  ```
  ```json
  {
    "total": 1,
    "vouchers": [
      { "id": "1", "status": "Funded", "expiresAt": "2026-09-03T10:00:00.000Z" }
    ]
  }
  ```
- **`GET /v1/vouchers.csv`**: Export voucher records as standard CSV for donor reporting and accounting.
  ```bash
  curl -o vouchers.csv "http://localhost:8080/v1/vouchers.csv?funder=GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45"
  ```
- **`GET /v1/stats`**: High-level protocol metrics including total volume and voucher counters.
  ```bash
  curl http://localhost:8080/v1/stats
  ```
  ```json
  {
    "vouchers": { "funded": 100, "redeemed": 85, "cancelled": 5, "expired": 10 },
    "volumeTotal": "3000000000",
    "volumeDisplay": "300.0000000"
  }
  ```

### 5. Care Receipts
- **`GET /v1/receipts`**: List anonymized care receipts minted on redemption.
  ```bash
  curl "http://localhost:8080/v1/receipts?provider=GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK&limit=10"
  ```
  ```json
  {
    "total": 1,
    "receipts": [
      {
        "id": "1",
        "voucherId": "1",
        "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
        "serviceCode": 101,
        "amount": "30000000",
        "mintedAt": "2026-09-02T14:30:00.000Z"
      }
    ]
  }
  ```
- **`GET /v1/receipts/:id`**: Get care receipt by id.
  ```bash
  curl http://localhost:8080/v1/receipts/1
  ```
  ```json
  {
    "id": "1",
    "voucherId": "1",
    "provider": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK",
    "serviceCode": 101,
    "amount": "30000000",
    "mintedAt": "2026-09-02T14:30:00.000Z"
  }
  ```

### 6. Governance & Protocol Administration
- **`GET /v1/governance/proposals`**: List DAO proposals and voting states.
  ```bash
  curl "http://localhost:8080/v1/governance/proposals?status=Active"
  ```
  ```json
  {
    "proposals": [
      {
        "id": 1,
        "title": "Add Nairobi Health Clinic",
        "status": "Active",
        "yesVotes": "50000000",
        "noVotes": "0"
      }
    ]
  }
  ```
- **`GET /v1/governance/proposals/:id`**: Detailed proposal votes and execution target.
  ```bash
  curl http://localhost:8080/v1/governance/proposals/1
  ```
  ```json
  {
    "id": 1,
    "title": "Add Nairobi Health Clinic",
    "status": "Active",
    "proposer": "GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45"
  }
  ```
- **`GET /v1/governance/history`**: Admin actions and parameter updates log.
  ```bash
  curl http://localhost:8080/v1/governance/history
  ```
  ```json
  {
    "history": [
      { "action": "ProviderApproved", "target": "GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK", "ledger": 4465520 }
    ]
  }
  ```

### 7. Real-Time Server-Sent Events (SSE)
- **`GET /v1/stream`**: Real-time event stream subscribing to voucher and protocol events.
  ```bash
  curl -N "http://localhost:8080/v1/stream?voucher=1"
  ```
  ```text
  event: voucher_update
  data: {"id":"1","status":"Redeemed","updatedAt":"2026-09-02T14:30:00.000Z"}
  ```

### 8. Atom Feed
- **`GET /v1/feed.xml`**: The latest protocol activity for a feed reader — settled vouchers and newly verified clinics, newest first, 20 at most. No beneficiary reference appears anywhere in the document.
  ```bash
  curl -H "Accept: application/atom+xml" http://localhost:8080/v1/feed.xml
  ```
  ```xml
  <?xml version="1.0" encoding="utf-8"?>
  <feed xmlns="http://www.w3.org/2005/Atom">
    <id>urn:sci-healthcare:activity</id>
    <title>SCI Healthcare protocol activity</title>
    <updated>2026-10-21T09:00:00.000Z</updated>
    <link rel="self" type="application/atom+xml" href="/v1/feed.xml"/>
    <author><name>SCI Healthcare</name></author>
    <entry>
      <title>Voucher 12 settled at Kigali Care Centre</title>
      <link rel="alternate" type="application/json" href="/v1/vouchers/12"/>
      <id>urn:sci-healthcare:voucher-settled:12</id>
      <updated>2026-10-21T09:00:00.000Z</updated>
      <content type="text">Care voucher 12 settled at Kigali Care Centre, Antenatal visit for 30000000 base units (3.0000000).</content>
    </entry>
  </feed>
  ```

Amounts are `i128` on chain and are returned as **decimal strings**. Parsing one into a JavaScript number loses precision above 2^53 — use `BigInt`.

`GET /stats/daily` returns one row per bucket, oldest first, and includes
periods with no activity as zeros so a chart never has to fill gaps (pass
`fill=false` for only the periods with a row). `granularity=day` (default)
buckets per UTC day, `week` per ISO 8601 week starting Monday in UTC, and
`month` per calendar month; a bucket's `date` is its first day. Each row is
`{ date, funded, settled, refunded }`, where each bucket is `{ count, amount }`
and `amount` is exact base units, summed with `BigInt`. Funded is bucketed by
voucher `createdAt`, settled by receipt `settledAt`, and refunded by a voucher's
`refundedAt`.

`GET /stats/funnel` returns `counts` for funded, claimed, attested and settled
vouchers plus `medianHours` for `fundedToClaimed`, `claimedToAttested` and
`attestedToSettled`. Pass a two-letter `country` code or a clinic's `clinic`
address to scope the results; both filters can be combined. Medians exclude
missing or reversed timestamps and are `null` when a stage has no complete
intervals. Settlement times come from receipt records.

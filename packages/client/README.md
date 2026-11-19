# @sci-healthcare/client

Typed TypeScript client for the SCI Healthcare indexer and API on Stellar.

## Overview

This package provides a type-safe API client and TypeScript models generated from the backend OpenAPI specification (`/openapi.json`). It guarantees that frontend consumers, test suites, and external integrations stay in sync with the backend read models and routes.

## Installation

```bash
npm install @sci-healthcare/client
```

Or within the workspace:

```json
{
  "dependencies": {
    "@sci-healthcare/client": "*"
  }
}
```

## Quick Start

```typescript
import { createClient } from '@sci-healthcare/client';

const client = createClient({
  baseUrl: process.env.API_URL || 'https://api.example.com',
});

// Fetch system health & stats
const health = await client.health();
const stats = await client.stats();

// Query clinics with type-safe filters
const { providers } = await client.providers({
  status: 'Active',
  country: 'KE',
  limit: 20,
});

// Retrieve voucher details
const voucher = await client.voucher('0001');

// Query care receipts by beneficiary HMAC reference
const receipts = await client.receipts({
  beneficiaryRef: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
});
```

## Live voucher stream

`GET /stream` is forwarded by `client.stream()`, which keeps the connection
open for you: it reconnects with a jittered exponential backoff, notices a
socket that died quietly, and resumes from the last event id the server framed.

```typescript
import { createClient } from '@sci-healthcare/client';

const client = createClient({ baseUrl: process.env.API_URL });

// Exactly one filter, like the route: a voucher, or a clinic.
const stream = client.stream(
  { provider: 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK' },
  {
    onEvent: (event) => {
      // { type, voucherId, providerAddress, status, ledger, txHash, at }
      console.log(`${event.voucherId} is now ${event.status} on ledger ${event.ledger}`);
    },
    onOpen: () => console.log('streaming'),
    onReconnect: ({ attempt, delayMs }) => console.warn(`reconnecting #${attempt} in ${delayMs}ms`),
    onError: (error, { fatal }) => console.error(error, { fatal }),
  },
);

// Later: stops reconnecting and abandons the open connection.
stream.close();
await stream.done;
```

It runs on `fetch` rather than `EventSource`, so the same call works in a
browser and on Node 22, and so a reconnect can carry the `Last-Event-ID`
header that `EventSource` cannot set from application code.

Two things a caller must know:

- **A gap is possible.** The backend frames no SSE `id:`, so `stream.lastEventId`
  stays `null` and events that happened while disconnected are not replayed.
  Treat the stream as a signal to re-read the JSON routes rather than as a
  complete log; frames are only written after the transaction that produced
  them commits, so those routes are never behind the last event delivered.
- **The feed is live in a combined process.** Where the indexer runs separately
  from the API, that API process has nothing to subscribe to and its streams
  only beat, so the heartbeat timeout reconnects on a loop. Set
  `{ heartbeatTimeoutMs }` above the server's `SSE_HEARTBEAT_MS` (15s default),
  and point the client at a process that indexes.

`onError` fires for every dropped connection and malformed frame; only a
`{ fatal: true }` error closes the handle. A server that answers the stream
with `400`, `401`, `403` or `404` is fatal, because reconnecting identically
would be a loop rather than a retry. A `503 stream_full` is not: it means the
instance is holding its `SSE_MAX_CONNECTIONS` and is worth trying again.

## Command-line interface

The package also ships a `sci` binary, so the same routes are usable from
shell scripts and cron jobs without writing HTTP code:

```bash
# one-off, without installing anything
npx --package @sci-healthcare/client sci stats
npx --package @sci-healthcare/client sci vouchers --provider GDOO... --status Funded

# or install it once
npm install --global @sci-healthcare/client
sci vouchers --funder GDUP... --sort expiresAt --order asc
```

Every command mirrors one read route:

| Command | Route |
| --- | --- |
| `sci health` / `sci ready` / `sci version` | `GET /health`, `/ready`, `/version` |
| `sci stats` | `GET /stats` |
| `sci stats-daily [--days n]` | `GET /stats/daily` |
| `sci providers [--status --country --q]` | `GET /providers` |
| `sci provider <address>` | `GET /providers/:address` |
| `sci provider-stats <address>` | `GET /providers/:address/stats` |
| `sci provider-history <address>` | `GET /providers/:address/history` |
| `sci provider-service-history <address> <code>` | `GET /providers/:address/services/:code/history` |
| `sci attesters [--all]` / `sci attester <address>` | `GET /attesters`, `/attesters/:address` |
| `sci services` / `sci service <code>` / `sci countries` | `GET /services`, `/services/:code`, `/countries` |
| `sci vouchers [--funder --provider --beneficiary-ref --status]` | `GET /vouchers` (one filter required, like the API) |
| `sci voucher <id>` / `sci voucher-events <id>` | `GET /vouchers/:id`, `/vouchers/:id/events` |
| `sci vouchers-due [--within 72h]` | `GET /vouchers/due` |
| `sci vouchers-csv [filters]` | `GET /vouchers.csv` (prints CSV) |
| `sci receipts (--beneficiary-ref \| --provider)` / `sci receipt <voucherId>` | `GET /receipts`, `/receipts/:voucherId` |
| `sci governance` | `GET /governance` |

Output is an aligned table by default and raw JSON with `--json`, so it is
both readable and pipeable:

```bash
sci stats --json | jq '.vouchers'
sci vouchers --provider GDOO... --json | jq -r '.vouchers[].id'
```

The API base URL is `--base-url <url>`, falling back to `SCI_API_URL`, then
`API_URL`, then `http://localhost:8080`. Exit codes: `0` success, `1` the
API or the network failed, `2` the command line was wrong. `sci <command>
--help` shows the flags for one command.

## Error Handling

All HTTP and API validation errors are mapped to `ApiError`:

```typescript
import { ApiError } from '@sci-healthcare/client';

try {
  await client.vouchers({ minAmount: '100', maxAmount: '50' });
} catch (err) {
  if (err instanceof ApiError) {
    console.error(`API Error ${err.status} [${err.error}]: ${err.message}`);
    console.error('Validation issues:', err.issues);
  }
}
```

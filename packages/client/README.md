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

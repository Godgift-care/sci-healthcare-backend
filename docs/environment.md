# Environment

Every variable the service reads. The Zod schema in `src/env.ts` is the source of truth and the process refuses to start when a required variable is missing; `src/__tests__/env-docs.test.ts` fails when this table and the schema drift apart.

[Back to the README](../README.md).

| Variable | Required | Default | Example | What it does |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | `production` | Deployment environment; `production` rejects the wildcard `CORS_ORIGIN` `*` |
| `PORT` | No | `8080` | `8080` | HTTP port the API listens on |
| `HOST` | No | `0.0.0.0` | `0.0.0.0` | Address the API binds to |
| `LOG_LEVEL` | No | `info` | `info` | pino log level: `fatal`, `error`, `warn`, `info`, `debug` or `trace` |
| `CORS_ORIGIN` | No | `http://localhost:3000` | `https://sci-healthcare.vercel.app` | Comma-separated origins allowed to call the API |
| `MAINTENANCE_MODE` | No | `false` | `true` | When `true`, every data route answers 503 with `Retry-After`; `/health` stays 200 (used during database restore) |
| `READY_MAX_LAG_LEDGERS` | No | `120` | `120` | Indexer lag in ledgers at which `/ready` reports degraded (503) |
| `READY_WEBHOOK_MAX_AGE_MS` | No | `900000` | `900000` | Age at which a pending webhook delivery makes `/ready` report a backlog and answer 503 |
| `DATABASE_URL` | Yes | — | `file:./dev.db` | Database connection string. SQLite paths resolve **relative to `prisma/`**; production uses a Postgres URL |
| `DATABASE_POOL_SIZE` | No | — | `5` | Maximum Postgres connection pool size; applied via `connection_limit` parameter on Postgres URLs, ignored on SQLite |
| `DATABASE_STATEMENT_TIMEOUT_MS` | No | — | `10000` | Maximum Postgres query execution time in milliseconds; applied via `statement_timeout` parameter on Postgres URLs, ignored on SQLite |
| `IPFS_GATEWAY_URL` | No | `https://ipfs.io/ipfs` | `https://gateway.pinata.cloud/ipfs` | Base URL of the gateway used to resolve `ipfs://<cid>` provider metadata pointers. The CID and path are appended to it; only http(s) gateways are accepted |
| `PROVIDER_METADATA_TTL_MS` | No | `86400000` | `86400000` | How long a cached provider metadata document is trusted before the refresh pass re-requests it. The request is conditional on the stored ETag, so an unchanged document costs one `304` |
| `EVENT_RETENTION_DAYS` | No | `0` | `365` | Prune `ContractEvent` log rows older than this many days, in batches, for vouchers in a final status (`Settled`, `Refunded`) and for events that belong to no voucher. History of open vouchers is never pruned. `0` (default) keeps the log forever |
| `STELLAR_NETWORK` | No | `testnet` | `testnet` | Stellar network: `testnet`, `public` or `futurenet` |
| `SOROBAN_RPC_URL` | No | — | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint (used when `SOROBAN_RPC_URLS` is unset) |
| `SOROBAN_RPC_URLS` | No | — | `https://rpc-a.example,https://rpc-b.example` | Comma-separated endpoints, tried in order on repeated failure |
| `SOROBAN_RPC_MAX_FAILURES` | No | `3` | `3` | Consecutive failures against one endpoint before switching |
| `NETWORK_PASSPHRASE` | Yes | — | `Test SDF Network ; September 2015` | Network passphrase used when building contract-read simulations |
| `REGISTRY_CONTRACT_ID` | Yes | — | `CAMU635NRFEHATJ6MTY5SI43IAZ43KHPFXAQDQAST2AHKCHLSGWHVE4V` | Clinic registry contract id; indexed for providers and admin history |
| `VOUCHER_CONTRACT_ID` | Yes | — | `CBPUQN6CNJCNGPKNEXB7UM4T7RINKQB7HQI5CXEOSQ5EFRHE4G4VKPSQ` | Voucher escrow contract id; indexed for vouchers |
| `RECEIPT_CONTRACT_ID` | Yes | — | `CBCJRI2BCZBMZNX77WWDC2NGSV4ZNAN5Q23XHYNBH6UTOQMPJHZGX5C7` | Care-receipt contract id; indexed for minted receipts |
| `USDC_CONTRACT_ID` | No | — | `CCRLJ7FEIKTR3GBT3VQQPSIJGRBO2WPNMVFKJDP6AYGJQWECOR4QVE5M` | Optional settlement-token (USDC) contract id, validated when set |
| `FAUCET_CONTRACT_ID` | No | — | `CCB25WG7DQ2CSNXPTOHZO2PDZ324FQPZLH3LSNCCLWYM3FEH52GEXC47` | Testnet demo faucet; optional, drips counted in `/stats` when set |
| `DEPLOYMENTS` | No | — | `[{"type":"registry","contractId":"C...","fromLedger":123}]` | Optional JSON array of previous contract deployments for redeployment support |
| `INDEXER_START_LEDGER` | No | `0` | `4465529` | Ledger to index from; `0` means start at the current tip and skip prior history |
| `INDEXER_POLL_MS` | No | `5000` | `5000` | Milliseconds between indexer polls once caught up |
| `RECONCILE_INTERVAL_MS` | No | — | `3600000` | Optional interval in milliseconds for lease-holder reconciliation passes; unset disables automatic reconciliation, and each pass checks at most 100 non-terminal vouchers plus 25 terminal samples |
| `INDEXER_BACKOFF_MAX_MS` | No | `60000` | `60000` | Ceiling for the backoff applied after RPC failures |
| `SHUTDOWN_TIMEOUT_MS` | No | `15000` | `15000` | How long SIGTERM/SIGINT waits for the indexer cycle in flight before the process hard-exits |
| `SSE_HEARTBEAT_MS` | No | `15000` | `15000` | Idle interval between `: heartbeat` comments on `GET /stream` |
| `SSE_MAX_CONNECTIONS` | No | `64` | `64` | Concurrent `GET /stream` connections one process will hold; past that the route answers `503 stream_full` |
| `STATS_MIN_CELL` | No | `5` | `5` | Minimum voucher count per reporting cell for `GET /countries` and scoped `GET /stats/funnel` calls. Cells with a non-zero count below this threshold are suppressed (returned as `null`). Set to `0` to disable suppression |
| `WEBHOOK_URLS` | No |  | `https://clinic.example/hooks` | Comma-separated endpoints sent a signed notification for each voucher event; blank (the default) disables webhooks |
| `WEBHOOK_SECRET` | No |  | `a-long-random-string` | HMAC-SHA256 key for the `X-SCI-Signature` header; blank by default, required (min 16 characters) when `WEBHOOK_URLS` is set |

Set `INDEXER_START_LEDGER` to the deployment ledger. Leaving it at `0` starts at the current tip and silently skips all prior history. Soroban RPC also only retains a rolling window of ledgers (about 7 days on testnet) — an indexer that falls further behind than the window cannot catch up, and `/ready` will say so rather than pretend otherwise.

`READY_MAX_LAG_LEDGERS` (default `120`, about ten minutes at five seconds a ledger) is where `/ready` flips from 200 to 503. A free-tier demo can tolerate a much larger window than production, so tune it per deployment. `GET /ready` echoes it as `checks.maxLagLedgers`.

Pause and resume the indexer without changing environment variables or
redeploying:

```bash
npm run indexer:pause
npm run indexer:resume
```

Pausing preserves the cursor and applies no events. `/ready` returns `503`
with `checks.indexer: "paused"` until indexing resumes. A read-model snapshot
can be moved to a new, empty migrated database with:

```bash
npm run snapshot:export -- --out sci-healthcare-snapshot.json.gz
npm run snapshot:import -- --file sci-healthcare-snapshot.json.gz
```

Snapshots include every table and the cursor, restore dates and 64-bit voucher
sequence values, and refuse to write into a non-empty database.

`READY_WEBHOOK_MAX_AGE_MS` (default `900000`, fifteen minutes) is the same idea for the webhook outbox: a delivery that has been pending longer than that makes `/ready` answer 503 with `checks.webhooks.state: "backlog"`. Every retry of a reachable endpoint resolves inside the backoff ceiling (six attempts within a few minutes), so an older row means the delivery loop is not draining, not that a clinic's endpoint is slow. With `WEBHOOK_URLS` unset the check reports `state: "disabled"` and never degrades.

`SOROBAN_RPC_URLS` is the failover list. Set it to two endpoints and an outage at the first one costs a few failed reads rather than an indexing stall; with one endpoint (or only `SOROBAN_RPC_URL` set) the behaviour is exactly as before. `GET /version` reports every configured endpoint and `GET /ready` reports the active one, both with any credentials redacted.

`SSE_HEARTBEAT_MS` and `SSE_MAX_CONNECTIONS` bound the live stream. The
heartbeat is what keeps an idle stream from being cut off by a proxy between the
client and the instance, so lower it only if the proxy timeout is lower;
15 seconds is comfortably inside the ~60 seconds Render and most CDNs allow.
The connection cap is a memory guard, not a security control: each open stream
is a socket and a subscription held for as long as the client keeps it, so
`SSE_MAX_CONNECTIONS` is how many the process will hold before answering
`503 stream_full`. A client that hits the cap retries — which is why
`GET /stream` is best-effort by design and the JSON routes stay the source of
truth. A free-tier instance with a handful of dashboards does not need many.

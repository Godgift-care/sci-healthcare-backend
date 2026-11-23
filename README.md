<p align="center">
  <a href="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/ci.yml">
    <img src="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/monitor.yml">
    <img src="https://github.com/Godgift-care/sci-healthcare-backend/actions/workflows/monitor.yml/badge.svg" alt="Uptime monitor" />
  </a>
  <img src="https://img.shields.io/badge/node-22-green" alt="node 22" />
  <img src="https://img.shields.io/badge/fastify-5.12-black" alt="fastify" />
  <img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="Apache 2.0" />
</p>

# SCI Healthcare — Indexer &amp; API | [Documentation](https://godgift-care.github.io/sci-healthcare-contracts/) | [Privacy Policy](docs/privacy.md)

> **Live:** [App](https://sci-healthcare.vercel.app) · [API](https://sci-healthcare-api.onrender.com/stats) · [Docs](https://godgift-care.github.io/sci-healthcare-contracts/) · [Privacy](docs/privacy.md) · [Contracts on testnet](https://stellar.expert/explorer/testnet/contract/CBPUQN6CNJCNGPKNEXB7UM4T7RINKQB7HQI5CXEOSQ5EFRHE4G4VKPSQ)
>
> The API runs on Render's free tier and sleeps after ~15 minutes idle; the first
> request may take 30–60 seconds to wake it.

Indexes Soroban contract events from the [SCI Healthcare care-voucher protocol](https://github.com/Godgift-care/sci-healthcare-contracts) into a queryable read model, and serves it over a read-only HTTP API.

The ledger is the source of truth. This service exists because a ledger cannot answer "show me every voucher this clinic is waiting on" without scanning it. Everything here is a projection: delete the database, replay from the deploy ledger, and you get the same rows back.

<p align="center">
  <a href="https://render.com/deploy?repo=https://github.com/Godgift-care/sci-healthcare-backend">
    <img src="https://render.com/images/deploy-to-render-button.svg" alt="Deploy to Render" />
  </a>
</p>

One click provisions the web service and its Postgres instance in the same
region, with every contract id already set. The only value you add by hand is
`CORS_ORIGIN`, once the frontend URL exists.

## Maintainers

<table align="center">
  <tr>
    <td align="center">
      <img src="https://github.com/adelekevat.png" width="140" alt="Maintainer" />
      <br /><br />
      <strong>Adeleke | Backend &amp; Indexer</strong>
      <br /><br />
      <a href="https://github.com/adelekevat">adelekevat</a>
    </td>
  </tr>
</table>

## Two properties worth stating up front

**It holds no keys and signs nothing.** Every state change in this protocol is a transaction signed in the user's wallet and submitted straight to Soroban RPC by the browser. This service is not in the write path. There is no custody here to steal.

**It stores no patient data.** The only patient-linked value is `beneficiaryRef`, an opaque 32-byte HMAC computed in the user's browser under a key that never leaves it. Nothing is written here that is not already public on chain, so a database breach is not a health-data breach.

## Architecture

```
  Soroban RPC ──getEvents──> Indexer ──> SQLite / Postgres ──> Fastify (read-only)
                             (cursor,                                   │
                              idempotent                                ▼
                              upserts)                              Frontend
```

The indexer polls on an interval, applies each event to the read model, and only then advances its cursor — so a crash mid-batch replays rather than skips. Handlers are idempotent upserts keyed by on-chain id, which makes replay safe.

The cursor is guarded by a lease (stored on `IndexerState`). However many indexer processes are running, exactly one holds the lease and advances the cursor; the others log that they are standing by and retry. Events are idempotent, but the cursor is not — two writers can skip events by advancing it from a stale read — which is the race the lease exists to prevent.

When the RPC fails, the indexer backs off exponentially (with jitter, up to `INDEXER_BACKOFF_MAX_MS`) instead of retrying every poll interval, and reports the failure once per streak rather than once per attempt — retrying at full speed adds load exactly where it hurts and buries every other log line. Configure more than one endpoint in `SOROBAN_RPC_URLS` and repeated failures move reads to the next one; the active endpoint is logged on each switch and reported as `checks.rpcUrl` on `/ready`.

On `SIGTERM` (every Render deploy) or `SIGINT`, the indexer stops scheduling new cycles, waits for the cycle in flight to commit its transaction and save the cursor (bounded by `SHUTDOWN_TIMEOUT_MS`), then releases the lease so the replacement instance can take over immediately. The process then closes the HTTP server and the database connection, with a hard exit as a backstop. If the cycle overruns the timeout the lease is deliberately left to expire rather than freed, so a peer cannot race a cycle that may still be committing.

See [docs/architecture.md](docs/architecture.md) for the full walkthrough: the paging and decode stages, the cursor and lease model, idempotency rules, and each failure mode with what to do about it.

## Quick start

```bash
git clone https://github.com/Godgift-care/sci-healthcare-backend
cd sci-healthcare-backend
npm install
cp .env.example .env          # fill in the contract ids below
npx prisma generate
npx prisma db push
npm run dev
```

### Quick start with Docker

`docker compose up` builds the API, starts Postgres, applies the schema and
serves a working indexing API on `http://localhost:8080`. It ships the current
testnet contract ids, so nothing has to be filled in first.

```bash
docker compose up
curl http://localhost:8080/health   # {"status":"ok"}
curl http://localhost:8080/ready    # 200 once the indexer catches up
```

`INDEXER_START_LEDGER` is `0` in compose, which starts at the current ledger tip
so `/ready` goes green in seconds. Set it to the deployment ledger to backfill
history instead — but note Soroban RPC only retains a rolling window of ledgers.

The image runs as the unprivileged `node` user. Override any environment value
(for example `CORS_ORIGIN` or the contract ids) by exporting it or adding a
`.env` file beside `docker-compose.yml`.

## Documentation

| Read it when | |
| --- | --- |
| You are calling the API | [API reference and endpoint list](docs/api-reference.md) · [Webhooks](docs/webhooks.md) |
| You are deploying or configuring an instance | [Environment](docs/environment.md) · [Deployment and operations runbook](docs/RUNBOOK.md) |
| You are reading or changing the read model | [Architecture](docs/architecture.md) · [Data dictionary](docs/data-dictionary.md) |
| You are tracing a slow request or cycle | [Tracing (OpenTelemetry)](docs/tracing.md) |
| You want to know what data this holds | [Privacy policy](docs/privacy.md) · [API versioning policy](docs/api-policy.md) |
| You are contributing | [CONTRIBUTING.md](CONTRIBUTING.md) |

## Running the indexer and the API separately

One process runs both by default (`npm start`). That is the right shape for a
single small deployment: fewer moving parts, and the one-click Render blueprint
assumes it.

Split them when the API and the indexer have different scaling or failure needs
— bursty API traffic alongside steady indexing, or more than one API replica.
The entry points are:

```bash
npm run start:api        # HTTP API only, no indexer
npm run start:indexer    # indexer only, no HTTP server
```

In development, `npm run dev:api` and `npm run dev:indexer` are the same split
with a watch loop. The indexer holds the cursor lease, so extra replicas are
safe: one indexes, the others log standby and retry. That also means combined
mode can be scaled to several replicas without racing — but it wastes the
standby replicas, which is the case for splitting.

`render.yaml` carries a commented two-service example. A background worker
needs a paid instance type, so the free-tier blueprint stays combined.

## Deploying

Suited to a platform that runs long-lived processes with a database attached, such as Render.

- Runtime: Node 22
- Build: `npm ci && npx prisma generate && npm run build`
- Start: `npm run db:migrate && npm start` (or `npm run start:api` / `npm run start:indexer` when split)
- Run `./scripts/use-postgres.sh` before `prisma generate` to switch the schema from `sqlite` to `postgresql`
- Provision the database in the **same region** and use its internal connection string
- Before the first mainnet request, work through [docs/mainnet-checklist.md](docs/mainnet-checklist.md): configuration, database and migrations, backups, capacity, monitoring and rollback, each item paired with the command or setting that verifies it. `src/__tests__/mainnet-checklist.test.ts` fails if the checklist names a variable, script, route or file that no longer exists

### Schema changes and migrations

Local development uses SQLite and `npx prisma db push`; nothing to do there. Production uses Postgres and **versioned migrations** in `prisma/migrations/`, applied on every start by `npm run db:migrate` (`prisma migrate deploy`).

To change the schema:

1. Edit `prisma/schema.prisma` (keep `provider = "sqlite"` in the committed file).
2. Against a scratch Postgres, run `./scripts/use-postgres.sh`, then `npx prisma migrate dev --name <change>`, and restore the provider to `sqlite` (`git checkout -p prisma/schema.prisma`, or edit it back).
3. Commit the new `prisma/migrations/<timestamp>_<change>/` directory with the schema change.

CI applies every migration to a fresh Postgres and then runs `prisma migrate diff`, failing the build if the schema and the migrations disagree.

**Existing database created with `db push`:** the first migration creates tables that already exist, so mark it as applied once, then deploy normally:

```bash
npx prisma migrate resolve --applied 20260101000000_init
npm run db:migrate
```

A new, empty database needs nothing special.

### Self-hosting on a VPS

[docs/self-hosting.md](docs/self-hosting.md) runs the same service on one
server with `deployments/docker-compose.prod.yml`: Postgres, a one-shot migration service,
the API, and Caddy for TLS. Use it when the indexer must not sleep — the
`docker-compose.yml` in this repo is the local dev stack, and Render's free
tier spins the process down after ~15 minutes idle.

## Operations

- **Rate limiting**: every IP is allowed 120 requests per minute on cheap routes and 30 per minute on list routes. Each response carries the IETF draft RateLimit headers (`RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`) so clients can throttle themselves before hitting the limit. The headers are exposed via CORS so browser clients can read them. `GET /metrics` is exempt from rate limiting.
- **Metrics**: `GET /metrics` is Prometheus text (not rate limited). `ops/grafana-dashboard.json` is a ready-made Grafana dashboard (import it, pick your Prometheus datasource) with panels for request rate, latency, error rate, indexer lag, seconds since the last successful poll, events applied/skipped and the webhook backlog; a test keeps it in sync with `src/lib/metrics.ts`. Alert on `indexer_lag_ledgers` and `indexer_seconds_since_success`; both are set by the process running the indexer. `stream_connections` is the number of `GET /stream` clients this process is holding, so `rate-limited`-looking `503 stream_full` responses can be seen before they happen; it only moves in the process that serves the streams (combined mode, or the API in a split deployment). `webhook_deliveries_pending` and `webhook_deliveries_abandoned` are the outbox backlog, refreshed by the process running the delivery loop, and are the series `/ready` reports as `checks.webhooks`.
- **Alerts**: `ops/alerts.yml` holds the Prometheus rules that should page someone — indexer lag past `READY_MAX_LAG_LEDGERS`, an indexer that has not completed a poll in five minutes, failed projections, a 5xx rate above 5%, and a webhook backlog that never drains. Load it with `rule_files:` in Prometheus (or as a `PrometheusRule`); CI validates it with `promtool check rules` in the `alerts` job, and `src/__tests__/alerts.test.ts` fails if a rule references a metric the service does not serve. Thresholds and what each alert means are commented in the file.
- **Logs**: Render's log explorer keeps a short window, so incident forensics need a stream to somewhere searchable. See [docs/logging.md](docs/logging.md) for the fields worth indexing, the Better Stack and Axiom recipes, and an end-to-end check that one request is one line.
- **Tracing**: with `OTEL_EXPORTER_OTLP_ENDPOINT` set, the OpenTelemetry SDK starts and emits spans for HTTP routes, Prisma queries, Soroban RPC calls and indexer cycles; unset means no tracing at all. See [docs/tracing.md](docs/tracing.md).
- **Dependency review**: `.github/workflows/dependency-review.yml` reviews the dependencies a pull request adds or bumps and fails it on a high or critical advisory. It complements the `audit` job, which runs `npm audit --omit=dev` over the whole lockfile; this one only looks at the diff, so a bad package is caught in the pull request that introduces it. It needs the repository's dependency graph, which a maintainer enables under **Settings → Code security and analysis → Dependency graph**; until then the job reports a warning naming that setting instead of failing every pull request, and starts reviewing as soon as it is on.
- **Docs links**: `.github/workflows/links.yml` runs [lychee](https://github.com/lycheeverse/lychee) over every tracked Markdown file on a pull request that touches one, and weekly on `main`. It checks the links in two halves with two severities: a link to a file or a heading inside this repository that no longer resolves fails the pull request, because only the author could have broken it and only the author can fix it. A link to somewhere else on the internet is retried and posted to the run summary without failing the job, because a third-party page moving on — or the free-tier API in this README still being asleep — is not a reason to block a merge. The settings are in `lychee.toml`, which a local run reads the same way (`lychee --config lychee.toml --scheme file $(git ls-files '*.md')`), so the fatal half is reproducible before pushing.
- **Failed events**: an event the indexer cannot project is stored in the `FailedEvent` table and `/ready` reports degraded until it is cleared. After fixing the cause, run `npm run indexer:retry-failed`; it exits non-zero while any event still fails.
- **Reconciliation**: the read model is a cache of the chain, so run `npm run indexer:reconcile` on a schedule. It reads `get_voucher` for every non-terminal voucher (plus a rolling sample of settled ones, `--sample`, default 25) and records each disagreement in `ReconcileMismatch`. `/ready` reports `checks.reconcileMismatches` and `checks.reconcile: "drift"`, but stays 200: unlike a failed event, drift says nothing about whether this instance can serve traffic. `--fix` rewrites the differing rows from chain state, which is the only safe direction. The command exits non-zero while any mismatch is open. It reads `get_voucher_options` for the same vouchers too: the terms a funder chose at funding time reach no event, so a `--fix` pass is what fills `Voucher.disputeWindowSecs` and `Voucher.presenceCommitment` (#319), and a report-only pass only compares them.

  These maintenance commands run the compiled entry points (`node dist/scripts/…`), so run `npm run build` first in a production image — `tsx` is a dev dependency and is not installed there. To run one from source without building, use the `:dev` twin (`npm run indexer:reconcile:dev`, same flags after `--`).
- **Faucet usage**: with `FAUCET_CONTRACT_ID` set, `dripped` events are indexed into `FaucetDrip` and `/stats` reports `faucetDrips` (total) and `faucetWallets` (distinct wallets) — the closest thing to a count of people who tried the demo.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). It documents the one trap this codebase has already hit: contract event fields marked `#[topic]` arrive in the topic list, not the data map, and reading them off the data map corrupts rows silently rather than crashing.

Security reports go through [SECURITY.md](SECURITY.md).

## Contributors

<a href="https://github.com/Godgift-care/sci-healthcare-backend/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Godgift-care/sci-healthcare-backend" />
</a>

## License

Apache-2.0. See [LICENSE](LICENSE).

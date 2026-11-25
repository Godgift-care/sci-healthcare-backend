# Mainnet readiness checklist

What has to be true before this service indexes and serves the **public**
Stellar network. Testnet being healthy proves nothing about mainnet: the
database plan, the backup regime, the traffic, the alerting and the money are
all different, and each of those is a decision that has to be made on purpose.

Every item is written so that it can be **verified**, not agreed with: a
command, a setting to read, or a number to compare. The one exception is a
named human decision, which is marked as such.

Work through it in order. Sections 1 and 2 gate everything after them.

Complements, does not replace: [RUNBOOK.md](RUNBOOK.md) (procedures),
[architecture.md](architecture.md) and its [decision records](adr/README.md)
(the rules), [logging.md](logging.md), [privacy.md](privacy.md),
[api-policy.md](api-policy.md).

---

## 1. Configuration

The process refuses to start on a bad combination, so each item here is a
command that either succeeds or tells you what is wrong — `src/env.ts`
validates all of it at boot.

| # | Item | Verify by |
| --- | --- | --- |
| 1.1 | `STELLAR_NETWORK` is `public` | `curl $API/version \| jq .network` returns `public` |
| 1.2 | `NETWORK_PASSPHRASE` is exactly `Public Global Stellar Network ; September 2015` | Boot fails with a named mismatch if not — the pair is checked together, so a testnet passphrase on a `public` label cannot start |
| 1.3 | Registry, voucher and receipt contract ids are the **mainnet** deployments | `curl $API/version \| jq .contracts` and compare each id to the contracts repository's mainnet release, character by character |
| 1.4 | `USDC_CONTRACT_ID` is the mainnet USDC contract, not the testnet value in the README's environment table; `FAUCET_CONTRACT_ID` is **unset** | `curl $API/version \| jq .contracts` — compare `usdc` to the mainnet deployment record character by character, and `faucet` must be `null`. `GET /stats` then reports `faucetDrips` and `faucetWallets` as `0`, because no drip event exists on mainnet; a faucet contract here would hand out real money |
| 1.5 | `SOROBAN_RPC_URLS` lists at least two independent mainnet endpoints | `curl -s $RPC | jq .latestLedger` twice, a minute apart, on each: both advance |
| 1.6 | `INDEXER_START_LEDGER` is the ledger the mainnet contracts were deployed at, not `0` and not the current tip | `GET /ready` reports `indexedLedger` climbing from that number; the deploy ledger is recorded in the contracts repo release notes |
| 1.7 | `CORS_ORIGIN` is the production frontend origin, https only | Boot rejects anything that is not a valid http(s) URL; a stray `http://localhost:3000` means the browser cannot call the API |
| 1.8 | `WEBHOOK_URLS` and `WEBHOOK_SECRET` are set together, and the secret is at least 16 characters and is not the testnet one | Boot fails when `WEBHOOK_URLS` is set and the secret is shorter than `MIN_WEBHOOK_SECRET_LENGTH` (`src/env.ts`). Rotate it for mainnet because it is a shared signing key: the value in the testnet environment must not appear in the mainnet one |
| 1.9 | `DATABASE_URL` points at the mainnet database, not the testnet one | `psql "$DATABASE_URL" -c "select count(*) from \"IndexerState\""` — the cursor is a mainnet ledger number |
| 1.10 | No `.env` file is committed, and nothing here holds a signing key | `git log --diff-filter=A --name-only -- '*.env'` prints nothing; the service is read-only by decision ([ADR-0004](adr/0004-database-is-a-projection.md)) |
| 1.11 | `LOG_LEVEL` is `info` or above and no secret appears in a log line | `GET /health` then search the platform logs for `webhook`, `secret`, `DATABASE_URL` — the redaction test (`src/__tests__/log-redaction.test.ts`) is what the code promises |

## 2. Database and migrations

SQLite is a development convenience. Mainnet is Postgres, with a plan you pay
for, because the indexer writes continuously while the API reads.

| # | Item | Verify by |
| --- | --- | --- |
| 2.1 | Engine is Postgres and the deployed schema came from `prisma migrate deploy`, not `db push` | `npx prisma migrate status` on the deployed database reports every migration applied |
| 2.2 | The migration set in `prisma/migrations/` applies cleanly to an empty database and matches the schema | The CI `migrations` job does exactly this, including `prisma migrate diff --exit-code`; it is green on the commit being deployed |
| 2.3 | Instance plan is paid, with a connection ceiling above the pool size | Read the plan's limits in the provider console: `DATABASE_POOL_SIZE` (see §2.4) × the number of processes must fit with room left for an operator session. The commented mainnet example in `render.yaml` uses `standard-0` for the database, not `free` |
| 2.4 | `DATABASE_POOL_SIZE` and `DATABASE_STATEMENT_TIMEOUT_MS` are set for that plan | Both feed the Prisma client in `src/db.ts`. `/ready` stays `ready` under load; a pool exhaustion answers `503 database_unavailable` with `Retry-After` rather than a bare 500 (`src/lib/errors.ts` treats `P1001/P1003/P1008/P1009/P2024` that way) |
| 2.5 | High availability is on | The provider lists a standby replica and automatic failover for that database — that is what you read, not what the plan is called. If it does not, the outage plan in §6 is signed off by whoever owns the service, which is a named human decision |
| 2.6 | `RETENTION_DAYS` was chosen, not inherited | Default 30 (`src/lib/retention.ts`). The cost of a short window is a gap: pruning past what the cursor still needs is what makes `/ready` answer `checks.indexer: "gap"` with the `checks.gap` ledger range |

## 3. Backups and restore

A projection of the chain can be rebuilt, which is a comfort, not a plan: a
full reindex from the deploy ledger takes as long as the history is long, and
the ledger behind it may already have left RPC retention.

| # | Item | Verify by |
| --- | --- | --- |
| 3.1 | Nightly `pg_dump` (or provider snapshots) runs and lands off-instance | [RUNBOOK.md § Backing up](RUNBOOK.md#backing-up-and-restoring-the-database) has the cron line; `ls -lh` on the destination shows yesterday's file with a plausible size |
| 3.2 | The backup restores | The dated entry under [RUNBOOK.md § Restore drill — results](RUNBOOK.md#restore-drill--results) is for the engine mainnet uses, and it names the check that proved it (`PRAGMA integrity_check` on SQLite, row counts against `/v1/stats` after a `pg_restore`) — a Postgres backup never restored is a rumour |
| 3.3 | Retention is at least as long as the recovery window you intend to offer | Read the retention from the provider's **Backups** tab and compare it, in days, to the dispute window a settlement stays reopenable for (`disputeDeadline` on a voucher is chain state — take the window from the contracts repository, not from this service) |
| 3.4 | A snapshot export exists as a second path | `npm run snapshot:export` (run `npm run build` first in a production image); it includes the cursor, which is why the pair restores consistently |
| 3.5 | Full reindex is rehearsed, with its real duration written down | [RUNBOOK.md § Full reindex](RUNBOOK.md#full-reindex-no-backup-or-a-backup-you-do-not-trust): start from empty against mainnet RPC and time the catch-up |

## 4. Capacity

| # | Item | Verify by |
| --- | --- | --- |
| 4.1 | The list routes' `limit` is capped, so no request can ask for the table | `curl "$API/v1/vouchers?limit=100000"` returns a validation error: the cap is 100 in `src/lib/cursor.ts` |
| 4.2 | Rate limits are deliberate for the traffic mainnet will get | 120 requests/min per client by default, 30/min on list routes and the feed (`src/lib/rate-limits.ts`). `GET /metrics` has no rate-limit counter, so read the 429s: `curl -s $API/metrics \| grep 'http_requests_total.*"429"'` — any 429 at launch means the limit is too low or something is scraping |
| 4.3 | `GET /stream` connections are bounded per process | `SSE_MAX_CONNECTIONS` (default 64) and `stream_connections` in `/metrics`; a full process answers `503 stream_full`, which is visible before it happens |
| 4.4 | The read paths that were slow are indexed | `EXPLAIN` the default `/v1/vouchers` filter against the production database: the composites created in `prisma/migrations/20260104000000_list_query_indexes` (`Voucher_funder_createdAt_idx`, `Voucher_status_createdAt_idx`, …) and `Voucher_amountKey_idx` from `prisma/migrations/20260110000000_voucher_amount_key` appear in the plan |
| 4.5 | Cold-cache latency is measured, not assumed | `npm run loadtest` against a deployment of the same shape; the p95 in the report is compared with what the app layer promises. [load-test.md](load-test.md) documents the harness |
| 4.6 | HTTP caching is on for the read routes | `curl -sI "$API/v1/stats"` shows `cache-control: public, max-age=5, stale-while-revalidate=30` (`src/lib/cache.ts`) and a weak `etag`; a second request with `if-none-match` returns `304`. `/health`, `/ready`, `/metrics` and `/stream` are `no-store`, because a cached "ok" keeps a broken instance in rotation |
| 4.7 | The instance type matches the profile, and a worker is a paid instance | `render.yaml`'s note still holds: a background worker needs a paid plan. Split API and indexer only if the index lag and request latency need to move independently |

## 5. Monitoring and alerting

| # | Item | Verify by |
| --- | --- | --- |
| 5.1 | `ops/alerts.yml` is loaded by the Prometheus that actually runs | `promtool check rules ops/alerts.yml` (the CI `alerts` job) passes, and the eight rules show up on the Prometheus server's own rules page |
| 5.2 | Every alert in that file has a route to a human | Stop the indexer in test (`npm run indexer:pause`) and confirm `SciIndexerLagging` from `ops/alerts.yml` pages somebody. The eight rules in that file cover lag, a stalled poller, failed events, reconciliation drift, a pause held for over an hour, 5xx rate, webhook backlog and abandoned deliveries; `SciReconcileMismatches` and `SciIndexerPausedTooLong` need an owner too |
| 5.3 | `/ready` is probed from outside, on a schedule | `.github/workflows/monitor.yml` runs and the external monitor ([RUNBOOK.md § Uptime monitoring](RUNBOOK.md#uptime-monitoring)) is pointed at `/ready`, not `/health` — `/health` answers while the read model is stale |
| 5.4 | The metric that matters has a threshold someone chose | `READY_MAX_LAG_LEDGERS` (default 120 ledgers) and the webhook freshness window, `READY_WEBHOOK_MAX_AGE_MS` (default 15 minutes): write the number down with the reason |
| 5.5 | Logs go somewhere searchable | [logging.md](logging.md): one request is one line, findable by `x-request-id`, and the retention window covers an incident review |
| 5.6 | Tracing is either on or consciously off | `OTEL_EXPORTER_OTLP_ENDPOINT` unset means no spans at all; `/version` and `GET /metrics` cannot tell you where a slow request was slow |
| 5.7 | The dashboard is imported and shows real series | `ops/grafana-dashboard.json` against the production datasource; `src/__tests__/grafana-dashboard.test.ts` keeps its panels and `src/lib/metrics.ts` in step |
| 5.8 | Reconciliation runs on a schedule | `npm run indexer:reconcile` exits `2` while a mismatch is open; `/ready` counts them in `checks.reconcileMismatches` and names the state `checks.reconcile: "drift"`. Drift deliberately does not flip `/ready` to `503` — a stale row is not a reason to pull a working API out of rotation, which is exactly why the scheduled exit code is what you rely on. The read model is a cache: drift is a fact of life and must be measured, not assumed away |

## 6. Rollback

| # | Item | Verify by |
| --- | --- | --- |
| 6.1 | The previous release can be redeployed in one action, and someone knows which button | Render keeps the last builds and deploys one by commit — the rollback is that, not a rebuild. Rehearse it on testnet and time how long `GET /ready` takes to return to `200` |
| 6.2 | No migration in the release is irreversible, or the irreversible one has a written forward-fix | Prisma migrations are not rolled back automatically. Read the new `prisma/migrations/` entries in the release: a column drop or type change is a one-way door — this is what [the amount migration plan](amount-numeric-migration-plan.md) is for |
| 6.3 | Rolling back the code does not lose the cursor | The schema is a superset after an additive migration, so the old code still runs. Verify with `npx prisma migrate status` after the rollback deploy |
| 6.4 | A bad projection can be repaired without a full reindex | `npm run indexer:backfill -- --from <ledger>` replays without touching the cursor, and `indexer:reconcile --fix` rewrites differing rows from chain state — the only safe direction |
| 6.5 | Pausing is rehearsed | `npm run indexer:pause` retains the cursor and stops applying; `/ready` goes `503` while paused, so the monitor knows. `npm run indexer:resume` continues from the retained cursor |
| 6.6 | The person on call knows the difference between a gap and drift | [RUNBOOK.md](RUNBOOK.md) has both procedures, and `/ready` names which one is happening: a gap is `checks.indexer: "gap"` with a `checks.gap` object and answers `503`; drift is `checks.reconcile: "drift"` with a non-zero `checks.reconcileMismatches` and answers `200` |

## 7. Before the first mainnet request

- [ ] All of §1 and §2 verified, with the output of each command pasted into the release issue.
- [ ] §3.2 restore drill done on mainnet-shaped data, not testnet data.
- [ ] §5.2 test alert fired and answered by a human, with the time recorded.
- [ ] A written decision from whoever owns the service that this checklist is complete — the checklist cannot grant itself sign-off.
- [ ] The first hour watched: `/ready`, `indexer_lag_ledgers`, 429s in `http_requests_total`, and `webhook_deliveries_abandoned`.

Dry-run the checklist against the testnet deployment first. An item that
cannot be verified on testnet — a plan, a standby, a paging route — is exactly
the item that will be missed on mainnet, so record who owns it before the day
it matters.

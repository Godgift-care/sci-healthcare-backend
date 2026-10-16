# Changelog

## Unreleased

### Added
- **GET /providers/:address/stats**: A clinic's vouchers grouped by status, with the total settled value summed exactly (base-unit strings). 404 for an unknown provider.
- **GET /stats/daily?days=30**: Funded, settled and refunded counts and value per UTC day (max 365). Days with no activity are returned as zeros, and amounts are summed with BigInt.
- **Voucher.refundedAt** (nullable): set from the `voucher_refunded` event's ledger close time. `prisma db push` adds the column in place (no backfill needed).
- **Signed webhooks**: optional `WEBHOOK_URLS` / `WEBHOOK_SECRET`. Voucher events are queued to a `WebhookDelivery` outbox in the same transaction as the projection and delivered from a separate loop, signed with `X-SCI-Signature` (HMAC-SHA256). Failed deliveries retry with exponential backoff and never block the indexer. `prisma db push` creates the new table in place.
- **Dockerfile and docker-compose.yml**: multi-stage image (Node 22, non-root) plus a `docker compose up` stack with Postgres, a one-shot schema push and the API. README documents the Docker quick start.
- **GET /receipts?provider=**: List receipts by clinic/provider. Beneficiary references omitted in this view.
- **GET /receipts/:voucherId**: Fetch a single receipt by voucher ID for shareable receipt pages and verification. No beneficiary reference in response.
- **GET /vouchers/due?within=72h**: Vouchers needing action soon (expiring, becoming refundable, or settleable) with funder or provider filter. Uses lifecycle logic from `src/lib/lifecycle.ts` so API and contracts agree.
- **Multi-status filter for vouchers**: `?status=Claimed,Attested` accepts comma-separated list validated against the status enum; invalid values rejected.
- **`READY_MAX_LAG_LEDGERS`** (default `120`): lag in ledgers at which `/ready` reports degraded. The response echoes it as `checks.maxLagLedgers`.
- **Split API and indexer entry points**: `npm run start:api` and `npm run start:indexer`; combined `npm start` stays the default. Commented two-service example in `render.yaml`.
- **Indexer lease**: `IndexerState.leaseOwner` / `leaseExpiresAt` make the cursor single-writer. Standby instances log and retry instead of racing the cursor.

### Changed
- **Error responses**: every route now returns the one `{ error, message, details? }` envelope via the app-level error and not-found handlers. Unhandled failures are `internal_error`, with the cause left in the log rather than the response.
- **GET /receipts**: Now requires exactly one of `beneficiaryRef` or `provider` query parameters.
- **GET /vouchers**: Status filter now accepts comma-separated values (e.g., `Claimed,Attested`) instead of a single value.
- **Indexer logs**: skipped events now include the transaction hash and ledger; an unknown event name is warned once per process instead of silently ignored.
- **`IndexerState` schema**: two nullable columns added; `prisma db push` adds them in place (no backfill needed).

## 0.2.0 — 2026-10-09

### Fixed
- **indexer:** follows the RPC cursor across pages. Previously any backlog over 200 events lost everything after the first page, because the cursor jumped to the RPC tip.

### Added
- Route tests for every endpoint against a throwaway SQLite database, through a new `buildApp()` that builds the API without starting the indexer. Tests: 57 (was 19).
- Issue forms (bug, feature) and a pull request template; blank issues off, security reports routed to SECURITY.md.
- `serviceLabel` on vouchers and receipts; `refundableAt` and `disputeReason` on vouchers. `isRefundable` follows the contract's claim-grace rule.
- `Voucher.disputeReason` column (nullable; `prisma db push` adds it in place).
- `npm run lint` (ESLint 9 + typescript-eslint) and a lint job in CI.

### Changed
- Points at the 2026-10-07 testnet deployment; `INDEXER_START_LEDGER` updated.

## 0.1.0 — 2026-09-02

Initial indexer and read API.

# Changelog

## Unreleased

### Added
- **GET /receipts?provider=**: List receipts by clinic/provider. Beneficiary references omitted in this view.
- **GET /receipts/:voucherId**: Fetch a single receipt by voucher ID for shareable receipt pages and verification. No beneficiary reference in response.
- **GET /vouchers/due?within=72h**: Vouchers needing action soon (expiring, becoming refundable, or settleable) with funder or provider filter. Uses lifecycle logic from `src/lib/lifecycle.ts` so API and contracts agree.
- **Multi-status filter for vouchers**: `?status=Claimed,Attested` accepts comma-separated list validated against the status enum; invalid values rejected.
- **`READY_MAX_LAG_LEDGERS`** (default `120`): lag in ledgers at which `/ready` reports degraded. The response echoes it as `checks.maxLagLedgers`.
- **Split API and indexer entry points**: `npm run start:api` and `npm run start:indexer`; combined `npm start` stays the default. Commented two-service example in `render.yaml`.
- **Indexer lease**: `IndexerState.leaseOwner` / `leaseExpiresAt` make the cursor single-writer. Standby instances log and retry instead of racing the cursor.
- **Attesters**: `Attester` model (`active`, `addedAt`, `removedAt`) and `Voucher.attestedBy`. The indexer now projects `attester_added` / `attester_removed` and records the attester from the `voucher_attested` topic instead of discarding it.
- **GET /attesters**: Active attesters by default, `?all=true` to include removed ones, each with its attestation count. **GET /attesters/:address** for one attester with its count.
- **Dispute resolution**: `Voucher.disputeResolvedAt` / `disputeResolvedBy` / `disputeOutcome` (`Funder` | `Provider`), projected from `dispute_resolved` and returned by `GET /vouchers` and `GET /vouchers/:id`.
- **GET /vouchers/:id/events**: the voucher's contract events in ledger order, each with its transaction hash, backed by a new append-only `ContractEvent` log.
- **Postgres CI matrix**: the suite now runs on Postgres as well as SQLite. `test/global-setup.ts` honours a provided Postgres `DATABASE_URL`, resetting by dropping and recreating the schema.

### Changed
- **GET /receipts**: Now requires exactly one of `beneficiaryRef` or `provider` query parameters.
- **GET /vouchers**: Status filter now accepts comma-separated values (e.g., `Claimed,Attested`) instead of a single value.
- **Indexer logs**: skipped events now include the transaction hash and ledger; an unknown event name is warned once per process instead of silently ignored.
- **`IndexerState` schema**: two nullable columns added; `prisma db push` adds them in place (no backfill needed).
- **Indexer transactions**: each event's projection and its `ContractEvent` log insert now commit in one database transaction, and the per-handler transactions were folded into it.
- **Known events**: `attester_added`, `attester_removed` and `dispute_resolved` are now projected rather than ignored.
- **`Voucher` schema**: three nullable dispute columns and a nullable `attestedBy` added; `prisma db push` adds them in place (no backfill needed).

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

# Changelog

## Unreleased

### Fixed
- **indexer:** follows the RPC cursor across pages. Previously any backlog over 200 events lost everything after the first page, because the cursor jumped to the RPC tip.

### Added
- `serviceLabel` on vouchers and receipts; `refundableAt` and `disputeReason` on vouchers. `isRefundable` follows the contract's claim-grace rule.
- `Voucher.disputeReason` column (nullable; `prisma db push` adds it in place).
- `npm run lint` (ESLint 9 + typescript-eslint) and a lint job in CI.

### Changed
- Points at the 2026-10-07 testnet deployment; `INDEXER_START_LEDGER` updated.

## 0.1.0 — 2026-09-02

Initial indexer and read API.

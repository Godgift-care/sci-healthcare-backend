-- perf(db): keyset index for voucher lists filtered by clinic and status (#274).
--
-- The clinic desk's main query is `provider = ? AND status = ?` ordered by the
-- numeric voucher id (`seq`). No existing index covers the pair plus the order
-- column, so Postgres either walks (providerAddress, createdAt) and filters
-- status row by row, or sorts the clinic's whole history. With equality on the
-- first two columns and `seq` last, a keyset page is one index range scan that
-- stops at LIMIT, in either direction.
--
-- Purely additive and idempotent. Rollback: DROP INDEX "Voucher_providerAddress_status_seq_idx";

CREATE INDEX IF NOT EXISTS "Voucher_providerAddress_status_seq_idx" ON "Voucher"("providerAddress", "status", "seq");

-- feat(indexer): project the terms a funder chose at funding time (#319).
--
-- `create_voucher_with_options` attaches settings that `VoucherCreated` never
-- announces — the event carries only the funding fields — so the read model
-- has had no place to put them and the API has shown the protocol-wide
-- dispute window for a voucher funded with a custom one.
--
-- `disputeWindowSecs` is the per-voucher window in seconds, null when the
-- funder took `Config.dispute_window`. `presenceCommitment` is the SHA-256 the
-- clinic must reveal in `claim_with_proof`, hex like every other byte field
-- here, null for a voucher claimable without a proof.
--
-- Both are filled by reconciliation (`get_voucher_options`, a simulation
-- read), never by the event stream, so the columns stay null until the first
-- pass over a voucher that has not settled or refunded.

-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "disputeWindowSecs" INTEGER,
ADD COLUMN     "presenceCommitment" TEXT;

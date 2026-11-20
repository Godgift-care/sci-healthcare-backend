-- feat(db): land the amount columns as NUMERIC on Postgres (#273, plan #60).
--
-- Amounts are i128 values that were carried as decimal strings, so on the
-- database `ORDER BY amount` was lexicographic and `SUM(amount)` went through
-- float8 or text. This converts every amount/price column to NUMERIC(39,0):
-- an i128 has at most 39 digits, so every value the chain can produce fits
-- exactly, and the type is exact (no float rounding) for sums and ranges.
-- docs/amount-numeric-migration-plan.md has the plan and the design notes.
--
-- Safety:
--   * A preflight aborts the whole migration, before any change, if a stored
--     value is not a plain decimal integer of at most 39 digits, naming the
--     table and column. Nothing is cast lossily and no row is changed.
--   * Each conversion uses an explicit USING cast and runs inside this
--     migration's single transaction, so a failure leaves the old text columns.
--   * The text-regex CHECK constraints from
--     20261025000000_retention_constraints_and_referential_integrity cannot
--     apply to a numeric column, so they are dropped and re-created as
--     `>= 0` checks with the same names (non-negative is still enforced).
--   * ALTER ... SET DATA TYPE takes an ACCESS EXCLUSIVE lock and rewrites the
--     table: run it in a short maintenance window (stop API + indexer,
--     `npm run db:migrate`, start).
--
-- Rollback (values are integers, so numeric -> text is lossless; ordering
-- goes back to lexicographic). The same statements are in docs/RUNBOOK.md:
--
--   ALTER TABLE "Voucher" DROP CONSTRAINT "voucher_amount_non_negative", DROP CONSTRAINT "voucher_settled_net_check", DROP CONSTRAINT "voucher_settled_fee_check";
--   ALTER TABLE "Receipt" DROP CONSTRAINT "receipt_amount_non_negative";
--   ALTER TABLE "Service" DROP CONSTRAINT "service_price_non_negative";
--   ALTER TABLE "Voucher" ALTER COLUMN "amount" SET DATA TYPE text USING "amount"::text;
--   ... the same for Voucher.settledNet, Voucher.settledFee, Receipt.amount,
--   FaucetDrip.amount, Service.price, ServicePriceChange.price ...
--   ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_amount_non_negative" CHECK ("amount" ~ '^[0-9]+$');
--   ... and the other four regex checks from 20261025000000 ...
--
-- then deploy the previous application version and delete this migration's
-- row from "_prisma_migrations".

-- Preflight.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT tbl, col, cnt FROM (
      SELECT 'Voucher'::text AS tbl, 'amount'::text AS col, count(*) AS cnt FROM "Voucher" WHERE "amount" !~ '^[+-]?[0-9]{1,39}$'
      UNION ALL SELECT 'Voucher', 'settledNet', count(*) FROM "Voucher" WHERE "settledNet" IS NOT NULL AND "settledNet" !~ '^[+-]?[0-9]{1,39}$'
      UNION ALL SELECT 'Voucher', 'settledFee', count(*) FROM "Voucher" WHERE "settledFee" IS NOT NULL AND "settledFee" !~ '^[+-]?[0-9]{1,39}$'
      UNION ALL SELECT 'Receipt', 'amount', count(*) FROM "Receipt" WHERE "amount" !~ '^[+-]?[0-9]{1,39}$'
      UNION ALL SELECT 'FaucetDrip', 'amount', count(*) FROM "FaucetDrip" WHERE "amount" !~ '^[+-]?[0-9]{1,39}$'
      UNION ALL SELECT 'Service', 'price', count(*) FROM "Service" WHERE "price" !~ '^[+-]?[0-9]{1,39}$'
      UNION ALL SELECT 'ServicePriceChange', 'price', count(*) FROM "ServicePriceChange" WHERE "price" !~ '^[+-]?[0-9]{1,39}$'
    ) bad WHERE cnt > 0
  LOOP
    RAISE EXCEPTION 'amount_numeric_to_decimal (#273): % rows in %.% are not decimal integers of at most 39 digits; clean them before migrating', r.cnt, r.tbl, r.col;
  END LOOP;
END $$;

-- The text-regex checks cannot survive the type change.
ALTER TABLE "Voucher" DROP CONSTRAINT IF EXISTS "voucher_amount_non_negative";
ALTER TABLE "Voucher" DROP CONSTRAINT IF EXISTS "voucher_settled_net_check";
ALTER TABLE "Voucher" DROP CONSTRAINT IF EXISTS "voucher_settled_fee_check";
ALTER TABLE "Receipt" DROP CONSTRAINT IF EXISTS "receipt_amount_non_negative";
ALTER TABLE "Service" DROP CONSTRAINT IF EXISTS "service_price_non_negative";

-- AlterTable
ALTER TABLE "Voucher" ALTER COLUMN "amount"     SET DATA TYPE DECIMAL(39,0) USING "amount"::numeric(39,0);
ALTER TABLE "Voucher" ALTER COLUMN "settledNet" SET DATA TYPE DECIMAL(39,0) USING "settledNet"::numeric(39,0);
ALTER TABLE "Voucher" ALTER COLUMN "settledFee" SET DATA TYPE DECIMAL(39,0) USING "settledFee"::numeric(39,0);
ALTER TABLE "Receipt" ALTER COLUMN "amount"     SET DATA TYPE DECIMAL(39,0) USING "amount"::numeric(39,0);
ALTER TABLE "FaucetDrip" ALTER COLUMN "amount"  SET DATA TYPE DECIMAL(39,0) USING "amount"::numeric(39,0);
-- Service.price and its historical mirror ServicePriceChange.price are the same
-- i128-as-string class; converting one without the other would keep the split.
ALTER TABLE "Service" ALTER COLUMN "price"      SET DATA TYPE DECIMAL(39,0) USING "price"::numeric(39,0);
ALTER TABLE "ServicePriceChange" ALTER COLUMN "price" SET DATA TYPE DECIMAL(39,0) USING "price"::numeric(39,0);

-- Non-negative amounts stay enforced, now numerically.
ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_amount_non_negative" CHECK ("amount" >= 0);
ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_settled_net_check" CHECK ("settledNet" IS NULL OR "settledNet" >= 0);
ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_settled_fee_check" CHECK ("settledFee" IS NULL OR "settledFee" >= 0);
ALTER TABLE "Receipt" ADD CONSTRAINT "receipt_amount_non_negative" CHECK ("amount" >= 0);
ALTER TABLE "Service" ADD CONSTRAINT "service_price_non_negative" CHECK ("price" >= 0);

-- perf(api): sort and filter vouchers by amount in the database (#96).
--
-- `Voucher.amount` is an i128 kept as a decimal string, so `ORDER BY amount`
-- is lexicographic and puts 9 after 10. `GET /vouchers?sort=amount` and the
-- minAmount/maxAmount band used to load every matching row and compare with
-- BigInt in JS. `amountKey` is the same amount zero-padded to 39 digits (the
-- width of the largest i128), so string order is numeric order and the
-- database can sort, range-filter and page it with an index.

-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN     "amountKey" TEXT NOT NULL DEFAULT '';

-- Backfill existing rows; same padding as `amountKey()` in src/lib/amounts.ts.
UPDATE "Voucher" SET "amountKey" = lpad("amount", 39, '0');

-- CreateIndex
CREATE INDEX "Voucher_amountKey_idx" ON "Voucher"("amountKey");

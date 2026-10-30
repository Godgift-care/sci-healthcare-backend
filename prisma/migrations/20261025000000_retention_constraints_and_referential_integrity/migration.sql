-- feat(db): retention for resolved failed events, status & amount CHECK constraints, and referential integrity (#142, #143, #144).

-- 1. Retention support for FailedEvent (#142)
ALTER TABLE "FailedEvent" ADD COLUMN "resolvedAt" TIMESTAMP(3);
CREATE INDEX "FailedEvent_resolvedAt_idx" ON "FailedEvent"("resolvedAt");

-- 2. CHECK constraints on Postgres for statuses and non-negative amounts (#143)
-- Status CHECK constraints
ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_status_check" CHECK ("status" IN ('Funded', 'Claimed', 'Attested', 'Settled', 'Disputed', 'Refunded'));
ALTER TABLE "Provider" ADD CONSTRAINT "provider_status_check" CHECK ("status" IN ('Pending', 'Active', 'Suspended'));

-- Non-negative amount CHECK constraints (numeric strings)
ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_amount_non_negative" CHECK ("amount" ~ '^[0-9]+$');
ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_settled_net_check" CHECK ("settledNet" IS NULL OR "settledNet" ~ '^[0-9]+$');
ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_settled_fee_check" CHECK ("settledFee" IS NULL OR "settledFee" ~ '^[0-9]+$');
ALTER TABLE "Receipt" ADD CONSTRAINT "receipt_amount_non_negative" CHECK ("amount" ~ '^[0-9]+$');
ALTER TABLE "Service" ADD CONSTRAINT "service_price_non_negative" CHECK ("price" ~ '^[0-9]+$');

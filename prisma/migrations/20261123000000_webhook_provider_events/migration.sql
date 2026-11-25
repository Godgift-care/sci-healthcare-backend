-- Webhook events for clinic and service changes (#266).
--
-- Registry and service events have no voucher, and a price change has no
-- status, so those columns become nullable and the event's own subject gets
-- two new columns. Existing voucher rows are unaffected: the payload column
-- still holds the exact body that was signed, and the voucher columns keep
-- their values.
--
-- Rollback: backfill `voucherId`/`status` for any registry or service rows
-- (or delete them), then
--   ALTER TABLE "WebhookDelivery" ALTER COLUMN "status" SET NOT NULL;
--   ALTER TABLE "WebhookDelivery" ALTER COLUMN "voucherId" SET NOT NULL;
--   ALTER TABLE "WebhookDelivery" DROP COLUMN "provider";
--   ALTER TABLE "WebhookDelivery" DROP COLUMN "serviceCode";

ALTER TABLE "WebhookDelivery" ALTER COLUMN "voucherId" DROP NOT NULL;
ALTER TABLE "WebhookDelivery" ALTER COLUMN "status" DROP NOT NULL;
ALTER TABLE "WebhookDelivery" ADD COLUMN "provider" TEXT;
ALTER TABLE "WebhookDelivery" ADD COLUMN "serviceCode" INTEGER;

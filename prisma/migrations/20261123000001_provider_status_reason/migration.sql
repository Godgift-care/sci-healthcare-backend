-- feat(indexer): persist provider status reasons and the Retired status (#212).
--
-- The new reason fields are nullable so events from older contract deployments
-- remain representable. Existing providers retain an unknown reason as NULL.

ALTER TABLE "Provider"
  ADD COLUMN "statusReason" INTEGER;

ALTER TABLE "ProviderStatusChange"
  ADD COLUMN "reasonCode" INTEGER;

ALTER TABLE "Provider" DROP CONSTRAINT "provider_status_check";
ALTER TABLE "Provider"
  ADD CONSTRAINT "provider_status_check"
  CHECK ("status" IN ('Pending', 'Active', 'Suspended', 'Retired'));

-- feat(metadata): fetch status, error code and ETag for provider metadata (#270, #271, #272).
--
-- All three columns are nullable and additive. Existing rows keep their
-- cached document; `metadataStatus` is filled by the next refresh attempt
-- (a row with a URI and no fetched timestamp is already due). Rollback:
--
--   ALTER TABLE "Provider" DROP COLUMN "metadataStatus",
--     DROP COLUMN "metadataError",
--     DROP COLUMN "metadataEtag";

ALTER TABLE "Provider"
  ADD COLUMN "metadataStatus" TEXT,
  ADD COLUMN "metadataError" TEXT,
  ADD COLUMN "metadataEtag" TEXT;

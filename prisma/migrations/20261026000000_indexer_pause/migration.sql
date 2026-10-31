-- feat(indexer): pause and resume indexing without a redeploy (#138).
ALTER TABLE "IndexerState" ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;

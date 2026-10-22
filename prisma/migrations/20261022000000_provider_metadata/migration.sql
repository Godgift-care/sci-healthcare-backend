-- AlterTable
ALTER TABLE "Provider" ADD COLUMN     "metadata" TEXT,
ADD COLUMN     "metadataFetchedAt" TIMESTAMP(3),
ADD COLUMN     "metadataUri" TEXT;

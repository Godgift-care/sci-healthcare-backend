-- feat(indexer): index the matching-funding desk (#317).
-- Three new tables, no change to any existing column, so an already-indexed
-- database picks them up empty and fills them as it replays.

-- CreateTable
CREATE TABLE "Sponsor" (
    "address" TEXT NOT NULL,
    "available" TEXT,
    "matchBps" INTEGER,
    "capPerVoucher" TEXT,
    "minVoucherAmount" TEXT,
    "minVoucherAgeSecs" TEXT,
    "rulesAt" TIMESTAMP(3),
    "lastMovementAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sponsor_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "SponsorBudgetEvent" (
    "id" TEXT NOT NULL,
    "sponsorAddress" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "available" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SponsorBudgetEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SponsorMatch" (
    "matchedVoucherId" TEXT NOT NULL,
    "originalVoucherId" TEXT NOT NULL,
    "sponsorAddress" TEXT NOT NULL,
    "providerAddress" TEXT NOT NULL,
    "serviceCode" INTEGER NOT NULL,
    "amount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "matchedAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),

    CONSTRAINT "SponsorMatch_pkey" PRIMARY KEY ("matchedVoucherId")
);

-- CreateIndex
CREATE INDEX "Sponsor_firstSeenAt_idx" ON "Sponsor"("firstSeenAt");

-- CreateIndex
CREATE INDEX "SponsorBudgetEvent_sponsorAddress_ledger_idx" ON "SponsorBudgetEvent"("sponsorAddress", "ledger");

-- CreateIndex
CREATE UNIQUE INDEX "SponsorMatch_originalVoucherId_key" ON "SponsorMatch"("originalVoucherId");

-- CreateIndex
CREATE INDEX "SponsorMatch_sponsorAddress_matchedAt_idx" ON "SponsorMatch"("sponsorAddress", "matchedAt");

-- CreateIndex
CREATE INDEX "SponsorMatch_status_idx" ON "SponsorMatch"("status");

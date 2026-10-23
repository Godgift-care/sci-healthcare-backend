-- CreateTable
CREATE TABLE "DailyStat" (
    "date" TEXT NOT NULL,
    "fundedCount" INTEGER NOT NULL DEFAULT 0,
    "fundedAmount" TEXT NOT NULL DEFAULT '0',
    "settledCount" INTEGER NOT NULL DEFAULT 0,
    "settledAmount" TEXT NOT NULL DEFAULT '0',
    "refundedCount" INTEGER NOT NULL DEFAULT 0,
    "refundedAmount" TEXT NOT NULL DEFAULT '0',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DailyStat_pkey" PRIMARY KEY ("date")
);

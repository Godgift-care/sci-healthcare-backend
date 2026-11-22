-- feat(api): upcoming scheduled price changes (#315).
-- Both columns are nullable so a deployment whose registry predates
-- `schedule_service_price` migrates and indexes unchanged.
ALTER TABLE "Service" ADD COLUMN "upcomingPrice" TEXT;
ALTER TABLE "Service" ADD COLUMN "upcomingFrom" TIMESTAMP(3);

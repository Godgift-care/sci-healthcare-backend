import { prisma } from '../db.js';
import { backfillDailyStats } from '../lib/daily-stats.js';

async function main() {
  console.log('Rebuilding DailyStat table from vouchers and receipts...');
  const count = await backfillDailyStats(prisma);
  console.log(`Successfully backfilled DailyStat for ${count} dates.`);
}

main()
  .catch((err) => {
    console.error('Failed to backfill daily stats:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

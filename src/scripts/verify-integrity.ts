import pino from 'pino';

import { disconnect, prisma } from '../db.js';
import { env } from '../env.js';
import { verifyReferentialIntegrity } from '../lib/referential-integrity.js';

const log = pino({ level: env.LOG_LEVEL });

async function main(): Promise<void> {
  const report = await verifyReferentialIntegrity(prisma);
  if (report.totalOrphans > 0) {
    log.error(report, 'referential integrity check failed: orphans detected');
  } else {
    log.info(report, 'referential integrity check passed: zero orphans detected');
  }
  console.log(JSON.stringify(report, null, 2));
  await disconnect();
  process.exit(report.totalOrphans > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

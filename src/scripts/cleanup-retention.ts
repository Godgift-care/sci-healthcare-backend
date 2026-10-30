import pino from 'pino';

import { disconnect } from '../db.js';
import { env } from '../env.js';
import { purgeExpiredOperationalData } from '../lib/retention.js';

const log = pino({ level: env.LOG_LEVEL });

async function main(): Promise<void> {
  const result = await purgeExpiredOperationalData();
  log.info(result, 'retention cleanup complete');
  console.log(JSON.stringify(result));
  await disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import pino from 'pino';

import { disconnect } from '../db.js';
import { env } from '../env.js';
import { retryFailed } from '../stellar/failed.js';
import { Indexer } from '../stellar/indexer.js';

const log = pino({ level: env.LOG_LEVEL });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--id' || !args[1])) {
    throw new Error('usage: indexer:retry-failed [--id <event-id>]');
  }
  const indexer = new Indexer(log);
  const result = await retryFailed((e) => indexer.applyEvent(e), args[1]);
  log.info(result, 'retry-failed complete');
  console.log(JSON.stringify(result));
  await disconnect();
  // Non-zero while anything is still failing, so a script or cron notices.
  process.exit(result.remaining > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

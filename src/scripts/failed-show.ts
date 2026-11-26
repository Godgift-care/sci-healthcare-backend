import { disconnect } from '../db.js';
import { showFailed } from '../stellar/failed.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    console.error('usage: failed:show -- <event-id>');
    process.exitCode = 2;
    return;
  }
  const row = await showFailed(args[0]);
  if (!row) {
    console.error('failed event not found');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(row, null, 2));
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnect());

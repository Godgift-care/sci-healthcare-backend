import { disconnect } from '../db.js';
import { listFailed } from '../stellar/failed.js';

async function main(): Promise<void> {
  const rows = await listFailed();
  console.log(JSON.stringify(rows, null, 2));
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnect());

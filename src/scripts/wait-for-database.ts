import { disconnect, waitForDatabase } from '../db.js';

async function main(): Promise<void> {
  await waitForDatabase();
  await disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

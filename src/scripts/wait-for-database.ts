import { disconnect, waitForDatabase } from '../db.js';

async function main(): Promise<void> {
  await waitForDatabase();
  await disconnect();
}

main().catch(() => {
  console.error('Database availability check failed');
  process.exit(1);
});

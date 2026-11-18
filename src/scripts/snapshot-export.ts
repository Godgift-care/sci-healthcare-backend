import { parseArgs } from 'node:util';
import { disconnect } from '../db.js';
import { writeSnapshot } from '../lib/snapshot.js';
const { values } = parseArgs({ options: { out: { type: 'string', short: 'o' } } });
const file = values.out ?? 'sci-healthcare-snapshot.json.gz';
writeSnapshot(file)
  .then((snapshot) => {
    const rows = Object.values(snapshot.tables).reduce((total, table) => total + table.length, 0);
    const ledger = snapshot.cursor?.lastLedger;
    const ledgerText =
      typeof ledger === 'number' || typeof ledger === 'string' ? String(ledger) : 'unknown';
    console.log(`Exported ${rows} rows through ledger ${ledgerText} to ${file}`);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => disconnect());

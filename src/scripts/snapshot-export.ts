import { parseArgs } from 'node:util';
import { disconnect } from '../db.js';
import { writeSnapshot } from '../lib/snapshot.js';
const { values } = parseArgs({ options: { out: { type: 'string', short: 'o' } } });
const file = values.out ?? 'sci-healthcare-snapshot.json.gz';
writeSnapshot(file).then((snapshot) => {
  const rows = Object.values(snapshot.tables).reduce((total, table) => total + table.length, 0);
  console.log(`Exported ${rows} rows through ledger ${String(snapshot.cursor?.lastLedger ?? 'unknown')} to ${file}`);
}).catch((err: unknown) => { console.error(err); process.exitCode = 1; }).finally(() => disconnect());

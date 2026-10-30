import { parseArgs } from 'node:util';
import { disconnect } from '../db.js';
import { importSnapshot, readSnapshot } from '../lib/snapshot.js';
const { values } = parseArgs({ options: { file: { type: 'string', short: 'f' } } });
const file = values.file ?? 'sci-healthcare-snapshot.json.gz';
readSnapshot(file).then((snapshot) => importSnapshot(snapshot)).then(() => console.log(`Imported snapshot from ${file}`)).catch((err: unknown) => { console.error(err); process.exitCode = 1; }).finally(() => disconnect());

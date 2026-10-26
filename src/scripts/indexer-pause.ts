import { disconnect, prisma } from '../db.js';

async function main(): Promise<void> {
  const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
  if (!state) throw new Error('IndexerState does not exist; start the indexer once before pausing it');
  await prisma.indexerState.update({ where: { id: 1 }, data: { paused: true } });
  console.log(`Indexer paused at ledger ${state.lastLedger}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => disconnect());

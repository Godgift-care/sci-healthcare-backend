import { parseArgs } from 'node:util';

import pino from 'pino';

import { disconnect, prisma, waitForDatabase } from '../db.js';
import { env, INDEXED_CONTRACTS } from '../env.js';
import { server } from '../stellar/client.js';
import { decodeEvent } from '../stellar/events.js';
import { recordFailure } from '../stellar/failed.js';
import { Indexer } from '../stellar/indexer.js';
import { collectEvents } from '../stellar/paging.js';
import { createServer } from '../stellar/rpc-pool.js';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
  },
  strict: true,
});

const from = Number(values.from);
if (!Number.isInteger(from) || from < 0) {
  console.error('--from <ledger> is required (non-negative integer)');
  process.exit(1);
}

const log = pino({ level: env.LOG_LEVEL });

async function main(): Promise<void> {
  await waitForDatabase();
  const health = await server.getHealth();

  const to = values.to ? Number(values.to) : health.latestLedger;
  if (!Number.isInteger(to) || to < from) {
    console.error(`--to must be an integer >= --from (${from})`);
    process.exit(1);
  }

  const archive = env.INDEXER_ARCHIVE_RPC_URL ? createServer(env.INDEXER_ARCHIVE_RPC_URL) : null;
  if (from < health.oldestLedger && !archive) {
    console.error(
      `--from ${from} is older than the RPC's oldest available ledger ${health.oldestLedger}. ` +
        'Set INDEXER_ARCHIVE_RPC_URL to a provider that retains this history.',
    );
    process.exit(1);
  }

  log.info(
    {
      from,
      to,
      oldestLedger: health.oldestLedger,
      archiveRpcConfigured: archive !== null,
    },
    'backfill starting',
  );

  const indexer = new Indexer(log);
  let startLedger = from;
  let totalApplied = 0;
  let filledLedger = from - 1;

  while (startLedger <= to) {
    const useArchive = startLedger < health.oldestLedger;
    const source = useArchive ? archive : server;
    if (!source) throw new Error('No RPC source configured for the requested backfill range');
    const rangeTo = useArchive ? Math.min(to, health.oldestLedger - 1) : to;
    if (rangeTo < startLedger) break;

    const { events, throughLedger, hasMore } = await collectEvents(source, {
      startLedger,
      contractIds:
        process.env.SPONSOR_CONTRACT_ID &&
        !INDEXED_CONTRACTS.includes(process.env.SPONSOR_CONTRACT_ID)
          ? [...INDEXED_CONTRACTS, process.env.SPONSOR_CONTRACT_ID]
          : INDEXED_CONTRACTS,
    });

    for (const raw of events) {
      if (raw.ledger > to) break;
      const decoded = decodeEvent(raw as never);
      if (!decoded) continue;
      try {
        await indexer.applyEvent(decoded);
        totalApplied += 1;
      } catch (err) {
        await recordFailure(prisma, raw as never, decoded, err);
        log.warn({ err, event: decoded.name, ledger: decoded.ledger }, 'backfill: event skipped');
      }
    }

    if (totalApplied > 0 && totalApplied % 500 < events.length) {
      log.info({ applied: totalApplied, throughLedger }, 'backfill progress');
    }

    filledLedger = Math.max(filledLedger, Math.min(throughLedger, rangeTo));
    if (!hasMore || throughLedger >= rangeTo) {
      startLedger = rangeTo + 1;
      if (startLedger > to) break;
      continue;
    }
    startLedger = throughLedger + 1;
  }

  if (filledLedger >= health.oldestLedger) {
    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: filledLedger, gap: false },
      update: {
        lastLedger: Math.max(state?.lastLedger ?? 0, filledLedger),
        gap: false,
        gapOldestLedger: null,
        gapCursorLedger: null,
      },
    });
  }

  log.info({ totalApplied, from, to }, 'backfill complete');
  await disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

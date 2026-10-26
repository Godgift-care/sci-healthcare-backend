import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { rpc } from '@stellar/stellar-sdk';

import { env, INDEXED_CONTRACTS } from '../env.js';
import { server } from '../stellar/client.js';

export type RecordedPage = {
  _provenance: {
    recordedAt: string;
    networkPassphrase: string;
    source: 'soroban-rpc.getEvents';
    startLedger: number;
    page: number;
  };
  response: {
    events: rpc.Api.EventResponse[];
    latestLedger: number;
    cursor?: string;
  };
};

export function parseRecordArgs(argv: string[]): {
  startLedger: number;
  pageSize: number;
  maxPages: number;
  outDir: string;
} {
  let startLedger = env.INDEXER_START_LEDGER || 1;
  let pageSize = 100;
  let maxPages = 5;
  let outDir = path.resolve(fileURLToPath(import.meta.url), '../../__tests__/fixtures/rpc-replay');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--from' && argv[i + 1]) startLedger = Number(argv[++i]);
    else if (arg === '--page-size' && argv[i + 1]) pageSize = Number(argv[++i]);
    else if (arg === '--max-pages' && argv[i + 1]) maxPages = Number(argv[++i]);
    else if (arg === '--out' && argv[i + 1]) outDir = path.resolve(argv[++i]!);
  }

  return { startLedger, pageSize, maxPages, outDir };
}

export async function recordRpcPages(
  source: Pick<rpc.Server, 'getEvents' | 'getLatestLedger'>,
  opts: {
    startLedger: number;
    pageSize: number;
    maxPages: number;
    outDir: string;
    contracts?: string[];
  },
): Promise<number> {
  mkdirSync(opts.outDir, { recursive: true });
  const contractIds = opts.contracts ?? INDEXED_CONTRACTS;
  const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [...contractIds] }];

  let cursor: string | undefined;
  let page = 0;

  while (page < opts.maxPages) {
    page += 1;
    const res = cursor
      ? await source.getEvents({ cursor, filters, limit: opts.pageSize })
      : await source.getEvents({ startLedger: opts.startLedger, filters, limit: opts.pageSize });

    const fixture: RecordedPage = {
      _provenance: {
        recordedAt: new Date().toISOString(),
        networkPassphrase: env.NETWORK_PASSPHRASE,
        source: 'soroban-rpc.getEvents',
        startLedger: opts.startLedger,
        page,
      },
      response: {
        events: res.events,
        latestLedger: res.latestLedger,
        cursor: res.cursor,
      },
    };

    const target = path.join(opts.outDir, `page-${page}.json`);
    writeFileSync(target, JSON.stringify(fixture, null, 2) + '\n', 'utf8');

    if (res.events.length < opts.pageSize || !res.cursor) {
      break;
    }
    cursor = res.cursor;
  }

  return page;
}

async function main(): Promise<void> {
  const args = parseRecordArgs(process.argv.slice(2));
  console.log(`Recording RPC getEvents pages starting from ledger ${args.startLedger} into ${args.outDir}...`);
  const pages = await recordRpcPages(server, args);
  console.log(`Successfully recorded ${pages} RPC page(s).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

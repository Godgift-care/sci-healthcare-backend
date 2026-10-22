import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scValToNative, xdr } from '@stellar/stellar-sdk';
import type { rpc } from "@stellar/stellar-sdk";

type GetEventsParams = Parameters<rpc.Server["getEvents"]>[0];

import { env, INDEXED_CONTRACTS } from '../env.js';
import { server } from '../stellar/client.js';
import { TOPIC_FIELDS } from '../stellar/events.js';

/**
 * Captures one raw contract event per decoded event type from the configured
 * testnet deployment and saves it as a JSON fixture (#64).
 *
 * The decoder's unit tests build events by hand, so a test and the decoder
 * can share the same misunderstanding about which `#[topic]` field sits in
 * which topic position and both stay green. These fixtures are the ground
 * truth: the bytes are whatever the network actually published, taken
 * verbatim from `soroban-rpc getEvents`. A fixture must never be authored by
 * hand — the whole point is that a hand-written fixture can encode the same
 * mistake as the decoder.
 *
 * Usage:
 *   npm run fixtures:capture
 *
 * Env: the same variables the indexer uses — SOROBAN_RPC_URL(S),
 * NETWORK_PASSPHRASE, REGISTRY/VOUCHER/RECEIPT/FAUCET_CONTRACT_ID. Nothing
 * is hardcoded here; point it at whatever deployment you want captured.
 *
 * Options:
 *   --out <dir>        fixture directory (default: src/__tests__/fixtures)
 *   --window <ledgers> ledger span scanned per RPC call (default: 500)
 *   --max-ledgers <n>  stop after scanning n ledgers back from the tip
 *                      (default: the RPC's whole retention window)
 */

type Fixture = {
  _provenance: {
    capturedAt: string;
    networkPassphrase: string;
    source: 'soroban-rpc.getEvents';
    txHash: string;
    ledger: number;
  };
  /** The `EventResponse` exactly as the RPC returned it. */
  event: Record<string, unknown>;
};

function parseArgs(argv: string[]): { outDir: string; window: number; maxLedgers: number | null } {
  let outDir = path.resolve(fileURLToPath(import.meta.url), '../../__tests__/fixtures');
  let window = 500;
  let maxLedgers: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' && argv[i + 1]) outDir = path.resolve(argv[(i += 1)]!);
    else if (arg === '--window' && argv[i + 1]) window = Number(argv[++i]);
    else if (arg === '--max-ledgers' && argv[i + 1]) maxLedgers = Number(argv[++i]);
  }
  if (!Number.isInteger(window) || window < 1 || window > 500) {
    throw new Error('--window must be between 1 and 500 ledgers');
  }
  return { outDir, window, maxLedgers };
}

/**
 * base64 of a topic/value entry. The SDK types these as parsed `ScVal`s but
 * passes through the RPC's base64 strings at runtime; accept both, and
 * always *store* base64 so a fixture is the raw bytes regardless of SDK
 * version (the decoder's `toScVal` reads either).
 */
function scValBase64(input: unknown): string {
  return typeof input === 'string' ? input : (input as xdr.ScVal).toXDR('base64');
}

/** The event name in an RPC event's first topic entry (a symbol ScVal). */
function eventNameOf(raw: { topic: unknown[] }): string | null {
  try {
    const name = scValToNative(xdr.ScVal.fromXDR(scValBase64(raw.topic[0]), 'base64'));
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

const WANTED = new Set(Object.keys(TOPIC_FIELDS));

function buildFixture(raw: Record<string, unknown>): Fixture {
  const event: Record<string, unknown> = {
    ...raw,
    topic: (raw.topic as unknown[]).map(scValBase64),
    value: scValBase64(raw.value),
  };
  return {
    _provenance: {
      capturedAt: new Date().toISOString(),
      networkPassphrase: env.NETWORK_PASSPHRASE,
      source: 'soroban-rpc.getEvents',
      txHash: String(event.txHash),
      ledger: Number(event.ledger),
    },
    event,
  };
}

/** Pages one ledger window's contract events, filling `found` as it goes. */
async function scanWindow(lo: number, hi: number, found: Map<string, Fixture>): Promise<void> {
  const filters = [{ type: 'contract' as const, contractIds: [...INDEXED_CONTRACTS] }];
  let res = await getEventsWindow(lo, hi, filters);
  for (;;) {
    for (const raw of res.events) {
      const name = eventNameOf(raw);
      if (name === null || !WANTED.has(name) || found.has(name)) continue;
      found.set(name, buildFixture(raw as unknown as Record<string, unknown>));
    }
    if (res.events.length < 200 || found.size === WANTED.size) break;
    res = await server.getEvents({ cursor: res.cursor, filters, limit: 200 });
  }
}

/**
 * `getEvents` for a fixed window, re-clamping `lo` if the RPC's retention
 * window has already dropped it. The oldest retained ledger advances while
 * a full-history scan runs, so a window that was valid minutes ago can
 * fail with "startLedger must be within the ledger range" by request time.
 */
async function getEventsWindow(
  lo: number,
  hi: number,
  filters: GetEventsParams["filters"],
): Promise<Awaited<ReturnType<typeof server.getEvents>>> {
  const request = (from: number) =>
    server.getEvents({ startLedger: from, endLedger: hi, filters, limit: 200 });
  try {
    return await request(lo);
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err);
    const match = /startLedger must be within the ledger range: (\d+)/.exec(message);
    if (!match) throw err;
    return await request(Math.max(lo, Number(match[1])));
  }
}

async function scanHistory(
  oldest: number,
  latest: number,
  maxLedgers: number | null,
  window: number,
  found: Map<string, Fixture>,
): Promise<void> {
  const floor = maxLedgers === null ? oldest : Math.max(oldest, latest - maxLedgers + 1);
  // Newest first: the freshest event of each type is the most representative
  // capture, and dense recent history usually completes the set quickly.
  for (let hi = latest; hi >= floor && found.size < WANTED.size; hi -= window) {
    const lo = Math.max(floor, hi - window + 1);
    await scanWindow(lo, hi, found);
    process.stdout.write(
      `scanned ledgers ${lo}..${hi} — ${found.size}/${WANTED.size} types captured\n`,
    );
  }
}

function writeFixtures(outDir: string, found: Map<string, Fixture>): void {
  mkdirSync(outDir, { recursive: true });
  for (const [name, fixture] of found) {
    writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
  }
}

async function main(): Promise<void> {
  const { outDir, window, maxLedgers } = parseArgs(process.argv.slice(2));
  const health = await server.getHealth();
  process.stdout.write(
    `RPC ${env.SOROBAN_RPC_URL} healthy: ledgers ${health.oldestLedger}..${health.latestLedger} retained\n`,
  );

  const found = new Map<string, Fixture>();
  await scanHistory(health.oldestLedger, health.latestLedger, maxLedgers, window, found);
  writeFixtures(outDir, found);

  process.stdout.write(
    `\nwrote ${found.size} fixture(s) to ${outDir}:\n` +
      [...found.entries()]
        .map(
          ([name, f]) =>
            `  ${name}.json  tx ${f._provenance.txHash}  ledger ${f._provenance.ledger}`,
        )
        .join('\n') +
      '\n',
  );
  const missing = [...WANTED].filter((n) => !found.has(n));
  if (missing.length > 0) {
    process.stdout.write(`NOT CAPTURABLE from history (no fixture): ${missing.join(', ')}\n`);
    process.exitCode = 1;
  }
}

await main();

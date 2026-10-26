import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../db.js';

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_TABLES = [
  'deployment', 'provider', 'service', 'voucher', 'attester', 'receipt',
  'governanceEvent', 'providerStatusChange', 'servicePriceChange', 'contractEvent',
  'failedEvent', 'indexerState', 'faucetDrip', 'reconcileMismatch', 'webhookDelivery', 'dailyStat',
] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];
export type Snapshot = { version: number; exportedAt: string; tables: Record<SnapshotTable, unknown[]>; cursor: Record<string, unknown> | null };
type Model = { findMany: () => Promise<unknown[]>; count: () => Promise<number>; createMany: (args: { data: object[] }) => Promise<unknown> };
type Models = Record<SnapshotTable, Model>;

const DATE_FIELDS: Record<SnapshotTable, readonly string[]> = {
  deployment: ['createdAt'], provider: ['registeredAt', 'updatedAt', 'metadataFetchedAt'], service: [],
  voucher: ['createdAt', 'expiresAt', 'claimedAt', 'attestedAt', 'disputeDeadline', 'disputeResolvedAt', 'refundedAt', 'updatedAt'],
  attester: ['addedAt', 'removedAt', 'updatedAt'], receipt: ['settledAt'], governanceEvent: ['occurredAt'],
  providerStatusChange: ['changedAt'], servicePriceChange: ['changedAt'], contractEvent: ['closedAt'],
  failedEvent: ['firstSeen', 'lastSeen', 'resolvedAt'], indexerState: ['updatedAt', 'leaseExpiresAt'], faucetDrip: ['drippedAt'],
  reconcileMismatch: ['firstSeen', 'lastSeen'], webhookDelivery: ['nextAttemptAt', 'deliveredAt', 'abandonedAt', 'createdAt'], dailyStat: ['updatedAt'],
};

function modelsOf(client: PrismaClient | Prisma.TransactionClient): Models { return client as unknown as Models; }
function jsonSafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item));
}
function cursorOf(rows: unknown[]): Record<string, unknown> | null {
  const row = rows.find((item) => typeof item === 'object' && item !== null && (item as { id?: unknown }).id === 1);
  return row ? (jsonSafe(row) as Record<string, unknown>) : null;
}

export async function exportSnapshot(client: PrismaClient = prisma): Promise<Snapshot> {
  const db = modelsOf(client); const tables = {} as Record<SnapshotTable, unknown[]>;
  for (const table of SNAPSHOT_TABLES) tables[table] = jsonSafe(await db[table].findMany()) as unknown[];
  return { version: SNAPSHOT_VERSION, exportedAt: new Date().toISOString(), tables, cursor: cursorOf(tables.indexerState) };
}
export async function writeSnapshot(file: string, client: PrismaClient = prisma): Promise<Snapshot> {
  const snapshot = await exportSnapshot(client);
  await writeFile(file, gzipSync(JSON.stringify(snapshot)), { mode: 0o600 }); return snapshot;
}
function assertSnapshot(input: unknown): asserts input is Snapshot {
  if (typeof input !== 'object' || input === null) throw new Error('Snapshot must be a JSON object');
  const value = input as Partial<Snapshot>;
  if (value.version !== SNAPSHOT_VERSION) throw new Error(`Unsupported snapshot version: ${String(value.version)}`);
  if (!value.tables || typeof value.tables !== 'object') throw new Error('Snapshot is missing its tables');
  for (const table of SNAPSHOT_TABLES) if (!Array.isArray(value.tables[table])) throw new Error(`Snapshot table is missing: ${table}`);
  if (JSON.stringify(cursorOf(value.tables.indexerState)) !== JSON.stringify(value.cursor ?? null)) throw new Error('Snapshot cursor does not match its IndexerState table');
}
function restoreRow(table: SnapshotTable, input: unknown): object {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error(`Invalid row in snapshot table ${table}`);
  const row = { ...(input as Record<string, unknown>) };
  for (const field of DATE_FIELDS[table]) if (typeof row[field] === 'string') row[field] = new Date(row[field]);
  if (table === 'voucher' && typeof row.seq === 'string') row.seq = BigInt(row.seq);
  return row;
}
const IMPORT_ORDER: readonly SnapshotTable[] = [
  'deployment', 'provider', 'service', 'voucher', 'attester', 'receipt', 'governanceEvent', 'providerStatusChange',
  'servicePriceChange', 'contractEvent', 'failedEvent', 'indexerState', 'faucetDrip', 'reconcileMismatch', 'webhookDelivery', 'dailyStat',
];
export async function importSnapshot(snapshot: Snapshot, client: PrismaClient = prisma): Promise<void> {
  assertSnapshot(snapshot); const db = modelsOf(client);
  await client.$transaction(async (tx: Prisma.TransactionClient) => {
    const transactionDb = modelsOf(tx);
    for (const table of SNAPSHOT_TABLES) if ((await db[table].count()) !== 0) throw new Error(`Snapshot import requires an empty database; ${table} is not empty`);
    for (const table of IMPORT_ORDER) {
      const rows = snapshot.tables[table].map((row) => restoreRow(table, row));
      if (rows.length > 0) await transactionDb[table].createMany({ data: rows });
    }
  });
}
export async function readSnapshot(file: string): Promise<Snapshot> {
  const parsed: unknown = JSON.parse(gunzipSync(await readFile(file)).toString('utf8')); assertSnapshot(parsed); return parsed;
}

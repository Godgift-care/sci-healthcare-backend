import type { Prisma } from '@prisma/client';
import type { xdr } from '@stellar/stellar-sdk';

import { prisma } from '../db.js';
import { decodeEvent, type DecodedEvent } from './events.js';

type Db = Prisma.TransactionClient;

/** The shape of an RPC event that `decodeEvent` reads. */
type RawEvent = Parameters<typeof decodeEvent>[0];

/** RPC returns topics and value as parsed ScVals or base64 XDR by version. */
function toBase64(input: unknown): string {
  return typeof input === 'string' ? input : (input as xdr.ScVal).toXDR('base64');
}

/**
 * Serialises an RPC event so it can be decoded again later. Topics and value
 * are stored as base64 XDR, which `decodeEvent` accepts directly.
 */
export function serializeRaw(raw: RawEvent): string {
  return JSON.stringify({
    id: raw.id,
    contractId: String(raw.contractId),
    txHash: typeof raw.txHash === 'string' ? raw.txHash : undefined,
    ledger: raw.ledger,
    ledgerClosedAt: raw.ledgerClosedAt,
    topic: (raw.topic ?? []).map(toBase64),
    value: toBase64(raw.value),
  });
}

function messageOf(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000);
}

/**
 * Records an event that failed to project. Seeing the same id again (a
 * replay, a backfill, a retry) bumps `attempts` rather than adding a row.
 */
export async function recordFailure(
  db: Db,
  raw: RawEvent,
  decoded: DecodedEvent,
  err: unknown,
): Promise<void> {
  const now = new Date();
  const error = messageOf(err);
  await db.failedEvent.upsert({
    where: { id: decoded.id },
    create: {
      id: decoded.id,
      name: decoded.name,
      ledger: decoded.ledger,
      raw: serializeRaw(raw),
      error,
      attempts: 1,
      firstSeen: now,
      lastSeen: now,
    },
    update: { error, attempts: { increment: 1 }, lastSeen: now },
  });
}

export async function listFailed() {
  return prisma.failedEvent.findMany({
    where: { resolvedAt: null },
    select: { id: true, name: true, ledger: true, attempts: true, firstSeen: true, lastSeen: true },
    orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
  });
}

export async function showFailed(id: string) {
  const row = await prisma.failedEvent.findUnique({ where: { id } });
  if (!row || row.resolvedAt !== null) return null;
  const decoded = decodeEvent(JSON.parse(row.raw) as RawEvent);
  return {
    id: row.id,
    name: row.name,
    ledger: row.ledger,
    attempts: row.attempts,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    error: row.error,
    decoded,
  };
}

export type RetryResult = { retried: number; recovered: number; remaining: number };

/**
 * Re-decodes and re-applies every stored failed event. Rows that now succeed
 * have their `resolvedAt` stamped so they are marked resolved (and eventually
 * pruned by operational data retention); rows that still fail keep their place
 * with a bumped attempt count and the latest error.
 */
export async function retryFailed(apply: (e: DecodedEvent) => Promise<void>, id?: string): Promise<RetryResult> {
  const rows = await prisma.failedEvent.findMany({
    where: { resolvedAt: null, ...(id ? { id } : {}) },
    orderBy: [{ ledger: 'asc' }, { id: 'asc' }],
  });
  let recovered = 0;

  for (const row of rows) {
    try {
      const decoded = decodeEvent(JSON.parse(row.raw) as RawEvent);
      if (!decoded) throw new Error('event no longer decodes');
      await apply(decoded);
      await prisma.failedEvent.update({
        where: { id: row.id },
        data: { resolvedAt: new Date(), lastSeen: new Date() },
      });
      recovered += 1;
    } catch (err) {
      await prisma.failedEvent.update({
        where: { id: row.id },
        data: { error: messageOf(err), attempts: { increment: 1 }, lastSeen: new Date() },
      });
    }
  }

  return { retried: rows.length, recovered, remaining: rows.length - recovered };
}

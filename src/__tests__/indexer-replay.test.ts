import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { rpc } from '@stellar/stellar-sdk';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { Indexer } from '../stellar/indexer.js';
import type { RecordedPage } from '../scripts/record-rpc-fixtures.js';

function fakeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as FastifyBaseLogger;
}

const FIXTURES_DIR = path.resolve(fileURLToPath(import.meta.url), '../fixtures/rpc-replay');

describe('Indexer replay through recorded RPC responses (#145)', () => {
  const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
  const VOUCHER_ID = '888001';

  beforeEach(async () => {
    await prisma.receipt.deleteMany();
    await prisma.voucher.deleteMany();
    await prisma.service.deleteMany();
    await prisma.contractEvent.deleteMany();
    await prisma.failedEvent.deleteMany();
    await prisma.provider.deleteMany();

    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastLedger: 99 },
      update: {
        lastLedger: 99,
        leaseOwner: null,
        leaseExpiresAt: null,
        gap: false,
        gapOldestLedger: null,
        gapCursorLedger: null,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('replays multi-page recorded RPC getEvents responses through the indexer pipeline', async () => {
    const page1Raw: RecordedPage = JSON.parse(
      readFileSync(path.join(FIXTURES_DIR, 'page-1.json'), 'utf8'),
    );
    const page2Raw: RecordedPage = JSON.parse(
      readFileSync(path.join(FIXTURES_DIR, 'page-2.json'), 'utf8'),
    );

    // Fake RPC server serving the recorded fixture pages across page boundaries
    const fakeRpc: Pick<rpc.Server, 'getEvents' | 'getLatestLedger' | 'getHealth'> = {
      getHealth: async () => ({
        oldestLedger: 1,
        latestLedger: 105,
      } as never),
      getLatestLedger: async () => ({
        sequence: 105,
      } as never),
      getEvents: async (opts) => {
        if (opts.cursor === 'cursor-page-2') {
          return { events: [], latestLedger: 105 } as never;
        }
        if (opts.cursor === 'cursor-page-1') {
          return page2Raw.response as never;
        }
        return page1Raw.response as never;
      },
    };

    const indexer = new Indexer(fakeLog(), { rpcServer: fakeRpc, pageSize: 3 });

    // Tick the indexer: collects all pages, decodes payloads, and projects them
    const appliedCount = await indexer.tick();
    expect(appliedCount).toBe(6);

    // 1. Verify Provider projection
    const provider = await prisma.provider.findUnique({
      where: { address: CLINIC },
    });
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe('Ikeja General Clinic');
    expect(provider?.country).toBe('NG');
    expect(provider?.status).toBe('Pending');

    // 2. Verify Voucher lifecycle from Created -> Claimed -> Attested -> Settled
    const voucher = await prisma.voucher.findUnique({
      where: { id: VOUCHER_ID },
      include: { provider: true },
    });
    expect(voucher).not.toBeNull();
    expect(voucher?.amount).toBe('50000000');
    expect(voucher?.status).toBe('Settled');
    expect(voucher?.settledNet).toBe('49500000');
    expect(voucher?.settledFee).toBe('500000');
    expect(voucher?.claimedAt).not.toBeNull();
    expect(voucher?.attestedAt).not.toBeNull();

    // 3. Verify Receipt projection & referential integrity
    const receipt = await prisma.receipt.findUnique({
      where: { voucherId: VOUCHER_ID },
    });
    expect(receipt).not.toBeNull();
    expect(receipt?.voucherId).toBe(VOUCHER_ID);
    expect(receipt?.amount).toBe('50000000');
    expect(receipt?.providerAddress).toBe(CLINIC);

    // 4. Verify append-only ContractEvent audit rows
    const events = await prisma.contractEvent.findMany({
      where: { voucherId: VOUCHER_ID },
      orderBy: { ledger: 'asc' },
    });
    const eventNames = events.map((e) => e.name);
    expect(eventNames).toContain('voucher_created');
    expect(eventNames).toContain('voucher_claimed');
    expect(eventNames).toContain('voucher_attested');
    expect(eventNames).toContain('voucher_settled');

    // 5. Verify IndexerState cursor advancement & zero failures
    const state = await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } });
    expect(state.lastLedger).toBe(105);

    const failures = await prisma.failedEvent.count();
    expect(failures).toBe(0);
  });
});

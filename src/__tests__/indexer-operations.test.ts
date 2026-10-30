import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { exportSnapshot, importSnapshot, readSnapshot, writeSnapshot } from '../lib/snapshot.js';
import { server, validateContractIds } from '../stellar/client.js';
import { Indexer } from '../stellar/indexer.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';

function log(): FastifyBaseLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as FastifyBaseLogger;
}

async function clearDatabase(): Promise<void> {
  await prisma.$transaction([
    prisma.webhookDelivery.deleteMany(),
    prisma.receipt.deleteMany(),
    prisma.voucher.deleteMany(),
    prisma.service.deleteMany(),
    prisma.providerStatusChange.deleteMany(),
    prisma.servicePriceChange.deleteMany(),
    prisma.governanceEvent.deleteMany(),
    prisma.contractEvent.deleteMany(),
    prisma.failedEvent.deleteMany(),
    prisma.faucetDrip.deleteMany(),
    prisma.reconcileMismatch.deleteMany(),
    prisma.attester.deleteMany(),
    prisma.provider.deleteMany(),
    prisma.deployment.deleteMany(),
    prisma.indexerState.deleteMany(),
    prisma.dailyStat.deleteMany(),
  ]);
}

beforeEach(clearDatabase);
afterAll(async () => prisma.$disconnect());

describe('configured contract validation (#139)', () => {
  it('deduplicates ids and checks each contract instance', async () => {
    const calls: string[] = [];
    await validateContractIds(['registry', 'registry', 'voucher'], {
      getContractInstance: async (id) => {
        calls.push(id);
        return {} as never;
      },
    });
    expect(calls).toEqual(['registry', 'voucher']);
  });

  it('fails with the selected network and contract id when RPC cannot find one', async () => {
    await expect(validateContractIds(['wrong-contract'], {
      getContractInstance: async () => { throw new Error('not found'); },
    })).rejects.toThrow(`Configured contract wrong-contract was not found on ${env.STELLAR_NETWORK}`);
  });
});

describe('indexer pause control (#138)', () => {
  it('does not query or advance the cursor while paused', async () => {
    await prisma.indexerState.create({ data: { id: 1, lastLedger: 123, paused: true } });
    const health = vi.spyOn(server, 'getHealth');

    await expect(new Indexer(log()).tick()).resolves.toBe(0);
    expect(health).not.toHaveBeenCalled();
    expect(await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      lastLedger: 123,
      paused: true,
    });
  });
});

describe('missing voucher repair (#140)', () => {
  it('reads and creates an unseen voucher before applying its status event', async () => {
    const reader = vi.fn().mockResolvedValue({
      id: 1n,
      funder: FUNDER,
      beneficiary_ref: Buffer.from(REF, 'hex'),
      provider: CLINIC,
      service_code: 101,
      amount: 30_000_000n,
      status: 1,
      created_at: 1_759_276_800n,
      expires_at: 1_790_944_632n,
      claimed_at: 1_759_363_200n,
      attested_at: 0n,
      dispute_deadline: 0n,
    });
    const event = {
      name: 'voucher_claimed',
      fields: { voucher_id: 1n, claimed_at: 1_759_363_200n },
      contractId: env.VOUCHER_CONTRACT_ID,
      txHash: 'a'.repeat(64),
      ledger: 111,
      ledgerClosedAt: new Date('2025-10-02T00:00:00Z'),
      id: 'claim-111',
    };
    const indexer = new Indexer(log(), { voucherReader: reader });

    await indexer.applyEvent(event);
    await indexer.applyEvent(event);

    expect(reader).toHaveBeenCalledTimes(1);
    expect(await prisma.voucher.count({ where: { id: '1' } })).toBe(1);
    expect(await prisma.voucher.findUniqueOrThrow({ where: { id: '1' } })).toMatchObject({
      funder: FUNDER,
      providerAddress: CLINIC,
      status: 'Claimed',
      amount: '30000000',
    });
    expect(await prisma.provider.count({ where: { address: CLINIC } })).toBe(1);
  }, 30_000);
});

describe('read-model snapshots (#141)', () => {
  it('round-trips compressed tables and the cursor into an empty database', async () => {
    await prisma.provider.create({
      data: { address: CLINIC, name: 'Clinic', country: 'NG', status: 'Active', registeredAt: new Date(0) },
    });
    await prisma.voucher.create({
      data: {
        id: '18446744073709551615', funder: FUNDER, beneficiaryRef: REF,
        providerAddress: CLINIC, serviceCode: 101, amount: '30000000', status: 'Funded',
        seq: 9007199254740993n,
        createdAt: new Date('2025-10-01T00:00:00Z'), expiresAt: new Date('2026-10-01T00:00:00Z'),
      },
    });
    await prisma.indexerState.create({ data: { id: 1, lastLedger: 456, paused: true } });

    const directory = await mkdtemp(join(tmpdir(), 'sci-snapshot-'));
    const file = join(directory, 'snapshot.json.gz');
    try {
      await writeSnapshot(file);
      const snapshot = await readSnapshot(file);
      await clearDatabase();
      await importSnapshot(snapshot);

      expect(await prisma.voucher.findUniqueOrThrow({ where: { id: '18446744073709551615' } })).toMatchObject({
        providerAddress: CLINIC,
        amount: '30000000',
        seq: 9007199254740993n,
      });
      expect(await prisma.indexerState.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
        lastLedger: 456,
        paused: true,
      });
      expect((await exportSnapshot()).cursor?.lastLedger).toBe(456);
    } finally {
      await rm(directory, { recursive: true, force: true });
      await clearDatabase();
    }
  });
});

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { isPostgres } from '../lib/database.js';
import { verifyReferentialIntegrity } from '../lib/referential-integrity.js';

describe('Referential integrity verification (#144)', () => {
  const PROVIDER = 'GAPROVIDER1111111111111111111111111111111111111111111111111';
  const VOUCHER_ID = '999001';

  beforeEach(async () => {
    await prisma.receipt.deleteMany();
    await prisma.voucher.deleteMany();
    await prisma.service.deleteMany();
    await prisma.providerStatusChange.deleteMany();
    await prisma.servicePriceChange.deleteMany();
    await prisma.contractEvent.deleteMany();
    await prisma.provider.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('reports zero orphans on clean relational data', async () => {
    await prisma.provider.create({
      data: {
        address: PROVIDER,
        name: 'Clinic Alpha',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date('2026-10-01T00:00:00Z'),
      },
    });

    await prisma.service.create({
      data: {
        id: `${PROVIDER}:101`,
        providerAddress: PROVIDER,
        code: 101,
        label: 'Consultation',
        price: '25000000',
      },
    });

    await prisma.voucher.create({
      data: {
        id: VOUCHER_ID,
        providerAddress: PROVIDER,
        funder: 'GAFUNDER1111111111111111111111111111111111111111111111111',
        beneficiaryRef: '00'.repeat(32),
        serviceCode: 101,
        amount: '25000000',
        status: 'Settled',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        expiresAt: new Date('2026-11-01T00:00:00Z'),
      },
    });

    await prisma.receipt.create({
      data: {
        voucherId: VOUCHER_ID,
        providerAddress: PROVIDER,
        beneficiaryRef: '00'.repeat(32),
        serviceCode: 101,
        amount: '25000000',
        settledAt: new Date('2026-10-02T00:00:00Z'),
      },
    });

    await prisma.contractEvent.create({
      data: {
        id: 'evt-1',
        contractId: 'C'.repeat(56),
        contract: 'voucher',
        name: 'voucher_settled',
        ledger: 10,
        txHash: 'a'.repeat(64),
        closedAt: new Date('2026-10-02T00:00:00Z'),
        voucherId: VOUCHER_ID,
        data: '{}',
      },
    });

    const report = await verifyReferentialIntegrity(prisma);
    expect(report.totalOrphans).toBe(0);
    expect(report.orphanedReceipts).toHaveLength(0);
    expect(report.orphanedServices).toHaveLength(0);
    expect(report.orphanedEvents).toHaveLength(0);
  }, 20000);

  it('detects orphaned receipts, services, and events', async () => {
    // 1. Orphaned receipt: references non-existent voucher and non-existent provider
    await prisma.receipt.create({
      data: {
        voucherId: 'ghost-voucher',
        beneficiaryRef: '0000',
        providerAddress: 'ghost-provider',
        serviceCode: 99,
        amount: '1000',
        settledAt: new Date('2026-10-01T00:00:00Z'),
      },
    });

    // 2. Orphaned contract event: references non-existent voucher
    await prisma.contractEvent.create({
      data: {
        id: 'evt-orphan',
        contractId: 'C'.repeat(56),
        contract: 'voucher',
        name: 'voucher_created',
        ledger: 10,
        txHash: 'b'.repeat(64),
        closedAt: new Date(),
        voucherId: 'ghost-voucher',
        data: '{}',
      },
    });

    // 3. Orphaned provider status change
    await prisma.providerStatusChange.create({
      data: {
        id: 'psc-orphan',
        providerAddress: 'ghost-provider',
        status: 'Active',
        ledger: 10,
        changedAt: new Date(),
      },
    });

    // 4. Orphaned service price change
    await prisma.servicePriceChange.create({
      data: {
        id: 'spc-orphan',
        providerAddress: 'ghost-provider',
        code: 99,
        price: '1000',
        ledger: 10,
        changedAt: new Date(),
      },
    });

    // In SQLite, temporarily disable foreign key enforcement to simulate an orphaned Service row
    if (!isPostgres) {
      await prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF;');
      await prisma.$executeRawUnsafe(`
        INSERT INTO "Service" ("id", "code", "label", "price", "active", "providerAddress")
        VALUES ('ghost-provider:99', 99, 'Ghost Service', '1000', 1, 'ghost-provider')
      `);
      await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON;');
    }

    const report = await verifyReferentialIntegrity(prisma);
    expect(report.totalOrphans).toBeGreaterThanOrEqual(4);
    expect(report.orphanedReceipts.some((r) => r.voucherId === 'ghost-voucher')).toBe(true);
    if (!isPostgres) {
      expect(report.orphanedServices.some((s) => s.providerAddress === 'ghost-provider')).toBe(true);
    }
    expect(report.orphanedEvents.some((e) => e.id === 'evt-orphan')).toBe(true);
    expect(report.orphanedEvents.some((e) => e.id === 'psc-orphan')).toBe(true);
    expect(report.orphanedEvents.some((e) => e.id === 'spc-orphan')).toBe(true);
  }, 20000);
});

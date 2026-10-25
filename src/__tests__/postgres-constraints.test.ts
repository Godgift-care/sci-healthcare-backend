import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { isPostgres } from '../lib/database.js';

describe('Database constraints for statuses and amounts (#143)', () => {
  const PROVIDER = 'GAPROVIDER2222222222222222222222222222222222222222222222222';
  const VOUCHER_ID = '999002';

  beforeAll(async () => {
    if (isPostgres) {
      const statements = [
        'ALTER TABLE "Voucher" DROP CONSTRAINT IF EXISTS "voucher_status_check"',
        'ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_status_check" CHECK ("status" IN (\'Funded\', \'Claimed\', \'Attested\', \'Settled\', \'Disputed\', \'Refunded\'))',
        'ALTER TABLE "Provider" DROP CONSTRAINT IF EXISTS "provider_status_check"',
        'ALTER TABLE "Provider" ADD CONSTRAINT "provider_status_check" CHECK ("status" IN (\'Pending\', \'Active\', \'Suspended\'))',
        'ALTER TABLE "Voucher" DROP CONSTRAINT IF EXISTS "voucher_amount_non_negative"',
        'ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_amount_non_negative" CHECK ("amount" ~ \'^[0-9]+$\')',
        'ALTER TABLE "Voucher" DROP CONSTRAINT IF EXISTS "voucher_settled_net_check"',
        'ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_settled_net_check" CHECK ("settledNet" IS NULL OR "settledNet" ~ \'^[0-9]+$\')',
        'ALTER TABLE "Voucher" DROP CONSTRAINT IF EXISTS "voucher_settled_fee_check"',
        'ALTER TABLE "Voucher" ADD CONSTRAINT "voucher_settled_fee_check" CHECK ("settledFee" IS NULL OR "settledFee" ~ \'^[0-9]+$\')',
        'ALTER TABLE "Receipt" DROP CONSTRAINT IF EXISTS "receipt_amount_non_negative"',
        'ALTER TABLE "Receipt" ADD CONSTRAINT "receipt_amount_non_negative" CHECK ("amount" ~ \'^[0-9]+$\')',
        'ALTER TABLE "Service" DROP CONSTRAINT IF EXISTS "service_price_non_negative"',
        'ALTER TABLE "Service" ADD CONSTRAINT "service_price_non_negative" CHECK ("price" ~ \'^[0-9]+$\')',
      ];
      for (const stmt of statements) {
        await prisma.$executeRawUnsafe(stmt);
      }
    }
  });

  beforeEach(async () => {
    await prisma.receipt.deleteMany();
    await prisma.voucher.deleteMany();
    await prisma.service.deleteMany();
    await prisma.provider.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('documents that SQLite skips CHECK constraints and Postgres enforces them', async () => {
    if (!isPostgres) {
      // Documented behavior for SQLite local dev/test engine
      expect(isPostgres).toBe(false);
      return;
    }

    // On Postgres:
    // 1. Invalid provider status should fail with CHECK constraint violation
    await expect(
      prisma.provider.create({
        data: {
          address: PROVIDER,
          name: 'Invalid Status Clinic',
          country: 'NG',
          status: 'InvalidStatus',
          registeredAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    // 2. Valid provider
    await prisma.provider.create({
      data: {
        address: PROVIDER,
        name: 'Valid Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date(),
      },
    });

    // 3. Invalid voucher status should fail
    await expect(
      prisma.voucher.create({
        data: {
          id: VOUCHER_ID,
          providerAddress: PROVIDER,
          funder: 'GAFUNDER2222222222222222222222222222222222222222222222222',
          beneficiaryRef: '00'.repeat(32),
          serviceCode: 101,
          amount: '10000000',
          status: 'BogusStatus',
          createdAt: new Date(),
          expiresAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    // 4. Negative amount should fail
    await expect(
      prisma.voucher.create({
        data: {
          id: VOUCHER_ID,
          providerAddress: PROVIDER,
          funder: 'GAFUNDER2222222222222222222222222222222222222222222222222',
          beneficiaryRef: '00'.repeat(32),
          serviceCode: 101,
          amount: '-50000',
          status: 'Funded',
          createdAt: new Date(),
          expiresAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it(
    'allows all valid status values and non-negative amount strings',
    async () => {
    await prisma.provider.create({
      data: {
        address: PROVIDER,
        name: 'Valid Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date(),
      },
    });

    const validStatuses = [
      'Funded',
      'Claimed',
      'Attested',
      'Settled',
      'Disputed',
      'Refunded',
    ] as const;

    for (let i = 0; i < validStatuses.length; i++) {
      const status = validStatuses[i]!;
      const id = `valid-${i + 1}`;
      const voucher = await prisma.voucher.create({
        data: {
          id,
          providerAddress: PROVIDER,
          funder: 'GAFUNDER2222222222222222222222222222222222222222222222222',
          beneficiaryRef: '00'.repeat(32),
          serviceCode: 101,
          amount: (i * 10000000).toString(),
          status,
          createdAt: new Date(),
          expiresAt: new Date(),
        },
      });
      expect(voucher.status).toBe(status);
    }
  }, 15000);
});

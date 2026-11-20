import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { decimalsToStrings, prisma } from '../db.js';
import { isPostgres } from '../lib/database.js';

/** The largest i128, 39 digits. */
const I128_MAX = '170141183460469231731687303715884105727';

describe('decimalsToStrings (#273)', () => {
  it('turns Decimals into exact plain strings, never exponent notation', () => {
    expect(decimalsToStrings(new Prisma.Decimal(I128_MAX))).toBe(I128_MAX);
    expect(decimalsToStrings(new Prisma.Decimal('1000000000000000000000000'))).toBe(
      '1000000000000000000000000',
    );
    expect(decimalsToStrings(new Prisma.Decimal(0))).toBe('0');
  });

  it('walks rows, arrays and nested includes and leaves other values alone', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    const out = decimalsToStrings({
      id: '1',
      seq: 5n,
      amount: new Prisma.Decimal('30000000'),
      settledNet: null,
      createdAt: when,
      services: [{ price: new Prisma.Decimal('7') }],
    });
    expect(out).toEqual({
      id: '1',
      seq: 5n,
      amount: '30000000',
      settledNet: null,
      createdAt: when,
      services: [{ price: '7' }],
    });
    expect(out.createdAt).toBe(when);
    expect(decimalsToStrings(null)).toBeNull();
    expect(decimalsToStrings('already a string')).toBe('already a string');
  });
});

describe('amount columns round-trip as strings', () => {
  const PROVIDER = 'GAMOUNTNUMERIC2222222222222222222222222222222222222222222';

  beforeAll(async () => {
    await prisma.provider.create({
      data: {
        address: PROVIDER,
        name: 'Numeric Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
  });

  afterAll(async () => {
    await prisma.voucher.deleteMany({ where: { providerAddress: PROVIDER } });
    await prisma.provider.deleteMany({ where: { address: PROVIDER } });
  });

  it('stores and returns the i128 maximum exactly, as strings, on either engine', async () => {
    await prisma.voucher.create({
      data: {
        id: 'amount-numeric-1',
        funder: 'GF',
        beneficiaryRef: 'r'.repeat(64),
        providerAddress: PROVIDER,
        serviceCode: 1,
        amount: I128_MAX,
        status: 'Settled',
        settledNet: I128_MAX,
        settledFee: '0',
        createdAt: new Date(),
        expiresAt: new Date(),
      },
    });
    const row = await prisma.voucher.findUniqueOrThrow({ where: { id: 'amount-numeric-1' } });
    expect(row.amount).toBe(I128_MAX);
    expect(typeof row.amount).toBe('string');
    expect(row.settledNet).toBe(I128_MAX);
    expect(row.settledFee).toBe('0');
  });

  it.skipIf(!isPostgres)('is NUMERIC(39,0) in the database and sums exactly in SQL', async () => {
    const cols = await prisma.$queryRaw<{ column_name: string; data_type: string; p: number }[]>`
      SELECT column_name, data_type, numeric_precision AS p
      FROM information_schema.columns
      WHERE table_name = 'Voucher' AND column_name IN ('amount', 'settledNet', 'settledFee')`;
    expect(cols).toHaveLength(3);
    for (const c of cols) {
      expect(c.data_type).toBe('numeric');
      expect(c.p).toBe(39);
    }
    const [sum] = await prisma.$queryRaw<{ total: string }[]>`
      SELECT SUM("amount")::text AS total FROM "Voucher" WHERE id = 'amount-numeric-1'`;
    expect(sum?.total).toBe(I128_MAX);
  });
});

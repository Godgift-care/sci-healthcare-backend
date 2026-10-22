import type { FastifyInstance } from 'fastify';
import fc from 'fast-check';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';

const PROPERTY_FUNDER = 'F'.repeat(56);
const PROPERTY_PROVIDER = 'P'.repeat(56);
const PROPERTY_REF = 'a'.repeat(64);
const BASE_TIME = Date.UTC(2026, 0, 1, 12, 0, 0);

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await prisma.voucher.deleteMany({ where: { funder: PROPERTY_FUNDER } });
  await prisma.provider.upsert({
    where: { address: PROPERTY_PROVIDER },
    create: {
      address: PROPERTY_PROVIDER,
      name: 'Property Test Clinic',
      country: 'NG',
      status: 'Active',
      registeredAt: new Date(BASE_TIME),
    },
    update: {},
  });
});

afterEach(async () => {
  await prisma.voucher.deleteMany({ where: { funder: PROPERTY_FUNDER } });
  await prisma.provider.deleteMany({ where: { address: PROPERTY_PROVIDER } });
});

function queryString(entries: ReadonlyArray<readonly [string, string]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of entries) params.append(key, value);
  return params.toString();
}

describe('cursor pagination properties (#146)', () => {
  it('returns every voucher exactly once when timestamps tie', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 16 }),
        fc.integer({ min: 1, max: 7 }),
        async (timestampBuckets, limit) => {
          await prisma.voucher.deleteMany({ where: { funder: PROPERTY_FUNDER } });
          await prisma.voucher.createMany({
            data: timestampBuckets.map((bucket, index) => {
              const id = String(index + 1);
              return {
                id,
                seq: BigInt(id),
                funder: PROPERTY_FUNDER,
                beneficiaryRef: PROPERTY_REF,
                providerAddress: PROPERTY_PROVIDER,
                serviceCode: 1,
                amount: '1',
                status: 'Funded',
                createdAt: new Date(BASE_TIME - bucket * 1000),
                expiresAt: new Date(BASE_TIME + 86_400_000),
              };
            }),
          });

          const expected = timestampBuckets
            .map((bucket, index) => ({
              id: String(index + 1),
              createdAt: BASE_TIME - bucket * 1000,
            }))
            .sort((a, b) => b.createdAt - a.createdAt || Number(BigInt(b.id) - BigInt(a.id)))
            .map(({ id }) => id);

          const seen: string[] = [];
          let cursor: string | null | undefined;
          let page = 0;
          do {
            const params = new URLSearchParams({ funder: PROPERTY_FUNDER, limit: String(limit) });
            if (cursor) params.set('cursor', cursor);
            const response = await app.inject({
              method: 'GET',
              url: `/vouchers?${params}`,
              headers: { 'x-forwarded-for': `10.0.${page}.1` },
            });
            expect(response.statusCode).toBe(200);
            const body = response.json() as {
              nextCursor?: string | null;
              vouchers: { id: string }[];
            };
            seen.push(...body.vouchers.map((voucher) => voucher.id));
            cursor = body.nextCursor;
            page += 1;
            expect(page).toBeLessThanOrEqual(expected.length + 1);
          } while (cursor);

          expect(seen).toEqual(expected);
          expect(new Set(seen).size).toBe(expected.length);
        },
      ),
      { numRuns: 30 },
    );
  }, 30_000);
});

describe('list-query fuzz properties (#147)', () => {
  it('returns a handled response for arbitrary query strings', async () => {
    const routes = [
      '/vouchers',
      '/vouchers.csv',
      '/vouchers/due',
      '/providers',
      '/receipts',
      '/receipts/summary',
      '/attesters',
      '/services',
      '/countries',
      '/stats/daily',
      '/governance',
    ];
    let request = 0;

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.string({ minLength: 0, maxLength: 32 }),
            fc.string({ minLength: 0, maxLength: 256 }),
          ),
          { maxLength: 8 },
        ),
        async (entries) => {
          const query = queryString(entries);
          for (const route of routes) {
            request += 1;
            const response = await app.inject({
              method: 'GET',
              url: query === '' ? route : `${route}?${query}`,
              headers: { 'x-forwarded-for': `10.${(request >>> 8) & 255}.${request & 255}.1` },
            });
            expect([200, 400]).toContain(response.statusCode);
          }
        },
      ),
      { numRuns: 50 },
    );
  }, 30_000);
});

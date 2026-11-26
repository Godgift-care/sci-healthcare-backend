import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { reconcileRegistry, type RegistryReader } from '../stellar/reconcile-registry.js';

const ADDRESS = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';

const read: RegistryReader = {
  provider: async () => ({ name: 'Chain Clinic', country: 'NG', status: 1 }),
  services: async () => [
    { code: 7, label: 'Consultation', price: 20000000000000000000n, active: true, available: false },
  ],
  service: async () => null,
};

beforeEach(async () => {
  await prisma.reconcileMismatch.deleteMany();
  await prisma.service.deleteMany();
  await prisma.voucher.deleteMany();
  await prisma.provider.deleteMany();
  await prisma.provider.create({
    data: {
      address: ADDRESS,
      name: 'Stale Clinic',
      country: 'KE',
      status: 'Pending',
      registeredAt: new Date(0),
      services: {
        create: {
          id: `${ADDRESS}:7`,
          code: 7,
          label: 'Consultation',
          price: '100',
          active: true,
          available: true,
        },
      },
    },
  });
});

afterAll(async () => {
  await prisma.reconcileMismatch.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
});

describe('registry reconciliation', () => {
  it('reports provider, price and availability drift without changing the read model', async () => {
    const result = await reconcileRegistry({ read });
    expect(result.mismatched).toBe(2);
    expect(result.fixed).toBe(0);
    const mismatches = await prisma.reconcileMismatch.findMany();
    expect(mismatches.map((row) => row.kind).sort()).toEqual(['provider', 'service']);
    expect(mismatches.find((row) => row.kind === 'service')?.fields).toContain('"field":"price"');
    expect((await prisma.service.findUniqueOrThrow({ where: { id: `${ADDRESS}:7` } })).price).toBe('100');
  });

  it('repairs from the registry and clears mismatch records', async () => {
    const result = await reconcileRegistry({ read, fix: true });
    expect(result.fixed).toBe(2);
    expect(await prisma.reconcileMismatch.count()).toBe(0);
    expect((await prisma.provider.findUniqueOrThrow({ where: { address: ADDRESS } })).name).toBe('Chain Clinic');
    const service = await prisma.service.findUniqueOrThrow({ where: { id: `${ADDRESS}:7` } });
    expect(service.price).toBe('20000000000000000000');
    expect(service.available).toBe(false);
  });

  it('does not mistake an unreadable registry for a missing provider', async () => {
    const result = await reconcileRegistry({
      read: { ...read, provider: async () => { throw new Error('RPC offline'); } },
      fix: true,
    });
    expect(result.errors).toBe(1);
    expect(result.fixed).toBe(0);
    expect(await prisma.reconcileMismatch.count()).toBe(0);
  });

  it('reads inactive services individually because get_services excludes them', async () => {
    const result = await reconcileRegistry({
      read: {
        ...read,
        services: async () => [],
        service: async () => ({
          code: 7,
          label: 'Consultation',
          price: 500n,
          active: false,
          available: false,
        }),
      },
      fix: true,
    });
    expect(result.fixed).toBe(2);
    expect((await prisma.service.findUniqueOrThrow({ where: { id: `${ADDRESS}:7` } })).active).toBe(false);
  });
});

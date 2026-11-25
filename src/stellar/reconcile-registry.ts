import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { asAmount, asNumber, providerStatusName } from './events.js';
import { readContract } from './client.js';
import type { FieldDiff } from './reconcile.js';

export type ChainProvider = {
  name: unknown;
  country: unknown;
  status: unknown;
};
export type ChainService = {
  code: unknown;
  label: unknown;
  price: unknown;
  active: unknown;
  available: unknown;
};
export type RegistryReader = {
  provider: (address: string) => Promise<ChainProvider>;
  services: (address: string, codes: number[]) => Promise<ChainService[]>;
  service: (address: string, code: number) => Promise<ChainService | null>;
};
export type RegistryResult = {
  checked: number;
  matched: number;
  mismatched: number;
  fixed: number;
  errors: number;
};

const addressArg = (address: string) => nativeToScVal(address, { type: 'address' });
const codeArg = (code: number) => nativeToScVal(code, { type: 'u32' });

export const registryReader: RegistryReader = {
  provider: (address) =>
    readContract<ChainProvider>(env.REGISTRY_CONTRACT_ID, 'get_provider', [addressArg(address)]),
  services: (address, codes) =>
    readContract<ChainService[]>(env.REGISTRY_CONTRACT_ID, 'get_services', [
      addressArg(address),
      xdr.ScVal.scvVec(codes.map(codeArg)),
    ]),
  service: async (address, code) => {
    try {
      return await readContract<ChainService>(env.REGISTRY_CONTRACT_ID, 'get_service', [
        addressArg(address),
        codeArg(code),
      ]);
    } catch (error) {
      // An unreadable service is not evidence that it was removed.
      throw error;
    }
  },
};

const value = (input: unknown) => String(input);
const diff = (field: string, db: unknown, chain: unknown): FieldDiff[] =>
  value(db) === value(chain) ? [] : [{ field, db: value(db), chain: value(chain) }];

async function record(key: string, kind: 'provider' | 'service', fields: FieldDiff[]) {
  const now = new Date();
  await prisma.reconcileMismatch.upsert({
    where: { voucherId: key },
    create: {
      voucherId: key,
      kind,
      fields: JSON.stringify(fields),
      runs: 1,
      firstSeen: now,
      lastSeen: now,
    },
    update: { kind, fields: JSON.stringify(fields), runs: { increment: 1 }, lastSeen: now },
  });
}

/**
 * Reconcile known providers and their known service codes.
 * get_services returns ACTIVE services only. For codes absent from its
 * response, get_service is required to distinguish inactive from missing.
 */
export async function reconcileRegistry({
  read = registryReader,
  fix = false,
}: {
  read?: RegistryReader;
  fix?: boolean;
} = {}): Promise<RegistryResult> {
  const result: RegistryResult = { checked: 0, matched: 0, mismatched: 0, fixed: 0, errors: 0 };
  const providers = await prisma.provider.findMany({
    include: { services: { orderBy: { code: 'asc' } } },
    orderBy: { address: 'asc' },
  });

  for (const provider of providers) {
    const key = `provider:${provider.address}`;
    try {
      const chain = await read.provider(provider.address);
      const status = providerStatusName(chain.status);
      const name = String(chain.name);
      const country = String(chain.country);
      const fields = [
        ...diff('name', provider.name, name),
        ...diff('country', provider.country, country),
        ...diff('status', provider.status, status),
      ];
      result.checked++;
      if (fields.length) {
        result.mismatched++;
        await record(key, 'provider', fields);
        if (fix) {
          await prisma.provider.update({
            where: { address: provider.address },
            data: { name, country, status },
          });
          await prisma.reconcileMismatch.delete({ where: { voucherId: key } });
          result.fixed++;
        }
      } else {
        result.matched++;
        await prisma.reconcileMismatch.deleteMany({ where: { voucherId: key } });
      }
    } catch {
      result.errors++;
      // Never repair a provider when the chain read failed.
      continue;
    }

    const codes = provider.services.map((service) => service.code);
    if (!codes.length) continue;
    let activeServices: ChainService[];
    try {
      activeServices = await read.services(provider.address, codes);
    } catch {
      result.errors += codes.length;
      continue;
    }
    const activeByCode = new Map(activeServices.map((item) => [asNumber(item.code), item]));

    for (const service of provider.services) {
      const serviceKey = `service:${service.id}`;
      try {
        // Inactive services are omitted from get_services, not deleted.
        const chain =
          activeByCode.get(service.code) ??
          (await read.service(provider.address, service.code));
        if (!chain) {
          result.errors++;
          continue;
        }
        const price = asAmount(chain.price);
        const label = String(chain.label);
        const active = Boolean(chain.active);
        const available = Boolean(chain.available);
        const fields = [
          ...diff('price', service.price, price),
          ...diff('label', service.label, label),
          ...diff('active', service.active, active),
          ...diff('available', service.available, available),
        ];
        result.checked++;
        if (fields.length) {
          result.mismatched++;
          await record(serviceKey, 'service', fields);
          if (fix) {
            await prisma.service.update({
              where: { id: service.id },
              data: { price, label, active, available },
            });
            await prisma.reconcileMismatch.delete({ where: { voucherId: serviceKey } });
            result.fixed++;
          }
        } else {
          result.matched++;
          await prisma.reconcileMismatch.deleteMany({ where: { voucherId: serviceKey } });
        }
      } catch {
        result.errors++;
      }
    }
  }
  return result;
}

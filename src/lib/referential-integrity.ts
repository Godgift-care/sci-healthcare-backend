import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '../db.js';

export type OrphanedReceipt = {
  voucherId: string;
  reason: string;
};

export type OrphanedService = {
  id: string;
  providerAddress: string;
  reason: string;
};

export type OrphanedEvent = {
  id: string;
  type: 'ContractEvent' | 'ProviderStatusChange' | 'ServicePriceChange';
  reason: string;
};

export type IntegrityReport = {
  orphanedReceipts: OrphanedReceipt[];
  orphanedServices: OrphanedService[];
  orphanedEvents: OrphanedEvent[];
  totalOrphans: number;
};

/**
 * Checks the database for orphaned rows across core entities:
 * 1. Receipts referencing non-existent Vouchers or non-existent Providers.
 * 2. Services referencing non-existent Providers.
 * 3. Operational and governance events referencing non-existent entities:
 *    - ContractEvents linked to non-existent Vouchers.
 *    - ProviderStatusChanges linked to non-existent Providers.
 *    - ServicePriceChanges linked to non-existent Providers.
 */
export async function verifyReferentialIntegrity(
  client: PrismaClient | Prisma.TransactionClient = defaultPrisma,
): Promise<IntegrityReport> {
  const [
    vouchers,
    providers,
    receipts,
    services,
    contractEventsWithVouchers,
    statusChanges,
    priceChanges,
  ] = await Promise.all([
    client.voucher.findMany({ select: { id: true } }),
    client.provider.findMany({ select: { address: true } }),
    client.receipt.findMany({ select: { voucherId: true, providerAddress: true } }),
    client.service.findMany({ select: { id: true, providerAddress: true } }),
    client.contractEvent.findMany({
      where: { voucherId: { not: null } },
      select: { id: true, voucherId: true },
    }),
    client.providerStatusChange.findMany({ select: { id: true, providerAddress: true } }),
    client.servicePriceChange.findMany({ select: { id: true, providerAddress: true } }),
  ]);

  const voucherIds = new Set(vouchers.map((v) => v.id));
  const providerAddresses = new Set(providers.map((p) => p.address));

  const orphanedReceipts: OrphanedReceipt[] = [];
  for (const r of receipts) {
    if (!voucherIds.has(r.voucherId)) {
      orphanedReceipts.push({
        voucherId: r.voucherId,
        reason: `Receipt references non-existent voucher '${r.voucherId}'`,
      });
    }
    if (!providerAddresses.has(r.providerAddress)) {
      orphanedReceipts.push({
        voucherId: r.voucherId,
        reason: `Receipt references non-existent provider '${r.providerAddress}'`,
      });
    }
  }

  const orphanedServices: OrphanedService[] = [];
  for (const s of services) {
    if (!providerAddresses.has(s.providerAddress)) {
      orphanedServices.push({
        id: s.id,
        providerAddress: s.providerAddress,
        reason: `Service references non-existent provider '${s.providerAddress}'`,
      });
    }
  }

  const orphanedEvents: OrphanedEvent[] = [];
  for (const ce of contractEventsWithVouchers) {
    if (ce.voucherId && !voucherIds.has(ce.voucherId)) {
      orphanedEvents.push({
        id: ce.id,
        type: 'ContractEvent',
        reason: `ContractEvent references non-existent voucher '${ce.voucherId}'`,
      });
    }
  }

  for (const sc of statusChanges) {
    if (!providerAddresses.has(sc.providerAddress)) {
      orphanedEvents.push({
        id: sc.id,
        type: 'ProviderStatusChange',
        reason: `ProviderStatusChange references non-existent provider '${sc.providerAddress}'`,
      });
    }
  }

  for (const pc of priceChanges) {
    if (!providerAddresses.has(pc.providerAddress)) {
      orphanedEvents.push({
        id: pc.id,
        type: 'ServicePriceChange',
        reason: `ServicePriceChange references non-existent provider '${pc.providerAddress}'`,
      });
    }
  }

  const totalOrphans =
    orphanedReceipts.length + orphanedServices.length + orphanedEvents.length;

  return {
    orphanedReceipts,
    orphanedServices,
    orphanedEvents,
    totalOrphans,
  };
}

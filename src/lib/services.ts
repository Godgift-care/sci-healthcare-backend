import { prisma } from '../db.js';

/** Service rows are keyed `{providerAddress}:{code}` by the indexer. */
export function serviceKey(providerAddress: string, code: number): string {
  return `${providerAddress}:${code}`;
}

/**
 * Looks up catalog labels for a batch of (provider, code) pairs in one
 * query, so a voucher list can say "Antenatal visit" instead of "101".
 *
 * Delisted services keep their row (marked inactive), so vouchers funded
 * against a service that was later removed still resolve a label.
 */
export async function serviceLabels(
  rows: readonly { providerAddress: string; serviceCode: number }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((r) => serviceKey(r.providerAddress, r.serviceCode)))];
  if (ids.length === 0) return new Map();

  const services = await prisma.service.findMany({
    where: { id: { in: ids } },
    select: { id: true, label: true },
  });
  return new Map(services.map((s) => [s.id, s.label]));
}

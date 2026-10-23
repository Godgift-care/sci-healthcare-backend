import { prisma } from '../db.js';

/** Service rows are keyed `{providerAddress}:{code}` by the indexer. */
export function serviceKey(providerAddress: string, code: number): string {
  return `${providerAddress}:${code}`;
}

/**
 * Returns the most-funded service codes, ranked by total voucher value.
 *
 * Each entry carries the count and summed value per (provider, code) pair,
 * with the catalog label resolved where available. Results are sorted by
 * value descending and capped at `limit`.
 */
export async function topFundedServices(
  vouchers: readonly { providerAddress: string; serviceCode: number; value: number }[],
  limit: number,
): Promise<{ id: string; serviceCode: number; providerAddress: string; label: string | null; count: number; value: number }[]> {
  const totals = new Map<string, { providerAddress: string; serviceCode: number; count: number; value: number }>();
  for (const v of vouchers) {
    const id = serviceKey(v.providerAddress, v.serviceCode);
    const t = totals.get(id) ?? { providerAddress: v.providerAddress, serviceCode: v.serviceCode, count: 0, value: 0 };
    t.count += 1;
    t.value += v.value;
    totals.set(id, t);
  }

  const labels = await serviceLabels([...totals.values()]);
  return [...totals.entries()]
    .map(([id, t]) => ({ id, ...t, label: labels.get(id) ?? null }))
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(0, limit));
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

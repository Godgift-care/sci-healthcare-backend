import { prisma } from '../db.js';
import { fromBaseUnits } from './amounts.js';

/** Service rows are keyed `{providerAddress}:{code}` by the indexer. */
export function serviceKey(providerAddress: string, code: number): string {
  return `${providerAddress}:${code}`;
}

/** The price columns a `Service` row carries. */
export type ScheduledPriceRow = {
  price: string;
  upcomingPrice: string | null;
  upcomingFrom: Date | null;
};

/**
 * What a service costs right now, and what is still scheduled for it.
 *
 * The registry applies a scheduled price lazily: `apply_due_price()` swaps
 * `pending_price` into `price` on the first read at or after `effective_at`
 * and emits no event when it does (contracts
 * `contracts/registry/src/types.rs`). So the ledger never says "this schedule
 * took effect" — the read model has to decide, the same way, at read time.
 *
 * `upcomingPrice` is therefore what the schedule was while it was still
 * pending, and both fields go null the moment the time is reached, because by
 * then the new price *is* `price`. The contract's `pending_price > 0` guard
 * becomes "a row with no schedule has no pending columns", which is also what
 * makes a deployment that predates `schedule_service_price` render unchanged:
 * its rows have never had either column written.
 */
export function scheduledPriceOf(row: ScheduledPriceRow, now: Date): ScheduledPriceRow {
  if (row.upcomingPrice === null || row.upcomingFrom === null) return row;
  if (now < row.upcomingFrom) return row;
  return { price: row.upcomingPrice, upcomingPrice: null, upcomingFrom: null };
}

/**
 * The same resolution in the shape a service entry has in an API response:
 * the effective price, its display amount, and the schedule still pending.
 */
export function formatServicePrice(
  row: ScheduledPriceRow,
  now: Date = new Date(),
): {
  price: string;
  priceDisplay: string;
  upcomingPrice: string | null;
  upcomingFrom: Date | null;
} {
  const effective = scheduledPriceOf(row, now);
  return {
    price: effective.price,
    priceDisplay: fromBaseUnits(effective.price),
    upcomingPrice: effective.upcomingPrice,
    upcomingFrom: effective.upcomingFrom,
  };
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
): Promise<
  {
    id: string;
    serviceCode: number;
    providerAddress: string;
    label: string | null;
    count: number;
    value: number;
  }[]
> {
  const totals = new Map<
    string,
    { providerAddress: string; serviceCode: number; count: number; value: number }
  >();
  for (const v of vouchers) {
    const id = serviceKey(v.providerAddress, v.serviceCode);
    const t = totals.get(id) ?? {
      providerAddress: v.providerAddress,
      serviceCode: v.serviceCode,
      count: 0,
      value: 0,
    };
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

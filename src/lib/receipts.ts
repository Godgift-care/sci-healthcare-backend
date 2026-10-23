import { prisma } from '../db.js';
import { fromBaseUnits } from './amounts.js';
import { providerSummaries } from './providers.js';
import { serviceKey, serviceLabels } from './services.js';

/**
 * The fields of a `Receipt` row that its public shape is built from.
 *
 * `beneficiaryRef` is deliberately absent: the single-receipt endpoint never
 * serves it, and the embedded receipts `?include=receipt` adds (#167) must be
 * the same object, so neither can leak a patient reference into a page built
 * for sharing.
 */
export type ReceiptRow = {
  voucherId: string;
  providerAddress: string;
  serviceCode: number;
  amount: string;
  settledAt: Date;
};

export type SerialisedReceipt = {
  voucherId: string;
  providerAddress: string;
  provider: { address: string; name: string | null; country: string | null };
  serviceCode: number;
  serviceLabel: string | null;
  amount: string;
  amountDisplay: string;
  settledAt: Date;
};

/**
 * One receipt in the shape `GET /receipts/:voucherId` serves.
 *
 * Shared with `?include=receipt` on the voucher routes so an embedded receipt
 * is byte-for-byte the response of the separate endpoint (#167): the same
 * `provider` object, `serviceLabel` and `amountDisplay`, resolved from the
 * same batched maps. A clinic the indexer never registered reports
 * `name: null` / `country: null` rather than a guessed name.
 */
export function serialiseReceipt(
  row: ReceiptRow,
  labels: Map<string, string>,
  clinics: Map<string, { name: string; country: string }>,
): SerialisedReceipt {
  const clinic = clinics.get(row.providerAddress);
  return {
    voucherId: row.voucherId,
    providerAddress: row.providerAddress,
    provider: {
      address: row.providerAddress,
      name: clinic?.name ?? null,
      country: clinic?.country ?? null,
    },
    serviceCode: row.serviceCode,
    serviceLabel: labels.get(serviceKey(row.providerAddress, row.serviceCode)) ?? null,
    amount: row.amount,
    amountDisplay: fromBaseUnits(row.amount),
    settledAt: row.settledAt,
  };
}

/**
 * Receipts for a whole page of vouchers, keyed by voucher id.
 *
 * One `findMany({ where: { voucherId: { in: ids } } })` plus the same two
 * batched lookups the receipt list already makes — never one query per row,
 * so embedding receipts costs a fixed number of round trips no matter how
 * many vouchers the page holds.
 */
export async function receiptsByVoucherId(
  voucherIds: readonly string[],
): Promise<Map<string, SerialisedReceipt>> {
  const ids = [...new Set(voucherIds)];
  if (ids.length === 0) return new Map();

  const rows = await prisma.receipt.findMany({ where: { voucherId: { in: ids } } });
  const [labels, clinics] = await Promise.all([serviceLabels(rows), providerSummaries(rows)]);
  return new Map(rows.map((r) => [r.voucherId, serialiseReceipt(r, labels, clinics)]));
}

import { fromBaseUnits } from '../../lib/amounts.js';
import { isRefundable, isSettleable, refundableAt } from '../../lib/lifecycle.js';
import { providerDetails } from '../../lib/providers.js';
import { receiptsByVoucherId } from '../../lib/receipts.js';
import { serviceKey, serviceLabels } from '../../lib/services.js';
import { includesField } from '../../lib/fields.js';
import type { Include } from './schema.js';

export type Row = {
  id: string;
  funder: string;
  beneficiaryRef: string;
  serviceCode: number;
  amount: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  attestedAt: Date | null;
  attestedBy: string | null;
  disputeDeadline: Date | null;
  /** The window the funder chose at funding time; null until read (#319). */
  disputeWindowSecs: number | null;
  /** SHA-256 the clinic must reveal to claim; null unless presence-gated (#319). */
  presenceCommitment: string | null;
  disputeReason: number | null;
  disputeResolvedAt: Date | null;
  disputeResolvedBy: string | null;
  disputeOutcome: string | null;
  settledNet: string | null;
  settledFee: string | null;
  providerAddress: string;
  /** Absent on a page whose fieldset left `provider` out (#321). */
  provider?: { name: string; country: string };
};

export function serialise(v: Row, labels: Map<string, string>) {
  const refundable = refundableAt(v);
  return {
    id: v.id,
    funder: v.funder,
    beneficiaryRef: v.beneficiaryRef,
    // The clinic summary, or nothing at all when the page never read the
    // relation because `?fields=` left it out (#321). A fieldset that asks
    // for `provider` always reads it, so no client can see this as null.
    provider: v.provider && {
      address: v.providerAddress,
      name: v.provider.name,
      country: v.provider.country,
    },
    serviceCode: v.serviceCode,
    serviceLabel: labels.get(serviceKey(v.providerAddress, v.serviceCode)) ?? null,
    amount: v.amount,
    amountDisplay: fromBaseUnits(v.amount),
    status: v.status,
    createdAt: v.createdAt,
    expiresAt: v.expiresAt,
    claimedAt: v.claimedAt,
    attestedAt: v.attestedAt,
    attestedBy: v.attestedBy,
    disputeDeadline: v.disputeDeadline,
    // The terms chosen at funding time, which no event announced (#319).
    // Null until reconciliation has read `get_voucher_options` for this
    // voucher; `disputeDeadline` remains the authoritative moment.
    disputeWindowSecs: v.disputeWindowSecs,
    presenceCommitment: v.presenceCommitment,
    disputeReason: v.disputeReason,
    disputeResolvedAt: v.disputeResolvedAt,
    disputeResolvedBy: v.disputeResolvedBy,
    disputeOutcome: v.disputeOutcome,
    settledNet: v.settledNet,
    settledFee: v.settledFee,
    // Convenience flags so the UI does not re-derive the state machine.
    refundableAt: refundable,
    isSettleable: isSettleable(v),
    isRefundable: isRefundable(v),
  };
}

/** Serialises one page, resolving any requested related records in batches. */
export async function serialisePage(
  rows: Row[],
  includes: ReadonlySet<Include>,
  fieldSet: readonly string[] | null,
) {
  // The label batch exists only to fill `serviceLabel`, so a page that did not
  // ask for it does not pay for the round trip (#321).
  const labels = includesField(fieldSet, 'serviceLabel')
    ? await serviceLabels(rows)
    : new Map<string, string>();
  // One `Receipt` batch and one `Provider` batch for the whole page (each
  // with its own single batched label/lookup query): the number of round
  // trips does not grow with the page size (#167). A requested record that
  // does not exist stays null rather than disappearing from the page.
  // `?fields=` also gets a say (#321): a page projecting neither `receipt`
  // nor `provider` cannot show the embed, so it does not read it either.
  const embedReceipt = includes.has('receipt') && includesField(fieldSet, 'receipt');
  const embedProvider = includes.has('provider') && includesField(fieldSet, 'provider');
  const [receipts, providers] = await Promise.all([
    embedReceipt ? receiptsByVoucherId(rows.map((v) => v.id)) : null,
    embedProvider ? providerDetails(rows) : null,
  ]);

  return rows.map((v) => {
    const summary = serialise(v, labels);
    const base = providers
      ? { ...summary, provider: providers.get(v.providerAddress) ?? summary.provider }
      : summary;
    return receipts ? { ...base, receipt: receipts.get(v.id) ?? null } : base;
  });
}

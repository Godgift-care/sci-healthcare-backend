/**
 * Voucher timing rules, mirrored from the voucher contract so the API can
 * tell the UI which actions will succeed without a simulation round trip.
 *
 * These must stay in step with `refundable_at_for` and `settle` in
 * `sci-healthcare-contracts/contracts/voucher/src/lib.rs`. The contract is
 * always the authority; these flags only decide which buttons to show.
 */

/** `CLAIM_GRACE_SECS` in the voucher contract: seven days. */
export const CLAIM_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export type VoucherTiming = {
  status: string;
  expiresAt: Date;
  disputeDeadline: Date | null;
};

/**
 * When `refund` will start to succeed, or null if it never will.
 *
 * Unclaimed vouchers refund at expiry. Claimed vouchers that were never
 * attested refund once the claim grace period after expiry has passed.
 */
export function refundableAt(v: VoucherTiming): Date | null {
  switch (v.status) {
    case 'Funded':
      return v.expiresAt;
    case 'Claimed':
      return new Date(v.expiresAt.getTime() + CLAIM_GRACE_MS);
    default:
      return null;
  }
}

export function isRefundable(v: VoucherTiming, now: number = Date.now()): boolean {
  const at = refundableAt(v);
  return at !== null && at.getTime() <= now;
}

export function isSettleable(v: VoucherTiming, now: number = Date.now()): boolean {
  return (
    v.status === 'Attested' && v.disputeDeadline !== null && v.disputeDeadline.getTime() <= now
  );
}

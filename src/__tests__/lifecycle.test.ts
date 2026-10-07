import { describe, expect, it } from 'vitest';

import { CLAIM_GRACE_MS, isRefundable, isSettleable, refundableAt } from '../lib/lifecycle.js';

const EXPIRY = new Date('2026-10-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function voucher(status: string, disputeDeadline: Date | null = null) {
  return { status, expiresAt: EXPIRY, disputeDeadline };
}

describe('refundableAt', () => {
  it('is the expiry for an unclaimed voucher', () => {
    expect(refundableAt(voucher('Funded'))).toEqual(EXPIRY);
  });

  it('adds the claim grace period for a claimed voucher', () => {
    expect(refundableAt(voucher('Claimed'))?.getTime()).toBe(EXPIRY.getTime() + 7 * DAY);
  });

  it.each(['Attested', 'Disputed', 'Settled', 'Refunded'])('is null once %s', (status) => {
    expect(refundableAt(voucher(status))).toBeNull();
  });
});

describe('isRefundable', () => {
  it('opens at expiry for an unclaimed voucher', () => {
    expect(isRefundable(voucher('Funded'), EXPIRY.getTime() - 1)).toBe(false);
    expect(isRefundable(voucher('Funded'), EXPIRY.getTime())).toBe(true);
  });

  it('keeps a claimed voucher locked through the grace period', () => {
    const v = voucher('Claimed');
    expect(isRefundable(v, EXPIRY.getTime() + DAY)).toBe(false);
    expect(isRefundable(v, EXPIRY.getTime() + CLAIM_GRACE_MS - 1)).toBe(false);
    expect(isRefundable(v, EXPIRY.getTime() + CLAIM_GRACE_MS)).toBe(true);
  });

  it('never opens for an attested voucher', () => {
    expect(isRefundable(voucher('Attested'), EXPIRY.getTime() + 365 * DAY)).toBe(false);
  });
});

describe('isSettleable', () => {
  const deadline = new Date('2026-09-20T00:00:00Z');

  it('waits for the dispute window to close', () => {
    expect(isSettleable(voucher('Attested', deadline), deadline.getTime() - 1)).toBe(false);
    expect(isSettleable(voucher('Attested', deadline), deadline.getTime())).toBe(true);
  });

  it('requires an attestation', () => {
    expect(isSettleable(voucher('Claimed', deadline), deadline.getTime() + DAY)).toBe(false);
  });
});

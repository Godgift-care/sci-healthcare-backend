import { prisma } from '../db.js';
import { fromBaseUnits } from './amounts.js';

/**
 * Read-model helpers for the matching-funding desk (#317).
 *
 * Shared between `GET /sponsors*` and the voucher routes, so the number a
 * voucher page calls `matchedAmount` is built from the same row, with the same
 * display conversion, as the sponsor's own totals — the two cannot drift into
 * disagreeing about what a match was worth.
 */

/** The public shape of the match attached to one voucher. */
export type VoucherMatch = {
  matchedAmount: string;
  matchedAmountDisplay: string;
  matchedBy: string;
  matchStatus: string;
  matchedAt: Date;
};

/** Match columns the public shape is built from. */
type MatchRow = {
  originalVoucherId: string;
  sponsorAddress: string;
  amount: string;
  status: string;
  matchedAt: Date;
};

function serialiseMatch(row: MatchRow): VoucherMatch {
  return {
    matchedAmount: row.amount,
    matchedAmountDisplay: fromBaseUnits(row.amount),
    matchedBy: row.sponsorAddress,
    matchStatus: row.status,
    matchedAt: row.matchedAt,
  };
}

/**
 * The match on each voucher of a page, keyed by the voucher's own id.
 *
 * One `findMany` for the whole page — never one per row — so a voucher list
 * costs a fixed number of round trips however many rows it holds. A voucher
 * that was never matched has no entry, and the caller emits nulls for it
 * rather than a zero: "nothing matched this voucher" and "someone matched
 * 0.0000000 against it" are different facts.
 */
export async function matchesByOriginalVoucherId(
  voucherIds: readonly string[],
): Promise<Map<string, VoucherMatch>> {
  const ids = [...new Set(voucherIds)];
  if (ids.length === 0) return new Map();

  const rows = await prisma.sponsorMatch.findMany({
    where: { originalVoucherId: { in: ids } },
    select: {
      originalVoucherId: true,
      sponsorAddress: true,
      amount: true,
      status: true,
      matchedAt: true,
    },
  });
  return new Map(rows.map((row) => [row.originalVoucherId, serialiseMatch(row)]));
}

/** i128 decimal strings added exactly; a JS number would round past 2^53. */
function add(total: string, value: string): string {
  return (BigInt(total) + BigInt(value)).toString();
}

/**
 * What one sponsor has funded, derived from its rows.
 *
 * Amounts are i128s kept as text, so no SQL aggregate can add them; the rows
 * are read and summed here instead — the same trade-off `attesterStats` makes
 * for the same reason, and it is exact rather than approximate.
 */
export type SponsorTotals = {
  deposited: string;
  withdrawn: string;
  matchCount: number;
  openMatchCount: number;
  settledMatchCount: number;
  refundedMatchCount: number;
  matchedAmount: string;
  settledMatchedAmount: string;
  refundedMatchedAmount: string;
};

const ZERO_TOTALS: SponsorTotals = {
  deposited: '0',
  withdrawn: '0',
  matchCount: 0,
  openMatchCount: 0,
  settledMatchCount: 0,
  refundedMatchCount: 0,
  matchedAmount: '0',
  settledMatchedAmount: '0',
  refundedMatchedAmount: '0',
};

/**
 * Totals for a whole page of sponsors in two queries.
 *
 * Grouping happens in JS because the amounts are strings: one pass over the
 * sponsors' match rows and one over their budget movements, whatever the page
 * size. A sponsor with no rows is absent from the map and reads as all zeros —
 * which is what its events actually added up to.
 */
export async function totalsBySponsor(
  sponsorAddresses: readonly string[],
): Promise<Map<string, SponsorTotals>> {
  const addresses = [...new Set(sponsorAddresses)];
  if (addresses.length === 0) return new Map();

  const [matches, movements] = await Promise.all([
    prisma.sponsorMatch.findMany({
      where: { sponsorAddress: { in: addresses } },
      select: { sponsorAddress: true, amount: true, status: true },
    }),
    prisma.sponsorBudgetEvent.findMany({
      where: { sponsorAddress: { in: addresses } },
      select: { sponsorAddress: true, amount: true, kind: true },
    }),
  ]);

  const totals = new Map<string, SponsorTotals>();
  const mutable = (address: string): SponsorTotals => {
    let row = totals.get(address);
    if (!row) {
      row = { ...ZERO_TOTALS };
      totals.set(address, row);
    }
    return row;
  };

  for (const movement of movements) {
    const row = mutable(movement.sponsorAddress);
    if (movement.kind === 'Deposited') {
      row.deposited = add(row.deposited, movement.amount);
    } else {
      row.withdrawn = add(row.withdrawn, movement.amount);
    }
  }

  for (const match of matches) {
    const row = mutable(match.sponsorAddress);
    row.matchCount += 1;
    row.matchedAmount = add(row.matchedAmount, match.amount);
    if (match.status === 'Settled') {
      row.settledMatchCount += 1;
      row.settledMatchedAmount = add(row.settledMatchedAmount, match.amount);
    } else if (match.status === 'Refunded') {
      row.refundedMatchCount += 1;
      row.refundedMatchedAmount = add(row.refundedMatchedAmount, match.amount);
    } else {
      row.openMatchCount += 1;
    }
  }

  return totals;
}

/** The stored sponsor row, as the routes read it. */
export type SponsorRow = {
  address: string;
  available: string | null;
  matchBps: number | null;
  capPerVoucher: string | null;
  minVoucherAmount: string | null;
  minVoucherAgeSecs: string | null;
  rulesAt: Date | null;
  lastMovementAt: Date | null;
  firstSeenAt: Date;
};

/** Display value beside an amount, keeping null a null rather than a zero. */
function display(amount: string | null): string | null {
  return amount === null ? null : fromBaseUnits(amount);
}

/**
 * One sponsor in the shape `GET /sponsors` and `GET /sponsors/:address` serve.
 *
 * `available` is the balance the contract reported at its last budget
 * movement, not what the desk holds for this sponsor right now: matching
 * spends budget without emitting a budget event, and the only way to know the
 * live figure is `available_budget` on chain. `availableAsOf` says which event
 * the figure came from, so a reader can tell a stale zero from no data at all
 * (`null`).
 */
export function serialiseSponsor(row: SponsorRow, totals: SponsorTotals) {
  return {
    address: row.address,
    available: row.available,
    availableDisplay: display(row.available),
    availableAsOf: row.lastMovementAt,
    // The terms the sponsor last set. 10000 bps matches one-for-one and
    // 20000 matches two-for-one; null fields mean `set_rules` was never
    // indexed for this sponsor.
    matchBps: row.matchBps,
    capPerVoucher: row.capPerVoucher,
    capPerVoucherDisplay: display(row.capPerVoucher),
    minVoucherAmount: row.minVoucherAmount,
    minVoucherAmountDisplay: display(row.minVoucherAmount),
    minVoucherAgeSecs: row.minVoucherAgeSecs,
    rulesAt: row.rulesAt,
    firstSeenAt: row.firstSeenAt,
    deposited: totals.deposited,
    depositedDisplay: fromBaseUnits(totals.deposited),
    withdrawn: totals.withdrawn,
    withdrawnDisplay: fromBaseUnits(totals.withdrawn),
    matchCount: totals.matchCount,
    openMatchCount: totals.openMatchCount,
    settledMatchCount: totals.settledMatchCount,
    refundedMatchCount: totals.refundedMatchCount,
    matchedAmount: totals.matchedAmount,
    matchedAmountDisplay: fromBaseUnits(totals.matchedAmount),
    settledMatchedAmount: totals.settledMatchedAmount,
    settledMatchedAmountDisplay: fromBaseUnits(totals.settledMatchedAmount),
    refundedMatchedAmount: totals.refundedMatchedAmount,
    refundedMatchedAmountDisplay: fromBaseUnits(totals.refundedMatchedAmount),
  };
}

/** The eight amounts and counts a sponsor page derives from its rows. */
export const EMPTY_SPONSOR_TOTALS: SponsorTotals = { ...ZERO_TOTALS };

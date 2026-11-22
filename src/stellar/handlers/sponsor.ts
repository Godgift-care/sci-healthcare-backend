import type { Db } from './types.js';
import { asAddress, asAmount, asId, asNumber, asTimestamp, type DecodedEvent } from '../events.js';

/**
 * A sponsor moved money in or out of the matching desk (#317).
 *
 * Two writes, and neither adds anything up: `SponsorBudgetEvent` is one row
 * per event keyed by the event id, and `Sponsor.available` is the balance
 * the contract itself reports *after* the movement. Deriving the balance by
 * accumulating here would double-count the first time a page is replayed,
 * which is exactly the class of bug the rest of the indexer avoids.
 */
export async function onSponsorBudget(
  db: Db,
  e: DecodedEvent,
  kind: 'Deposited' | 'Withdrawn',
): Promise<void> {
  const d = e.fields;
  const address = asAddress(d.sponsor);
  const amount = asAmount(d.amount);
  const available = asAmount(d.available);

  await db.sponsor.upsert({
    where: { address },
    create: {
      address,
      available,
      lastMovementAt: e.ledgerClosedAt,
      firstSeenAt: e.ledgerClosedAt,
    },
    update: { available, lastMovementAt: e.ledgerClosedAt },
  });
  await db.sponsorBudgetEvent.upsert({
    where: { id: e.id },
    create: {
      id: e.id,
      sponsorAddress: address,
      kind,
      amount,
      available,
      ledger: e.ledger,
      occurredAt: e.ledgerClosedAt,
    },
    update: {},
  });
}

/**
 * The latest terms a sponsor matches on. The four rule columns are a
 * snapshot of the whole `Rules` struct, so an older row cannot survive a
 * partial update, and `rulesAt` says which event this came from.
 */
export async function onSponsorRules(db: Db, e: DecodedEvent): Promise<void> {
  const d = e.fields;
  const address = asAddress(d.sponsor);
  const rules = {
    matchBps: asNumber(d.match_bps),
    capPerVoucher: asAmount(d.cap_per_voucher),
    minVoucherAmount: asAmount(d.min_voucher_amount),
    // u64: wider than a Postgres integer, so kept as a decimal string like
    // every other number this schema cannot put in a JS-safe column.
    minVoucherAgeSecs: asAmount(d.min_voucher_age_secs),
    rulesAt: e.ledgerClosedAt,
  };

  await db.sponsor.upsert({
    where: { address },
    create: { address, firstSeenAt: e.ledgerClosedAt, ...rules },
    update: rules,
  });
}

/**
 * The desk matched a voucher: it funded a second voucher of its own.
 *
 * Both ids are kept, because they are two different vouchers and the
 * contract will not create a second match against the same original
 * voucher. The voucher the desk funded arrives separately as its own
 * `voucher_created` with the desk as funder; this row is what links them.
 */
export async function onMatchCreated(db: Db, e: DecodedEvent): Promise<void> {
  const d = e.fields;
  const address = asAddress(d.sponsor);
  const matchedVoucherId = asId(d.matched_voucher_id);
  const originalVoucherId = asId(d.original_voucher_id);

  // The sponsor row exists before its first match: a match can be the
  // first event this indexer sees for that sponsor (a deposit before the
  // start ledger, or a sponsor that topped up and matched in one go).
  await db.sponsor.upsert({
    where: { address },
    create: { address, firstSeenAt: e.ledgerClosedAt },
    update: {},
  });
  await db.sponsorMatch.upsert({
    where: { matchedVoucherId },
    create: {
      matchedVoucherId,
      originalVoucherId,
      sponsorAddress: address,
      providerAddress: asAddress(d.provider),
      serviceCode: asNumber(d.service_code),
      amount: asAmount(d.amount),
      matchedAt: asTimestamp(d.matched_at),
    },
    update: {},
  });
}

/**
 * A match's voucher settled or was refunded, as the desk discovered it.
 *
 * The desk publishes these from `reconcile`, which only runs when someone
 * calls it — so this can lag the voucher's own status by however long, and
 * the amount is the stored `OpenMatch.amount` rather than a fresh read,
 * which is what lets a test assert the two agree.
 *
 * `updateMany`, not an upsert: the event names only the matched voucher,
 * so it cannot supply the original id a create would need. A match created
 * before the indexer's start ledger is the same known gap the voucher
 * lifecycle handlers already have, and `reconcile` repairs vouchers but not
 * matches; the row simply stays absent until the create is replayed.
 */
export async function onMatchResolved(
  db: Db,
  e: DecodedEvent,
  status: 'Settled' | 'Refunded',
): Promise<void> {
  const d = e.fields;
  const matchedVoucherId = asId(d.matched_voucher_id);
  // No timestamp on these events, as with voucher_refunded: the ledger
  // close time is when the money moved.
  const at = e.ledgerClosedAt;

  await db.sponsorMatch.updateMany({
    where: { matchedVoucherId },
    data: status === 'Settled' ? { status, settledAt: at } : { status, refundedAt: at },
  });
}

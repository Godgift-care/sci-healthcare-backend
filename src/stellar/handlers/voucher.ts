import { recordDailyStatFunded, recordDailyStatRefunded } from '../../lib/daily-stats.js';
import { voucherSeq } from '../../lib/voucher-seq.js';
import { enqueueWebhook } from '../../lib/webhooks.js';
import {
  asAddress,
  asAmount,
  asBoolean,
  asHex,
  asId,
  asNumber,
  asTimestamp,
  type DecodedEvent,
} from '../events.js';
import { normaliseChainVoucher } from '../reconcile.js';
import { lookupDeploymentId } from './common.js';
import type { Db, PendingSignal, VoucherHandlerContext } from './types.js';

/**
 * The clinic in an event's topic, or `null` when it is not a usable address.
 *
 * Deliberately not `asAddress`. That one throws, and the stream is a reader
 * of what the projection decided — it must never be the reason an event the
 * indexer used to apply starts dead-lettering. `voucher_claimed` and
 * `voucher_settled` name their provider in the topic and never read it in
 * the handler, so a malformed topic used to be harmless here; now it just
 * sends the signal through the same read-from-the-row fallback an attestation
 * already uses. `publish` resolves it, and the stream simply reports what the
 * read model says.
 */
export function topicProvider(e: DecodedEvent): string | null {
  const raw = e.fields.provider;
  return typeof raw === 'string' && raw.length === 56 ? raw : null;
}

/**
 * The stream signal for one voucher event.
 *
 * `asId(d.voucher_id)` is already how the handler picked the row, so by the
 * time this runs the field has decoded once and cannot fail here.
 */
export function voucherSignal(
  e: DecodedEvent,
  status: string,
  providerAddress: string | null,
): PendingSignal {
  return {
    type: e.name,
    voucherId: asId(e.fields.voucher_id),
    status,
    providerAddress,
    ledger: e.ledger,
    txHash: e.txHash,
    at: e.ledgerClosedAt,
  };
}

/** Rebuilds a voucher whose creation event predates the indexer's cursor. */
export async function repairMissingVoucher(
  db: Db,
  id: string,
  contractId: string,
  ctx: VoucherHandlerContext,
): Promise<void> {
  const existing = await db.voucher.findUnique({ where: { id }, select: { id: true } });
  if (existing) return;

  const chain = await ctx.voucherReader(id, contractId);
  if (!chain) throw new Error(`Cannot repair missing voucher ${id}: voucher is not on chain`);
  const voucher = normaliseChainVoucher(chain);

  await db.provider.upsert({
    where: { address: voucher.providerAddress },
    create: {
      address: voucher.providerAddress,
      name: 'Unknown provider',
      country: '??',
      status: 'Active',
      registeredAt: new Date(0),
    },
    update: {},
  });

  const deploymentId = await lookupDeploymentId(contractId, db);
  await recordDailyStatFunded(db, voucher.createdAt, voucher.amount);
  await db.voucher.create({
    data: {
      id,
      seq: voucherSeq(id),
      funder: voucher.funder,
      beneficiaryRef: voucher.beneficiaryRef,
      providerAddress: voucher.providerAddress,
      serviceCode: voucher.serviceCode,
      amount: voucher.amount,
      status: voucher.status,
      createdAt: voucher.createdAt,
      expiresAt: voucher.expiresAt,
      claimedAt: voucher.claimedAt,
      attestedAt: voucher.attestedAt,
      disputeDeadline: voucher.disputeDeadline,
      deploymentId,
    },
  });

  if (ctx.repairedVouchers && !ctx.repairedVouchers.has(id)) {
    ctx.repairedVouchers.add(id);
    ctx.log?.warn({ voucherId: id }, 'repaired voucher missing its creation event');
  }
}

export async function onVoucherCreated(db: Db, e: DecodedEvent): Promise<PendingSignal> {
  const d = e.fields;
  const id = asId(d.voucher_id);
  const providerAddress = asAddress(d.provider);

  // A voucher references a provider row; if the indexer started after the
  // provider was registered, backfill a stub so the relation holds.
  await db.provider.upsert({
    where: { address: providerAddress },
    create: {
      address: providerAddress,
      name: 'Unknown provider',
      country: '??',
      status: 'Active',
      registeredAt: new Date(0),
    },
    update: {},
  });

  const deploymentId = await lookupDeploymentId(e.contractId, db);

  const existing = await db.voucher.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!existing) {
    await recordDailyStatFunded(db, asTimestamp(d.created_at), asAmount(d.amount));
  }

  await db.voucher.upsert({
    where: { id },
    create: {
      id,
      // Numeric mirror of the id, so ordering by `seq` gives voucher 9
      // before voucher 10 instead of the string order (#61).
      seq: voucherSeq(id),
      funder: asAddress(d.funder),
      beneficiaryRef: asHex(d.beneficiary_ref),
      providerAddress,
      serviceCode: asNumber(d.service_code),
      amount: asAmount(d.amount),
      status: 'Funded',
      createdAt: asTimestamp(d.created_at),
      expiresAt: asTimestamp(d.expires_at),
      deploymentId,
    },
    update: {},
  });

  await enqueueWebhook(db, {
    event: e.name,
    voucherId: id,
    status: 'Funded',
    txHash: e.txHash,
    ledger: e.ledger,
    provider: providerAddress,
  });

  return voucherSignal(e, 'Funded', topicProvider(e));
}

export async function onVoucherStatus(
  db: Db,
  d: Record<string, unknown>,
  status: string,
  extra: Record<string, unknown>,
  contractId: string,
  ctx: VoucherHandlerContext,
): Promise<void> {
  const id = asId(d.voucher_id);
  await repairMissingVoucher(db, id, contractId, ctx);
  if (status === 'Refunded') {
    const existing = await db.voucher.findUnique({
      where: { id },
      select: { refundedAt: true, amount: true },
    });
    if (existing && !existing.refundedAt) {
      const refundedAt = (extra.refundedAt as Date) ?? new Date();
      await recordDailyStatRefunded(db, refundedAt, existing.amount);
    }
  }
  await db.voucher.updateMany({
    where: { id },
    data: { status, ...extra },
  });
}

/**
 * Applies a status transition and returns its stream signal in one step, so
 * the row that commits and the update that follows it cannot disagree about
 * which status an event was.
 */
export async function handleVoucherStatus(
  db: Db,
  e: DecodedEvent,
  status: string,
  extra: Record<string, unknown>,
  providerAddress: string | null,
  ctx: VoucherHandlerContext,
): Promise<PendingSignal> {
  await onVoucherStatus(db, e.fields, status, extra, e.contractId, ctx);
  const voucherId = asId(e.fields.voucher_id);
  // Some events name the clinic in their topic and some do not, so fall back
  // to the voucher's own provider before filtering endpoints (#263).
  const voucher =
    providerAddress === null
      ? await db.voucher.findUnique({
          where: { id: voucherId },
          select: { providerAddress: true },
        })
      : null;
  // Queued in the same transaction, so nothing is announced that did not
  // land in the read model. Delivery happens on its own loop.
  await enqueueWebhook(db, {
    event: e.name,
    voucherId,
    status,
    txHash: e.txHash,
    ledger: e.ledger,
    provider: providerAddress ?? voucher?.providerAddress ?? null,
  });
  return voucherSignal(e, status, providerAddress);
}

export async function onVoucherClaimed(
  db: Db,
  e: DecodedEvent,
  ctx: VoucherHandlerContext,
): Promise<PendingSignal> {
  return handleVoucherStatus(
    db,
    e,
    'Claimed',
    { claimedAt: asTimestamp(e.fields.claimed_at) },
    topicProvider(e),
    ctx,
  );
}

export async function onVoucherAttested(
  db: Db,
  e: DecodedEvent,
  ctx: VoucherHandlerContext,
): Promise<PendingSignal> {
  // The topic carries the attester, not the clinic.
  return handleVoucherStatus(
    db,
    e,
    'Attested',
    {
      attestedAt: asTimestamp(e.fields.attested_at),
      attestedBy: asAddress(e.fields.attester),
      disputeDeadline: asTimestamp(e.fields.dispute_deadline),
    },
    null,
    ctx,
  );
}

export async function onVoucherDisputed(
  db: Db,
  e: DecodedEvent,
  ctx: VoucherHandlerContext,
): Promise<PendingSignal> {
  // The topic carries the funder.
  return handleVoucherStatus(
    db,
    e,
    'Disputed',
    { disputeReason: asNumber(e.fields.reason_code) },
    null,
    ctx,
  );
}

export async function onVoucherSettled(
  db: Db,
  e: DecodedEvent,
  ctx: VoucherHandlerContext,
): Promise<PendingSignal> {
  return handleVoucherStatus(
    db,
    e,
    'Settled',
    { settledNet: asAmount(e.fields.net), settledFee: asAmount(e.fields.fee) },
    topicProvider(e),
    ctx,
  );
}

export async function onVoucherRefunded(
  db: Db,
  e: DecodedEvent,
  ctx: VoucherHandlerContext,
): Promise<PendingSignal> {
  // The topic carries the funder.
  // The contract emits no timestamp on a refund, so the ledger close
  // time is the timestamp: it is when the refund became true.
  return handleVoucherStatus(db, e, 'Refunded', { refundedAt: e.ledgerClosedAt }, null, ctx);
}

/**
 * Records who resolved a dispute and how. The voucher's final status
 * arrives separately through voucher_settled or voucher_refunded in the
 * same transaction, so this only writes the outcome fields and works in
 * either order.
 */
export async function onDisputeResolved(db: Db, e: DecodedEvent): Promise<void> {
  const id = asId(e.fields.voucher_id);
  await db.voucher.updateMany({
    where: { id },
    data: {
      disputeResolvedAt: e.ledgerClosedAt,
      disputeResolvedBy: asAddress(e.fields.admin),
      disputeOutcome: asBoolean(e.fields.refunded_funder) ? 'Funder' : 'Provider',
    },
  });
}

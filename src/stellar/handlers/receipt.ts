import { recordDailyStatSettled } from '../../lib/daily-stats.js';
import {
  asAddress,
  asAmount,
  asHex,
  asId,
  asNumber,
  asTimestamp,
  type DecodedEvent,
} from '../events.js';
import { lookupDeploymentId } from './common.js';
import type { Db } from './types.js';

export async function onReceiptMinted(db: Db, e: DecodedEvent): Promise<void> {
  const d = e.fields;
  const voucherId = asId(d.voucher_id);
  const deploymentId = await lookupDeploymentId(e.contractId, db);

  const existing = await db.receipt.findUnique({
    where: { voucherId },
    select: { voucherId: true },
  });
  if (!existing) {
    await recordDailyStatSettled(db, asTimestamp(d.settled_at), asAmount(d.amount));
  }

  await db.receipt.upsert({
    where: { voucherId },
    create: {
      voucherId,
      beneficiaryRef: asHex(d.beneficiary_ref),
      providerAddress: asAddress(d.provider),
      serviceCode: asNumber(d.service_code),
      amount: asAmount(d.amount),
      settledAt: asTimestamp(d.settled_at),
      deploymentId,
    },
    update: {},
  });
}

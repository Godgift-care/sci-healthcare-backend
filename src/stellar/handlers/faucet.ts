import { asAddress, asAmount, type DecodedEvent } from '../events.js';
import type { Db } from './types.js';

/**
 * Records one testnet faucet drip.
 *
 * A row per event rather than a bare counter: replay is idempotent only
 * if the key is the on-chain event id, and keeping the wallet is what
 * lets `/stats` report how many distinct people tried the demo rather
 * than how many times anyone pressed the button.
 */
export async function onDripped(db: Db, e: DecodedEvent): Promise<void> {
  const d = e.fields;
  await db.faucetDrip.upsert({
    where: { id: e.id },
    create: {
      id: e.id,
      wallet: asAddress(d.to),
      amount: asAmount(d.amount),
      ledger: e.ledger,
      drippedAt: e.ledgerClosedAt,
    },
    update: {},
  });
}

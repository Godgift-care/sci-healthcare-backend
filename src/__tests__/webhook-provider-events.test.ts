import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import {
  PROVIDER_REGISTERED_EVENT,
  PROVIDER_STATUS_CHANGED_EVENT,
  SERVICE_PRICE_CHANGED_EVENT,
} from '../lib/webhooks.js';
import { decodeEvent, type DecodedEvent } from '../stellar/events.js';
import {
  onProviderRegistered,
  onProviderStatus,
  onServiceUpserted,
} from '../stellar/handlers/index.js';

/**
 * Clinic and service webhooks (#266).
 *
 * Projection tests for the three non-voucher events: they must reach the
 * outbox in the same transaction as the row they describe, with the payloads
 * documented in `docs/webhooks.md`, and a replay must not notify twice for a
 * status the clinic already has.
 */

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const LEDGER_CLOSED_AT = '2026-10-01T00:00:00.000Z';

function sym(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: 'symbol' });
}

const addr = (a: string): xdr.ScVal => Address.fromString(a).toScVal();

function registryEvent(
  name: string,
  ledger: number,
  data: Record<string, unknown>,
  topics: xdr.ScVal[],
): DecodedEvent {
  const decoded = decodeEvent({
    id: `${name}-${ledger}`,
    contractId: env.REGISTRY_CONTRACT_ID,
    txHash: 'd'.repeat(64),
    ledger,
    ledgerClosedAt: LEDGER_CLOSED_AT,
    topic: [sym(name), ...topics],
    value: nativeToScVal(data),
  });
  if (!decoded) throw new Error(`event ${name} did not decode`);
  return decoded;
}

function registration(ledger = 100): DecodedEvent {
  return registryEvent(
    'provider_registered',
    ledger,
    {
      name: 'Ikeja General Clinic',
      country: 'NG',
      registered_at: 1_760_000_000n,
    },
    [addr(CLINIC)],
  );
}

function statusChange(status: number, ledger = 101): DecodedEvent {
  return registryEvent('provider_status_changed', ledger, { status }, [addr(CLINIC)]);
}

function serviceUpsert(price: bigint, ledger: number): DecodedEvent {
  return registryEvent('service_upserted', ledger, { price, label: 'Consultation' }, [
    addr(CLINIC),
    nativeToScVal(101, { type: 'u32' }),
  ]);
}

async function deliveries(event: string) {
  return prisma.webhookDelivery.findMany({ where: { event }, orderBy: { ledger: 'asc' } });
}

beforeEach(async () => {
  await prisma.webhookDelivery.deleteMany();
  await prisma.servicePriceChange.deleteMany();
  await prisma.providerStatusChange.deleteMany();
  await prisma.service.deleteMany();
  await prisma.provider.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('clinic and service webhook events (#266)', () => {
  it('emits provider.registered with the clinic as the subject and no voucher', async () => {
    await prisma.$transaction((tx) => onProviderRegistered(tx, registration()));

    const rows = await deliveries(PROVIDER_REGISTERED_EVENT);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      voucherId: null,
      provider: CLINIC,
      status: 'Pending',
      serviceCode: null,
      ledger: 100,
    });
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      event: 'provider.registered',
      provider: CLINIC,
      status: 'Pending',
      txHash: 'd'.repeat(64),
      ledger: 100,
    });
  });

  it('emits provider.status_changed once, and not again for a replay of the same status', async () => {
    await prisma.$transaction((tx) => onProviderRegistered(tx, registration()));
    await prisma.webhookDelivery.deleteMany();

    const suspended = statusChange(2, 101);
    await prisma.$transaction((tx) => onProviderStatus(tx, suspended));
    // Replaying the identical event must not produce a second notification.
    await prisma.$transaction((tx) => onProviderStatus(tx, suspended));

    const rows = await deliveries(PROVIDER_STATUS_CHANGED_EVENT);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toMatchObject({
      event: 'provider.status_changed',
      provider: CLINIC,
      status: 'Suspended',
    });
    expect(rows[0]!.voucherId).toBeNull();
  });

  it('emits service.price_changed only when the price actually changes', async () => {
    await prisma.$transaction((tx) => onProviderRegistered(tx, registration()));
    await prisma.webhookDelivery.deleteMany();

    // First listing: a change from no price at all.
    await prisma.$transaction((tx) => onServiceUpserted(tx, serviceUpsert(5_000_000n, 102)));
    expect(await deliveries(SERVICE_PRICE_CHANGED_EVENT)).toHaveLength(1);

    // Same price, new label: no price change, no delivery.
    await prisma.$transaction((tx) => onServiceUpserted(tx, serviceUpsert(5_000_000n, 103)));
    expect(await deliveries(SERVICE_PRICE_CHANGED_EVENT)).toHaveLength(1);

    await prisma.$transaction((tx) => onServiceUpserted(tx, serviceUpsert(6_000_000n, 104)));
    const rows = await deliveries(SERVICE_PRICE_CHANGED_EVENT);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]!.payload)).toEqual({
      event: 'service.price_changed',
      provider: CLINIC,
      serviceCode: 101,
      price: '6000000',
      txHash: 'd'.repeat(64),
      ledger: 104,
    });
    expect(rows[1]).toMatchObject({
      provider: CLINIC,
      serviceCode: 101,
      status: null,
      voucherId: null,
    });
  });
});

import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../db.js';
import { env } from '../env.js';
import { decodeEvent, type DecodedEvent } from '../stellar/events.js';
import {
  lookupDeploymentId,
  onAdminChanged,
  onAdminProposed,
  onAttesterAdded,
  onAttesterRemoved,
  onCapacityChanged,
  onDisputeResolved,
  onDripped,
  onProviderMetadataChanged,
  onProviderRegistered,
  onReceiptMinted,
  onServiceRemoved,
  onServiceUpserted,
  onVoucherClaimed,
  onVoucherCreated,
  storedMetadataUri,
  topicProvider,
  voucherSignal,
} from '../stellar/handlers/index.js';

const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const OTHER_CLINIC = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const FUNDER = 'GAVOC64Q4HF3MIIL5X6J2ZNB4IHIG2RT5NR3XPOIPVGNTV5V5B5L4PFO';
const ATTESTER = 'GBN3U6C2NDHCNA33TKKGRGOQ3VFZQCNZTQOTAHQ6DSYAOTGCWSMYAXEU';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
const LEDGER_CLOSED_AT = '2026-10-01T00:00:00.000Z';

function sym(s: string): xdr.ScVal {
  return nativeToScVal(s, { type: 'symbol' });
}

function rawEvent(
  name: string,
  ledger: number,
  data: Record<string, unknown> = {},
  topics: xdr.ScVal[] = [],
  contractId: string = env.REGISTRY_CONTRACT_ID,
): DecodedEvent {
  const decoded = decodeEvent({
    id: `${name}-${ledger}`,
    contractId,
    txHash: 'c'.repeat(64),
    ledger,
    ledgerClosedAt: LEDGER_CLOSED_AT,
    topic: [sym(name), ...topics],
    value: nativeToScVal(data),
  });
  if (!decoded) throw new Error(`event ${name} did not decode`);
  return decoded;
}

const addr = (a: string): xdr.ScVal => Address.fromString(a).toScVal();
const refBytes = (): xdr.ScVal => nativeToScVal(Buffer.from(REF, 'hex'));
const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: 'u32' });

beforeEach(async () => {
  await prisma.$transaction([
    prisma.reconcileMismatch.deleteMany(),
    prisma.failedEvent.deleteMany(),
    prisma.faucetDrip.deleteMany(),
    prisma.receipt.deleteMany(),
    prisma.dailyStat.deleteMany(),
    prisma.servicePriceChange.deleteMany(),
    prisma.service.deleteMany(),
    prisma.webhookDelivery.deleteMany(),
    prisma.voucher.deleteMany(),
    prisma.providerStatusChange.deleteMany(),
    prisma.provider.deleteMany(),
    prisma.governanceEvent.deleteMany(),
    prisma.attester.deleteMany(),
    prisma.contractEvent.deleteMany(),
    prisma.deployment.deleteMany(),
  ]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('stellar handler modules', () => {
  describe('common helpers', () => {
    it('lookupDeploymentId returns null for untracked contract', async () => {
      const id = await prisma.$transaction((tx) => lookupDeploymentId('CUNKNOWNCONTRACTID', tx));
      expect(id).toBeNull();
    });
  });

  describe('registry handlers', () => {
    it('storedMetadataUri validates uri bounds and logs when over cap', () => {
      const warn = vi.fn();
      const logger = { warn } as never;

      expect(storedMetadataUri('https://example.com/meta.json', logger)).toEqual({
        metadataUri: 'https://example.com/meta.json',
      });
      expect(warn).not.toHaveBeenCalled();

      const tooLong = `https://example.com/${'a'.repeat(600)}`;
      expect(storedMetadataUri(tooLong, logger)).toEqual({});
      expect(warn).toHaveBeenCalledOnce();
    });

    it('onProviderRegistered projects clinic and handles metadata invalidation', async () => {
      const event = rawEvent(
        'provider_registered',
        101,
        {
          name: 'Nairobi Clinic',
          country: 'KE',
          registered_at: 1_760_000_000n,
          metadata_uri: 'https://example.com/clinic.json',
        },
        [addr(CLINIC)],
      );

      await prisma.$transaction((tx) => onProviderRegistered(tx, event));

      const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
      expect(row.name).toBe('Nairobi Clinic');
      expect(row.country).toBe('KE');
      expect(row.status).toBe('Pending');
      expect(row.metadataUri).toBe('https://example.com/clinic.json');
    });

    it('onProviderMetadataChanged updates or clears metadata URI', async () => {
      await prisma.provider.create({
        data: {
          address: CLINIC,
          name: 'Clinic',
          country: 'KE',
          status: 'Active',
          registeredAt: new Date(),
          metadataUri: 'https://example.com/old.json',
        },
      });

      const event = rawEvent(
        'provider_metadata_changed',
        102,
        { metadata_uri: 'https://example.com/new.json' },
        [addr(CLINIC)],
      );

      await prisma.$transaction((tx) => onProviderMetadataChanged(tx, event));

      const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
      expect(row.metadataUri).toBe('https://example.com/new.json');
    });

    it('onCapacityChanged updates provider capacity', async () => {
      await prisma.provider.create({
        data: {
          address: CLINIC,
          name: 'Clinic',
          country: 'KE',
          status: 'Active',
          registeredAt: new Date(),
        },
      });

      const event = rawEvent('capacity_changed', 103, { max_outstanding: u32(50) }, [addr(CLINIC)]);
      await prisma.$transaction((tx) => onCapacityChanged(tx, event));

      const row = await prisma.provider.findUniqueOrThrow({ where: { address: CLINIC } });
      expect(row.capacity).toBe(50);
    });

    it('onServiceUpserted and onServiceRemoved manage clinic services', async () => {
      await prisma.provider.create({
        data: {
          address: CLINIC,
          name: 'Clinic',
          country: 'KE',
          status: 'Active',
          registeredAt: new Date(),
        },
      });

      const upsertEvent = rawEvent(
        'service_upserted',
        104,
        { price: 5_000_000n, label: 'Consultation' },
        [addr(CLINIC), u32(10)],
      );
      await prisma.$transaction((tx) => onServiceUpserted(tx, upsertEvent));

      const service = await prisma.service.findUniqueOrThrow({
        where: { id: `${CLINIC}:10` },
      });
      expect(service.price).toBe('5000000');
      expect(service.active).toBe(true);

      await prisma.$transaction((tx) => onServiceRemoved(tx, { provider: CLINIC, code: 10 }));

      const removed = await prisma.service.findUniqueOrThrow({
        where: { id: `${CLINIC}:10` },
      });
      expect(removed.active).toBe(false);
    });

    it('onAttesterAdded and onAttesterRemoved manage attester roster', async () => {
      const addEvent = rawEvent('attester_added', 105, {}, [addr(ATTESTER)]);
      await prisma.$transaction((tx) => onAttesterAdded(tx, addEvent));

      const active = await prisma.attester.findUniqueOrThrow({ where: { address: ATTESTER } });
      expect(active.active).toBe(true);

      const removeEvent = rawEvent('attester_removed', 106, {}, [addr(ATTESTER)]);
      await prisma.$transaction((tx) => onAttesterRemoved(tx, removeEvent));

      const removed = await prisma.attester.findUniqueOrThrow({ where: { address: ATTESTER } });
      expect(removed.active).toBe(false);
      expect(removed.removedAt).toBeInstanceOf(Date);
    });

    it('onAdminProposed and onAdminChanged record governance events', async () => {
      const propEvent = rawEvent(
        'admin_proposed',
        107,
        { pending_admin: OTHER_CLINIC },
        [addr(CLINIC)],
        env.VOUCHER_CONTRACT_ID,
      );
      await prisma.$transaction((tx) => onAdminProposed(tx, propEvent));

      const proposed = await prisma.governanceEvent.findFirstOrThrow({
        where: { kind: 'Proposed' },
      });
      expect(proposed.admin).toBe(CLINIC);
      expect(proposed.pendingAdmin).toBe(OTHER_CLINIC);

      const changeEvent = rawEvent(
        'admin_changed',
        108,
        { new_admin: OTHER_CLINIC },
        [],
        env.RECEIPT_CONTRACT_ID,
      );
      await prisma.$transaction((tx) => onAdminChanged(tx, changeEvent));

      const changed = await prisma.governanceEvent.findFirstOrThrow({
        where: { kind: 'Changed' },
      });
      expect(changed.admin).toBe(OTHER_CLINIC);
    });
  });

  describe('faucet handlers', () => {
    it('onDripped stores faucet drip with wallet and amount', async () => {
      const event = rawEvent(
        'dripped',
        109,
        { amount: 10_000_000n },
        [addr(FUNDER)],
        env.FAUCET_CONTRACT_ID,
      );

      await prisma.$transaction((tx) => onDripped(tx, event));

      const drip = await prisma.faucetDrip.findFirstOrThrow({ where: { wallet: FUNDER } });
      expect(drip.amount).toBe('10000000');
      expect(drip.ledger).toBe(109);
    });
  });

  describe('receipt handlers', () => {
    it('onReceiptMinted stores receipt and daily stat', async () => {
      const event = rawEvent(
        'receipt_minted',
        110,
        {
          voucher_id: 999n,
          service_code: 1,
          amount: 50_000_000n,
          settled_at: 1_759_536_000n,
        },
        [refBytes(), addr(CLINIC)],
        env.RECEIPT_CONTRACT_ID,
      );

      await prisma.$transaction((tx) => onReceiptMinted(tx, event));

      const receipt = await prisma.receipt.findUniqueOrThrow({ where: { voucherId: '999' } });
      expect(receipt.amount).toBe('50000000');
      expect(receipt.providerAddress).toBe(CLINIC);

      const daily = await prisma.dailyStat.findUniqueOrThrow({ where: { date: '2025-10-04' } });
      expect(daily.settledCount).toBe(1);
    });
  });

  describe('voucher handlers', () => {
    it('topicProvider extracts provider address or returns null', () => {
      const withProvider = rawEvent(
        'voucher_created',
        111,
        { voucher_id: 1n },
        [addr(FUNDER), addr(CLINIC), refBytes()],
        env.VOUCHER_CONTRACT_ID,
      );
      expect(topicProvider(withProvider)).toBe(CLINIC);

      const withoutProvider = rawEvent('voucher_created', 111, { voucher_id: 1n }, []);
      expect(topicProvider(withoutProvider)).toBeNull();
    });

    it('voucherSignal constructs a valid PendingSignal', () => {
      const event = rawEvent(
        'voucher_created',
        112,
        { voucher_id: 42n },
        [addr(FUNDER), addr(CLINIC), refBytes()],
        env.VOUCHER_CONTRACT_ID,
      );
      const signal = voucherSignal(event, 'Funded', CLINIC);
      expect(signal).toEqual({
        id: event.id,
        type: 'voucher_created',
        voucherId: '42',
        status: 'Funded',
        providerAddress: CLINIC,
        ledger: 112,
        txHash: event.txHash,
        at: event.ledgerClosedAt,
      });
    });

    it('onVoucherCreated and onVoucherClaimed transition voucher state', async () => {
      const createEvent = rawEvent(
        'voucher_created',
        113,
        {
          voucher_id: 123n,
          service_code: 1,
          amount: 25_000_000n,
          created_at: 1_760_000_000n,
          expires_at: 1_760_500_000n,
        },
        [addr(FUNDER), addr(CLINIC), refBytes()],
        env.VOUCHER_CONTRACT_ID,
      );

      const createdSignal = await prisma.$transaction((tx) => onVoucherCreated(tx, createEvent));
      expect(createdSignal.voucherId).toBe('123');
      expect(createdSignal.status).toBe('Funded');

      const claimEvent = rawEvent(
        'voucher_claimed',
        114,
        { voucher_id: 123n, claimed_at: 1_760_050_000n },
        [addr(CLINIC)],
        env.VOUCHER_CONTRACT_ID,
      );

      const claimedSignal = await prisma.$transaction((tx) =>
        onVoucherClaimed(tx, claimEvent, {
          voucherReader: vi.fn(),
        }),
      );
      expect(claimedSignal.status).toBe('Claimed');

      const row = await prisma.voucher.findUniqueOrThrow({ where: { id: '123' } });
      expect(row.status).toBe('Claimed');
      expect(row.claimedAt).toBeInstanceOf(Date);
    });

    it('onDisputeResolved records dispute resolution outcome', async () => {
      await prisma.provider.create({
        data: {
          address: CLINIC,
          name: 'Clinic',
          country: 'KE',
          status: 'Active',
          registeredAt: new Date(),
        },
      });

      await prisma.voucher.create({
        data: {
          id: '456',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 1,
          amount: '10000',
          status: 'Disputed',
          createdAt: new Date(),
          expiresAt: new Date(),
        },
      });

      const event = rawEvent(
        'dispute_resolved',
        115,
        { voucher_id: 456n, admin: FUNDER, refunded_funder: true },
        [],
        env.VOUCHER_CONTRACT_ID,
      );

      await prisma.$transaction((tx) => onDisputeResolved(tx, event));

      const row = await prisma.voucher.findUniqueOrThrow({ where: { id: '456' } });
      expect(row.disputeOutcome).toBe('Funder');
      expect(row.disputeResolvedBy).toBe(FUNDER);
    });
  });
});

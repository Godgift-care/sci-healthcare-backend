import { describe, expect, it } from 'vitest';
import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { decodeEvent, TOPIC_FIELDS } from '../stellar/events.js';
import { normaliseChainVoucher, type ChainVoucher } from '../stellar/reconcile.js';

describe('quickstart integration and topic regression test suite', () => {
  const FUNDER_ADDR = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
  const CLINIC_ADDR = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
  const ATTESTER_ADDR = 'GA64IEGSITBY4EVMROLT24OV4CT7X2LWARAXNRRILIQLQ2CEFTPJWS4P';
  const BREF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';
  const CONTRACT_ID = 'CBPUQN6CNJCNGPKNEXB7UM4T7RINKQB7HQI5CXEOSQ5EFRHE4G4VKPSQ';

  describe('on-chain contract event and topic regression', () => {
    it('decodes topic fields as real Stellar addresses, never literal "undefined"', () => {
      const rawEvent = {
        id: 'evt-quickstart-1',
        contractId: CONTRACT_ID,
        txHash: 'a'.repeat(64),
        ledger: 100,
        ledgerClosedAt: '2026-10-23T12:00:00Z',
        topic: [
          nativeToScVal('voucher_created', { type: 'symbol' }),
          Address.fromString(FUNDER_ADDR).toScVal(),
          Address.fromString(CLINIC_ADDR).toScVal(),
          nativeToScVal(Buffer.from(BREF, 'hex')),
        ],
        value: nativeToScVal({
          voucher_id: 1n,
          service_code: 101,
          amount: 30000000n,
          created_at: 1788352637n,
          expires_at: 1790944632n,
        }),
      };

      const decoded = decodeEvent(rawEvent);
      expect(decoded).not.toBeNull();
      expect(decoded!.name).toBe('voucher_created');

      expect(decoded!.fields.funder).toBe(FUNDER_ADDR);
      expect(decoded!.fields.funder).not.toBe('undefined');
      expect(typeof decoded!.fields.funder).toBe('string');
      expect((decoded!.fields.funder as string).length).toBe(56);

      expect(decoded!.fields.provider).toBe(CLINIC_ADDR);
      expect(decoded!.fields.provider).not.toBe('undefined');
      expect(typeof decoded!.fields.provider).toBe('string');
      expect((decoded!.fields.provider as string).length).toBe(56);
    });

    it('ensures all topic mapping declarations in TOPIC_FIELDS have defined field names', () => {
      for (const [_eventName, topics] of Object.entries(TOPIC_FIELDS)) {
        for (const topicField of topics) {
          expect(topicField).toBeDefined();
          expect(topicField).not.toBe('undefined');
          expect(typeof topicField).toBe('string');
          expect(topicField.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe('read model vs on-chain get_voucher state', () => {
    it('matches read model state against on-chain get_voucher struct for a full lifecycle', async () => {
      const TEST_VOUCHER_ID = '90001';
      const chainVoucher: ChainVoucher = {
        id: BigInt(TEST_VOUCHER_ID),
        funder: Address.fromString(FUNDER_ADDR).toScVal(),
        beneficiary_ref: nativeToScVal(Buffer.from(BREF, 'hex')),
        provider: Address.fromString(CLINIC_ADDR).toScVal(),
        service_code: 101n,
        amount: 30000000n,
        status: 2n,
        created_at: 1788352637n,
        expires_at: 1790944632n,
        claimed_at: 1788353000n,
        attested_at: 1788354000n,
        dispute_deadline: 1788613200n,
      };

      const native = {
        id: scValToNative(chainVoucher.id as xdr.ScVal),
        funder: FUNDER_ADDR,
        beneficiary_ref: Buffer.from(BREF, 'hex'),
        provider: CLINIC_ADDR,
        service_code: 101,
        amount: 30000000n,
        status: 2,
        created_at: 1788352637,
        expires_at: 1790944632,
        claimed_at: 1788353000,
        attested_at: 1788354000,
        dispute_deadline: 1788613200,
      };

      const normalised = normaliseChainVoucher(native);
      expect(normalised.status).toBe('Attested');
      expect(normalised.funder).toBe(FUNDER_ADDR);
      expect(normalised.providerAddress).toBe(CLINIC_ADDR);
      expect(normalised.amount).toBe('30000000');

      await prisma.provider.upsert({
        where: { address: CLINIC_ADDR },
        create: {
          address: CLINIC_ADDR,
          name: 'Integration Test Clinic',
          country: 'NG',
          status: 'Active',
          registeredAt: new Date(1788350000 * 1000),
        },
        update: {},
      });

      await prisma.service.upsert({
        where: { id: `${CLINIC_ADDR}:101` },
        create: {
          id: `${CLINIC_ADDR}:101`,
          providerAddress: CLINIC_ADDR,
          code: 101,
          label: 'Outpatient consult',
          price: '30000000',
          active: true,
        },
        update: {},
      });

      await prisma.voucher.upsert({
        where: { id: TEST_VOUCHER_ID },
        create: {
          id: TEST_VOUCHER_ID,
          seq: BigInt(TEST_VOUCHER_ID),
          funder: normalised.funder,
          beneficiaryRef: normalised.beneficiaryRef,
          providerAddress: normalised.providerAddress,
          serviceCode: normalised.serviceCode,
          amount: normalised.amount,
          amountKey: normalised.amount.padStart(39, '0'),
          status: normalised.status,
          createdAt: normalised.createdAt,
          expiresAt: normalised.expiresAt,
          claimedAt: normalised.claimedAt,
          attestedAt: normalised.attestedAt,
          disputeDeadline: normalised.disputeDeadline,
          attestedBy: ATTESTER_ADDR,
        },
        update: {
          status: normalised.status,
          createdAt: normalised.createdAt,
          expiresAt: normalised.expiresAt,
          claimedAt: normalised.claimedAt,
          attestedAt: normalised.attestedAt,
          disputeDeadline: normalised.disputeDeadline,
          attestedBy: ATTESTER_ADDR,
        },
      });

      const app = await buildApp();
      const res = await app.inject({
        method: 'GET',
        url: `/vouchers/${TEST_VOUCHER_ID}`,
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();

      expect(json.id).toBe(TEST_VOUCHER_ID);
      expect(json.funder).toBe(FUNDER_ADDR);
      expect(json.funder).not.toBe('undefined');
      expect(json.provider.address).toBe(CLINIC_ADDR);
      expect(json.provider.address).not.toBe('undefined');
      expect(json.beneficiaryRef).toBe(BREF);
      expect(json.serviceCode).toBe(101);
      expect(json.amount).toBe(normalised.amount);
      expect(json.status).toBe(normalised.status);
      expect(new Date(json.createdAt).getTime()).toBe(normalised.createdAt.getTime());
      expect(new Date(json.expiresAt).getTime()).toBe(normalised.expiresAt.getTime());
      expect(new Date(json.claimedAt).getTime()).toBe(normalised.claimedAt!.getTime());
      expect(new Date(json.attestedAt).getTime()).toBe(normalised.attestedAt!.getTime());
      expect(new Date(json.disputeDeadline).getTime()).toBe(normalised.disputeDeadline!.getTime());
    });
  });
});

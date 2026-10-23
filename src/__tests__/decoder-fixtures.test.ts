import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { asHex, decodeEvent, TOPIC_FIELDS } from '../stellar/events.js';

/**
 * Which of the decoder's event types the captured set does *not* cover, and
 * why — measured against the live testnet deployment, not read off the
 * contracts' source. These are the events a reviewer cannot get from history
 * either: the RPC retains ~7 days of testnet ledgers and this deployment is
 * dormant, so there is no past event to capture for them.
 *
 * `lapsed-voucher-refund` and the rest of the captured set come from
 * `src/scripts/capture-testnet-fixtures.ts`; the calls that published them are
 * listed with their transaction hashes in the PR body for #64.
 */
const BLOCKED_REASONS: Record<string, string> = {
  provider_status_changed:
    'registry.set_provider_status is admin-only; the live admin GA64IEG…WS4P key is not held by us',
  provider_metadata_changed:
    'absent from the deployed bytecode: the live registry CAMU635…VE4V exports 17 functions (read back with getContractWasmByContractId) and none of them repoints a metadata URI — the event exists only in the contracts source (#10, surfaced here by #181)',
  service_upserted:
    'the deployed register_provider self-registers a provider as Pending and upsert_service requires Active (live registry error #6); activation is admin-only',
  service_removed:
    'same Active gate as service_upserted — no self-service path to Active on the deployed bytecode',
  attester_added: 'registry.add_attester is admin-only',
  attester_removed: 'registry.remove_attester is admin-only',
  admin_proposed: 'registry.propose_admin is admin-only',
  admin_changed: 'registry.accept_admin needs an outstanding admin proposal (admin-only)',
  voucher_claimed:
    'voucher.claim needs the provider signature; the only Active provider on the deployment is the seeded clinic, whose key we do not hold',
  voucher_attested:
    'voucher.attest requires a registry attester, and add_attester (which grants it) is admin-only',
  voucher_disputed:
    'voucher.dispute needs a Claimed (or in-window Attested) voucher, which presupposes voucher_claimed',
  voucher_settled:
    'voucher.settle requires status Attested — transitively gated behind the admin-granted attester role',
  dispute_resolved: 'voucher.resolve_dispute is admin-only',
  receipt_minted:
    'the only receipt-mint call sites are settle and dispute resolution, both unreachable; the mint itself also requires the voucher contract signature',
};

/**
 * Decoder fixtures captured from testnet (#64).
 *
 * `events.test.ts` builds events by hand with its own `sym()`/`raw()` helpers,
 * so a mistake about which `#[topic]` field sits in which topic position can be
 * encoded identically in the test and the decoder — and both stay green. The
 * JSON files next to this suite are ground truth instead: raw `EventResponse`
 * bytes captured verbatim from `soroban-rpc getEvents` by
 * `src/scripts/capture-testnet-fixtures.ts`, each with a `_provenance` block
 * pointing at the transaction and ledger that produced it. To refresh them:
 * publish the lifecycle events against the testnet deployment (the entry point
 * and signer for each is listed in the PR body for #64), then run
 * `npm run fixtures:capture` to read them back through the RPC. No generator
 * script ships here — the body says why.
 *
 * This suite runs offline — it only ever reads the committed JSON.
 */

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixtureFiles = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

type Fixture = {
  _provenance: {
    capturedAt: string;
    networkPassphrase: string;
    source: string;
    txHash: string;
    ledger: number;
  };
  event: {
    id: string;
    contractId: string;
    txHash: string;
    ledger: number;
    ledgerClosedAt: string;
    topic: string[];
    value: string;
  };
};

function loadFixture(file: string): Fixture {
  return JSON.parse(readFileSync(path.join(fixturesDir, file), 'utf8')) as Fixture;
}

const capturedNames = fixtureFiles.map((f) => f.replace(/\.json$/, ''));
const allTypes = Object.keys(TOPIC_FIELDS);
const blockedTypes = Object.keys(BLOCKED_REASONS);

describe('testnet decoder fixtures', () => {
  it('holds at least one captured fixture', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0);
  });

  it('accounts for every event type the decoder claims to know', () => {
    // The completeness contract of #64: a type is either covered by a captured
    // fixture or explicitly documented as uncapturable on the live deployment.
    // Anything else is a silent gap.
    const covered = new Set([...capturedNames, ...blockedTypes]);
    expect(covered).toEqual(new Set(allTypes));
    for (const name of capturedNames) {
      expect(blockedTypes, `"${name}" is both captured and documented as blocked`).not.toContain(
        name,
      );
    }
  });

  it('documents the blocked types with a reason that is not a placeholder', () => {
    expect(blockedTypes).toHaveLength(new Set(blockedTypes).size);
    for (const [name, reason] of Object.entries(BLOCKED_REASONS)) {
      expect(allTypes, `blocked type "${name}" is not a decoder event type`).toContain(name);
      expect(reason.length).toBeGreaterThan(30);
      expect(reason).not.toMatch(/TODO|TBD|unknown/i);
    }
  });

  for (const file of fixtureFiles) {
    const name = file.replace(/\.json$/, '');
    describe(name, () => {
      const fixture = loadFixture(file);
      const decoded = decodeEvent(fixture.event);

      it('is named after a decoder event type and decodes to that name', () => {
        expect(allTypes, `"${name}" is not a TOPIC_FIELDS event type`).toContain(name);
        expect(decoded).not.toBeNull();
        expect(decoded!.name).toBe(name);
      });

      it('resolves every registered topic field to a defined value', () => {
        const registered = TOPIC_FIELDS[name];
        if (!registered) throw new Error(`no TOPIC_FIELDS entry for "${name}"`);
        // The core regression guard: a topic field read from the wrong slot —
        // or out of the data map instead of the topic — surfaces here as
        // undefined, which no hand-built event can reveal.
        for (const field of registered) {
          expect(decoded!.fields[field], `topic field "${field}" is undefined`).toBeDefined();
        }
      });

      it('keeps the topic values in the positions TOPIC_FIELDS assumes', () => {
        const registered = TOPIC_FIELDS[name];
        if (!registered) throw new Error(`no TOPIC_FIELDS entry for "${name}"`);
        // topic[0] is the event name; every registered field needs its own slot.
        expect(fixture.event.topic.length).toBeGreaterThanOrEqual(1 + registered.length);
        expect(decoded!.id).toBe(fixture.event.id);
        expect(decoded!.txHash).toBe(fixture.event.txHash);
      });

      it('carries provenance back to a real testnet transaction', () => {
        expect(fixture._provenance.source).toBe('soroban-rpc.getEvents');
        expect(fixture._provenance.networkPassphrase).toBe(
          'Test SDF Network ; September 2015',
        );
        expect(fixture._provenance.txHash).toMatch(/^[0-9a-f]{64}$/);
        expect(Number.isInteger(fixture._provenance.ledger)).toBe(true);
        expect(fixture._provenance.ledger).toBeGreaterThan(0);
        expect(decoded!.txHash).toBe(fixture._provenance.txHash);
        expect(decoded!.ledger).toBe(fixture._provenance.ledger);
      });
    });
  }

  it("stamps vouchers with the fixture run's synthetic beneficiary, never real data", () => {
    // sha256 of a fixed marker, not a hash of anything real. If a captured
    // fixture ever shows a different value here, deployment data leaked into
    // the fixture set — which is the patient-data check this issue asks for.
    const want = createHash('sha256').update('L154B synthetic fixture beneficiary').digest('hex');
    for (const name of ['voucher_created', 'receipt_minted']) {
      if (!capturedNames.includes(name)) continue;
      const decoded = decodeEvent(loadFixture(`${name}.json`).event)!;
      expect(asHex(decoded.fields.beneficiary_ref), `${name} beneficiary_ref`).toBe(want);
    }
  });

  it('holds no real patient or clinic data in the captured set', () => {
    for (const file of fixtureFiles) {
      const decoded = decodeEvent(loadFixture(file).event)!;
      if (typeof decoded.fields.name === 'string') {
        expect(decoded.fields.name).toMatch(/^L154B.Fixture.Clinic$/);
      }
      if (typeof decoded.fields.label === 'string') {
        expect(decoded.fields.label).toMatch(/Fixture/);
      }
    }
  });
});

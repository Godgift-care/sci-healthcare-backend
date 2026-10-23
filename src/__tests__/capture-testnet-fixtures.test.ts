import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  buildFixture,
  eventNameOf,
  getEventsWindow,
  parseArgs,
  scanWindow,
  scValBase64,
  writeFixtures,
} from '../scripts/capture-testnet-fixtures.js';

/**
 * Unit tests for the fixture capture script (#64): the helpers that turn raw
 * `soroban-rpc getEvents` responses into the JSON fixtures this repo decodes.
 * The network paths (`main`, `scanHistory`) are exercised by hand against
 * testnet and never from CI, so the RPC server here is mocked.
 */

// The capture script's getEvents calls go through ../stellar/client.js.
const { mockServer } = vi.hoisted(() => ({ mockServer: { getEvents: vi.fn() } }));
vi.mock('../stellar/client.js', () => ({ server: mockServer }));

const sym = (s: string): string => xdr.ScVal.scvSymbol(s).toXDR('base64');

describe('capture-testnet-fixtures helpers', () => {
  it('parseArgs applies defaults and option values', () => {
    expect(parseArgs([])).toEqual({
      outDir: expect.any(String),
      window: 500,
      maxLedgers: null,
      contracts: null,
    });
    const p = parseArgs(['--out', '/tmp/fx', '--window', '50', '--max-ledgers', '400']);
    expect(p.outDir).toBe('/tmp/fx');
    expect(p.window).toBe(50);
    expect(p.maxLedgers).toBe(400);
  });

  it('parseArgs collects repeated --contract and null when none', () => {
    const p = parseArgs(['--contract', 'C1', '--contract', 'C2']);
    expect(p.contracts).toEqual(['C1', 'C2']);
  });

  it('parseArgs rejects a window outside 1..500', () => {
    expect(() => parseArgs(['--window', '0'])).toThrow(/between 1 and 500/);
    expect(() => parseArgs(['--window', '501'])).toThrow(/between 1 and 500/);
    expect(() => parseArgs(['--window', '1.5'])).toThrow(/between 1 and 500/);
  });

  it('scValBase64 passes strings through and encodes ScVals', () => {
    const b64 = sym('dripped');
    expect(scValBase64(b64)).toBe(b64);
    expect(scValBase64(xdr.ScVal.scvSymbol('dripped'))).toBe(b64);
  });

  it('eventNameOf reads the first topic entry, null on garbage', () => {
    expect(eventNameOf({ topic: [sym('voucher_created')] })).toBe('voucher_created');
    expect(eventNameOf({ topic: [] })).toBeNull();
    expect(eventNameOf({ topic: [xdr.ScVal.scvU32(7).toXDR('base64')] })).toBeNull();
  });

  it('buildFixture keeps raw base64 bytes and records provenance', () => {
    const raw = {
      id: '0000000123#0',
      type: 'contract',
      txHash: 'ab'.repeat(32),
      contractId: 'CABC',
      topic: [sym('dripped'), xdr.ScVal.scvU32(1)],
      value: xdr.ScVal.scvMap([]),
      ledger: 123,
      ledgerClosedAt: '2026-10-22T00:00:00Z',
    };
    const fx = buildFixture(raw);
    expect(fx._provenance.source).toBe('soroban-rpc.getEvents');
    expect(fx._provenance.txHash).toBe('ab'.repeat(32));
    expect(fx._provenance.ledger).toBe(123);
    expect(fx._provenance.networkPassphrase).toBe('Test SDF Network ; September 2015');
    expect(fx.event.topic).toHaveLength(2);
    expect(typeof (fx.event.topic as string[])[1]).toBe('string');
    expect(typeof fx.event.value).toBe('string');
  });

  it('getEventsWindow re-clamps startLedger when the retention window moved', async () => {
    mockServer.getEvents
      .mockRejectedValueOnce(new Error('startLedger must be within the ledger range: 900'))
      .mockResolvedValueOnce({ events: [], cursor: 'c' });
    const res = await getEventsWindow(100, 600, []);
    expect(res.events).toEqual([]);
    expect(mockServer.getEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ startLedger: 900, endLedger: 600 }),
    );
    mockServer.getEvents.mockReset();
  });

  it('scanWindow captures one fixture per wanted type and ignores the rest', async () => {
    mockServer.getEvents.mockResolvedValue({
      events: [
        {
          id: '1#0',
          txHash: 'aa',
          contractId: 'CC',
          topic: [sym('dripped')],
          value: xdr.ScVal.scvMap([]),
          ledger: 5,
          ledgerClosedAt: '2026-10-22T00:00:00Z',
        },
        {
          id: '1#1',
          txHash: 'bb',
          contractId: 'CC',
          topic: [sym('some_unknown_event')],
          value: xdr.ScVal.scvMap([]),
          ledger: 5,
          ledgerClosedAt: '2026-10-22T00:00:00Z',
        },
      ],
      cursor: 'c',
    });
    const found = new Map<string, ReturnType<typeof buildFixture>>();
    await scanWindow(1, 10, ['CC'], found);
    expect([...found.keys()]).toEqual(['dripped']);
    // A second scan of the same window does not overwrite the first capture.
    await scanWindow(1, 10, ['CC'], found);
    expect(found.get('dripped')!._provenance.txHash).toBe('aa');
    mockServer.getEvents.mockReset();
  });

  it('writeFixtures writes <type>.json per captured event', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fx-'));
    try {
      const found = new Map<string, ReturnType<typeof buildFixture>>([
        [
          'dripped',
          buildFixture({
            id: '1',
            txHash: 'aa',
            topic: [sym('dripped')],
            value: sym('x'),
            ledger: 2,
          }),
        ],
      ]);
      writeFixtures(dir, found);
      const written = JSON.parse(readFileSync(path.join(dir, 'dripped.json'), 'utf8'));
      expect(written._provenance.ledger).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  digestEquals,
  verifyWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_TOLERANCE_SEC,
} from '../../packages/client/dist/index.js';
import { computeSignature, verifySignature } from '../../examples/telegram-bot/dist/index.js';

/**
 * Fixed vectors, computed independently of this code with
 * `openssl dgst -sha256 -hmac test-secret-key-12345`, so a verifier that
 * silently changed what it signs would not move them along with it.
 */
const SECRET = 'test-secret-key-12345';
const BODY = '{"event":"voucher_settled","voucherId":"voucher-1","status":"Settled","ledger":5123}';
const BODY_DIGEST = 'fb9ea81f5101d3e1afb065366e25c88c26c11a59bce2e554ad630ac17dfd39a7';
const STAMP = '1730000000';
const STAMPED_DIGEST = '3279725fa02322b61b4260e28ebaced144e030f4fc5cc34f520a208dee520fbe';
const STAMPED_NOW = Number(STAMP) * 1000;

const hex = (value: string): string =>
  createHmac('sha256', SECRET).update(value, 'utf8').digest('hex');

/** The same digest with its first character changed to another hex digit. */
const wrongDigest = (value: string): string => `${value[0] === 'a' ? 'b' : 'a'}${value.slice(1)}`;

describe('verifyWebhook, body-only signatures (#288)', () => {
  it('accepts the fixed vector over the raw body', () => {
    expect(verifyWebhook(BODY, { [WEBHOOK_SIGNATURE_HEADER]: BODY_DIGEST }, SECRET)).toBe(true);
  });

  it('accepts the sha256= prefix and either header case', () => {
    expect(verifyWebhook(BODY, { [WEBHOOK_SIGNATURE_HEADER]: `sha256=${BODY_DIGEST}` }, SECRET)).toBe(true);
    expect(verifyWebhook(BODY, { 'X-SCI-Signature': BODY_DIGEST.toUpperCase() }, SECRET)).toBe(true);
  });

  it('accepts a Headers instance and a repeated header', () => {
    expect(verifyWebhook(BODY, new Headers({ [WEBHOOK_SIGNATURE_HEADER]: BODY_DIGEST }), SECRET)).toBe(true);
    expect(verifyWebhook(BODY, { [WEBHOOK_SIGNATURE_HEADER]: [BODY_DIGEST, 'junk'] }, SECRET)).toBe(true);
  });

  it('signs the bytes, not a re-serialisation of them', () => {
    const asBuffer = Buffer.from(BODY, 'utf8');
    expect(verifyWebhook(asBuffer, { [WEBHOOK_SIGNATURE_HEADER]: BODY_DIGEST }, SECRET)).toBe(true);
    // Whitespace inside the body is part of what was signed.
    expect(verifyWebhook(`${BODY} `, { [WEBHOOK_SIGNATURE_HEADER]: BODY_DIGEST }, SECRET)).toBe(false);
  });

  it('rejects a tampered body, another secret, and a malformed header', () => {
    expect(verifyWebhook(`${BODY.slice(0, -1)}, "ledger": 5124}`, { [WEBHOOK_SIGNATURE_HEADER]: BODY_DIGEST }, SECRET)).toBe(false);
    expect(verifyWebhook(BODY, { [WEBHOOK_SIGNATURE_HEADER]: hex(BODY) }, 'other-secret')).toBe(false);
    for (const header of ['', '   ', 'not-hex', BODY_DIGEST.slice(0, 63), `${BODY_DIGEST}00`]) {
      expect(verifyWebhook(BODY, { [WEBHOOK_SIGNATURE_HEADER]: header }, SECRET)).toBe(false);
    }
  });

  it('rejects when the header or the secret is missing (#288)', () => {
    expect(verifyWebhook(BODY, undefined, SECRET)).toBe(false);
    expect(verifyWebhook(BODY, null, SECRET)).toBe(false);
    expect(verifyWebhook(BODY, {}, SECRET)).toBe(false);
    expect(verifyWebhook(BODY, { [WEBHOOK_SIGNATURE_HEADER]: BODY_DIGEST }, '')).toBe(false);
  });

  it('reads the header it is told to read', () => {
    const signature = hex(BODY);
    expect(verifyWebhook(BODY, { 'x-other-signature': signature }, SECRET, { header: 'x-other-signature' })).toBe(true);
    expect(verifyWebhook(BODY, { 'x-other-signature': signature }, SECRET)).toBe(false);
  });
});

describe('verifyWebhook, timestamped signatures (#288)', () => {
  const header = (timestamp: string, signature: string): Record<string, string> => ({
    [WEBHOOK_SIGNATURE_HEADER]: `t=${timestamp},v1=${signature}`,
  });

  it('accepts the fixed vector signed as `<t>.<body>` within the window', () => {
    expect(
      verifyWebhook(BODY, header(STAMP, STAMPED_DIGEST), SECRET, { now: () => STAMPED_NOW }),
    ).toBe(true);
    // The window is symmetric and inclusive at the edge.
    expect(
      verifyWebhook(
        BODY,
        header(STAMP, STAMPED_DIGEST),
        SECRET,
        { now: () => STAMPED_NOW + WEBHOOK_TIMESTAMP_TOLERANCE_SEC * 1000 },
      ),
    ).toBe(true);
  });

  it('rejects a replayed header once the timestamp is old (#288)', () => {
    // Same valid signature, one second past the tolerance.
    expect(
      verifyWebhook(
        BODY,
        header(STAMP, STAMPED_DIGEST),
        SECRET,
        { now: () => STAMPED_NOW + (WEBHOOK_TIMESTAMP_TOLERANCE_SEC + 1) * 1000 },
      ),
    ).toBe(false);
    // ...and a clock that is ahead of the timestamp by the same amount.
    expect(
      verifyWebhook(
        BODY,
        header(STAMP, STAMPED_DIGEST),
        SECRET,
        { now: () => STAMPED_NOW - (WEBHOOK_TIMESTAMP_TOLERANCE_SEC + 1) * 1000 },
      ),
    ).toBe(false);
    expect(
      verifyWebhook(BODY, header(STAMP, STAMPED_DIGEST), SECRET, {
        now: () => STAMPED_NOW,
        toleranceSec: 0,
      }),
    ).toBe(true);
  });

  it('rejects a timestamp moved to stretch the window', () => {
    // A captured header cannot be re-dated: the timestamp is inside what
    // was signed, so moving it breaks the digest.
    expect(verifyWebhook(BODY, header('1730000600', STAMPED_DIGEST), SECRET, { now: () => STAMPED_NOW })).toBe(false);
    expect(verifyWebhook(BODY, header(STAMP, BODY_DIGEST), SECRET, { now: () => STAMPED_NOW })).toBe(false);
  });

  it('accepts any listed v1 and needs at least one', () => {
    const other = hex(`${STAMP}.${BODY}`);
    expect(
      verifyWebhook(
        BODY,
        { [WEBHOOK_SIGNATURE_HEADER]: `t=${STAMP},v1=deadbeef,v1=${other}` },
        SECRET,
        { now: () => STAMPED_NOW },
      ),
    ).toBe(true);
    expect(verifyWebhook(BODY, { [WEBHOOK_SIGNATURE_HEADER]: `t=${STAMP}` }, SECRET, { now: () => STAMPED_NOW })).toBe(false);
    expect(verifyWebhook(BODY, { [WEBHOOK_SIGNATURE_HEADER]: `t=soon,v1=${STAMPED_DIGEST}` }, SECRET, { now: () => STAMPED_NOW })).toBe(false);
  });
});

describe('digestEquals (#288)', () => {
  it('compares digests of equal length and refuses everything else', () => {
    expect(digestEquals(BODY_DIGEST, BODY_DIGEST)).toBe(true);
    expect(digestEquals(BODY_DIGEST.toUpperCase(), BODY_DIGEST)).toBe(true);
    expect(digestEquals(BODY_DIGEST, wrongDigest(BODY_DIGEST))).toBe(false);
    expect(digestEquals(BODY_DIGEST.slice(0, 62), BODY_DIGEST.slice(0, 62))).toBe(false);
    expect(digestEquals('', '')).toBe(false);
    expect(digestEquals(BODY_DIGEST, 'not hexadecimal at all..................')).toBe(false);
  });
});

describe('the shared verifier is what the examples use (#288)', () => {
  it('compares with timingSafeEqual rather than string equality', () => {
    // Structural, because a timing leak is invisible to a behavioural test:
    // the digests must reach node:crypto's constant-time compare, and no
    // digest may be judged with `===`.
    const source = readFileSync(
      new URL('../../packages/client/src/webhook.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/import \{[^}]*timingSafeEqual[^}]*\} from 'node:crypto'/);
    expect(source).toMatch(/timingSafeEqual\(/);
    expect(source).not.toMatch(/(?:digest|expected|candidate|signature|sig) === /);
  });

  it('agrees with the Telegram example about the same request', () => {
    for (const payload of [BODY, '{"event":"voucher_funded","voucherId":"voucher-2"}']) {
      const signature = computeSignature(payload, SECRET);
      expect(verifySignature(payload, signature, SECRET)).toBe(
        verifyWebhook(payload, { [WEBHOOK_SIGNATURE_HEADER]: signature }, SECRET),
      );
      expect(verifySignature(payload, wrongDigest(signature), SECRET)).toBe(false);
    }
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
  });
});

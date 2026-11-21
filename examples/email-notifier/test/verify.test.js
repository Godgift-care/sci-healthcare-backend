import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeSignature, verifySignature } from '../lib/verify.js';

const SECRET = 'test-secret';

test('accepts a signature the service would have sent', () => {
  const body = Buffer.from(JSON.stringify({ voucherId: 'VC-1', status: 'claimed' }));
  const signature = computeSignature(body, SECRET);
  assert.equal(verifySignature(body, signature, SECRET), true);
});

test('accepts the sha256= prefix other tooling adds', () => {
  const body = Buffer.from('{"voucherId":"VC-1"}');
  const signature = computeSignature(body, SECRET);
  assert.equal(verifySignature(body, `sha256=${signature}`, SECRET), true);
});

test('rejects a body that changed after signing', () => {
  const signature = computeSignature('{"voucherId":"VC-1"}', SECRET);
  const tampered = Buffer.from('{"voucherId":"VC-2"}');
  assert.equal(verifySignature(tampered, signature, SECRET), false);
});

test('rejects a signature under the wrong secret', () => {
  const body = Buffer.from('{"voucherId":"VC-1"}');
  const signature = computeSignature(body, 'other-secret');
  assert.equal(verifySignature(body, signature, SECRET), false);
});

test('rejects a missing header or an unset secret', () => {
  const body = Buffer.from('{"voucherId":"VC-1"}');
  assert.equal(verifySignature(body, undefined, SECRET), false);
  assert.equal(verifySignature(body, computeSignature(body, SECRET), ''), false);
});

test('rejects non-hex and wrong-length headers instead of throwing', () => {
  const body = Buffer.from('{"voucherId":"VC-1"}');
  assert.equal(verifySignature(body, 'not-hex', SECRET), false);
  assert.equal(verifySignature(body, 'abc', SECRET), false);
  assert.equal(verifySignature(body, 'sha256=', SECRET), false);
});

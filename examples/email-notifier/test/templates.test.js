import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PrivacyError, assertNoPatientData, renderEmail } from '../lib/templates.js';

const OPTIONS = { from: 'notifier@example.invalid', to: 'clinic@example.invalid' };

function email(payload) {
  return renderEmail(payload, OPTIONS);
}

test('renders the fields the service actually sends', () => {
  const mail = email({
    event: 'voucher_settled',
    voucherId: 'VC-42',
    status: 'Settled',
    txHash: 'abc123',
    ledger: 1005,
  });

  assert.equal(mail.subject, 'Voucher settled and paid');
  assert.match(mail.text, /Voucher: VC-42/);
  assert.match(mail.text, /Status: Settled/);
  assert.match(mail.text, /Event: voucher_settled/);
  assert.match(mail.text, /Ledger: 1005/);
  assert.match(mail.text, /Transaction: abc123/);
  assert.match(mail.html, /<li>Ledger: 1005<\/li>/);
});

test('a settled voucher asks for nothing, a claimed one names the next step', () => {
  assert.doesNotMatch(email({ voucherId: 'VC-1', status: 'Settled' }).text, /Prepare/);
  assert.match(
    email({ voucherId: 'VC-1', status: 'Claimed' }).text,
    /Deliver the care and attest it\./,
  );
});

test('falls back to the event name when the status is unknown', () => {
  const mail = email({ voucherId: 'VC-1', status: 'Weird', event: 'voucher_refunded' });
  assert.equal(mail.subject, 'Voucher refunded');
});

test('an unrecognised transition still produces a letter', () => {
  const mail = email({ voucherId: 'VC-1', status: 'SomethingElse' });
  assert.equal(mail.subject, 'Voucher updated');
});

test('omits a transaction hash the RPC did not report', () => {
  const mail = email({ voucherId: 'VC-1', status: 'Claimed', ledger: 7 });
  assert.doesNotMatch(mail.text, /Transaction/);
  assert.doesNotMatch(mail.html, /Transaction/);
});

test('escapes markup rather than injecting it into the html part', () => {
  const mail = email({ voucherId: '<script>alert(1)</script>', status: 'Claimed' });
  assert.doesNotMatch(mail.html, /<script>/i);
  assert.match(mail.html, /&lt;script&gt;/i);
});

test('escapes markup whatever case the payload uses', () => {
  const mail = email({ voucherId: '<SCRIPT>alert(1)</SCRIPT>', status: 'Claimed' });
  assert.doesNotMatch(mail.html, /<script>/i);
  assert.match(mail.html, /&lt;SCRIPT&gt;/);
});

test('refuses a payload carrying a beneficiary reference', () => {
  const payload = { voucherId: 'VC-1', status: 'Claimed', beneficiaryRef: 'a'.repeat(64) };
  assert.throws(() => email(payload), PrivacyError);
});

test('refuses a reference at any depth, and a patient-named key', () => {
  assert.throws(
    () => email({ voucherId: 'VC-1', status: 'Claimed', meta: { patient: 'ref' } }),
    PrivacyError,
  );
  assert.throws(
    () => email({ voucherId: 'VC-1', status: 'Claimed', events: [{ beneficiary: 'ref' }] }),
    PrivacyError,
  );
});

test('the privacy guard passes a clean payload', () => {
  assert.doesNotThrow(() => assertNoPatientData({ voucherId: 'VC-1', ledger: 4, tags: ['a'] }));
});

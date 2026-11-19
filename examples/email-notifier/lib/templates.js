/**
 * Turning a signed webhook payload into the mail a clinic desk receives.
 *
 * Two rules shape this file. The first is the one the whole example exists to
 * demonstrate: a beneficiary reference never reaches an inbox, so the body is
 * assembled from an explicit allow-list rather than from whatever the payload
 * happened to carry, and any payload that mentions one at all is refused
 * before a letter is written. The indexer does not send the reference, but a
 * receiver that renders unknown fields is one upstream change away from
 * leaking it.
 *
 * The second is that this is public-chain data only: voucher id, status, event,
 * ledger, transaction hash. Anything a patient would not want forwarded is
 * already absent.
 */

/** Key names that would make a payload patient-identifying. */
const PRIVATE_KEY = /beneficiar|patient/i;

/** A payload that must not become a letter. */
export class PrivacyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrivacyError';
    this.code = 'privacy_violation';
  }
}

/**
 * Throws if the payload carries anything patient-identifying, at any depth.
 *
 * The chain of custody for a webhook body is not this example's to trust: a
 * future indexer release, a proxy that enriches, or a hand-rolled test all
 * have the same ability to put a reference in front of a clinic's mailbox.
 */
export function assertNoPatientData(value, path = 'payload') {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoPatientData(item, `${path}[${index}]`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_KEY.test(key)) {
        throw new PrivacyError(`Privacy violation: ${path}.${key} is a beneficiary reference`);
      }
      assertNoPatientData(item, `${path}.${key}`);
    }
  }
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The subject and the desk's next step, keyed by contract event word. */
const TEMPLATES = {
  created: { subject: 'New care voucher funded', action: 'Prepare to receive this patient.' },
  claimed: { subject: 'Voucher claimed at your clinic', action: 'Deliver the care and attest it.' },
  attested: { subject: 'Voucher attested', action: 'Settlement follows the attestation window.' },
  settled: { subject: 'Voucher settled and paid', action: null },
  disputed: { subject: 'Voucher disputed', action: 'A funder has queried this settlement.' },
  refunded: { subject: 'Voucher refunded', action: 'No payment is due for this voucher.' },
};

const UNKNOWN = { subject: 'Voucher updated', action: null };

/**
 * Matches `voucher_claimed`, `claimed` or `Claimed` to one template. Status is
 * consulted first because it is what the voucher ended up as, which is the
 * thing the desk acts on.
 */
function templateFor(status, event) {
  for (const value of [status, event]) {
    const word = String(value ?? '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .find((part) => part in TEMPLATES);
    if (word) return TEMPLATES[word];
  }
  return UNKNOWN;
}

/**
 * The letter for one transition: `{ from, to, subject, text, html }`.
 *
 * `assertNoPatientData` runs first, so a caller cannot reach the template
 * without passing the guard.
 */
export function renderEmail(payload, { from, to }) {
  assertNoPatientData(payload);

  const { subject, action } = templateFor(payload.status, payload.event);
  const facts = [
    ['Voucher', payload.voucherId],
    ['Status', payload.status],
    ...(payload.event ? [['Event', payload.event]] : []),
    ...(payload.ledger === undefined || payload.ledger === null
      ? []
      : [['Ledger', payload.ledger]]),
    ...(payload.txHash ? [['Transaction', payload.txHash]] : []),
  ];

  const lines = [subject, '', ...facts.map(([label, value]) => `${label}: ${value}`)];
  if (action) lines.push('', action);

  const html = [
    `<h2>${escapeHtml(subject)}</h2>`,
    '<ul>',
    ...facts.map(([label, value]) => `<li>${escapeHtml(label)}: ${escapeHtml(value)}</li>`),
    '</ul>',
    ...(action ? [`<p><em>${escapeHtml(action)}</em></p>`] : []),
  ].join('\n');

  return { from, to, subject, text: lines.join('\n'), html };
}

/**
 * The webhook body the indexer posts (`src/lib/webhooks.ts` in the backend).
 * Those five keys are the whole contract: the payload carries no beneficiary
 * reference, no amount and no service label, so a receiver cannot name a
 * patient even by accident.
 */
export type WebhookVoucherPayload = {
  event: string;
  voucherId: string;
  status: string;
  txHash?: string | null;
  ledger?: number | null;
};

/** A WhatsApp Business Cloud message template, as approved by Meta. */
export type WhatsAppTemplate = {
  /** Template name registered in Meta Business Manager. */
  name: string;
  /** Language code the approved template exists in. */
  languageCode: string;
  /** Text for `{{1}}`, `{{2}}`, ... in that order. */
  variables: string[];
};

/**
 * Voucher status -> approved template name. Only statuses with an approved
 * template can be sent: an unapproved name is a Graph API error, so anything
 * else is skipped rather than guessed at. `voucher_created` (status `Funded`)
 * is deliberately absent — this example notifies staff once care is being
 * delivered or paid, which is what #293 asks for.
 */
export const TEMPLATE_BY_STATUS: Readonly<Record<string, string>> = Object.freeze({
  Claimed: 'voucher_claimed',
  Attested: 'voucher_attested',
  Settled: 'voucher_settled',
});

/**
 * Payload keys that would identify a beneficiary. The indexer never sends
 * them; the check is here so a misconfigured or hand-rolled poster is refused
 * instead of forwarded.
 */
const FORBIDDEN_KEYS = ['beneficiaryRef', 'beneficiary_ref', 'beneficiary', 'patient'];

/** Throws when the payload carries anything that could identify a patient. */
export function assertNoPatientReference(payload: Record<string, unknown>): void {
  const found = FORBIDDEN_KEYS.filter((key) => key in payload);
  if (found.length > 0) {
    throw new Error(`Privacy violation: payload contains beneficiary references (${found.join(', ')})`);
  }
}

/**
 * Maps a webhook payload onto an approved template, or returns `undefined`
 * when no approved template covers the status. Variables are the voucher id
 * and the ledger only — the two public, non-patient fields in the contract.
 */
export function templateForPayload(
  payload: WebhookVoucherPayload,
  languageCode: string,
): WhatsAppTemplate | undefined {
  assertNoPatientReference(payload as Record<string, unknown>);

  const name = TEMPLATE_BY_STATUS[payload.status];
  if (name === undefined) return undefined;

  const voucherId = String(payload.voucherId ?? '').trim();
  // Only a numeric id may reach a template variable: a hand-rolled poster
  // could otherwise put free text (a name, a note) into the message body.
  if (!/^\d+$/.test(voucherId)) {
    throw new Error(`Invalid voucher id in payload: ${JSON.stringify(payload.voucherId)}`);
  }

  const ledger = payload.ledger ?? null;
  if (ledger !== null && !Number.isSafeInteger(ledger)) {
    throw new Error(`Invalid ledger in payload: ${JSON.stringify(payload.ledger)}`);
  }

  return { name, languageCode, variables: [voucherId, ledger === null ? '-' : String(ledger)] };
}

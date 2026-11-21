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
export declare const TEMPLATE_BY_STATUS: Readonly<Record<string, string>>;
/** Throws when the payload carries anything that could identify a patient. */
export declare function assertNoPatientReference(payload: Record<string, unknown>): void;
/**
 * Maps a webhook payload onto an approved template, or returns `undefined`
 * when no approved template covers the status. Variables are the voucher id
 * and the ledger only — the two public, non-patient fields in the contract.
 */
export declare function templateForPayload(payload: WebhookVoucherPayload, languageCode: string): WhatsAppTemplate | undefined;

/**
 * The webhook body the indexer posts (`src/lib/webhooks.ts` in the backend).
 * Those five keys are the whole contract: no beneficiary reference, no
 * amount and no service label, so a receiver cannot name a patient even by
 * accident.
 */
export type WebhookVoucherPayload = {
    event: string;
    voucherId: string;
    status: string;
    txHash?: string | null;
    ledger?: number | null;
};
/**
 * Character budget for one SMS segment. The network counts GSM-7 *septets*
 * (160 per segment) and switches the whole message to UCS-2 — 70 characters
 * per segment — if any character is outside GSM-7. "Under 160 characters"
 * therefore means: one segment under whichever budget applies to the text.
 */
export declare const GSM_7_SEGMENT_LIMIT = 160;
export declare const UCS_2_SEGMENT_LIMIT = 70;
export type SmsEncoding = 'gsm7' | 'ucs2';
/** Which alphabet a message has to be sent in. */
export declare function smsEncoding(text: string): SmsEncoding;
/**
 * Length in the units the carrier bills a segment by: septets for GSM-7
 * (shift-table characters counting double), characters for UCS-2.
 */
export declare function smsUnits(text: string): number;
/** The limit that applies to this particular text. */
export declare function smsUnitLimit(text: string): number;
export declare function fitsOneSegment(text: string): boolean;
/** Throws when the text would be split across more than one segment. */
export declare function assertOneSegment(text: string): string;
/** Throws when the payload carries anything that could identify a patient. */
export declare function assertNoPatientReference(payload: Record<string, unknown>): void;
/** Every status this example has wording for. */
export declare const KNOWN_STATUSES: readonly string[];
/**
 * Builds the SMS for one webhook delivery: the voucher id and the ledger,
 * which are the only public, non-patient fields in the contract, and nothing
 * else. The result is checked against the single-segment budget, so an
 * unexpectedly long id fails loudly instead of arriving as two billed
 * messages.
 */
export declare function formatSmsMessage(payload: WebhookVoucherPayload): string;

/**
 * Webhook payload from SCI Healthcare indexer.
 * STRICT PRIVACY GUARANTEE:
 * Beneficiary references and patient secrets are never sent by the indexer
 * and never included in clinic messages.
 */
export type WebhookVoucherPayload = {
    event: string;
    voucherId: string;
    status: string;
    txHash?: string | null;
    ledger?: number | null;
    amount?: string | null;
    amountDisplay?: string | null;
    serviceCode?: number | null;
    serviceLabel?: string | null;
    providerAddress?: string | null;
    [key: string]: unknown;
};
/**
 * Formats a plain-text email notification body for clinic staff.
 * Throws an Error if any beneficiary reference is present in the payload.
 */
export declare function formatEmailMessage(payload: WebhookVoucherPayload): string;
/**
 * Formats a Telegram notification message for clinic staff.
 * Throws an Error if any beneficiary reference is present in the payload.
 */
export declare function formatTelegramMessage(payload: WebhookVoucherPayload): string;

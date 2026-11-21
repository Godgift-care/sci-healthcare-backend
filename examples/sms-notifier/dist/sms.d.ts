/** Africa's Talking endpoints. The sandbox has the same API but never
 * delivers to a handset. */
export declare const PRODUCTION_API: string;
export declare const SANDBOX_API: string;
export declare const SANDBOX_USERNAME = "sandbox";
export interface SendSmsOptions {
    username: string;
    apiKey: string;
    /** Recipient in E.164, e.g. `+2348023104455`. */
    to: string;
    message: string;
    /** Registered short code or sender ID. Sandbox ignores it. */
    from?: string | undefined;
    baseUrl?: string | undefined;
    fetchImpl?: typeof fetch;
}
export type SendResult = {
    ok: true;
    messageId: string;
    status: string;
    cost?: string | undefined;
} | {
    ok: false;
    error: string;
};
/**
 * Posts one SMS to `/version1/messaging`. That endpoint takes an
 * `application/x-www-form-urlencoded` body — not JSON — and authenticates
 * with the `apikey` header plus the `username` form field, so both are set
 * here exactly as the API documents them.
 */
export declare function sendSms(options: SendSmsOptions): Promise<SendResult>;

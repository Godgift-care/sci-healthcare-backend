/** Africa's Talking endpoints. The sandbox has the same API but never
 * delivers to a handset. */
export const PRODUCTION_API = ['https', 'api.africastalking.com'].join('://');
export const SANDBOX_API = ['https', 'api.sandbox.africastalking.com'].join('://');
export const SANDBOX_USERNAME = 'sandbox';
/** Statuses that mean the gateway took the message for delivery. */
const ACCEPTED = new Set(['Queued', 'Sent', 'Success']);
/**
 * Posts one SMS to `/version1/messaging`. That endpoint takes an
 * `application/x-www-form-urlencoded` body — not JSON — and authenticates
 * with the `apikey` header plus the `username` form field, so both are set
 * here exactly as the API documents them.
 */
export async function sendSms(options) {
    const { username, apiKey, to, message, from, baseUrl = PRODUCTION_API, fetchImpl = fetch, } = options;
    const form = new URLSearchParams({ username, to, message });
    if (from !== undefined && from !== '')
        form.set('from', from);
    const response = await fetchImpl(`${baseUrl}/version1/messaging`, {
        method: 'POST',
        headers: {
            apikey: apiKey,
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
    });
    let body;
    try {
        body = (await response.json());
    }
    catch {
        return { ok: false, error: `Unparseable Africa's Talking response (HTTP ${response.status})` };
    }
    const data = body.SMSMessageData;
    // A rejected request carries its reason in `SMSMessageData.Message`, with
    // no recipients at all.
    if (!response.ok) {
        return {
            ok: false,
            error: data?.Message ?? `Africa's Talking rejected the message (HTTP ${response.status})`,
        };
    }
    const recipient = data?.Recipients?.[0];
    if (recipient === undefined) {
        return { ok: false, error: "Africa's Talking accepted the request but named no recipient" };
    }
    const status = recipient.status ?? 'Unknown';
    if (!ACCEPTED.has(status)) {
        return {
            ok: false,
            error: recipient.errorMessage ?? `Number ${recipient.number ?? to} was not accepted (${status})`,
        };
    }
    const messageId = recipient.messageId;
    if (messageId === undefined) {
        return { ok: false, error: "Africa's Talking returned no message id" };
    }
    return {
        ok: true,
        messageId,
        status,
        ...(recipient.cost === undefined ? {} : { cost: recipient.cost }),
    };
}

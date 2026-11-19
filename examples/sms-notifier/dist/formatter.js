/**
 * Character budget for one SMS segment. The network counts GSM-7 *septets*
 * (160 per segment) and switches the whole message to UCS-2 — 70 characters
 * per segment — if any character is outside GSM-7. "Under 160 characters"
 * therefore means: one segment under whichever budget applies to the text.
 */
export const GSM_7_SEGMENT_LIMIT = 160;
export const UCS_2_SEGMENT_LIMIT = 70;
/** Printable ASCII that GSM-7 only reaches through its shift table. */
const SHIFTED_ASCII = ['^', '[', ']', '{', '}', '|', '\\', '~', '`', '€'];
/** One septet each: the GSM-7 basic alphabet, ASCII plus its accented letters. */
const GSM_7_BASIC = new Set([
    ...'\n\r',
    ..." !\"#$%&'()*+,-./0123456789:;<=>?@_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    ...'£$¥¡¿ÇØøÅÆæßÉÍÑÖÜàäåçèéìñòöùúü',
]);
/**
 * Two septets each: the characters GSM-7 only reaches with a single shift.
 * Anything outside both sets — `ɓ`, `Ŋ`, `฿`, any non-Latin script — is not
 * GSM-7 at all and forces the whole message into UCS-2.
 */
const GSM_7_EXTENDED = new Set(SHIFTED_ASCII);
/** Septets for one character, or `Infinity` when the character is not GSM-7. */
function charSeptets(char) {
    if (GSM_7_BASIC.has(char))
        return 1;
    if (GSM_7_EXTENDED.has(char))
        return 2;
    return Infinity;
}
/** Which alphabet a message has to be sent in. */
export function smsEncoding(text) {
    for (const char of text) {
        if (!Number.isFinite(charSeptets(char)))
            return 'ucs2';
    }
    return 'gsm7';
}
/**
 * Length in the units the carrier bills a segment by: septets for GSM-7
 * (shift-table characters counting double), characters for UCS-2.
 */
export function smsUnits(text) {
    if (smsEncoding(text) === 'ucs2')
        return [...text].length;
    let units = 0;
    for (const char of text)
        units += charSeptets(char);
    return units;
}
/** The limit that applies to this particular text. */
export function smsUnitLimit(text) {
    return smsEncoding(text) === 'ucs2' ? UCS_2_SEGMENT_LIMIT : GSM_7_SEGMENT_LIMIT;
}
export function fitsOneSegment(text) {
    return smsUnits(text) <= smsUnitLimit(text);
}
/** Throws when the text would be split across more than one segment. */
export function assertOneSegment(text) {
    if (!fitsOneSegment(text)) {
        throw new Error(`SMS is ${smsUnits(text)} ${smsEncoding(text)} units, over the ${smsUnitLimit(text)}-unit single-segment limit: ${text}`);
    }
    return text;
}
/**
 * Payload keys that would identify a beneficiary. The indexer never sends
 * them; the check is here so a misconfigured or hand-rolled poster is refused
 * instead of forwarded.
 */
const FORBIDDEN_KEYS = ['beneficiaryRef', 'beneficiary_ref', 'beneficiary', 'patient'];
/** Throws when the payload carries anything that could identify a patient. */
export function assertNoPatientReference(payload) {
    const found = FORBIDDEN_KEYS.filter((key) => key in payload);
    if (found.length > 0) {
        throw new Error(`Privacy violation: payload contains beneficiary references (${found.join(', ')})`);
    }
}
/**
 * Wording per status. A status outside this table never reaches a handset as
 * written: it gets the generic line, because payload text is not content.
 */
const MESSAGE_BY_STATUS = Object.freeze({
    Funded: 'New care voucher {{voucher}} funded (ledger {{ledger}}).',
    Claimed: 'Care voucher {{voucher}} claimed (ledger {{ledger}}). Submit the attestation.',
    Attested: 'Care voucher {{voucher}} attested (ledger {{ledger}}). Settlement follows.',
    Settled: 'Care voucher {{voucher}} settled and paid (ledger {{ledger}}). Receipt in portal.',
    Disputed: 'Care voucher {{voucher}} disputed (ledger {{ledger}}). Review it in the portal.',
    Refunded: 'Care voucher {{voucher}} refunded (ledger {{ledger}}).',
});
const GENERIC_MESSAGE = 'Care voucher {{voucher}} updated (ledger {{ledger}}).';
/** Every status this example has wording for. */
export const KNOWN_STATUSES = Object.freeze(Object.keys(MESSAGE_BY_STATUS));
/**
 * Builds the SMS for one webhook delivery: the voucher id and the ledger,
 * which are the only public, non-patient fields in the contract, and nothing
 * else. The result is checked against the single-segment budget, so an
 * unexpectedly long id fails loudly instead of arriving as two billed
 * messages.
 */
export function formatSmsMessage(payload) {
    assertNoPatientReference(payload);
    const voucherId = String(payload.voucherId ?? '').trim();
    // Only a numeric id may reach the message: a hand-rolled poster could
    // otherwise put free text (a name, a note) straight onto a handset.
    if (!/^\d+$/.test(voucherId)) {
        throw new Error(`Invalid voucher id in payload: ${JSON.stringify(payload.voucherId)}`);
    }
    const ledger = payload.ledger ?? null;
    if (ledger !== null && !Number.isSafeInteger(ledger)) {
        throw new Error(`Invalid ledger in payload: ${JSON.stringify(payload.ledger)}`);
    }
    const template = MESSAGE_BY_STATUS[String(payload.status ?? '')] ?? GENERIC_MESSAGE;
    return assertOneSegment(template
        .replaceAll('{{voucher}}', voucherId)
        .replaceAll('{{ledger}}', ledger === null ? 'pending' : String(ledger)));
}

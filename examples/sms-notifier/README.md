# Clinic SMS Notifier

An example microservice that turns the indexer's signed voucher webhook into a
one-segment SMS for clinic staff, sent through the **Africa's Talking** messaging
API. Same shape as [`examples/telegram-bot/`](../telegram-bot/README.md) and
[`examples/whatsapp-notifier/`](../whatsapp-notifier/README.md).

## Why SMS

Feature phones are common among clinic staff and among the sponsors who fund
vouchers. SMS needs no app, no data plan and no smartphone, so it is the floor
every other channel sits on top of.

## What it does

1. **Verifies the `X-SCI-Signature` HMAC-SHA256 of the raw bytes** — with a
   constant-time comparison — *before* the body is parsed, formatted or sent.
   A delivery without a valid signature for the shared `WEBHOOK_SECRET`
   produces no network traffic at all.
2. **Builds one short message per event** from fixed wording
   (`MESSAGE_BY_STATUS` in `src/formatter.ts`) and checks it fits a single
   segment before it is sent.
3. **Sends only public fields**: the voucher id and the ledger, which are the
   only two non-patient values in the webhook contract
   (`{event, voucherId, status, txHash?, ledger}`).

## No patient reference, in three places

The payload never carries a beneficiary reference (`src/lib/webhooks.ts`), and
this service does not reintroduce one:

- `assertNoPatientReference` refuses a payload carrying `beneficiaryRef`,
  `beneficiary_ref`, `beneficiary` or `patient` with `400 payload_rejected`,
  before anything is sent.
- The message text is chosen from a table keyed by status. A status outside
  that table is never copied into the message — it gets the generic line —
  so payload text cannot become message content.
- The voucher id must be digits and the ledger a safe integer, so free text
  (a name, a note) cannot be interpolated onto a handset.

`src/__tests__/sms-notifier.test.ts` asserts both halves of that: no rejection
path makes an HTTP call, and every generated message is checked for the words
it must never contain.

## The 160-character rule, precisely

"One SMS, under 160 characters" is a budget in the encoding the carrier uses,
not a plain string length:

| Text | Encoding | Budget for one segment |
|---|---|---|
| ASCII, and GSM-7 accented letters (`é ñ ß ü ø Å`) | GSM-7 septets | 160, and shift-table characters (`^ [ ] { } ~ | €`) cost **two** |
| anything outside GSM-7 (`₦`, `Ŋ`, any non-Latin script) | UCS-2 | **70** |

`smsEncoding`, `smsUnits`, `smsUnitLimit` and `assertOneSegment` implement
exactly that, so a message containing `₦` is measured against 70 rather than
160. Every wording in the table fits with room to spare — the longest, for
`Settled`, is 80 characters — and a voucher id long enough to break the budget
is refused with `400 payload_rejected` instead of silently billing two
segments.

## Requirements

- Node.js >= 20.11
- An [Africa's Talking](https://africastalking.com) account (the sandbox needs
  no payment details)
- An API key from the dashboard
- For live sending: a registered **sender ID** or short code, since the
  gateway refuses a message whose `from` is not yours

## Step 1: run it in the sandbox first

The sandbox is a full copy of the API that never delivers to a real handset.

1. Sign in at `https://account.africastalking.com` and open **Sandbox**. Your
   sandbox username is literally `sandbox`.
2. Copy your **API key** from the sandbox dashboard (it differs from the live
   key — do not mix them).
3. Add the test number you want to use in the sandbox's phone numbers, and use
   it as the recipient: the sandbox only accepts its own test numbers (the
   `1515…`, `1516…`, `1517…` block shown in the dashboard) and shows what you
   sent in the sandbox **simulator** rather than delivering it.
4. Start the notifier with `SMS_SANDBOX=1`, which points it at
   `https://api.sandbox.africastalking.com` and defaults the username to
   `sandbox`:

```bash
PORT=3003 \
WEBHOOK_SECRET=your-secret \
SMS_SANDBOX=1 \
AFRICTALKING_API_KEY=your-sandbox-key \
SMS_CLINIC_NUMBER=1515123456 \
npx tsx examples/sms-notifier/src/index.ts
```

`GET /health` answers `{"status":"ok","sandbox":true}`, so you can tell which
endpoint a running instance is actually pointed at before you send anything.

## Step 2: switch to live

```bash
WEBHOOK_SECRET=your-secret \
AFRICTALKING_USERNAME=your-username \
AFRICTALKING_API_KEY=your-live-key \
SMS_SENDER_ID=CLINIC \
SMS_CLINIC_NUMBER=+2348023104455 \
npx tsx examples/sms-notifier/src/index.ts
```

Live recipients are E.164 (`+2348023104455`), and each message is billed at
your account's rate — the gateway's per-recipient `cost` is echoed in the
response and is what you meter against.

## Configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port the webhook is posted to | `3003` |
| `WEBHOOK_SECRET` | Shared with the indexer; verifies `X-SCI-Signature` | `example-webhook-secret-do-not-use-in-prod` |
| `AFRICTALKING_USERNAME` | Account username | `sandbox` when pointed at the sandbox, otherwise required |
| `AFRICTALKING_API_KEY` | API key for that environment | none — required |
| `SMS_SANDBOX` | `1`/`true` to use the sandbox host | off |
| `SMS_API_BASE_URL` | Explicit host, e.g. for a proxy | sandbox or production by `SMS_SANDBOX` |
| `SMS_SENDER_ID` | Registered short code / sender ID for `from` | omitted, so the account default is used |
| `SMS_CLINIC_NUMBER` | Staff number that receives the alerts | none |

The payload identifies a voucher, not a clinic, so the recipient comes from
`SMS_CLINIC_NUMBER` or from the `resolveRecipient(voucherId)` hook passed to
`createWebhookServer` — in a real deployment that is a voucher -> clinic ->
staff lookup in the clinic's own store. If it resolves to nothing, the
delivery is answered `200 no_recipient` and nothing is sent.

## Step 3: point the indexer at it

```bash
WEBHOOK_URLS=http://localhost:3003/webhook
```

## Step 4: send a test delivery

The signature is the hex HMAC-SHA256 of the exact bytes posted, so sign the
string you send and post that same string:

```bash
SECRET="your-secret"
PAYLOAD='{"event":"voucher_settled","voucherId":"9100000000002","status":"Settled","txHash":"deadbeef","ledger":5612039}'

SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -sS -X POST http://localhost:3003/webhook \
  -H 'content-type: application/json' \
  -H "x-sci-signature: $SIG" \
  --data "$PAYLOAD"
```

Expected response:

```json
{"ok":true,"status":"delivered","voucherId":"9100000000002","providerStatus":"Queued","chars":80,"messageId":"030003491181811571071","cost":"KES0.8000"}
```

In the sandbox, `providerStatus` is what the gateway reported and the message
appears in the simulator.

## Responses you can get back

| Status | Body | When |
|---|---|---|
| `200` | `{"ok":true,"status":"delivered",...}` | the gateway queued the message |
| `200` | `{"ok":true,"status":"no_recipient",...}` | signed, but no number on file for the voucher |
| `401` | `{"error":"invalid_signature"}` | missing or wrong `x-sci-signature` — nothing was sent |
| `400` | `{"error":"invalid_json"}` | body was not JSON |
| `400` | `{"error":"payload_rejected"}` | a beneficiary reference, an unusable voucher id / ledger, or a message over one segment |
| `501` | `{"error":"not_configured"}` | signed, but no username/API key |
| `502` | `{"error":"sms_error"}` | the gateway refused the number or the request |

`4xx` other than 408/429 stops the indexer's retries permanently, which is
what you want for a forged or malformed payload; `502` and `501` are retried
with the documented backoff, so a sandbox that is briefly unreachable does
not lose the alert.

## Tests

The suite stubs the HTTP client — nothing is sent and no test needs
credentials — and asserts that every rejection path makes zero calls.

```bash
npx vitest run src/__tests__/sms-notifier.test.ts
```

## Layout

```
src/verify.ts      hex HMAC-SHA256 over the raw body, constant-time
src/formatter.ts   privacy guard, wording table, single-segment budget
src/sms.ts         POST /version1/messaging, form-encoded, apikey header
src/server.ts      the webhook endpoint, in that order
src/index.ts       environment wiring and the listener
dist/              compiled output, committed like the other examples
```

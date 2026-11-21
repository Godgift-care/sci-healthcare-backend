# Clinic WhatsApp Notifier

An example microservice that turns the indexer's signed voucher webhook into a
WhatsApp message for clinic staff, sent through the **WhatsApp Business Cloud
API** (Meta's Graph API). It follows the same shape as
[`examples/telegram-bot/`](../telegram-bot/README.md).

## Why WhatsApp

Most clinics in the target regions already coordinate on WhatsApp. A message
that lands where staff already read means a claimed voucher is attested
sooner, and attested vouchers settle sooner.

## What it does

1. **Verifies the `X-SCI-Signature` HMAC-SHA256 of the raw bytes** — with a
   constant-time comparison — *before* the body is parsed, formatted or sent.
   A delivery that does not carry a valid signature for the shared
   `WEBHOOK_SECRET` produces no network traffic at all.
2. **Maps the voucher status onto an approved message template.** Only
   `Claimed`, `Attested` and `Settled` have templates (`TEMPLATE_BY_STATUS` in
   `src/formatter.ts`); any other status is answered `200 skipped` and nothing
   is sent, because Meta rejects an unknown or unapproved template name.
3. **Sends only public fields.** The webhook body is
   `{event, voucherId, status, txHash?, ledger}` and the template variables are
   the voucher id and the ledger — the two values that are public on-chain.

## Privacy guarantee

The indexer never puts a beneficiary reference in a webhook payload
(`src/lib/webhooks.ts`), and this service keeps that promise in three places:

- `assertNoPatientReference` refuses a payload carrying `beneficiaryRef`,
  `beneficiary_ref`, `beneficiary` or `patient` with `400 payload_rejected`,
  so a hand-rolled or misconfigured poster cannot turn this service into a
  leak.
- Template variables are validated before use: the voucher id must be digits
  only and the ledger a safe integer. Free text from a payload can never be
  interpolated into a message.
- Nothing from the payload is echoed back into the HTTP response beyond
  `voucherId`.

Meta's own rules are stricter than the code: a notification template must not
disclose that a specific person is receiving healthcare. That is why these
templates name a *voucher*, never a patient, and why the wording below is
written for clinic staff rather than for the beneficiary.

## Requirements

- Node.js >= 20.11
- A **Meta Business Portfolio** with a WhatsApp Business Account
- A sending number registered on the WhatsApp Business Cloud API (its
  `PHONE_NUMBER_ID`, from the API setup page)
- A **System User access token** with `whatsapp_business_messaging` and
  `whatsapp_business_management` scopes. Use a System User token, not a
  short-lived user token: this service is unattended and a user token expires.
- The recipient number(s) of the clinic staff who opt in to notifications

## Step 1: create and get the templates approved

WhatsApp only allows business-initiated messages through a **template** that
Meta has approved. Free-form text is only allowed inside the 24-hour customer
service window, which a voucher webhook does not create.

1. In Meta Business Manager, open **WhatsApp → Message templates → Create**.
2. Choose **Category: Utility** (a transactional notification about an agreed
   service). Marketing category is reviewed under different rules and is not
   what an operational alert is.
3. Name the template exactly as the code expects it, lowercase with
   underscores, and pick **Language: English (US)**:

   | Status in webhook | Template name | Approved body (2 variables) |
   |---|---|---|
   | `Claimed` | `voucher_claimed` | `Care voucher {{1}} has been claimed by the clinic. Ledger {{2}}. Please record the treatment and submit your attestation in the clinic portal.` |
   | `Attested` | `voucher_attested` | `Care voucher {{1}} has been attested. Ledger {{2}}. Settlement is being finalised.` |
   | `Settled` | `voucher_settled` | `Care voucher {{1}} is settled and the clinic has been paid. Ledger {{2}}. The receipt is in the clinic portal.` |

   The variables are positional: `{{1}}` is the voucher id and `{{2}}` is the
   ledger, always in that order, because `templateForPayload` emits exactly
   two `body` parameters. A template whose placeholder count differs is
   rejected by the API, so re-approve the wording rather than changing the
   code.
4. **Submit for review.** Approval is automatic for most utility templates
   within minutes, and can take up to 24 hours (longer if Meta asks for a
   resubmission). The template list shows `Pending`, then `Approved`. Until it
   is `Approved`, every send to that name fails and this service answers
   `502 whatsapp_error`.
5. Read the approved name(s) and the language back into the environment below.
   If you change the language code, `WHATSAPP_LANGUAGE_CODE` must match a
   language in which that template was actually approved.

Approval is the step people forget: the code is correct, the token is valid,
and Meta still refuses the send because the template is `Pending`.

## Step 2: configuration

| Variable | Description | Default |
|---|---|---|
| `PORT` | HTTP port the webhook is posted to | `3002` |
| `WEBHOOK_SECRET` | Shared with the indexer; verifies `X-SCI-Signature` | `example-webhook-secret-do-not-use-in-prod` |
| `WHATSAPP_PHONE_NUMBER_ID` | Graph API id of the sending business number | none — required |
| `WHATSAPP_ACCESS_TOKEN` | System User token | none — required |
| `WHATSAPP_CLINIC_NUMBER` | Staff number in E.164, e.g. `+2348023104455` | none |
| `WHATSAPP_LANGUAGE_CODE` | Language of the approved template | `en_US` |
| `WHATSAPP_GRAPH_API` | Graph API host | `https://graph.facebook.com` |
| `WHATSAPP_API_VERSION` | Graph API version | `v23.0` |

The payload identifies a voucher, not a clinic, so the recipient comes from
`WHATSAPP_CLINIC_NUMBER` or from the `resolveRecipient(voucherId)` hook you can
pass to `createWebhookServer` — in a real deployment that is a lookup of
voucher -> clinic -> staff number in the clinic's own store. If it resolves to
nothing, the delivery is answered `200 no_recipient` and nothing is sent.

## Step 3: run it

```bash
# from the repository root
WEBHOOK_SECRET=your-secret \
WHATSAPP_PHONE_NUMBER_ID=1234567890 \
WHATSAPP_ACCESS_TOKEN=EAAG... \
WHATSAPP_CLINIC_NUMBER=+2348023104455 \
npx tsx examples/whatsapp-notifier/src/index.ts
```

Point the indexer at it (`WEBHOOK_URLS` accepts a comma-separated list):

```bash
WEBHOOK_URLS=http://localhost:3002/webhook
```

To run the built output instead, `npm run build` inside this directory
compiles `src/` to `dist/` and `npm start` runs it.

## Step 4: send a test delivery

The signature is the hex HMAC-SHA256 of the exact bytes posted, so sign the
string you send and post that same string:

```bash
SECRET="your-secret"
PAYLOAD='{"event":"voucher_settled","voucherId":"9100000000002","status":"Settled","txHash":"deadbeef","ledger":5612039}'

SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')

curl -sS -X POST http://localhost:3002/webhook \
  -H 'content-type: application/json' \
  -H "x-sci-signature: $SIG" \
  --data "$PAYLOAD"
```

Expected response:

```json
{"ok":true,"status":"delivered","voucherId":"9100000000002","template":"voucher_settled","messageId":"wamid.MTAyM..."}
```

## Responses you can get back

| Status | Body | When |
|---|---|---|
| `200` | `{"ok":true,"status":"delivered",...}` | Graph API accepted the message |
| `200` | `{"ok":true,"status":"skipped",...}` | signed, but no approved template for that status |
| `200` | `{"ok":true,"status":"no_recipient",...}` | signed, but no number on file for the voucher |
| `401` | `{"error":"invalid_signature"}` | missing or wrong `x-sci-signature` — nothing was sent |
| `400` | `{"error":"invalid_json"}` | body was not JSON |
| `400` | `{"error":"payload_rejected"}` | payload carried a beneficiary reference, or an unusable voucher id / ledger |
| `501` | `{"error":"not_configured"}` | signed, but `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_ACCESS_TOKEN` unset |
| `502` | `{"error":"whatsapp_error"}` | Meta refused the send |

Only `200` tells the indexer's dispatcher the delivery is done (`4xx` other
than 408/429 is permanent, see the README "Webhooks" section), so a `401` or
`400` here stops the retries — which is what you want: the payload is either
forged or malformed, and retrying will not fix it. A `502` is retried with
backoff, and a template that is still `Pending` eventually gets approved
without you touching anything.

## Tests

The suite stubs the Graph API — nothing is sent, and no test needs Meta
credentials — and asserts that every rejection path makes **zero** calls.

```bash
npx vitest run src/__tests__/whatsapp-notifier.test.ts
```

## Layout

```
src/verify.ts      hex HMAC-SHA256 over the raw body, constant-time
src/formatter.ts   payload validation, TEMPLATE_BY_STATUS, template variables
src/whatsapp.ts    POST /{PHONE_NUMBER_ID}/messages on the Graph API
src/server.ts      the webhook endpoint, in that order
src/index.ts       environment wiring and the listener
dist/              compiled output, committed like the other examples
```

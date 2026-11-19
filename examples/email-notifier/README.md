# Email notifier

A webhook receiver that turns signed voucher notifications into mail for a
clinic desk. It is the email counterpart to [`../telegram-bot`](../telegram-bot).

## Running it

```bash
cd examples/email-notifier
npm start          # http://localhost:3002/webhook
```

With no `SMTP_HOST` the mail is printed to the console instead of being sent,
so the example runs from a fresh clone without installing anything. To send
real mail:

```bash
npm install
SMTP_HOST=smtp.example.com SMTP_PORT=587 \
SMTP_USER=notify@example.com SMTP_PASS=... \
MAIL_FROM=notify@example.com MAIL_TO=clinic-desk@example.com \
WEBHOOK_SECRET=... npm start
```

`MAIL_TO` is required once `SMTP_HOST` is set: a guessed inbox would send
clinic mail somewhere it was not meant to go.

## Testing

```bash
cd examples/email-notifier
npm test           # node --test, needs no dependencies
```

The suite drives the real HTTP server and a recording transport, so it proves
what a clinic would read without opening a socket.

## What it checks before mailing

1. **The signature.** `x-sci-signature` is the HMAC-SHA256 of the raw body
   under `WEBHOOK_SECRET`, compared in constant time. The body is verified as
   bytes, before parsing — re-serialising first would change them.
2. **The size.** Bodies over `MAX_BODY_BYTES` (64 KiB) get a 413 rather than
   being buffered.
3. **The shape.** A payload that is not an object with a `voucherId` and a
   `status` gets a 400.
4. **Privacy.** See below.

## Privacy

A beneficiary reference is an HMAC of a patient identifier. The service never
puts one in a webhook payload, and this receiver refuses a payload that
carries one anyway: `assertNoPatientData` walks the whole object and throws
before a letter is rendered, and the response names the policy without
echoing the field back.

The letter itself is built from an allow-list — `event`, `voucherId`,
`status`, `ledger`, `txHash` — not from whatever the payload happened to
carry. A receiver that renders unknown fields is one upstream change away
from leaking a reference.

## Layout

| File | Purpose |
| --- | --- |
| `lib/verify.js` | HMAC-SHA256 verification of the raw body |
| `lib/templates.js` | the privacy guard and the per-event letter |
| `lib/mailer.js` | console and SMTP transports behind one interface |
| `lib/server.js` | the webhook receiver and env configuration |
| `test/` | `node:test` suites, run with `npm test` |

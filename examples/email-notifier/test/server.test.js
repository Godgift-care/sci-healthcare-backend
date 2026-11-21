import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeSignature } from '../lib/verify.js';
import { createMailer } from '../lib/mailer.js';
import { MAX_BODY_BYTES, createServerFromEnv, createWebhookServer } from '../lib/server.js';

const SECRET = 'test-secret';

/** Boots the receiver on an ephemeral port and returns a signed poster. */
async function serve(mails) {
  const transport = {
    name: 'recording',
    async send(mail) {
      mails.push(mail);
    },
  };
  const mailer = createMailer({ from: 'a@b.invalid', to: 'c@d.invalid', transport });
  const server = createWebhookServer({ webhookSecret: SECRET, mailer, logger: () => {} });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    async post(body, { signature = computeSignature(body, SECRET), headers = {} } = {}) {
      const res = await fetch(`${base}/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sci-signature': signature, ...headers },
        body,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
  };
}

const PAYLOAD = JSON.stringify({
  event: 'voucher_attested',
  voucherId: 'VC-7',
  status: 'Attested',
  ledger: 900,
});

test('a signed delivery is rendered and mailed', async () => {
  const mails = [];
  const app = await serve(mails);
  try {
    const res = await app.post(PAYLOAD);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, status: 'delivered', voucherId: 'VC-7' });
    assert.equal(mails.length, 1);
    assert.equal(mails[0].subject, 'Voucher attested');
  } finally {
    await app.close();
  }
});

test('an unsigned or wrongly signed body is refused before parsing', async () => {
  const mails = [];
  const app = await serve(mails);
  try {
    assert.equal((await app.post(PAYLOAD, { signature: 'deadbeef' })).status, 401);
    assert.equal((await app.post(PAYLOAD, { headers: { 'x-sci-signature': '' } })).status, 401);
    assert.equal(mails.length, 0);
  } finally {
    await app.close();
  }
});

test('a body changed after signing fails the check', async () => {
  const mails = [];
  const app = await serve(mails);
  try {
    const signature = computeSignature(PAYLOAD, SECRET);
    const tampered = PAYLOAD.replace('VC-7', 'VC-8');
    assert.equal((await app.post(tampered, { signature })).status, 401);
    assert.equal(mails.length, 0);
  } finally {
    await app.close();
  }
});

test('a payload carrying a reference is rejected without echoing the detail', async () => {
  const mails = [];
  const logged = [];
  const mailer = createMailer({
    from: 'a@b.invalid',
    to: 'c@d.invalid',
    transport: {
      name: 'recording',
      async send(mail) {
        mails.push(mail);
      },
    },
  });
  const server = createWebhookServer({
    webhookSecret: SECRET,
    mailer,
    logger: (line) => logged.push(line),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const body = JSON.stringify({
      voucherId: 'VC-7',
      status: 'Claimed',
      beneficiaryRef: 'a'.repeat(64),
    });
    const res = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sci-signature': computeSignature(body, SECRET),
      },
      body,
    });
    const json = await res.json();

    assert.equal(res.status, 400);
    assert.equal(json.error, 'payload_rejected');
    // The response names the policy in fixed words. What must not come back is
    // the reference itself or where in the body it sat, and no stack trace.
    assert.equal(json.message, 'Payload refused because it carries a beneficiary reference');
    assert.doesNotMatch(JSON.stringify(json), /a{10,}/);
    assert.doesNotMatch(JSON.stringify(json), /payload\./);
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'stack'), false);
    assert.equal(mails.length, 0);
    assert.match(logged.join('\n'), /beneficiaryRef/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('malformed bodies are answered distinctly from a bad signature', async () => {
  const mails = [];
  const app = await serve(mails);
  try {
    const notJson = 'plain text';
    assert.equal((await app.post(notJson)).status, 400);
    assert.equal((await app.post('[]')).status, 400);
    assert.equal((await app.post(JSON.stringify({ voucherId: 'VC-1' }))).status, 400);
    assert.equal(mails.length, 0);
  } finally {
    await app.close();
  }
});

test('a transport failure is a 502, not a crash', async () => {
  const mailer = createMailer({
    from: 'a@b.invalid',
    to: 'c@d.invalid',
    transport: {
      name: 'broken',
      async send() {
        throw new Error('SMTP connection refused');
      },
    },
  });
  const server = createWebhookServer({ webhookSecret: SECRET, mailer, logger: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sci-signature': computeSignature(PAYLOAD, SECRET),
      },
      body: PAYLOAD,
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, 'mail_error');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('an over-long body is refused rather than buffered', async () => {
  const mails = [];
  const app = await serve(mails);
  try {
    const body = JSON.stringify({
      voucherId: 'VC-7',
      status: 'Claimed',
      note: 'x'.repeat(MAX_BODY_BYTES),
    });
    const res = await app.post(body);
    assert.equal(res.status, 413);
    assert.equal(mails.length, 0);
  } finally {
    await app.close();
  }
});

test('health reports the transport and unknown paths 404', async () => {
  const mails = [];
  const app = await serve(mails);
  try {
    const health = await fetch(`${app.base}/health`);
    assert.deepEqual(await health.json(), { status: 'ok', transport: 'recording' });
    assert.equal((await fetch(`${app.base}/nope`)).status, 404);
  } finally {
    await app.close();
  }
});

test('with no SMTP host the example runs against the console', async () => {
  const { mailer, server } = await createServerFromEnv(
    { WEBHOOK_SECRET: SECRET },
    { logger: () => {} },
  );
  try {
    assert.equal(mailer.transport.name, 'console');
    assert.equal(mailer.to, 'clinic-desk@example.invalid');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('once a real host is configured a recipient is required', async () => {
  await assert.rejects(
    () => createServerFromEnv({ SMTP_HOST: 'smtp.example.invalid', WEBHOOK_SECRET: SECRET }),
    /MAIL_TO is required/,
  );
});

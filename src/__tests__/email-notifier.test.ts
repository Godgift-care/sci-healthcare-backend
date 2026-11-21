import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_BODY_BYTES,
  PrivacyError,
  assertNoPatientData,
  computeSignature,
  createMailer,
  createWebhookServer,
  renderEmail,
  verifySignature,
} from '../../examples/email-notifier/index.js';

/**
 * The email notifier example, run through the same HTTP path the indexer uses.
 *
 * The suite lives here rather than only in `examples/` so CI covers it: the
 * `test` job runs `vitest`, and `node --test` inside the example folder is not
 * part of any workflow.
 */
describe('examples/email-notifier', () => {
  const secret = 'test-webhook-secret';

  /** Every letter the fake transport was handed. */
  const mails: { subject: string; text: string; html: string }[] = [];

  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const mailer = createMailer({
      from: 'notifier@example.invalid',
      to: 'clinic-desk@example.invalid',
      transport: {
        name: 'recording',
        async send(mail) {
          mails.push(mail);
        },
      },
    });

    server = createWebhookServer({ webhookSecret: secret, mailer, logger: () => {} });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function post(body: string, signature = computeSignature(body, secret)) {
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sci-signature': signature },
      body,
    });
    return { status: res.status, json: (await res.json()) as Record<string, string> };
  }

  it('verifies the signature the service would send', () => {
    const body = JSON.stringify({ event: 'voucher_settled', voucherId: '1', ledger: 2 });
    expect(verifySignature(body, computeSignature(body, secret), secret)).toBe(true);
  });

  it('rejects a signature made under another secret', () => {
    const body = '{"voucherId":"1","status":"Settled"}';
    expect(verifySignature(body, computeSignature(body, 'other-secret'), secret)).toBe(false);
  });

  it('rejects an unset secret rather than accepting everything', () => {
    const body = '{"voucherId":"1","status":"Settled"}';
    expect(verifySignature(body, computeSignature(body, ''), '')).toBe(false);
  });

  it('mails a signed transition', async () => {
    const before = mails.length;
    const res = await post(
      JSON.stringify({ event: 'voucher_claimed', voucherId: '7', status: 'Claimed', ledger: 900 }),
    );

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, status: 'delivered', voucherId: '7' });
    expect(mails.length).toBe(before + 1);
    expect(mails.at(-1)?.subject).toBe('Voucher claimed at your clinic');
  });

  it('refuses an unsigned body without mailing it', async () => {
    const before = mails.length;
    const res = await post('{"voucherId":"8","status":"Claimed"}', 'deadbeef');

    expect(res.status).toBe(401);
    expect(res.json.error).toBe('invalid_signature');
    expect(mails.length).toBe(before);
  });

  it('refuses a body changed after signing', async () => {
    const signature = computeSignature('{"voucherId":"9","status":"Claimed"}', secret);
    const res = await post('{"voucherId":"10","status":"Claimed"}', signature);

    expect(res.status).toBe(401);
  });

  it('refuses a payload carrying a beneficiary reference, without echoing it', async () => {
    const before = mails.length;
    const body = JSON.stringify({
      voucherId: '11',
      status: 'Claimed',
      beneficiaryRef: 'a'.repeat(64),
    });
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(res.json.error).toBe('payload_rejected');
    expect(JSON.stringify(res.json)).not.toMatch(/a{10,}|payload\./);
    expect(mails.length).toBe(before);
  });

  it('distinguishes a malformed body from a bad signature', async () => {
    expect((await post('plain text')).status).toBe(400);
    expect((await post('{"voucherId":"12"}')).json.error).toBe('invalid_payload');
  });

  it('refuses a body larger than the cap instead of buffering it', async () => {
    const body = JSON.stringify({
      voucherId: '13',
      status: 'Claimed',
      note: 'x'.repeat(MAX_BODY_BYTES),
    });
    expect((await post(body)).status).toBe(413);
  });

  it('renders only the public-chain allow-list', () => {
    const mail = renderEmail(
      {
        event: 'voucher_attested',
        voucherId: '14',
        status: 'Attested',
        txHash: 'ff00',
        ledger: 12,
      },
      { from: 'a@example.invalid', to: 'b@example.invalid' },
    );

    expect(Object.keys(mail).sort()).toEqual(['from', 'html', 'subject', 'text', 'to']);
    expect(mail.text).toContain('Ledger: 12');
    expect(`${mail.text}${mail.html}`).not.toMatch(/beneficiar|patient/i);
  });

  it('the guard walks arrays and nested objects', () => {
    expect(() => assertNoPatientData({ history: [{ beneficiary_ref: 'x' }] })).toThrow(
      PrivacyError,
    );
  });
});

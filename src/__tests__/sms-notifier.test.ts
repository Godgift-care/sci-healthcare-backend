import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import {
  GSM_7_SEGMENT_LIMIT,
  KNOWN_STATUSES,
  PRODUCTION_API,
  SANDBOX_API,
  UCS_2_SEGMENT_LIMIT,
  assertOneSegment,
  computeSignature,
  createWebhookServer,
  fitsOneSegment,
  formatSmsMessage,
  sendSms,
  smsEncoding,
  smsUnitLimit,
  smsUnits,
  verifySignature,
  type SentSms,
  type WebhookVoucherPayload,
} from '../../examples/sms-notifier/dist/index.js';

/**
 * `examples/sms-notifier` (#294): the indexer's signed voucher webhook turned
 * into a short SMS for clinic staff through Africa's Talking. The HTTP client
 * is stubbed, so no test reaches the network and none needs credentials.
 *
 * Two acceptance criteria drive the shape: "messages contain no patient
 * reference" (the payload guard and the fixed wording) and the length limit,
 * which is a per-segment unit budget rather than a plain character count.
 */

const SECRET = 'test-webhook-secret';
const CREDENTIALS = { username: 'sci-clinic', apiKey: 'test-api-key' };
const RECIPIENT = '+2348023104455';

type SmsCall = { url: string; headers: Record<string, string>; form: URLSearchParams };

/** `fetch` stub that records the form POST Africa's Talking expects. */
function smsStub(
  reply: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: {
      SMSMessageData: {
        Message: 'Sent',
        Recipients: [
          { messageId: 'abc-123', number: RECIPIENT, status: 'Queued', statusCode: 100, cost: 'KES0.8000' },
        ],
      },
    },
  }),
): { fetchImpl: typeof fetch; calls: SmsCall[] } {
  const calls: SmsCall[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      form: new URLSearchParams(String(init?.body)),
    });
    const { status, body } = reply();
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function webhook(payload: Record<string, unknown>, secret = SECRET) {
  const body = JSON.stringify(payload);
  return { body, signature: computeSignature(body, secret) };
}

const settled = {
  event: 'voucher_settled',
  voucherId: '9100000000002',
  status: 'Settled',
  txHash: 'deadbeef',
  ledger: 5612039,
};

function startServer(
  options: Partial<Parameters<typeof createWebhookServer>[0]> = {},
  reply?: () => { status: number; body: unknown },
): Promise<{
  url: string;
  calls: SmsCall[];
  sent: SentSms[];
  close: () => Promise<void>;
}> {
  const stub = smsStub(reply);
  const sent: SentSms[] = [];
  const server = createWebhookServer({
    webhookSecret: SECRET,
    ...CREDENTIALS,
    resolveRecipient: () => RECIPIENT,
    logger: () => {},
    fetchImpl: stub.fetchImpl,
    onMessageSent: (message) => sent.push(message),
    ...options,
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls: stub.calls,
        sent,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err?: Error | null) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}

async function post(
  url: string,
  body: string,
  signature: string | undefined,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature === undefined ? {} : { 'x-sci-signature': signature }),
    },
    body,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('examples/sms-notifier', () => {
  describe('single-segment length budget', () => {
    it('counts ASCII as one septet each and stays GSM-7', () => {
      expect(smsEncoding('Care voucher 42 settled.')).toBe('gsm7');
      expect(smsUnits('abcdef')).toBe(6);
      expect(smsUnitLimit('abcdef')).toBe(GSM_7_SEGMENT_LIMIT);
    });

    it('counts shift-table characters as two septets', () => {
      expect(smsEncoding('a€b')).toBe('gsm7');
      expect(smsUnits('a€b')).toBe(4);
      expect(smsUnits('[{~')).toBe(6);
    });

    it('drops the whole message to the UCS-2 budget for a non-GSM character', () => {
      // The naira sign is not in GSM-7, so a message containing it is
      // encoded as UCS-2 and only gets 70 characters.
      expect(smsEncoding('₦')).toBe('ucs2');
      expect(smsUnitLimit('pay ₦10')).toBe(UCS_2_SEGMENT_LIMIT);
      expect(smsUnits('pay ₦10')).toBe(7);
    });

    it('accepts a 160-unit message and rejects one unit over', () => {
      const exactly = 'x'.repeat(GSM_7_SEGMENT_LIMIT);
      expect(fitsOneSegment(exactly)).toBe(true);
      expect(assertOneSegment(exactly)).toBe(exactly);
      expect(() => assertOneSegment(`${exactly}y`)).toThrow(/over the 160-unit/);
      expect(() => assertOneSegment('₦'.repeat(71))).toThrow(/over the 70-unit/);
    });
  });

  describe('message formatting', () => {
    it('sends one short message per event, each inside one segment', () => {
      expect(KNOWN_STATUSES).toEqual(['Funded', 'Claimed', 'Attested', 'Settled', 'Disputed', 'Refunded']);
      for (const status of KNOWN_STATUSES) {
        const message = formatSmsMessage({ ...settled, status });
        expect(message, status).toContain(settled.voucherId);
        expect(message, status).toContain(String(settled.ledger));
        expect(fitsOneSegment(message), `${status}: ${message}`).toBe(true);
      }
    });

    it('names the status it was sent for', () => {
      expect(formatSmsMessage({ ...settled, status: 'Claimed' })).toContain('claimed');
      expect(formatSmsMessage({ ...settled, status: 'Settled' })).toBe(
        'Care voucher 9100000000002 settled and paid (ledger 5612039). Receipt in portal.',
      );
    });

    it('contains no patient reference', () => {
      const message = formatSmsMessage(settled);
      expect(message).not.toMatch(/beneficiar|patient|ref\b/i);
      expect(message).toBe(
        'Care voucher 9100000000002 settled and paid (ledger 5612039). Receipt in portal.',
      );
    });

    it('refuses a payload that carries a beneficiary reference', () => {
      expect(() =>
        formatSmsMessage(
          { ...settled, beneficiaryRef: 'a1b2c3' } as unknown as WebhookVoucherPayload,
        ),
      ).toThrow(/beneficiary references/);
    });

    it('refuses a non-numeric voucher id so free text never reaches a handset', () => {
      expect(() => formatSmsMessage({ ...settled, voucherId: 'Ade Yayo' })).toThrow(
        /Invalid voucher id/,
      );
      expect(() => formatSmsMessage({ ...settled, ledger: 1.5 })).toThrow(/Invalid ledger/);
    });

    it('never repeats an unknown status, and marks a missing ledger as pending', () => {
      expect(formatSmsMessage({ ...settled, status: 'Adeniji Unknown' })).toBe(
        'Care voucher 9100000000002 updated (ledger 5612039).',
      );
      expect(formatSmsMessage({ ...settled, ledger: null })).toContain('(ledger pending).');
    });
  });

  describe('signature verification', () => {
    it('accepts a bare hex digest and a sha256= prefixed one', () => {
      const sig = computeSignature(settled.voucherId, SECRET);
      expect(verifySignature(settled.voucherId, sig, SECRET)).toBe(true);
      expect(verifySignature(settled.voucherId, `sha256=${sig}`, SECRET)).toBe(true);
    });

    it('rejects a missing header, a wrong secret, a truncated digest and a non-hex header', () => {
      const sig = computeSignature(settled.voucherId, SECRET);
      expect(verifySignature(settled.voucherId, undefined, SECRET)).toBe(false);
      expect(verifySignature(settled.voucherId, sig, 'other-secret')).toBe(false);
      expect(verifySignature(settled.voucherId, sig.slice(0, -2), SECRET)).toBe(false);
      expect(verifySignature(settled.voucherId, 'zz'.repeat(sig.length / 2), SECRET)).toBe(false);
      expect(verifySignature(settled.voucherId, sig, '')).toBe(false);
    });
  });

  describe('sendSms', () => {
    it('posts a form-encoded message to /version1/messaging', async () => {
      const stub = smsStub();
      const result = await sendSms({
        ...CREDENTIALS,
        to: RECIPIENT,
        message: 'Care voucher 42 settled.',
        from: 'CLINIC',
        fetchImpl: stub.fetchImpl,
      });

      expect(result).toEqual({
        ok: true,
        messageId: 'abc-123',
        status: 'Queued',
        cost: 'KES0.8000',
      });
      expect(stub.calls[0]!.url).toBe(`${PRODUCTION_API}/version1/messaging`);
      expect(stub.calls[0]!.headers.apikey).toBe('test-api-key');
      expect(stub.calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
      expect([...stub.calls[0]!.form]).toEqual([
        ['username', 'sci-clinic'],
        ['to', RECIPIENT],
        ['message', 'Care voucher 42 settled.'],
        ['from', 'CLINIC'],
      ]);
    });

    it('omits an empty sender instead of sending from=', async () => {
      const stub = smsStub();
      await sendSms({
        ...CREDENTIALS,
        to: RECIPIENT,
        message: 'x',
        from: '',
        baseUrl: SANDBOX_API,
        fetchImpl: stub.fetchImpl,
      });
      expect(stub.calls[0]!.url).toBe(`${SANDBOX_API}/version1/messaging`);
      expect(stub.calls[0]!.form.get('from')).toBeNull();
    });

    it('reports a number the gateway refused', async () => {
      const stub = smsStub(() => ({
        status: 200,
        body: {
          SMSMessageData: {
            Recipients: [
              { number: '1515000000', status: 'InvalidMobileNumber', errorMessage: 'Invalid mobile number format' },
            ],
          },
        },
      }));
      expect(await sendSms({ ...CREDENTIALS, to: '1515000000', message: 'x', fetchImpl: stub.fetchImpl })).toEqual({
        ok: false,
        error: 'Invalid mobile number format',
      });
    });

    it('reads the rejection reason off a failed request', async () => {
      const stub = smsStub(() => ({
        status: 403,
        body: { SMSMessageData: { Message: 'Invalid username or password' } },
      }));
      expect(await sendSms({ ...CREDENTIALS, to: RECIPIENT, message: 'x', fetchImpl: stub.fetchImpl })).toEqual({
        ok: false,
        error: 'Invalid username or password',
      });
    });

    it('fails closed on an unparseable body or a response with no recipient', async () => {
      const broken = vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch;
      expect(
        await sendSms({ ...CREDENTIALS, to: RECIPIENT, message: 'x', fetchImpl: broken }),
      ).toEqual({ ok: false, error: "Unparseable Africa's Talking response (HTTP 502)" });

      const empty = smsStub(() => ({ status: 200, body: { SMSMessageData: { Recipients: [] } } }));
      expect(
        await sendSms({ ...CREDENTIALS, to: RECIPIENT, message: 'x', fetchImpl: empty.fetchImpl }),
      ).toEqual({ ok: false, error: "Africa's Talking accepted the request but named no recipient" });
    });
  });

  describe('webhook delivery', () => {
    it('sends one SMS when the signature checks out', async () => {
      const server = await startServer();
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        ok: true,
        status: 'delivered',
        voucherId: settled.voucherId,
        providerStatus: 'Queued',
        chars: 80,
        messageId: 'abc-123',
        cost: 'KES0.8000',
      });
      expect(server.calls).toHaveLength(1);
      expect(server.calls[0]!.form.get('message')).toBe(
        'Care voucher 9100000000002 settled and paid (ledger 5612039). Receipt in portal.',
      );
      expect(server.calls[0]!.form.get('to')).toBe(RECIPIENT);
      expect(server.sent[0]!.message).not.toMatch(/beneficiar|patient/i);
      await server.close();
    });

    it('verifies the signature before anything is sent: no header, no HTTP call', async () => {
      const server = await startServer();
      const { body } = webhook(settled);
      const res = await post(server.url, body, undefined);

      expect(res.status).toBe(401);
      expect(res.json.error).toBe('invalid_signature');
      expect(server.calls).toEqual([]);
      await server.close();
    });

    it('rejects a body tampered with after signing, without sending', async () => {
      const server = await startServer();
      const { body, signature } = webhook(settled);
      const tampered = body.replace('"Settled"', '"Funded"');
      const res = await post(server.url, tampered, signature);

      expect(res.status).toBe(401);
      expect(server.calls).toEqual([]);
      await server.close();
    });

    it('rejects unparseable JSON under a valid signature, without sending', async () => {
      const server = await startServer();
      const body = '{"event":"voucher_settled",';
      const res = await post(server.url, body, computeSignature(body, SECRET));

      expect(res.status).toBe(400);
      expect(res.json.error).toBe('invalid_json');
      expect(server.calls).toEqual([]);
      await server.close();
    });

    it('rejects a signed payload that leaks a beneficiary reference, without sending', async () => {
      const server = await startServer();
      const { body, signature } = webhook({ ...settled, beneficiary: 'GBOOO...' });
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(400);
      expect(res.json.error).toBe('payload_rejected');
      expect(server.calls).toEqual([]);
      await server.close();
    });

    it('refuses a message that would need more than one segment, without sending', async () => {
      const server = await startServer();
      const { body, signature } = webhook({ ...settled, voucherId: '9'.repeat(200) });
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(400);
      expect(res.json.message).toMatch(/over the 160-unit single-segment limit/);
      expect(server.calls).toEqual([]);
      await server.close();
    });

    it('answers 501 without a key, rather than calling the gateway unauthenticated', async () => {
      const server = await startServer({ username: '', apiKey: '' });
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(501);
      expect(res.json.error).toBe('not_configured');
      expect(server.calls).toEqual([]);
      await server.close();
    });

    it('defaults the sandbox username when pointed at the sandbox host', async () => {
      const server = await startServer({ username: '', baseUrl: SANDBOX_API });
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(200);
      expect(server.calls[0]!.url).toBe(`${SANDBOX_API}/version1/messaging`);
      expect(server.calls[0]!.form.get('username')).toBe('sandbox');
      await server.close();
    });

    it('answers no_recipient when no number is on file for the voucher', async () => {
      const server = await startServer({ resolveRecipient: () => undefined });
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(200);
      expect(res.json.status).toBe('no_recipient');
      expect(server.calls).toEqual([]);
      await server.close();
    });

    it('surfaces a gateway rejection as 502 so the webhook is retried', async () => {
      const server = await startServer({}, () => ({
        status: 400,
        body: { SMSMessageData: { Message: 'Invalid parameter' } },
      }));
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(502);
      expect(res.json).toEqual({ error: 'sms_error', message: 'Invalid parameter' });
      await server.close();
    });

    it('serves /health, naming the endpoint it will use, and 404s anything else', async () => {
      const server = await startServer({ baseUrl: SANDBOX_API });
      const health = await fetch(`${server.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok', sandbox: true });

      const miss = await post(`${server.url}/nope`, '{}', undefined);
      expect(miss.status).toBe(404);
      await server.close();
    });
  });
});

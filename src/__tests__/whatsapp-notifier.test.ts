import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

import {
  TEMPLATE_BY_STATUS,
  computeSignature,
  createWebhookServer,
  sendWhatsAppTemplate,
  templateForPayload,
  verifySignature,
  type SentMessage,
  type WebhookVoucherPayload,
} from '../../examples/whatsapp-notifier/dist/index.js';

/**
 * `examples/whatsapp-notifier` (#293): a clinic microservice that turns the
 * indexer's signed voucher webhook into an approved WhatsApp template
 * message. The Graph API is stubbed — no test here reaches the network.
 *
 * The acceptance criterion that decides the shape of the code is "signature
 * verified before anything is sent", so every rejection case asserts both
 * the HTTP status and that the stub received zero calls.
 */

const SECRET = 'test-webhook-secret';
const CREDENTIALS = { phoneNumberId: '1234567890', accessToken: 'test-page-token' };
const RECIPIENT = '+2348023104455';

type GraphCall = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** Fetch stub that records what the notifier tried to send to Meta. */
function graphStub(
  reply: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.TEST123' }] },
  }),
): { fetchImpl: typeof fetch; calls: GraphCall[] } {
  const calls: GraphCall[] = [];
  const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body)),
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

function startServer(
  options: Partial<Parameters<typeof createWebhookServer>[0]> = {},
  reply?: () => { status: number; body: unknown },
): Promise<{
  url: string;
  calls: GraphCall[];
  sent: SentMessage[];
  close: () => Promise<void>;
}> {
  const stub = graphStub(reply);
  const sent: SentMessage[] = [];
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

const settled = {
  event: 'voucher_settled',
  voucherId: '9100000000002',
  status: 'Settled',
  txHash: 'deadbeef',
  ledger: 5612039,
};

describe('examples/whatsapp-notifier', () => {
  describe('template mapping', () => {
    it('covers the three statuses #293 names, with an approved template each', () => {
      expect(Object.keys(TEMPLATE_BY_STATUS)).toEqual(['Claimed', 'Attested', 'Settled']);
      for (const status of Object.keys(TEMPLATE_BY_STATUS)) {
        expect(templateForPayload({ ...settled, status }, 'en_US')).toEqual({
          name: TEMPLATE_BY_STATUS[status],
          languageCode: 'en_US',
          variables: [settled.voucherId, String(settled.ledger)],
        });
      }
    });

    it('has no template for the other voucher statuses, so they are not sent', () => {
      for (const status of ['Funded', 'Disputed', 'Refunded', 'nonsense']) {
        expect(templateForPayload({ ...settled, status }, 'en_US')).toBeUndefined();
      }
    });

    it('refuses a payload that carries a beneficiary reference', () => {
      expect(() =>
        templateForPayload(
          { ...settled, beneficiaryRef: 'a1b2c3' } as unknown as WebhookVoucherPayload,
          'en_US',
        ),
      ).toThrow(/beneficiary references/);
    });

    it('refuses a voucher id that is not numeric, so free text cannot reach the template', () => {
      expect(() => templateForPayload({ ...settled, voucherId: 'Ade Yayo' }, 'en_US')).toThrow(
        /Invalid voucher id/,
      );
      expect(() => templateForPayload({ ...settled, ledger: 1.5 }, 'en_US')).toThrow(
        /Invalid ledger/,
      );
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

  describe('webhook delivery', () => {
    it('sends the approved template to the resolved number when the signature checks out', async () => {
      const server = await startServer();
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(200);
      expect(res.json).toEqual({
        ok: true,
        status: 'delivered',
        voucherId: settled.voucherId,
        template: 'voucher_settled',
        messageId: 'wamid.TEST123',
      });

      expect(server.calls).toHaveLength(1);
      const call = server.calls[0]!;
      expect(call.url).toMatch(/\/v\d+\.[0-9]\/1234567890\/messages$/);
      expect(call.headers.authorization).toBe('Bearer test-page-token');
      expect(call.body).toEqual({
        messaging_product: 'whatsapp',
        to: RECIPIENT,
        type: 'template',
        template: {
          name: 'voucher_settled',
          language: { code: 'en_US' },
          components: [
            {
              type: 'body',
              parameters: [
                { type: 'text', text: settled.voucherId },
                { type: 'text', text: String(settled.ledger) },
              ],
            },
          ],
        },
      });
      expect(server.sent).toEqual([
        {
          to: RECIPIENT,
          template: {
            name: 'voucher_settled',
            languageCode: 'en_US',
            variables: [settled.voucherId, String(settled.ledger)],
          },
          messageId: 'wamid.TEST123',
        },
      ]);
      await server.close();
    });

    it('verifies the signature before anything is sent: no header, no Graph API call', async () => {
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
      const tampered = body.replace('"Settled"', '"Refunded"');
      expect(tampered).not.toBe(body);

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
      const { body, signature } = webhook({ ...settled, beneficiaryRef: 'deadbeefcafe' });
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(400);
      expect(res.json.error).toBe('payload_rejected');
      expect(server.calls).toEqual([]);
      await server.close();
    });

    it('skips a status with no approved template instead of inventing a template name', async () => {
      const server = await startServer();
      const { body, signature } = webhook({ ...settled, status: 'Funded', event: 'voucher_created' });
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(200);
      expect(res.json.status).toBe('skipped');
      expect(res.json.reason).toMatch(/no approved template for status Funded/);
      expect(server.calls).toEqual([]);
      await server.close();
    });

    it('answers 501 without a credential, rather than calling Meta unauthenticated', async () => {
      const server = await startServer({ phoneNumberId: '', accessToken: '' });
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(501);
      expect(res.json.error).toBe('not_configured');
      expect(server.calls).toEqual([]);
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

    it('surfaces a Graph API rejection as 502 so the webhook is retried', async () => {
      const server = await startServer({}, () => ({
        status: 400,
        body: {
          error: {
            message: 'Invalid template name for this WhatsApp Business account',
            type: 'OAuthException',
            code: 100,
          },
        },
      }));
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(502);
      expect(res.json.error).toBe('whatsapp_error');
      expect(res.json.message).toBe('Invalid template name for this WhatsApp Business account');
      await server.close();
    });

    it('keeps the HTTP status when the Graph API gives no message', async () => {
      const server = await startServer({}, () => ({ status: 500, body: {} }));
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(502);
      expect(res.json.message).toMatch(/HTTP 500/);
      await server.close();
    });

    it('treats an accepted request with no message id as a failure', async () => {
      const server = await startServer({}, () => ({ status: 200, body: { messaging_product: 'whatsapp' } }));
      const { body, signature } = webhook(settled);
      const res = await post(server.url, body, signature);

      expect(res.status).toBe(502);
      expect(res.json.message).toMatch(/no message id/);
      await server.close();
    });

    it('serves /health and 404s anything else', async () => {
      const server = await startServer();
      const health = await fetch(`${server.url}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ status: 'ok' });

      const miss = await post(`${server.url}/nope`, '{}', undefined);
      expect(miss.status).toBe(404);
      await server.close();
    });
  });

  describe('sendWhatsAppTemplate', () => {
    it('posts to the versioned Graph API path for the phone number id', async () => {
      const stub = graphStub();
      const result = await sendWhatsAppTemplate({
        ...CREDENTIALS,
        to: RECIPIENT,
        template: { name: 'voucher_claimed', languageCode: 'en_GB', variables: ['42'] },
        graphApi: 'https://graph.facebook.com',
        apiVersion: 'v21.0',
        fetchImpl: stub.fetchImpl,
      });

      expect(result).toEqual({ ok: true, messageId: 'wamid.TEST123' });
      expect(stub.calls[0]!.url).toBe('https://graph.facebook.com/v21.0/1234567890/messages');
      expect(stub.calls[0]!.body.template).toEqual({
        name: 'voucher_claimed',
        language: { code: 'en_GB' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: '42' }] }],
      });
    });

    it('reports a non-JSON response instead of throwing', async () => {
      const fetchImpl = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;
      const result = await sendWhatsAppTemplate({
        ...CREDENTIALS,
        to: RECIPIENT,
        template: { name: 'voucher_settled', languageCode: 'en_US', variables: ['42', '1'] },
        fetchImpl,
      });

      expect(result).toEqual({
        ok: false,
        error: 'Unparseable Graph API response (HTTP 502)',
      });
    });
  });
});

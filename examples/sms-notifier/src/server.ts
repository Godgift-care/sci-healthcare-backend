import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { formatSmsMessage, type WebhookVoucherPayload } from './formatter.js';
import { PRODUCTION_API, SANDBOX_API, SANDBOX_USERNAME, sendSms } from './sms.js';
import { verifySignature } from './verify.js';

export interface SentSms {
  to: string;
  message: string;
  messageId: string;
}

export interface WebhookServerOptions {
  webhookSecret: string;
  username?: string | undefined;
  apiKey?: string | undefined;
  from?: string | undefined;
  baseUrl?: string | undefined;
  /**
   * Which number a voucher goes to. The webhook payload identifies the
   * voucher and nothing else, so a real deployment resolves
   * voucher -> clinic -> staff number from its own store; the default is the
   * single number in `SMS_CLINIC_NUMBER`.
   */
  resolveRecipient?: ((voucherId: string) => string | undefined) | undefined;
  logger?: ((msg: string) => void) | undefined;
  fetchImpl?: typeof fetch | undefined;
  onMessageSent?: ((message: SentSms) => void) | undefined;
}

export function createWebhookServer(options: WebhookServerOptions): Server {
  const sandbox = /^(1|true|yes)$/i.test(process.env.SMS_SANDBOX ?? '');
  const configuredBaseUrl =
    process.env.SMS_API_BASE_URL ?? (sandbox ? SANDBOX_API : PRODUCTION_API);
  // Read once so a later change to the environment cannot silently redirect
  // messages mid-process.
  const configuredClinicNumber = (process.env.SMS_CLINIC_NUMBER ?? '').trim() || undefined;

  const {
    webhookSecret,
    username = process.env.AFRICTALKING_USERNAME ?? '',
    apiKey = process.env.AFRICTALKING_API_KEY ?? '',
    from = process.env.SMS_SENDER_ID ?? '',
    baseUrl = configuredBaseUrl,
    resolveRecipient = () => configuredClinicNumber,
    logger = console.log,
    fetchImpl = fetch,
    onMessageSent,
  } = options;

  // The sandbox only ever authenticates as `sandbox`; requiring the name
  // again would be a footgun, not a feature.
  const effectiveUsername = username || (baseUrl === SANDBOX_API ? SANDBOX_USERNAME : '');

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      send(res, 200, { status: 'ok', sandbox: baseUrl === SANDBOX_API });
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/webhook') {
      send(res, 404, { error: 'not_found', message: 'Endpoint not found' });
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));

    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks);
      const signatureHeader = req.headers['x-sci-signature'] as string | undefined;

      // Nothing is read, formatted or sent until the HMAC over the exact
      // bytes received checks out.
      if (!verifySignature(rawBody, signatureHeader, webhookSecret)) {
        logger('Rejected webhook with invalid or missing signature');
        send(res, 401, {
          error: 'invalid_signature',
          message: 'Signature header X-SCI-Signature is missing or invalid',
        });
        return;
      }

      let payload: WebhookVoucherPayload;
      try {
        payload = JSON.parse(rawBody.toString('utf8')) as WebhookVoucherPayload;
      } catch {
        send(res, 400, { error: 'invalid_json', message: 'Payload is not valid JSON' });
        return;
      }

      let message: string;
      try {
        message = formatSmsMessage(payload);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger(`Privacy or length rejection: ${reason}`);
        send(res, 400, { error: 'payload_rejected', message: reason });
        return;
      }

      if (effectiveUsername === '' || apiKey === '') {
        logger("Africa's Talking credentials missing; nothing was sent");
        send(res, 501, {
          error: 'not_configured',
          message: 'Set AFRICTALKING_API_KEY (and AFRICTALKING_USERNAME, or SMS_SANDBOX=1)',
        });
        return;
      }

      const to = resolveRecipient(payload.voucherId);
      if (to === undefined) {
        logger(`No phone number on file for voucher: ${payload.voucherId}`);
        send(res, 200, {
          ok: true,
          status: 'no_recipient',
          voucherId: payload.voucherId,
          reason: 'no phone number resolved for this voucher',
        });
        return;
      }

      logger(`Delivering webhook for voucher ${payload.voucherId} (status: ${payload.status})`);
      const result = await sendSms({
        username: effectiveUsername,
        apiKey,
        to,
        message,
        from,
        baseUrl,
        fetchImpl,
      });

      if (!result.ok) {
        logger(`Failed to post to Africa's Talking: ${result.error}`);
        send(res, 502, { error: 'sms_error', message: result.error });
        return;
      }

      if (onMessageSent) {
        onMessageSent({ to, message, messageId: result.messageId });
      }

      send(res, 200, {
        ok: true,
        status: 'delivered',
        voucherId: payload.voucherId,
        providerStatus: result.status,
        chars: message.length,
        messageId: result.messageId,
        ...(result.cost === undefined ? {} : { cost: result.cost }),
      });
    });
  });

  return server;
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

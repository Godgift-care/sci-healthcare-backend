import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { templateForPayload, type WhatsAppTemplate, type WebhookVoucherPayload } from './formatter.js';
import { sendWhatsAppTemplate } from './whatsapp.js';
import { verifySignature } from './verify.js';

export interface SentMessage {
  to: string;
  template: WhatsAppTemplate;
  messageId: string;
}

export interface WebhookServerOptions {
  webhookSecret: string;
  phoneNumberId?: string | undefined;
  accessToken?: string | undefined;
  languageCode?: string | undefined;
  graphApi?: string | undefined;
  apiVersion?: string | undefined;
  /**
   * Which WhatsApp number a voucher goes to. The webhook payload identifies
   * the voucher and nothing else, so a real deployment resolves
   * voucher -> clinic -> staff number from its own store; the default is the
   * single number in `WHATSAPP_CLINIC_NUMBER`.
   */
  resolveRecipient?: ((voucherId: string) => string | undefined) | undefined;
  logger?: ((msg: string) => void) | undefined;
  fetchImpl?: typeof fetch | undefined;
  onMessageSent?: ((message: SentMessage) => void) | undefined;
}

export function createWebhookServer(options: WebhookServerOptions): Server {
  // Read once so a later change to the environment cannot silently redirect
  // messages mid-process.
  const configuredClinicNumber =
    (process.env.WHATSAPP_CLINIC_NUMBER ?? '').trim() || undefined;

  const {
    webhookSecret,
    phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    accessToken = process.env.WHATSAPP_ACCESS_TOKEN ?? '',
    languageCode = process.env.WHATSAPP_LANGUAGE_CODE ?? 'en_US',
    graphApi = process.env.WHATSAPP_GRAPH_API ?? undefined,
    apiVersion = process.env.WHATSAPP_API_VERSION ?? undefined,
    resolveRecipient = () => configuredClinicNumber,
    logger = console.log,
    fetchImpl = fetch,
    onMessageSent,
  } = options;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
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

      let template: WhatsAppTemplate | undefined;
      try {
        template = templateForPayload(payload, languageCode);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger(`Privacy or formatting rejection: ${message}`);
        send(res, 400, { error: 'payload_rejected', message });
        return;
      }

      if (template === undefined) {
        logger(`No approved WhatsApp template for status: ${payload.status}`);
        send(res, 200, {
          ok: true,
          status: 'skipped',
          voucherId: payload.voucherId,
          reason: `no approved template for status ${payload.status}`,
        });
        return;
      }

      if (phoneNumberId === '' || accessToken === '') {
        logger('WhatsApp credentials missing; nothing was sent');
        send(res, 501, {
          error: 'not_configured',
          message: 'Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN',
        });
        return;
      }

      const to = resolveRecipient(payload.voucherId);
      if (to === undefined) {
        logger(`No WhatsApp number on file for voucher: ${payload.voucherId}`);
        send(res, 200, {
          ok: true,
          status: 'no_recipient',
          voucherId: payload.voucherId,
          reason: 'no WhatsApp number resolved for this voucher',
        });
        return;
      }

      logger(`Delivering webhook for voucher ${payload.voucherId} (status: ${payload.status})`);
      const result = await sendWhatsAppTemplate({
        phoneNumberId,
        accessToken,
        to,
        template,
        ...(graphApi === undefined ? {} : { graphApi }),
        ...(apiVersion === undefined ? {} : { apiVersion }),
        fetchImpl,
      });

      if (!result.ok) {
        logger(`Failed to post to WhatsApp: ${result.error}`);
        send(res, 502, { error: 'whatsapp_error', message: result.error });
        return;
      }

      if (onMessageSent) {
        onMessageSent({ to, template, messageId: result.messageId });
      }

      send(res, 200, {
        ok: true,
        status: 'delivered',
        voucherId: payload.voucherId,
        template: template.name,
        messageId: result.messageId,
      });
    });
  });

  return server;
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

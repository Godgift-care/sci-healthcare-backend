import { createServer } from 'node:http';

import { consoleTransport, createMailer, smtpTransport } from './mailer.js';
import { PrivacyError, assertNoPatientData } from './templates.js';
import { verifySignature } from './verify.js';

/**
 * The receiver: verify, then mail.
 *
 * It reads the body as bytes and keeps them, because the signature is over
 * exactly what was sent — parsing and re-serialising first would change the
 * bytes and every delivery would fail to verify.
 */

/** Refusing to buffer an unbounded body on a service a network can reach. */
export const MAX_BODY_BYTES = 64 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Reads the request body, or resolves null once it passes the cap. */
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Stop accumulating; the handler answers 413 and drops the socket.
        chunks.length = 0;
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

export function createWebhookServer(options) {
  const { webhookSecret, mailer, logger = () => {} } = options;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      json(res, 200, { status: 'ok', transport: mailer.transport.name });
      return;
    }

    if (req.method !== 'POST' || url.pathname !== '/webhook') {
      json(res, 404, { error: 'not_found', message: 'Endpoint not found' });
      return;
    }

    const raw = await readBody(req);
    if (raw === null) {
      logger(`Rejected an over-long webhook body (cap ${MAX_BODY_BYTES} bytes)`);
      json(res, 413, { error: 'payload_too_large', message: 'Body exceeds the accepted size' });
      return;
    }

    // The signature is checked against the raw bytes, before anything is
    // trusted enough to be parsed.
    if (!verifySignature(raw, req.headers['x-sci-signature'], webhookSecret)) {
      logger('Rejected webhook with invalid or missing signature');
      json(res, 401, {
        error: 'invalid_signature',
        message: 'The x-sci-signature header is missing or does not match the body',
      });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      json(res, 400, { error: 'invalid_json', message: 'Payload is not valid JSON' });
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      json(res, 400, { error: 'invalid_payload', message: 'Payload must be an object' });
      return;
    }

    if (typeof payload.voucherId !== 'string' || typeof payload.status !== 'string') {
      json(res, 400, {
        error: 'invalid_payload',
        message: 'Payload must carry a voucherId and a status',
      });
      return;
    }

    try {
      assertNoPatientData(payload);
      await mailer.send(payload);
    } catch (error) {
      if (error instanceof PrivacyError) {
        // Named rather than echoed: the reason is this service's policy, and
        // the detail goes to the log where it can be investigated.
        logger(`Privacy rejection: ${error.message}`);
        json(res, 400, {
          error: 'payload_rejected',
          message: 'Payload refused because it carries a beneficiary reference',
        });
        return;
      }
      logger(`Mail delivery failed for voucher ${payload.voucherId}: ${error?.stack ?? error}`);
      json(res, 502, { error: 'mail_error', message: 'The notification could not be delivered' });
      return;
    }

    json(res, 200, { ok: true, status: 'delivered', voucherId: payload.voucherId });
  });
}

/**
 * Builds the server from environment configuration.
 *
 * With no `SMTP_HOST` it prints to the console instead of dialling out, so the
 * example runs from a fresh clone the way the Telegram one does. There the
 * recipient can be a placeholder; once a real SMTP host is configured it
 * cannot be, because a guessed address would send clinic mail somewhere.
 */
export async function createServerFromEnv(env = process.env, { logger = console.log } = {}) {
  const to = env.MAIL_TO ?? (env.SMTP_HOST ? null : 'clinic-desk@example.invalid');
  if (!to) {
    throw new Error('MAIL_TO is required once SMTP_HOST is set: which inbox receives the mail?');
  }

  const transport = env.SMTP_HOST
    ? await smtpTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT ? Number(env.SMTP_PORT) : 587,
        secure: env.SMTP_SECURE === 'true',
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      })
    : consoleTransport({ logger });

  const mailer = createMailer({
    from: env.MAIL_FROM ?? 'notifier@sci-healthcare.local',
    to,
    transport,
  });

  return {
    mailer,
    server: createWebhookServer({
      webhookSecret: env.WEBHOOK_SECRET ?? 'example-webhook-secret-do-not-use-in-prod',
      mailer,
      logger,
    }),
  };
}

import type { Server } from 'node:http';

/** The signed body the indexer posts; see `src/lib/webhooks.ts`. */
export interface WebhookVoucherPayload {
  event: string;
  voucherId: string;
  status: string;
  txHash?: string | null;
  ledger: number;
  [key: string]: unknown;
}

/** One rendered letter, ready for a transport. */
export interface RenderedEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Anything that can take a rendered letter. */
export interface MailTransport {
  name: string;
  send(mail: RenderedEmail): Promise<unknown>;
}

export interface Mailer {
  from: string;
  to: string;
  transport: MailTransport;
  send(payload: WebhookVoucherPayload): Promise<unknown>;
}

export interface WebhookServerOptions {
  webhookSecret: string;
  mailer: Mailer;
  logger?: (message: string) => void;
}

export class PrivacyError extends Error {
  code: string;
}

export const MAX_BODY_BYTES: number;

export function computeSignature(payload: string | Buffer, secret: string): string;

export function verifySignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string,
): boolean;

export function assertNoPatientData(value: unknown, path?: string): void;

export function renderEmail(
  payload: WebhookVoucherPayload,
  options: { from: string; to: string },
): RenderedEmail;

export function consoleTransport(options?: { logger?: (message: string) => void }): MailTransport;

export function smtpTransport(options?: {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
}): Promise<MailTransport>;

export function createMailer(options: {
  from: string;
  to: string;
  transport: MailTransport;
}): Mailer;

export function createWebhookServer(options: WebhookServerOptions): Server;

export function createServerFromEnv(
  env?: NodeJS.ProcessEnv,
  options?: { logger?: (message: string) => void },
): Promise<{ mailer: Mailer; server: Server }>;

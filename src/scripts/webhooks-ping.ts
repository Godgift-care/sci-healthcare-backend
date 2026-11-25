import { pathToFileURL } from 'node:url';

import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from '../lib/webhook-signature.js';

/**
 * `npm run webhooks:ping -- --url <url>` (#267).
 *
 * Sends one signed `ping` delivery so an integrator can check a receiver and
 * its shared secret without waiting for a real voucher event. The request is
 * byte-for-byte the shape the dispatcher sends — raw JSON body, hex
 * HMAC-SHA256 in `x-sci-signature` — so a receiver that verifies a ping will
 * verify real deliveries too.
 *
 * A non-2xx answer (or a network error) exits non-zero, which is what makes
 * this usable in a setup script or a CI check.
 */

export const PING_EVENT = 'ping';

export const PING_USAGE =
  'Usage: npm run webhooks:ping -- --url <url> [--secret <secret>]\n' +
  '  --url     receiver URL to POST the signed ping to (http or https)\n' +
  '  --secret  HMAC key; defaults to WEBHOOK_SECRET from the environment';

export type PingOptions = {
  url: string;
  secret: string;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export type PingResult = {
  status: number;
  ok: boolean;
  /** Wall-clock milliseconds for the request, including the response body. */
  latencyMs: number;
};

export type PingArguments = { url: string; secret: string };

export class PingUsageError extends Error {}

/** The exact body a ping signs and sends. */
export function pingPayload(now: Date = new Date()): { event: string; sentAt: string } {
  return { event: PING_EVENT, sentAt: now.toISOString() };
}

/**
 * Sends one signed ping and reports what came back.
 *
 * The body is signed once and sent unchanged: rebuilding it between signing
 * and sending is the classic way to break a receiver's HMAC check.
 */
export async function pingWebhook(opts: PingOptions): Promise<PingResult> {
  const body = JSON.stringify(pingPayload(opts.now?.() ?? new Date()));
  const started = Date.now();
  const res = await (opts.fetchImpl ?? fetch)(opts.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: signWebhook(body, opts.secret),
    },
    body,
  });
  // Drain the body so the connection is released before reporting latency.
  await res.arrayBuffer().catch(() => undefined);
  return { status: res.status, ok: res.ok, latencyMs: Date.now() - started };
}

/** Parses `--url` and `--secret`; throws `PingUsageError` for anything else. */
export function parsePingArgs(
  argv: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): PingArguments {
  let url: string | undefined;
  let secret = source.WEBHOOK_SECRET ?? '';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg !== '--url' && arg !== '--secret') {
      throw new PingUsageError(`unknown argument: ${String(arg)}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new PingUsageError(`${arg} requires a value`);
    }
    i += 1;
    if (arg === '--url') url = value;
    else secret = value;
  }

  if (url === undefined || url === '') throw new PingUsageError('--url is required');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PingUsageError(`--url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PingUsageError(`--url must be http or https, not ${parsed.protocol}`);
  }
  if (secret === '') {
    throw new PingUsageError('--secret is required (or set WEBHOOK_SECRET)');
  }
  return { url, secret };
}

/** Runs the command and returns its exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: PingArguments;
  try {
    args = parsePingArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error(PING_USAGE);
    return 2;
  }

  try {
    const result = await pingWebhook(args);
    // Status and latency are the two things the integrator is here for.
    console.log(`POST ${args.url} -> ${result.status} in ${result.latencyMs} ms`);
    return result.ok ? 0 : 1;
  } catch (err) {
    console.error(`webhook ping failed: ${(err as Error).message}`);
    return 1;
  }
}

// Only run when executed (`node dist/scripts/webhooks-ping.js`); the module is
// imported directly by tests, and must not start a request on import.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}

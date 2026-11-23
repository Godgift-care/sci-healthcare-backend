import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { signWebhook, WEBHOOK_SIGNATURE_HEADER } from '../lib/webhook-signature.js';
import {
  main,
  parsePingArgs,
  pingWebhook,
  PingUsageError,
  PING_EVENT,
} from '../scripts/webhooks-ping.js';

/**
 * `npm run webhooks:ping -- --url <url>` (#267).
 *
 * The command exists so an integrator can check a receiver and its secret
 * before a real event ever fires. The tests drive it against a real local
 * HTTP server: the ping must be signed over the exact bytes it sends, and a
 * non-2xx answer must be a failure rather than something to ignore.
 */

const SECRET = 'ping-test-secret-0123456789';

let server: Server;
let baseUrl: string;
let responseStatus = 204;
let lastBody = '';
let lastHeaders: Record<string, string | string[] | undefined> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      lastBody = Buffer.concat(chunks).toString('utf8');
      lastHeaders = req.headers;
      res.statusCode = responseStatus;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/hooks`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  responseStatus = 204;
  lastBody = '';
  lastHeaders = {};
  vi.restoreAllMocks();
});

describe('pingWebhook', () => {
  it('sends a ping signed exactly like a real delivery', async () => {
    const result = await pingWebhook({ url: baseUrl, secret: SECRET });

    expect(result).toMatchObject({ status: 204, ok: true });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const payload = JSON.parse(lastBody) as { event: string; sentAt: string };
    expect(payload.event).toBe(PING_EVENT);
    expect(Number.isNaN(Date.parse(payload.sentAt))).toBe(false);
    expect(lastHeaders[WEBHOOK_SIGNATURE_HEADER]).toBe(signWebhook(lastBody, SECRET));
    expect(lastHeaders['content-type']).toBe('application/json');
  });

  it('reports a non-2xx answer as a failure', async () => {
    responseStatus = 500;
    await expect(pingWebhook({ url: baseUrl, secret: SECRET })).resolves.toMatchObject({
      status: 500,
      ok: false,
    });
  });
});

describe('webhooks:ping command', () => {
  it('exits zero on a 2xx and prints the status and latency', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(main(['--url', baseUrl, '--secret', SECRET])).resolves.toBe(0);
    expect(log.mock.calls[0]?.[0]).toMatch(/-> 204 in \d+ ms$/);
  });

  it('exits non-zero on a non-2xx answer', async () => {
    responseStatus = 404;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(main(['--url', baseUrl, '--secret', SECRET])).resolves.toBe(1);
  });

  it('exits 2 on a usage error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The test environment sets WEBHOOK_SECRET, so use a missing value to
    // make this a usage error rather than a successful ping.
    await expect(main(['--url', baseUrl, '--secret'])).resolves.toBe(2);
  });

  it('ignores the ambient WEBHOOK_SECRET only when --secret is given', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('WEBHOOK_SECRET', SECRET);
    try {
      await expect(main(['--url', baseUrl])).resolves.toBe(0);
      expect(lastHeaders[WEBHOOK_SIGNATURE_HEADER]).toBe(signWebhook(lastBody, SECRET));
      expect(log).toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('parsePingArgs', () => {
  it('defaults the secret from the environment and floors production scripts honestly', () => {
    expect(parsePingArgs(['--url', baseUrl], { WEBHOOK_SECRET: SECRET })).toEqual({
      url: baseUrl,
      secret: SECRET,
    });
  });

  it('rejects a missing URL, unknown flags, a missing value and a non-http scheme', () => {
    expect(() => parsePingArgs([], {})).toThrow(PingUsageError);
    expect(() => parsePingArgs(['--url', baseUrl, '--wat'], {})).toThrow(/unknown argument/);
    expect(() => parsePingArgs(['--url'], {})).toThrow(/requires a value/);
    expect(() =>
      parsePingArgs(['--url', 'ftp://example.test/x'], { WEBHOOK_SECRET: SECRET }),
    ).toThrow(/http or https/);
    expect(() => parsePingArgs(['--url', 'not-a-url'], { WEBHOOK_SECRET: SECRET })).toThrow(
      /not a valid URL/,
    );
  });
});

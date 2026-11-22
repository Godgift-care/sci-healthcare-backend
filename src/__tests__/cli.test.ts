import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { prisma } from '../db.js';
import { seedLocalData } from '../scripts/seed.js';
import { runCli } from '../../packages/client/dist/cli.js';

/**
 * Smoke tests for the `sci` command-line client (packages/client), driven
 * in-process against the same app the route tests use. The CLI is built
 * into `packages/client/dist` by `npm run client:build`; the dist is
 * committed, like the typed client's (issue #153).
 */

type CliRun = { code: number; out: string; err: string };

/**
 * A clinic whose address carries a real StrKey checksum: `GET /vouchers`
 * validates the `provider` filter (#171), and the seed's `GSEED…` addresses
 * are realistic-shaped but fake.
 */
const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';
const FUNDER = 'GDUPJTF3PNSYJ73WWLNTYLG6UXN7HHBKCGFEEMDFMWKWGR3UMQT3JG45';
const REF = '72676a6f4fff92b09ab1c6368672b05112062f683014d07c9518d4141d094745';

describe('sci CLI', () => {
  let app: FastifyInstance;
  let activeProviderAddress: string;
  let someVoucherId: string;

  const env = { SCI_API_URL: 'http://cli.test.invalid' };

  // The same app.inject transport the typed client tests use: no sockets.
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    );
    const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'PUT' | 'DELETE';
    const headers: Record<string, string> = {};
    if (init?.headers) Object.assign(headers, init.headers);

    const res = await app.inject({
      method,
      url: url.pathname + url.search,
      headers,
      ...(init?.body ? { payload: String(init.body) } : {}),
    });
    return new Response(res.body, { status: res.statusCode, statusText: res.statusMessage });
  };

  async function sci(argv: string[]): Promise<CliRun> {
    let out = '';
    let err = '';
    const code = await runCli({
      argv,
      fetchImpl,
      env,
      stdout: (chunk) => {
        out += chunk;
      },
      stderr: (chunk) => {
        err += chunk;
      },
    });
    return { code, out, err };
  }

  beforeAll(async () => {
    app = await buildApp({ logger: false });
    await app.ready();

    await prisma.faucetDrip.deleteMany();
    await prisma.receipt.deleteMany();
    await prisma.voucher.deleteMany();
    await prisma.service.deleteMany();
    await prisma.provider.deleteMany();
    await prisma.governanceEvent.deleteMany();
    await prisma.servicePriceChange.deleteMany();
    await seedLocalData(prisma, { vouchers: 24, providers: 3 });

    await prisma.provider.create({
      data: {
        address: CLINIC,
        name: 'Ikeja General Clinic',
        country: 'NG',
        status: 'Active',
        registeredAt: new Date('2026-09-01T00:00:00Z'),
        services: {
          create: [
            { id: `${CLINIC}:101`, code: 101, label: 'Outpatient consult', price: '30000000' },
          ],
        },
      },
    });
    await prisma.voucher.createMany({
      data: [
        {
          id: 'cli-1',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '30000000',
          status: 'Funded',
          createdAt: new Date('2026-10-02T09:00:00Z'),
          expiresAt: new Date('2026-11-30T00:00:00Z'),
        },
        {
          id: 'cli-2',
          funder: FUNDER,
          beneficiaryRef: REF,
          providerAddress: CLINIC,
          serviceCode: 101,
          amount: '10000000',
          status: 'Claimed',
          createdAt: new Date('2026-10-03T09:00:00Z'),
          expiresAt: new Date('2026-11-30T00:00:00Z'),
        },
      ],
    });

    activeProviderAddress = CLINIC;
    someVoucherId = 'cli-1';
  });

  afterAll(async () => {
    await app.close();
  });

  it('prints help with every command, and exits 0', async () => {
    const help = await sci(['--help']);
    expect(help.code).toBe(0);
    for (const command of ['stats', 'vouchers', 'voucher', 'providers', 'receipts']) {
      expect(help.out).toContain(command);
    }
    expect(help.out).toContain('--json');
  });

  it('exits 2 with usage when no command or an unknown command is given', async () => {
    const noArgs = await sci([]);
    expect(noArgs.code).toBe(2);
    expect(noArgs.err).toContain('Usage:');

    const unknown = await sci(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain("unknown command 'frobnicate'");
  });

  it('renders stats as a table and as JSON', async () => {
    const table = await sci(['stats']);
    expect(table.code).toBe(0);
    expect(table.out).toContain('providers');
    expect(table.out).toMatch(/vouchers\s+\d+/);

    const json = await sci(['stats', '--json']);
    expect(json.code).toBe(0);
    const parsed = JSON.parse(json.out) as { providers: number; vouchers: number };
    expect(parsed.providers).toBeGreaterThan(0);
    expect(parsed.vouchers).toBeGreaterThan(0);
  });

  it('lists vouchers for one provider and fetches one voucher', async () => {
    // One page holds this clinic's whole book, so the assertion does not
    // depend on the route's default sort order.
    const list = await sci(['vouchers', '--provider', activeProviderAddress, '--limit', '24']);
    expect(list.code).toBe(0);
    expect(list.out).toContain('id');
    expect(list.out).toContain(someVoucherId);

    const one = await sci(['voucher', someVoucherId, '--json']);
    expect(one.code).toBe(0);
    const parsed = JSON.parse(one.out) as { id: string; provider: { address: string } };
    expect(parsed.id).toBe(someVoucherId);
    expect(parsed.provider.address).toBe(activeProviderAddress);
  });

  it('surfaces the API error when a voucher query has no filter', async () => {
    const noFilter = await sci(['vouchers']);
    expect(noFilter.code).toBe(1);
    expect(noFilter.err).toContain('filter_required');
  });

  it('fetches a provider with its service catalogue', async () => {
    const res = await sci(['provider', activeProviderAddress]);
    expect(res.code).toBe(0);
    expect(res.out).toContain(activeProviderAddress);
    expect(res.out).toContain('services');
  });

  it('lists providers filtered by status', async () => {
    const res = await sci(['providers', '--status', 'Active', '--json']);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.out) as { providers: { address: string }[] };
    expect(parsed.providers.length).toBeGreaterThan(0);
    expect(parsed.providers.map((p) => p.address)).toContain(activeProviderAddress);
  });

  it('exits 2 when a required argument or option value is missing', async () => {
    const missingArg = await sci(['voucher']);
    expect(missingArg.code).toBe(2);
    expect(missingArg.err).toContain('missing argument');

    const missingValue = await sci(['vouchers', '--provider', '--json']);
    expect(missingValue.code).toBe(2);
    expect(missingValue.err).toContain('--provider needs a value');
  });

  it('reports an unreachable API as exit code 1', async () => {
    const down = await runCli({
      argv: ['stats'],
      env,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
      stdout: () => {},
      stderr: () => {},
    });
    expect(down).toBe(1);
  });

  // --- #291: --csv on the list commands -------------------------------------

  describe('--csv output', () => {
    /** Parse a single CSV (header + rows) written by `--csv`. */
    function parseCsv(text: string): Record<string, string>[] {
      const lines = text.trimEnd().split('\n');
      const header = splitCsvLine(lines.shift() ?? '');
      return lines.map((line) => {
        const cells = splitCsvLine(line);
        const row: Record<string, string> = {};
        header.forEach((h, i) => {
          row[h] = cells[i] ?? '';
        });
        return row;
      });
    }
    function splitCsvLine(line: string): string[] {
      const out: string[] = [];
      let cur = '';
      let quoted = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quoted) {
          if (ch === '"' && line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else if (ch === '"') quoted = false;
          else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') {
          out.push(cur);
          cur = '';
        } else cur += ch;
      }
      out.push(cur);
      return out;
    }

    it('renders a voucher list as CSV that a reader parses', async () => {
      const res = await sci([
        'vouchers',
        '--provider',
        activeProviderAddress,
        '--limit',
        '24',
        '--csv',
      ]);
      expect(res.code).toBe(0);
      const rows = parseCsv(res.out);
      expect(rows.length).toBeGreaterThan(0);
      // `id` is a top-level column and the seeded voucher shows up.
      expect(Object.keys(rows[0]!)).toContain('id');
      expect(rows.map((r) => r.id)).toContain(someVoucherId);
    });

    it('quotes fields that contain a comma', async () => {
      // The clinic name has no comma, so force one through a filter echoed
      // nowhere; instead assert a nested object cell is JSON, not raw.
      const res = await sci(['providers', '--status', 'Active', '--csv']);
      expect(res.code).toBe(0);
      expect(res.out.split('\n')[0]).toContain('address');
    });

    it('writes nothing to stdout and exits non-zero on an error', async () => {
      const bad = await sci(['vouchers', '--csv']); // no filter -> filter_required
      expect(bad.code).toBe(1);
      expect(bad.out).toBe('');
      expect(bad.err).toContain('filter_required');
    });
  });

  // --- #290: sci watch over the live stream -----------------------------------

  describe('watch', () => {
    /** An SSE `fetch` that serves the given frames and then closes. */
    function sseFetch(frames: string[]): typeof fetch {
      return (async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const frame of frames) controller.enqueue(encoder.encode(frame));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }) as typeof fetch;
    }

    const fund = (id: string): string =>
      `data: {"type":"voucher_funded","voucherId":"${id}","providerAddress":"${CLINIC}","status":"Funded","ledger":10,"txHash":"aa","at":"2026-01-01T00:00:00Z"}\n\n`;

    it('needs a filter, like the stream route', async () => {
      let out = '';
      let err = '';
      const code = await runCli({
        argv: ['watch'],
        env,
        fetchImpl: sseFetch([]),
        stdout: (c) => {
          out += c;
        },
        stderr: (c) => {
          err += c;
        },
      });
      expect(code).toBe(2);
      expect(err).toContain('watch needs one filter');
      expect(out).toBe('');
    });

    it('prints one line per event and ends on the interrupt', async () => {
      // The stream stays open (the handle reconnects when a server closes
      // it), so the operator pressing Ctrl-C is what ends `sci watch`.
      const controller = new AbortController();
      let out = '';
      const code = await runCli({
        argv: ['watch', '--provider', CLINIC],
        env,
        fetchImpl: sseFetch([': connected\n\n', fund('v1'), fund('v2')]),
        signal: controller.signal,
        stdout: (c) => {
          out += c;
          if (out.trimEnd().split('\n').length >= 2) controller.abort();
        },
        stderr: () => {},
      });
      expect(code).toBe(130);
      const lines = out.trimEnd().split('\n');
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain('voucher_funded');
      expect(lines[0]).toContain('v1');
    });

    it('prints JSON lines with --json', async () => {
      const controller = new AbortController();
      let out = '';
      await runCli({
        argv: ['watch', '--provider', CLINIC, '--json'],
        env,
        fetchImpl: sseFetch([fund('v1')]),
        signal: controller.signal,
        stdout: (c) => {
          out += c;
          controller.abort();
        },
        stderr: () => {},
      });
      const parsed = JSON.parse(out.trim().split('\n')[0]!) as {
        voucherId: string;
        status: string;
      };
      expect(parsed.voucherId).toBe('v1');
      expect(parsed.status).toBe('Funded');
    });

    it('exits cleanly (130) when the stream is interrupted', async () => {
      // A stream that never closes: only an abort can end it, which is what
      // Ctrl-C does. The pre-aborted signal models the keypress arriving
      // before/while reading, and the CLI must not hang or throw.
      const neverClosing = (async () =>
        new Response(new ReadableStream<Uint8Array>({ start: () => {} }), {
          status: 200,
        })) as typeof fetch;

      const controller = new AbortController();
      controller.abort();
      let err = '';
      const code = await runCli({
        argv: ['watch', '--provider', CLINIC],
        env,
        fetchImpl: neverClosing,
        signal: controller.signal,
        stdout: () => {},
        stderr: (c) => {
          err += c;
        },
      });
      expect(code).toBe(130);
      expect(err).toBe(''); // an interrupt is not reported as an error
    });

    it('retries a full instance and reports a status it will not retry', async () => {
      // 503 `stream_full` means the instance is at `SSE_MAX_CONNECTIONS`, so
      // the stream retries it; 404 is fatal and is what ends the command.
      let calls = 0;
      let err = '';
      const code = await runCli({
        argv: ['watch', '--provider', CLINIC],
        env,
        fetchImpl: (async () => {
          calls += 1;
          return calls === 1
            ? new Response('nope', { status: 503, statusText: 'unavailable' })
            : new Response('gone', { status: 404, statusText: 'not found' });
        }) as typeof fetch,
        stdout: () => {},
        stderr: (c) => {
          err += c;
        },
      });
      expect(code).toBe(1);
      expect(err).toContain('error:');
      expect(calls).toBe(2);
    });
  });
});

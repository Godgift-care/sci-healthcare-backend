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

    const provider = await prisma.provider.findFirstOrThrow({
      where: { status: 'Active' },
      select: { address: true },
    });
    activeProviderAddress = provider.address;
    const voucher = await prisma.voucher.findFirstOrThrow({
      where: { providerAddress: provider.address },
      select: { id: true },
    });
    someVoucherId = voucher.id;
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
    // The whole seed for this provider fits in one page, so the assertion
    // does not depend on the route's default sort order.
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
});

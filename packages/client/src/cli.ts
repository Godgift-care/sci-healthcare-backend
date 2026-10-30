#!/usr/bin/env node
/**
 * `sci` — command-line client for the SCI Healthcare API.
 *
 * Every command maps to one read route of the API (the same routes the
 * typed client wraps), so shell scripts, cron jobs and clinic IT staff can
 * query vouchers, clinics and protocol statistics without writing HTTP
 * code:
 *
 *   sci stats
 *   sci vouchers --provider GDOO... --status Funded
 *   sci voucher 42 --json
 *
 * Output is an aligned table by default and raw JSON with `--json`, so it
 * is both readable and pipeable (jq, awk, grep). Exit codes: 0 success,
 * 1 the API or the network failed, 2 the command line was wrong.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { ApiError, Client, createClient, type ClientOptions } from './client.js';
import type {
  CsvVouchersParams,
  DueVouchersParams,
  ListProvidersParams,
  ListReceiptsParams,
  ListVouchersParams,
} from './types.js';

/** The environment the CLI reads; injectable for tests. */
export type CliEnv = Record<string, string | undefined>;

export type CliOptions = {
  /** Arguments after the program name, i.e. `process.argv.slice(2)`. */
  argv: readonly string[];
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  env?: CliEnv;
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
};

/** Wrong arguments: the command did not run. Reported with exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

type Flags = Record<string, string | boolean>;

/** Flags that never take a value; everything else expects the next token. */
const BOOLEAN_FLAGS = new Set(['json', 'help', 'all']);
const DEFAULT_BASE_URL = 'http://localhost:8080';
/** Longest a table cell is shown before it is shortened (JSON stays whole). */
const MAX_CELL_WIDTH = 60;

/** `beneficiary-ref` -> `beneficiaryRef`, so flags read like the API. */
function camel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

type Parsed = { command: string | null; positionals: string[]; flags: Flags };

function parseArgv(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags: Flags = {};
  let command: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      const key = camel(eq === -1 ? body : body.slice(0, eq));
      if (eq !== -1) {
        flags[key] = body.slice(eq + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (command === null) command = arg;
    else positionals.push(arg);
  }
  return { command, positionals, flags };
}

function flagBool(flags: Flags, name: string): boolean {
  return flags[name] === true;
}

/** Reads a flag as text, failing loudly when the value is missing. */
function flagValue(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new UsageError(`--${kebab(name)} needs a value`);
  }
  return value;
}

function intFlag(flags: Flags, name: string): number | undefined {
  const value = flagValue(flags, name);
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    throw new UsageError(`--${kebab(name)} must be an integer, got '${value}'`);
  }
  return n;
}

/** The listed flags, as query params, omitting the ones that were not given. */
function paramsFrom<T>(flags: Flags, keys: readonly string[]): T {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = flagValue(flags, key);
    if (value !== undefined) out[key] = value;
  }
  return out as unknown as T;
}

function positional(positionals: string[], index: number, usage: string): string {
  const value = positionals[index];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`missing argument: ${usage}`);
  }
  return value;
}

type CommandResult = { data?: unknown; text?: string };

type CommandContext = {
  client: Client;
  positionals: string[];
  flags: Flags;
};

type Command = {
  name: string;
  summary: string;
  usage: string;
  examples?: string[];
  run: (ctx: CommandContext) => Promise<CommandResult>;
};

const VOUCHER_FILTER_FLAGS = ['funder', 'provider', 'beneficiaryRef', 'status'] as const;

/** Every command mirrors one read route of the API. */
const COMMANDS: Command[] = [
  {
    name: 'health',
    summary: 'Liveness probe (GET /health)',
    usage: 'sci health',
    run: async ({ client }) => ({ data: await client.health() }),
  },
  {
    name: 'ready',
    summary: 'Readiness with indexer lag and dependency checks (GET /ready)',
    usage: 'sci ready',
    run: async ({ client }) => ({ data: await client.ready() }),
  },
  {
    name: 'version',
    summary: 'Build, network, RPC endpoints and contract ids (GET /version)',
    usage: 'sci version',
    run: async ({ client }) => ({ data: await client.version() }),
  },
  {
    name: 'stats',
    summary: 'Protocol counters for dashboards (GET /stats)',
    usage: 'sci stats',
    examples: ['sci stats --json | jq .vouchers'],
    run: async ({ client }) => ({ data: await client.stats() }),
  },
  {
    name: 'stats-daily',
    summary: 'Funded / settled / refunded per UTC day (GET /stats/daily)',
    usage: 'sci stats-daily [--days <n>]',
    examples: ['sci stats-daily --days 7'],
    run: async ({ client, flags }) => {
      const days = intFlag(flags, 'days');
      return { data: days === undefined ? await client.dailyStats() : await client.dailyStats(days) };
    },
  },
  {
    name: 'providers',
    summary: 'Clinics, filterable by status, country and name (GET /providers)',
    usage: 'sci providers [--status Active] [--country NG] [--q <text>] [--limit <n>]',
    run: async ({ client, flags }) => ({
      data: await client.providers(
        paramsFrom<ListProvidersParams>(flags, ['status', 'country', 'q', 'limit', 'cursor']),
      ),
    }),
  },
  {
    name: 'provider',
    summary: 'One clinic and its service catalogue (GET /providers/:address)',
    usage: 'sci provider <address>',
    examples: ['sci provider GDOOCN...'],
    run: async ({ client, positionals }) => ({
      data: await client.provider(positional(positionals, 0, 'provider <address>')),
    }),
  },
  {
    name: 'provider-stats',
    summary: "A clinic's vouchers by status and total settled value (GET /providers/:address/stats)",
    usage: 'sci provider-stats <address>',
    run: async ({ client, positionals }) => ({
      data: await client.rawGet<unknown>(
        `/providers/${encodeURIComponent(positional(positionals, 0, 'provider-stats <address>'))}/stats`,
      ),
    }),
  },
  {
    name: 'provider-history',
    summary: 'Every status transition for a clinic (GET /providers/:address/history)',
    usage: 'sci provider-history <address>',
    run: async ({ client, positionals }) => ({
      data: await client.providerHistory(positional(positionals, 0, 'provider-history <address>')),
    }),
  },
  {
    name: 'provider-service-history',
    summary: 'Every observed price for one service (GET /providers/:address/services/:code/history)',
    usage: 'sci provider-service-history <address> <code>',
    run: async ({ client, positionals }) => {
      const address = positional(positionals, 0, 'provider-service-history <address> <code>');
      const code = Number(positional(positionals, 1, 'provider-service-history <address> <code>'));
      if (!Number.isInteger(code)) {
        throw new UsageError(`<code> must be an integer, got '${positionals[1] ?? ''}'`);
      }
      return { data: await client.providerServiceHistory(address, code) };
    },
  },
  {
    name: 'attesters',
    summary: 'Attesters trusted to confirm care (GET /attesters)',
    usage: 'sci attesters [--all]',
    run: async ({ client, flags }) => ({
      data: flagBool(flags, 'all')
        ? await client.rawGet<unknown>('/attesters', { all: 'true' })
        : await client.rawGet<unknown>('/attesters'),
    }),
  },
  {
    name: 'attester',
    summary: 'One attester with its attestation count (GET /attesters/:address)',
    usage: 'sci attester <address>',
    run: async ({ client, positionals }) => ({
      data: await client.rawGet<unknown>(
        `/attesters/${encodeURIComponent(positional(positionals, 0, 'attester <address>'))}`,
      ),
    }),
  },
  {
    name: 'services',
    summary: 'Service catalogue with clinic counts and price range (GET /services)',
    usage: 'sci services',
    run: async ({ client }) => ({ data: await client.services() }),
  },
  {
    name: 'service',
    summary: 'Active clinics offering a service code (GET /services/:code)',
    usage: 'sci service <code>',
    examples: ['sci service 101'],
    run: async ({ client, positionals }) => {
      const code = Number(positional(positionals, 0, 'service <code>'));
      if (!Number.isInteger(code)) {
        throw new UsageError(`<code> must be an integer, got '${positionals[0] ?? ''}'`);
      }
      return { data: await client.service(code) };
    },
  },
  {
    name: 'countries',
    summary: 'Countries with active clinics and their counts (GET /countries)',
    usage: 'sci countries',
    run: async ({ client }) => ({ data: await client.countries() }),
  },
  {
    name: 'vouchers',
    summary: 'Vouchers; one of --funder, --provider, --beneficiary-ref or --status is required',
    usage:
      'sci vouchers [--funder G...] [--provider G...] [--beneficiary-ref <ref>] [--status Funded,Claimed] [--sort createdAt|expiresAt|amount] [--order asc|desc] [--limit <n>]',
    examples: [
      'sci vouchers --provider GDOO... --status Funded --limit 10',
      'sci vouchers --funder GDUP... --sort expiresAt --order asc --json | jq -r \'.vouchers[].id\'',
    ],
    run: async ({ client, flags }) => ({
      data: await client.vouchers(
        paramsFrom<ListVouchersParams>(flags, [
          ...VOUCHER_FILTER_FLAGS,
          'sort',
          'order',
          'limit',
          'cursor',
        ]),
      ),
    }),
  },
  {
    name: 'voucher',
    summary: 'One voucher with receipt, attester and dispute outcome (GET /vouchers/:id)',
    usage: 'sci voucher <id>',
    examples: ['sci voucher 42', 'sci voucher 42 --json'],
    run: async ({ client, positionals }) => ({
      data: await client.voucher(positional(positionals, 0, 'voucher <id>')),
    }),
  },
  {
    name: 'voucher-events',
    summary: 'Every contract event for a voucher (GET /vouchers/:id/events)',
    usage: 'sci voucher-events <id>',
    run: async ({ client, positionals }) => ({
      data: await client.rawGet<unknown>(
        `/vouchers/${encodeURIComponent(positional(positionals, 0, 'voucher-events <id>'))}/events`,
      ),
    }),
  },
  {
    name: 'vouchers-due',
    summary: 'Vouchers needing action soon (GET /vouchers/due)',
    usage: 'sci vouchers-due [--within 72h] [--funder G...] [--provider G...]',
    run: async ({ client, flags }) => ({
      data: await client.vouchersDue(
        paramsFrom<DueVouchersParams>(flags, ['within', 'funder', 'provider']),
      ),
    }),
  },
  {
    name: 'vouchers-csv',
    summary: 'CSV export with the voucher filters (GET /vouchers.csv)',
    usage: 'sci vouchers-csv (--funder G... | --provider G... | --beneficiary-ref <ref> | --status ...)',
    examples: ['sci vouchers-csv --funder GDUP... > vouchers.csv'],
    run: async ({ client, flags }) => ({
      text: await client.vouchersCsv(paramsFrom<CsvVouchersParams>(flags, VOUCHER_FILTER_FLAGS)),
    }),
  },
  {
    name: 'receipts',
    summary: "A patient's or a clinic's settled care history (GET /receipts)",
    usage: 'sci receipts (--beneficiary-ref <ref> | --provider G...)',
    run: async ({ client, flags }) => ({
      data: await client.receipts(paramsFrom<ListReceiptsParams>(flags, ['beneficiaryRef', 'provider'])),
    }),
  },
  {
    name: 'receipt',
    summary: 'One receipt by voucher id (GET /receipts/:voucherId)',
    usage: 'sci receipt <voucherId>',
    run: async ({ client, positionals }) => ({
      data: await client.receipt(positional(positionals, 0, 'receipt <voucherId>')),
    }),
  },
  {
    name: 'governance',
    summary: 'Admin per contract plus the handover history (GET /governance)',
    usage: 'sci governance',
    run: async ({ client }) => ({ data: await client.governance() }),
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function cell(value: unknown): string {
  const text = display(value);
  return text.length > MAX_CELL_WIDTH ? `${text.slice(0, MAX_CELL_WIDTH - 3)}...` : text;
}

/** Renders rows as an aligned markdown-free table. */
export function renderTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '(no rows)\n';
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => cell(row[col]).length)),
  );
  const line = (cells: string[]): string =>
    cells.map((text, i) => text.padEnd(widths[i]!)).join('  ').trimEnd();
  const lines = [line(columns), line(widths.map((w) => '-'.repeat(w)))];
  for (const row of rows) lines.push(line(columns.map((col) => cell(row[col]))));
  return `${lines.join('\n')}\n`;
}

/** `totals` -> `totals.settledValue`, so nested counters stay readable. */
function flatten(value: Record<string, unknown>, prefix = ''): [string, unknown][] {
  const rows: [string, unknown][] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (isPlainObject(entry)) rows.push(...flatten(entry, `${prefix}${key}.`));
    else rows.push([`${prefix}${key}`, entry]);
  }
  return rows;
}

/** Renders one command result: JSON with --json, tables otherwise. */
function renderData(data: unknown, json: boolean): string {
  if (json) return `${JSON.stringify(data, null, 2)}\n`;
  if (Array.isArray(data)) return renderTable(data as Record<string, unknown>[]);
  if (isPlainObject(data)) {
    const scalars: [string, unknown][] = [];
    const arrays: [string, Record<string, unknown>[]][] = [];
    for (const [key, value] of Object.entries(data)) {
      if (Array.isArray(value) && value.every(isPlainObject)) arrays.push([key, value]);
      else if (isPlainObject(value)) scalars.push(...flatten(value, `${key}.`));
      else scalars.push([key, value]);
    }
    const width = Math.max(0, ...scalars.map(([key]) => key.length));
    let out = `${scalars.map(([key, value]) => `${key.padEnd(width)}  ${display(value)}`).join('\n')}\n`;
    for (const [name, rows] of arrays) out += `\n${name} (${rows.length}):\n${renderTable(rows)}`;
    return out;
  }
  return `${display(data)}\n`;
}

function usageText(topic?: string): string {
  if (topic !== undefined) {
    const def = COMMANDS.find((c) => c.name === topic);
    if (def !== undefined) {
      const lines = [`${def.name} — ${def.summary}`, '', `Usage: ${def.usage}`];
      if (def.examples?.length) lines.push('', 'Examples:', ...def.examples.map((e) => `  ${e}`));
      return `${lines.join('\n')}\n`;
    }
  }
  const lines = [
    'sci — command-line client for the SCI Healthcare API',
    '',
    'Usage: sci <command> [options]',
    '',
    'Global options:',
    '  --base-url <url>   API base URL (default: $SCI_API_URL, $API_URL, then http://localhost:8080)',
    '  --json             Print raw JSON instead of a table',
    '  -h, --help         Show this help, or help for one command',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(26)} ${c.summary}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Runs one command line. Returns the process exit code instead of exiting,
 * so tests can drive it in-process.
 */
export async function runCli(options: CliOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk));
  const stderr = options.stderr ?? ((chunk: string) => void process.stderr.write(chunk));

  const { command, positionals, flags } = parseArgv(options.argv);

  if (command === null) {
    if (flagBool(flags, 'help')) {
      stdout(usageText());
      return 0;
    }
    stderr(usageText());
    return 2;
  }
  if (command === 'help') {
    stdout(usageText(positionals[0]));
    return 0;
  }

  const def = COMMANDS.find((c) => c.name === command);
  if (def === undefined) {
    stderr(`error: unknown command '${command}'\n\n${usageText()}`);
    return 2;
  }
  if (flagBool(flags, 'help')) {
    stdout(usageText(command));
    return 0;
  }

  try {
    const baseUrl = (
      flagValue(flags, 'baseUrl') ??
      env.SCI_API_URL ??
      env.API_URL ??
      DEFAULT_BASE_URL
    ).replace(/\/+$/, '');
    const clientOptions: ClientOptions = { baseUrl };
    if (options.fetchImpl) clientOptions.fetch = options.fetchImpl;
    const client = createClient(clientOptions);

    const result = await def.run({ client, positionals, flags });
    if (result.text !== undefined) stdout(result.text);
    else stdout(renderData(result.data, flagBool(flags, 'json')));
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      stderr(`error: ${err.message}\n\nUsage: ${def.usage}\n`);
      return 2;
    }
    if (err instanceof ApiError) {
      stderr(`error: ${err.message} (status ${err.status}, code ${err.error})\n`);
      return 1;
    }
    stderr(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

/**
 * True when this module is the entry point. Comparing resolved real paths
 * keeps the check working through the `node_modules/.bin` symlink npm
 * creates for the `sci` bin.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = await runCli({ argv: process.argv.slice(2) });
}

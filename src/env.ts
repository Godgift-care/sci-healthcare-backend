import { z } from 'zod';

/**
 * Environment is validated once, at boot, and the process refuses to start
 * if anything required is missing. A backend that starts with a blank
 * contract id and fails silently at request time is far harder to debug
 * than one that will not start at all.
 */
function isValidHttpUrl(val: string): boolean {
  try {
    const url = new URL(val);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The two parsed fields the CORS rule reads. */
type CorsConfig = { NODE_ENV: string; CORS_ORIGIN: string };

/** The CORS_ORIGIN rule, as the message it fails with, or null when it holds. */
function corsViolation(cfg: CorsConfig): string | null {
  const origins = cfg.CORS_ORIGIN.split(',').map((s) => s.trim());
  if (cfg.NODE_ENV === 'production' && origins.some((o) => o === '*')) {
    return 'Wildcard CORS origin "*" is not allowed in production';
  }
  const ok = origins.every((o) => {
    if (o === '*' && cfg.NODE_ENV !== 'production') return true;
    return isValidHttpUrl(o);
  });
  return ok ? null : 'CORS_ORIGIN must contain valid http(s) URLs';
}

/** The parsed environment shape, before the CORS rule is layered on. */
const envShape = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  /**
   * When 'true', every data route answers 503 Service Unavailable with
   * a Retry-After header while /health stays 200 OK (#322).
   */
  MAINTENANCE_MODE: z.enum(['true', 'false']).default('false'),
  READY_MAX_LAG_LEDGERS: z.coerce.number().int().nonnegative().default(120),
  /**
   * How long a webhook delivery may stay pending before `/ready` reports the
   * backlog. Every retry finishes inside the backoff ceiling (six attempts
   * within a few minutes), so anything older than this means the delivery
   * loop is not draining the outbox, not that an endpoint is slow.
   */
  READY_WEBHOOK_MAX_AGE_MS: z.coerce.number().int().positive().default(900_000),

  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().optional(),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // Prune ContractEvent rows older than this many days, for settled/refunded
  // vouchers only (#275). 0 or unset keeps the full log forever.
  EVENT_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(0),

  STELLAR_NETWORK: z.enum(['testnet', 'public', 'futurenet']).default('testnet'),
  // One of these two is required. `SOROBAN_RPC_URLS` is the comma-separated
  // form that allows a standby endpoint; `SOROBAN_RPC_URL` is the original
  // single-endpoint variable and is still honoured.
  SOROBAN_RPC_URL: z.string().url().optional(),
  SOROBAN_RPC_URLS: z.string().optional(),
  /**
   * Consecutive failures against one endpoint before the pool rotates to the
   * next. One blip is not an outage, so the default waits for a small streak.
   */
  SOROBAN_RPC_MAX_FAILURES: z.coerce.number().int().positive().default(3),
  NETWORK_PASSPHRASE: z.string().min(1),

  REGISTRY_CONTRACT_ID: z.string().length(56),
  VOUCHER_CONTRACT_ID: z.string().length(56),
  RECEIPT_CONTRACT_ID: z.string().length(56),
  USDC_CONTRACT_ID: z.string().length(56).optional(),
  /** Testnet demo faucet. Drips are counted only when this is set. */
  FAUCET_CONTRACT_ID: z.string().length(56).optional(),

  /**
   * Optional JSON array of previous contract deployments for redeployment support.
   * Each entry has {type, contractId, fromLedger, toLedger?}.
   * When present, the indexer subscribes to ALL listed contracts.
   */
  DEPLOYMENTS: z.string().optional(),

  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(5000),
  /** Ceiling for the indexer's exponential backoff after RPC failures. */
  INDEXER_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * How long shutdown waits for the indexer cycle in flight before giving
   * up. Render sends SIGTERM on every deploy, so the process must finish the
   * transaction and save the cursor, but a wedged cycle must not hang the
   * deploy forever.
   */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // Comma-separated endpoints notified of voucher events. Blank disables
  // webhooks entirely, which is the default.
  WEBHOOK_URLS: z.string().default(''),
  // JSON array of per-endpoint objects: {url, secret?, events?, provider?}.
  // Takes precedence over WEBHOOK_URLS when set (#263).
  WEBHOOK_ENDPOINTS: z.string().default(''),
  // HMAC key used to sign every delivery. Required once an endpoint is set,
  // so a deployment cannot accidentally send unsigned events.
  WEBHOOK_SECRET: z.string().default(''),
  // Comma-separated HMAC keys, newest first. Every key signs each delivery,
  // so a receiver can verify with the old key until it has rotated (#262).
  WEBHOOK_SECRETS: z.string().default(''),
  // Opt in to loopback/private destinations for local development. Off in
  // production, so a webhook or metadata URI cannot reach an internal host.
  WEBHOOK_ALLOW_PRIVATE: z.enum(['true', 'false']).default('false'),

  /**
   * Idle interval between heartbeat frames on `GET /stream`. A comment line
   * every so often is what stops a proxy or mobile carrier from closing a
   * connection that is alive but quiet, and it is how the server notices a
   * client that has vanished. The floor keeps a misconfigured value from
   * turning every open stream into a self-inflicted flood.
   */
  SSE_HEARTBEAT_MS: z.coerce.number().int().min(250).default(15_000),
  /**
   * Concurrent `GET /stream` connections this instance will hold. Each one is
   * a socket that is never released, so the cap is what keeps a page that
   * reconnects on every focus from using up the instance; past it the route
   * answers 503 and the client retries later.
   */
  SSE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(64),
});

/**
 * The CORS rule, applied after the shape parses. Kept off the object literal
 * so `env-docs.test.ts`, which reads the shape as text, stops at its closing
 * brace.
 */
const corsSchema = envShape.refine((cfg) => corsViolation(cfg) === null, {
  error: (issue) => ({
    message:
      corsViolation(issue.input as CorsConfig) ?? 'CORS_ORIGIN must contain valid http(s) URLs',
  }),
  path: ['CORS_ORIGIN'],
});

/**
 * Expected network passphrases for each STELLAR_NETWORK value.
 * These match the Stellar SDK Networks constants.
 */
const EXPECTED_PASSPHRASES: Record<string, string> = {
  testnet: 'Test SDF Network ; September 2015',
  public: 'Public Global Stellar Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
};

export type Env = Omit<z.infer<typeof schema>, 'SOROBAN_RPC_URL' | 'WEBHOOK_ALLOW_PRIVATE'> & {
  /** The first configured endpoint; kept for callers that want just one. */
  SOROBAN_RPC_URL: string;
  /** Every configured endpoint, in failover order. Never empty. */
  RPC_URLS: readonly string[];
  /** Boolean form of WEBHOOK_ALLOW_PRIVATE. */
  WEBHOOK_ALLOW_PRIVATE: boolean;
};

/**
 * Parses the endpoint list, preferring `SOROBAN_RPC_URLS` and falling back to
 * the single `SOROBAN_RPC_URL`. Duplicates are dropped so a copy-paste in the
 * list cannot make the pool rotate onto the endpoint that just failed.
 */
export function parseRpcUrls(list: string | undefined, single: string | undefined): string[] {
  const raw = (list ?? single ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const url of raw) {
    if (!URL.canParse(url)) throw new Error(`SOROBAN_RPC_URLS contains an invalid URL: ${url}`);
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

/** Hides any credentials in an RPC URL before it reaches a log or a response. */
export function redactRpcUrl(url: string): string {
  return url.replace(/:\/\/[^/]+@/, '://***@');
}

/** Minimum length of a webhook signing secret; shorter keys are refused at boot. */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

/**
 * One delivery target: its URL, the keys that sign its requests, and the
 * optional filters that decide which events it is told about (#263).
 *
 * A `null` filter means "everything": `events: null` receives every voucher
 * event and `provider: null` is not restricted to one clinic.
 */
export type WebhookEndpoint = {
  url: string;
  /** Newest first; every key signs the request so either can verify it. */
  secrets: readonly string[];
  /** Event names this endpoint wants, or null for all of them. */
  events: readonly string[] | null;
  /** Clinic address this endpoint wants, or null for every clinic. */
  provider: string | null;
};

const webhookEndpointSchema = z
  .object({
    url: z.string().min(1),
    secret: z.string().optional(),
    events: z.array(z.string().min(1)).min(1).optional(),
    provider: z.string().optional(),
  })
  // Strict: a misspelt `event` would otherwise silently mean "all events".
  .strict();

/**
 * Parses comma-separated signing keys, newest first, dropping blanks and
 * duplicates. `WEBHOOK_SECRET` stays supported on its own (#262).
 */
export function parseWebhookSecrets(...sources: readonly string[]): string[] {
  const seen = new Set<string>();
  const secrets: string[] = [];
  for (const raw of sources.join(',').split(',')) {
    const secret = raw.trim();
    if (secret === '' || seen.has(secret)) continue;
    seen.add(secret);
    secrets.push(secret);
  }
  return secrets;
}

/** Throws with a message an operator can act on; returns the trimmed key. */
function validSecret(secret: string, where: string): string {
  const trimmed = secret.trim();
  if (trimmed.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new Error(
      `${where} must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters (got ${trimmed.length})`,
    );
  }
  return trimmed;
}

/**
 * Parses `WEBHOOK_ENDPOINTS`, the JSON form that gives each partner its own
 * secret and event/clinic filters (#263).
 *
 * Invalid JSON is a startup error rather than a silently disabled feature:
 * a clinic that believes it is receiving notifications must not discover at
 * settlement time that its endpoint was never registered.
 */
export function parseWebhookEndpoints(
  json: string,
  fallbackSecrets: readonly string[],
): WebhookEndpoint[] {
  const raw = json.trim();
  if (raw === '') return [];

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Invalid WEBHOOK_ENDPOINTS JSON: ${(err as Error).message}\n` +
        'Expected an array like [{"url":"https://clinic.example/hooks","secret":"...","events":["voucher_settled"],"provider":"G..."}]',
    );
  }

  const parsed = z.array(webhookEndpointSchema).safeParse(document);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || 'endpoints'}: ${i.message}`)
      .join('\n');
    throw new Error(
      `Invalid WEBHOOK_ENDPOINTS JSON:\n${issues}\n` +
        'Expected an array of {url, secret?, events?, provider?} objects.',
    );
  }

  const seen = new Set<string>();
  return parsed.data.map((entry, i) => {
    let url: URL;
    try {
      url = new URL(entry.url);
    } catch {
      throw new Error(`WEBHOOK_ENDPOINTS entry ${i}: url is not a valid URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`WEBHOOK_ENDPOINTS entry ${i}: url scheme ${url.protocol} is not http(s)`);
    }
    if (seen.has(entry.url)) {
      throw new Error(`WEBHOOK_ENDPOINTS entry ${i}: duplicate url ${entry.url}`);
    }
    seen.add(entry.url);
    if (entry.provider !== undefined && entry.provider.length !== 56) {
      throw new Error(`WEBHOOK_ENDPOINTS entry ${i}: provider must be a 56-character address`);
    }
    const secrets =
      entry.secret !== undefined
        ? [validSecret(entry.secret, `WEBHOOK_ENDPOINTS entry ${i} secret`)]
        : fallbackSecrets;
    if (secrets.length === 0) {
      throw new Error(
        `WEBHOOK_ENDPOINTS entry ${i} has no secret and neither WEBHOOK_SECRETS nor WEBHOOK_SECRET is set`,
      );
    }
    return {
      url: entry.url,
      secrets,
      events: entry.events ?? null,
      provider: entry.provider ?? null,
    };
  });
}

/** Splits and validates the legacy comma-separated URL list. */
function parseWebhookUrls(raw: string): string[] {
  const urls = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  for (const url of urls) {
    if (!isValidHttpUrl(url))
      throw new Error(`WEBHOOK_URLS contains an invalid http(s) URL: ${url}`);
  }
  return urls;
}

/**
 * The complete environment rule: shape, CORS, and webhook configuration.
 * Exported so tests can drive it directly without touching `process.env`.
 */
export const schema = corsSchema.superRefine((value, ctx) => {
  // Parse once here so a malformed list fails as an ordinary environment
  // error with the variable named, before any endpoint is used.
  try {
    const secrets = parseWebhookSecrets(value.WEBHOOK_SECRETS, value.WEBHOOK_SECRET);
    const endpoints = parseWebhookEndpoints(value.WEBHOOK_ENDPOINTS, secrets);
    const urls = parseWebhookUrls(value.WEBHOOK_URLS);
    if (endpoints.length === 0 && urls.length > 0 && secrets.length === 0) {
      throw new Error('WEBHOOK_SECRETS (or WEBHOOK_SECRET) must be set when WEBHOOK_URLS is set');
    }
    for (const secret of secrets) validSecret(secret, 'WEBHOOK_SECRETS');
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WEBHOOK_ENDPOINTS'],
      message: (err as Error).message,
    });
  }
});

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(
      `Invalid environment configuration:\n${issues}\n\n` +
        'Copy .env.example to .env and fill in the contract ids printed by scripts/deploy.sh.',
    );
  }

  const config = parsed.data;

  // Validate that NETWORK_PASSPHRASE matches STELLAR_NETWORK at startup.
  // A mismatched passphrase means the backend would query the wrong chain.
  const expectedPassphrase = EXPECTED_PASSPHRASES[config.STELLAR_NETWORK];
  if (expectedPassphrase && config.NETWORK_PASSPHRASE !== expectedPassphrase) {
    throw new Error(
      `NETWORK_PASSPHRASE mismatch for ${config.STELLAR_NETWORK}:\n` +
        `  Expected: ${expectedPassphrase}\n` +
        `  Got:      ${config.NETWORK_PASSPHRASE}\n\n` +
        'Fix your .env file so the passphrase matches the chosen network.',
    );
  }

  const rpcUrls = parseRpcUrls(config.SOROBAN_RPC_URLS, config.SOROBAN_RPC_URL);
  if (rpcUrls.length === 0) {
    throw new Error(
      'No Soroban RPC endpoint configured.\n' +
        '  Set SOROBAN_RPC_URLS to a comma-separated list, or SOROBAN_RPC_URL to one endpoint.',
    );
  }

  return {
    ...config,
    SOROBAN_RPC_URL: rpcUrls[0]!,
    RPC_URLS: rpcUrls,
    WEBHOOK_ALLOW_PRIVATE: config.WEBHOOK_ALLOW_PRIVATE === 'true',
  };
}

/**
 * A single contract deployment entry from the DEPLOYMENTS config.
 */
export type DeploymentEntry = {
  type: 'registry' | 'voucher' | 'receipt';
  contractId: string;
  fromLedger: number;
  toLedger?: number;
};

const deploymentSchema = z.array(
  z.object({
    type: z.enum(['registry', 'voucher', 'receipt']),
    contractId: z.string().length(56),
    fromLedger: z.number().int().nonnegative(),
    toLedger: z.number().int().nonnegative().optional(),
  }),
);

export const env = load();

/** Every configured RPC endpoint, in failover order. */
export const RPC_URLS = env.RPC_URLS;

/**
 * Parse DEPLOYMENTS JSON if present, otherwise empty array.
 */
function parseDeployments(): DeploymentEntry[] {
  if (!env.DEPLOYMENTS) return [];
  try {
    const parsed: unknown = JSON.parse(env.DEPLOYMENTS);
    const validated = deploymentSchema.parse(parsed);
    // Strip undefined toLedger values to satisfy exactOptionalPropertyTypes
    return validated.map((d) => ({
      type: d.type,
      contractId: d.contractId,
      fromLedger: d.fromLedger,
      ...(d.toLedger !== undefined ? { toLedger: d.toLedger } : {}),
    }));
  } catch (err) {
    throw new Error(
      `Invalid DEPLOYMENTS JSON: ${(err as Error).message}\n` +
        'Expected format: [{"type":"registry","contractId":"C...","fromLedger":123}]',
    );
  }
}

const DEPLOYMENTS = parseDeployments();

/**
 * Returns all deployments, including the current one as the last entry.
 */
export function getAllDeployments(): DeploymentEntry[] {
  // Add current deployment as the active ones (no toLedger means still active)
  const current: DeploymentEntry[] = [
    { type: 'registry', contractId: env.REGISTRY_CONTRACT_ID, fromLedger: 0 },
    { type: 'voucher', contractId: env.VOUCHER_CONTRACT_ID, fromLedger: 0 },
    { type: 'receipt', contractId: env.RECEIPT_CONTRACT_ID, fromLedger: 0 },
  ];
  return [...DEPLOYMENTS, ...current];
}

/**
 * Map from contract ID to deployment index for quick lookup.
 */
const CONTRACT_TO_DEPLOYMENT_INDEX = new Map<string, number>();
getAllDeployments().forEach((d, i) => {
  CONTRACT_TO_DEPLOYMENT_INDEX.set(d.contractId, i);
});

/**
 * Returns the deployment index for a given contract ID, or undefined if not found.
 */
export function deploymentIndexForContract(contractId: string): number | undefined {
  return CONTRACT_TO_DEPLOYMENT_INDEX.get(contractId);
}

/**
 * Contract ids the indexer subscribes to, in one place.
 *
 * The faucet is only present on a testnet demo, so it joins the list when
 * `FAUCET_CONTRACT_ID` is set and is absent otherwise.
 */
export const INDEXED_CONTRACTS = [
  ...new Set([
    env.REGISTRY_CONTRACT_ID,
    env.VOUCHER_CONTRACT_ID,
    env.RECEIPT_CONTRACT_ID,
    ...(env.FAUCET_CONTRACT_ID ? [env.FAUCET_CONTRACT_ID] : []),
    ...DEPLOYMENTS.map((d) => d.contractId),
  ]),
] as readonly string[];

/**
 * The short name for each configured contract, used to group per-contract
 * history (governance, especially) for readers who think in roles rather
 * than contract ids.
 *
 * The faucet is deliberately absent: it has an admin but emits no admin
 * events, so listing it under `/governance` would only add an empty row.
 */
export const CONTRACTS = [
  { contract: 'registry', contractId: env.REGISTRY_CONTRACT_ID },
  { contract: 'voucher', contractId: env.VOUCHER_CONTRACT_ID },
  { contract: 'receipt', contractId: env.RECEIPT_CONTRACT_ID },
] as const;

/** Signing keys, newest first; every key signs every delivery. */
export const WEBHOOK_SECRETS: readonly string[] = parseWebhookSecrets(
  env.WEBHOOK_SECRETS,
  env.WEBHOOK_SECRET,
);

/**
 * Every delivery target, from `WEBHOOK_ENDPOINTS` or the flat
 * `WEBHOOK_URLS` list. Empty means webhooks are off.
 *
 * Parsed here rather than attached to `env`: the general environment object
 * is passed around and logged, and the per-endpoint secrets belong only to
 * the code that signs requests.
 */
export const WEBHOOK_ENDPOINTS: readonly WebhookEndpoint[] = (() => {
  const configured = parseWebhookEndpoints(env.WEBHOOK_ENDPOINTS, WEBHOOK_SECRETS);
  if (configured.length > 0) return configured;
  // WEBHOOK_ENDPOINTS is the richer form; the flat list stays the simple
  // case and is ignored (not merged, which would double-deliver) when the
  // JSON list is present. Both are documented in docs/environment.md.
  return parseWebhookUrls(env.WEBHOOK_URLS).map((url) => ({
    url,
    secrets: WEBHOOK_SECRETS.map((secret) => validSecret(secret, 'WEBHOOK_SECRETS')),
    events: null,
    provider: null,
  }));
})();

/** Just the URLs, for callers that only need to know where deliveries go. */
export const WEBHOOK_URLS: readonly string[] = WEBHOOK_ENDPOINTS.map((e) => e.url);

/** True when at least one endpoint is configured. */
export const WEBHOOKS_ENABLED = WEBHOOK_ENDPOINTS.length > 0;

/**
 * Whether destinations in loopback, private, link-local or unique-local
 * ranges are allowed. Local development opts in; production does not.
 */
export const WEBHOOK_ALLOW_PRIVATE: boolean = env.WEBHOOK_ALLOW_PRIVATE;

/**
 * Map from contract ID to its type (registry/voucher/receipt).
 * Includes both current and historical deployments.
 */
const CONTRACT_ID_TO_TYPE = new Map<string, string>([
  [env.REGISTRY_CONTRACT_ID, 'registry'],
  [env.VOUCHER_CONTRACT_ID, 'voucher'],
  [env.RECEIPT_CONTRACT_ID, 'receipt'],
  ...DEPLOYMENTS.map((d) => [d.contractId, d.type] as const),
]);

export function contractName(contractId: string): string {
  return CONTRACT_ID_TO_TYPE.get(contractId) ?? 'unknown';
}

/**
 * Returns all contract IDs for a given type across all deployments.
 */
export function contractIdsForType(type: 'registry' | 'voucher' | 'receipt'): string[] {
  const ids: string[] = [];
  // Add current deployment
  if (type === 'registry') ids.push(env.REGISTRY_CONTRACT_ID);
  else if (type === 'voucher') ids.push(env.VOUCHER_CONTRACT_ID);
  else if (type === 'receipt') ids.push(env.RECEIPT_CONTRACT_ID);
  // Add historical deployments
  ids.push(...DEPLOYMENTS.filter((d) => d.type === type).map((d) => d.contractId));
  return [...new Set(ids)];
}

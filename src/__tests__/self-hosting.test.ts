import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Self-hosting on one VPS (#300).
 *
 * The stack file, its env template and the guide are the deliverable, and all
 * three are configuration: nothing here is executable, so the way to test them
 * is to read them as text and assert the invariants that make the guide true.
 * Each one is a claim a reader can only check by ending up with an open
 * database or a blank contract id, which is why they belong in CI rather than
 * in a paragraph.
 *
 * Same approach as `env-docs.test.ts`: the schema is parsed as text because
 * importing `src/env.ts` validates `process.env` at module scope.
 */

const compose = readFileSync(new URL('../../docker-compose.prod.yml', import.meta.url), 'utf8');
const template = readFileSync(new URL('../../.env.prod.example', import.meta.url), 'utf8');
const gitignore = readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const guide = readFileSync(new URL('../../docs/self-hosting.md', import.meta.url), 'utf8');
const envSource = readFileSync(new URL('../env.ts', import.meta.url), 'utf8');

/** Names compose interpolates from the host environment, i.e. from `.env`. */
const COMPOSE_ONLY_VARS = ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'SITE_ADDRESS'];

function servicesRegion(yml: string): string {
  const marker = '\nservices:\n';
  const start = yml.indexOf(marker);
  if (start === -1) throw new Error('docker-compose.prod.yml has no services block');
  const body = yml.slice(start + marker.length);
  // Anything in a service is indented, so the next column-0 key ends the region.
  const end = body.search(/^[a-z][a-z0-9_-]*:/m);
  return end === -1 ? body : body.slice(0, end);
}

/** `text` without its comment lines, so a claim in prose cannot match. */
function uncommented(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** Every `  <name>:` block under `services:`, keyed by service name. */
function serviceBlocks(): Map<string, string> {
  const parts = servicesRegion(compose).split(/^ {2}(?=[a-z][a-z0-9_-]*:$)/m);
  const blocks = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const name = part.split('\n', 1)[0];
    if (name !== undefined) blocks.set(name.replace(/:$/, ''), part);
  }
  return blocks;
}

function serviceBlock(name: string): string {
  const block = serviceBlocks().get(name);
  if (block === undefined) throw new Error(`docker-compose.prod.yml has no ${name} service`);
  return block;
}

/** `KEY=value` lines the operator sees, comments included. */
function templateKeys(text: string): string[] {
  return [...text.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

function activeTemplateKeys(): string[] {
  return [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
}

type SchemaVar = { name: string; required: boolean };

function schemaVars(): SchemaVar[] {
  const start = envSource.indexOf('z.object({');
  const body = envSource.slice(start, envSource.indexOf('\n});', start));
  const keys: { name: string; at: number }[] = [];
  for (const match of body.matchAll(/^ {2}([A-Z][A-Z0-9_]*):/gm)) {
    if (match[1] !== undefined && match.index !== undefined)
      keys.push({ name: match[1], at: match.index });
  }
  return keys.map(({ name, at }, i) => {
    const next = keys[i + 1];
    const entry = body.slice(at, next ? next.at : body.length);
    return { name, required: !entry.includes('.default(') && !entry.includes('.optional()') };
  });
}

function interpolatedNames(): string[] {
  return [...new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]!))].sort();
}

/** A gitignore pattern that would swallow a committed template file. */
function ignoresFile(fileName: string): string | undefined {
  for (const line of gitignore.split('\n')) {
    const pattern = line.trim();
    if (pattern === '' || pattern.startsWith('#') || pattern.startsWith('!')) continue;
    if (pattern.includes('/')) continue;
    const asRegex = new RegExp(`^${pattern.replaceAll('.', '\\.').replaceAll('*', '.*')}$`);
    if (asRegex.test(fileName)) return pattern;
  }
  return undefined;
}

describe('docker-compose.prod.yml', () => {
  it('is its own stack and leaves the dev stack as it was (#300)', () => {
    expect(Object.keys(Object.fromEntries(serviceBlocks())).sort()).toEqual([
      'api',
      'caddy',
      'db',
      'migrate',
    ]);
    const dev = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');
    expect(dev).not.toMatch(/caddy/i);
    expect(compose).toMatch(/^name: sci-healthcare$/m);
  });

  it('publishes only the two web ports (#300)', () => {
    const publishing = [...serviceBlocks()].filter(([, block]) => /^ {4}ports:/m.test(block));
    expect(publishing.map(([name]) => name)).toEqual(['caddy']);
    expect(compose.match(/8080:\d|\d{2,5}:5432/g)).toBeNull();
    expect(serviceBlock('caddy')).toMatch(/"80:80"/);
    expect(serviceBlock('caddy')).toMatch(/"443:443"/);
  });

  it('applies reviewed migrations instead of pushing a schema over real rows (#300)', () => {
    expect(serviceBlock('migrate')).toMatch(/npx prisma migrate deploy/);
    expect(uncommented(compose)).not.toMatch(/db push/);
    expect(uncommented(compose)).not.toMatch(/accept-data-loss/);
  });

  it('never lets an unmigrated schema serve traffic (#300)', () => {
    expect(serviceBlock('migrate')).toMatch(/restart: "no"/);
    expect(serviceBlock('migrate')).toMatch(/condition: service_healthy/);
    expect(serviceBlock('api')).toMatch(/migrate:\n {8}condition: service_completed_successfully/);
    expect(serviceBlock('caddy')).toMatch(/api:\n {8}condition: service_healthy/);
  });

  it('assembles the database credential in exactly one place (#300)', () => {
    const anchor = compose.match(/^x-database-url: &database-url (.+)$/m)?.[1];
    expect(anchor).toBeDefined();
    expect(compose.match(/&database-url/g)).toHaveLength(1);
    expect(compose.match(/\*database-url/g)).toHaveLength(2);
    for (const name of ['api', 'migrate']) {
      expect(serviceBlock(name)).toContain('DATABASE_URL: *database-url');
    }
    for (const secret of ['POSTGRES_USER', 'POSTGRES_PASSWORD']) {
      expect(anchor).toContain(`\${${secret}:?`);
    }
  });

  it('refuses to guess a secret rather than defaulting one (#300)', () => {
    for (const name of ['POSTGRES_USER', 'POSTGRES_PASSWORD', 'SITE_ADDRESS']) {
      expect(compose).toContain(`\${${name}:?`);
      expect(compose).not.toContain(`\${${name}:-`);
    }
    // The database name is not a secret, so it may keep a default.
    expect(compose).toContain('${POSTGRES_DB:-sci_healthcare}');
  });

  it('names only variables the app actually reads (#300)', () => {
    const declared = new Set(schemaVars().map((v) => v.name));
    for (const name of ['api', 'migrate']) {
      for (const key of [...serviceBlock(name).matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)]) {
        expect(declared.has(key[1]!), `${name} sets ${key[1]}`).toBe(true);
      }
    }
  });

  it('pins the three settings a production process must not get wrong (#300)', () => {
    const api = serviceBlock('api');
    expect(api).toMatch(/NODE_ENV: production/);
    expect(api).toMatch(/PORT: "8080"/);
    expect(api).toMatch(/HOST: 0\.0\.0\.0/);
    // NODE_ENV is what turns off the wildcard-CORS allowance.
    expect(api).toMatch(/DATABASE_URL: \*database-url/);
  });

  it('keeps the proxy the only way in, and says why (#300)', () => {
    expect(serviceBlock('api')).toMatch(/trustProxy/);
    expect(serviceBlock('api')).toMatch(/X-Forwarded-For/);
    expect(serviceBlock('db')).toMatch(/no `ports:`/);
  });

  it('points the proxy at the app and the app at a file it cannot write (#300)', () => {
    const caddy = serviceBlock('caddy');
    expect(guideCaddyfile()).toMatch(/reverse_proxy api:8080/);
    expect(caddy).toMatch(/\.\/ops\/Caddyfile:\/etc\/caddy\/Caddyfile:ro/);
    expect(caddy).toMatch(/caddy-data:\/data/);
  });

  it('checks readiness rather than liveness in the healthcheck (#300)', () => {
    expect(serviceBlock('api')).toMatch(/\/ready/);
    expect(serviceBlock('api')).not.toMatch(/\/health"/);
    expect(serviceBlock('api')).toMatch(/start_period: \d+s/);
  });
});

function guideCaddyfile(): string {
  return readFileSync(new URL('../../ops/Caddyfile', import.meta.url), 'utf8');
}

describe('.env.prod.example', () => {
  it('defines every name compose interpolates (#300)', () => {
    const defined = activeTemplateKeys();
    for (const name of interpolatedNames()) {
      expect(defined, `${name} interpolated but not in the template`).toContain(name);
    }
    expect(interpolatedNames().length).toBeGreaterThan(0);
  });

  it('supplies every variable the app needs to boot (#300)', () => {
    const supplied = new Set([...activeTemplateKeys(), ...COMPOSE_ONLY_VARS]);
    for (const key of [...serviceBlock('api').matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)]) {
      supplied.add(key[1]!);
    }
    const missing = schemaVars()
      .filter((v) => v.required)
      .map((v) => v.name)
      .filter((name) => !supplied.has(name));
    expect(missing).toEqual([]);
    // One of the two RPC names has to be set or the app exits at boot.
    expect(supplied.has('SOROBAN_RPC_URL') || supplied.has('SOROBAN_RPC_URLS')).toBe(true);
  });

  it('does not document a variable the schema dropped (#300)', () => {
    const declared = new Set(schemaVars().map((v) => v.name));
    const composeOnly = new Set(COMPOSE_ONLY_VARS);
    for (const name of templateKeys(template)) {
      expect(declared.has(name) || composeOnly.has(name), name).toBe(true);
    }
  });

  it('keeps every secret and every operator-specific value blank (#300)', () => {
    const blanks = [
      'POSTGRES_PASSWORD',
      'SITE_ADDRESS',
      'CORS_ORIGIN',
      'REGISTRY_CONTRACT_ID',
      'VOUCHER_CONTRACT_ID',
      'RECEIPT_CONTRACT_ID',
      'USDC_CONTRACT_ID',
      'FAUCET_CONTRACT_ID',
      'WEBHOOK_SECRET',
    ];
    for (const name of blanks) {
      expect(template, `${name} should be an empty assignment`).toMatch(
        new RegExp(`^${name}=$`, 'm'),
      );
    }
    // And nothing that looks like a credential appears anywhere in the file.
    expect(template).not.toMatch(/postgres(ql)?:\/\/[^\s]*:[^\s]*@/);
    expect(template).not.toMatch(/ghp_|AKIA|BEGIN (RSA|EC) PRIVATE KEY/);
  });

  it('is committable while the file it seeds is not (#300)', () => {
    expect(ignoresFile('.env')).toBe('.env');
    expect(ignoresFile('.env.prod.example')).toBeUndefined();
    expect(ignoresFile('.env.example')).toBeUndefined();
  });

  it('carries the two decisions that are silently wrong by default (#300)', () => {
    // A blank contract id and INDEXER_START_LEDGER=0 both boot fine and both
    // lose data, so the template is where the warning has to live.
    expect(template).toMatch(/INDEXER_START_LEDGER=0/);
    expect(template).toMatch(/silently skips/i);
    expect(template).toMatch(/openssl rand -hex 24/);
    expect(template).toMatch(/openssl rand -hex 32/);
    expect(template).toMatch(/rejects `\*`|`CORS_ORIGIN=\*`/);
  });
});

describe('docs/self-hosting.md', () => {
  it('walks a fresh server to a green readiness check (#300)', () => {
    for (const heading of [
      'Point the DNS',
      'Install Docker',
      'Open the firewall',
      'write the env file',
      'Start it',
      'Backups',
      'Upgrades',
    ]) {
      expect(guide, heading).toContain(heading);
    }
    expect(guide).toMatch(/curl -i https:\/\/[^/\s]+\/ready/);
    expect(guide).toMatch(/`"status":"ready"`|"status":"ready"/);
  });

  it('is reachable from the README, so the link checker covers it (#300)', () => {
    expect(readme).toMatch(/\(docs\/self-hosting\.md\)/);
  });

  it('names only variables that exist (#300)', () => {
    const known = new Set(templateKeys(template));
    for (const block of serviceBlocks().values()) {
      for (const key of [...block.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)]) known.add(key[1]!);
    }
    const table = guide.slice(guide.indexOf('| Variable |'));
    const cited = [
      ...table.slice(0, table.indexOf('\n\n')).matchAll(/`([A-Z][A-Z0-9_]{3,})`/g),
    ].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(3);
    for (const name of cited) {
      expect(known.has(name), name).toBe(true);
    }
  });

  it('tests the backup by restoring it (#300)', () => {
    expect(guide).toMatch(/pg_dump .*--format=custom|--format=custom/);
    expect(guide).toMatch(/pg_restore/);
    expect(guide).toMatch(/--clean --if-exists/);
    // The credential lives in the container, so the host shell must not expand it.
    expect(guide).toMatch(/'pg_dump -U "\$POSTGRES_USER"/);
    expect(guide).toMatch(/'pg_restore -U "\$POSTGRES_USER"/);
  });

  it('migrates before cutting over and gives a rollback a target (#300)', () => {
    expect(guide).toMatch(/prisma migrate deploy/);
    expect(guide).toMatch(/git rev-parse HEAD/);
    expect(guide).toMatch(/up -d --build api/);
    expect(guide).toMatch(/--build` is what makes the rollback real/);
  });

  it('keeps its own section links pointed at real headings (#300)', () => {
    // GitHub builds a heading anchor by lowercasing, dropping punctuation and
    // turning spaces into hyphens. lychee checks the same thing over the
    // network; this catches a renamed section in the file that renamed it.
    const slug = (heading: string) =>
      heading
        .toLowerCase()
        .replaceAll(/[^\w\s-]/g, '')
        .trim()
        .replaceAll(/\s+/g, '-');
    const headings = new Set([...guide.matchAll(/^#{2,4} (.+)$/gm)].map((m) => slug(m[1]!)));
    const targets = [...guide.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]!);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(headings.has(target), `#${target}`).toBe(true);
    }
  });

  it('documents the volume name the backup depends on (#300)', () => {
    expect(guide).toMatch(/sci-healthcare_caddy-data/);
    expect(compose).toMatch(/^name: sci-healthcare$/m);
  });

  it('keeps the reasons it can only be checked in production (#300)', () => {
    expect(guide).toMatch(/trustProxy: true/);
    expect(guide).toMatch(/X-Forwarded-For/);
    expect(guide).toMatch(/rolling window/i);
  });

  it('says the Caddyfile adds no encode and no security headers, and why (#300)', () => {
    const caddyfile = guideCaddyfile();
    expect(caddyfile).not.toMatch(/^\s*encode\b/m);
    expect(caddyfile).not.toMatch(/^\s*strict-transport-security|^\s*header /m);
    expect(caddyfile).toMatch(/reverse_proxy api:8080/);
    expect(caddyfile).toMatch(/@fastify\/compress|compress/i);
  });
});

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * `docs/mainnet-checklist.md` promises that every item is verifiable, so the
 * promise is checked rather than agreed with: each row names something real
 * in this repository, and every name still exists.
 *
 * The failure mode this guards is the one a checklist always has — the code
 * moves and the document does not. A renamed environment variable, a deleted
 * npm script, a route that no longer answers, a metric nobody exports, or a
 * runbook section people were pointed at and then renamed all fail here, in
 * the suite that already tests the other operator-facing documents
 * (`alerts.test.ts`, `data-dictionary.test.ts`, `adr-docs.test.ts`).
 *
 * Sources are read as text, not imported, because importing `src/env.ts`
 * validates `process.env` at module scope.
 */

const checklist = readFileSync(new URL('../../docs/mainnet-checklist.md', import.meta.url), 'utf8');
const envSource = readFileSync(new URL('../env.ts', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const scripts = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

/** A doc-relative path: the checklist lives in `docs/`, this test in `src/__tests__/`. */
function docUrl(path: string): URL {
  return new URL(`../../docs/${path}`, import.meta.url);
}

function repoFile(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function srcFile(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}

const voucherSources = [
  'detail',
  'events',
  'export',
  'index',
  'list',
  'query',
  'schema',
  'serialiser',
]
  .map((name) => srcFile(`routes/vouchers/${name}.ts`))
  .join('\n');

const routesSource = [
  'health',
  'providers',
  'services',
  'receipts',
  'feed',
  'governance',
  'attesters',
  'stream',
]
  .map((name) => srcFile(`routes/${name}.ts`))
  .concat(voucherSources, srcFile('app.ts'))
  .join('\n');

/** Where a variable is read: the schema, or the modules that bypass it. */
const envReadSites = [
  envSource,
  schema,
  srcFile('lib/retention.ts'),
  srcFile('db.ts'),
  srcFile('api.ts'),
];

/** Words the checklist backticks that are SQL or prose, not configuration. */
const NOT_ENV_VARIABLES = new Set(['EXPLAIN', 'PRAGMA', 'SELECT', 'RETRY', 'CACHE']);

/** A section body: everything under its `## N. Title` heading. */
function sectionBodies(): { number: string; title: string; body: string }[] {
  const headings = [...checklist.matchAll(/^## (\d+)\. (.+)$/gm)];
  return headings.map((match, i) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = headings[i + 1]?.index ?? checklist.length;
    return { number: match[1] ?? '', title: match[2] ?? '', body: checklist.slice(start, end) };
  });
}

/** `[id, item, verifyBy]` for the three-column rows in `text`. */
function rowsIn(text: string): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\| (\d+\.\d+) \| (.+) \| (.+) \|$/);
    if (match?.[1] && match[2] && match[3]) out.push([match[1], match[2], match[3]]);
  }
  return out;
}

const allRows = rowsIn(checklist);

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');
}

/** GitHub's anchor for a heading: lowercase, punctuation dropped, every space hyphenated. */
function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/ /g, '-');
}

describe('mainnet-checklist.md structure', () => {
  it('has the five areas the issue named, plus configuration and the final gate', () => {
    const found = sectionBodies();
    expect(found.map((s) => s.number)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    for (const name of [
      'Configuration',
      'Database and migrations',
      'Backups and restore',
      'Capacity',
      'Monitoring and alerting',
      'Rollback',
    ]) {
      expect(
        found.some((s) => s.title.includes(name)),
        `section ${name}`,
      ).toBe(true);
    }
  });

  it('gives every row a unique id, so a release can cite which items passed', () => {
    expect(allRows.length).toBeGreaterThanOrEqual(30);
    const ids = allRows.map(([id]) => id);
    expect(new Set(ids).size, 'a row id repeats').toBe(ids.length);
  });

  it('numbers each row under the section it sits in', () => {
    for (const section of sectionBodies()) {
      for (const [id] of rowsIn(section.body)) {
        expect(
          id.startsWith(`${section.number}.`),
          `row ${id} sits in section ${section.number}`,
        ).toBe(true);
      }
    }
  });
});

describe('every item is verifiable', () => {
  it('pairs each item with a command, a setting, a link, or a named human decision', () => {
    for (const [id, , verifyBy] of allRows) {
      const verifiable =
        verifyBy.includes('`') ||
        verifyBy.includes('](') ||
        verifyBy.includes('named human decision');
      expect(verifiable, `row ${id} offers no check: "${verifyBy}"`).toBe(true);
    }
  });

  it('writes a check long enough to be one', () => {
    for (const [id, , verifyBy] of allRows) {
      expect(verifyBy.length, `row ${id} is too short to be a check`).toBeGreaterThanOrEqual(40);
    }
  });

  it('defers to a human only where nothing in this repository can be read', () => {
    for (const [id] of allRows.filter(([, , verifyBy]) =>
      verifyBy.includes('named human decision'),
    )) {
      // Plans, standbys and sign-off (§2, §3, §6) are the only rows that can
      // legitimately end at "someone decided". Anything else hides a check.
      expect(['2', '3', '6'], `row ${id} hides a checkable item behind a human`).toContain(
        id.split('.')[0],
      );
    }
  });
});

describe('names used in the checklist still exist', () => {
  const tokens = backticked(checklist);

  it('names only environment variables this service reads', () => {
    const vars = tokens.filter((t) => /^[A-Z][A-Z0-9_]{3,}$/.test(t) && !NOT_ENV_VARIABLES.has(t));
    expect(vars.length).toBeGreaterThanOrEqual(12);
    for (const name of vars) {
      // A word boundary, not `includes`: `WEBHOOK_MAX_AGE_MS` is a substring
      // of `READY_WEBHOOK_MAX_AGE_MS`, and a name that merely looks like one
      // is exactly how a checklist outlives the code it describes.
      const pattern = new RegExp(`\\b${name}\\b`);
      const read = envReadSites.some((source) => pattern.test(source));
      expect(read, `docs/mainnet-checklist.md names ${name}, which nothing reads`).toBe(true);
    }
  });

  it('names only npm scripts that exist', () => {
    const named = new Set([...checklist.matchAll(/npm run ([a-z0-9:-]+)/g)].map((m) => m[1] ?? ''));
    expect(named.size).toBeGreaterThanOrEqual(5);
    for (const script of named) {
      expect(scripts[script], `package.json has no "npm run ${script}"`).toBeTruthy();
    }
  });

  it('points only at paths that are on disk', () => {
    const paths = tokens.filter(
      (t) => /^(src|prisma|ops|docs|\.github)\//.test(t) || t === 'render.yaml',
    );
    expect(paths.length).toBeGreaterThanOrEqual(8);
    for (const path of paths) {
      expect(
        existsSync(new URL(`../../${path}`, import.meta.url)),
        `docs/mainnet-checklist.md points at ${path}, which does not exist`,
      ).toBe(true);
    }
  });

  it('cites only routes the app registers', () => {
    const routes = new Set<string>();
    for (const token of tokens) {
      const bare = token.startsWith('/') ? (token.split('?')[0] ?? '') : undefined;
      const curl = token.match(/\$API(\/[^\s"'?|]+)/)?.[1];
      const cited = token.match(/\bGET (\/[a-z0-9/_-]+)/)?.[1];
      for (const route of [bare, curl, cited]) if (route) routes.add(route);
    }
    expect(routes.size).toBeGreaterThanOrEqual(6);
    for (const route of routes) {
      // The /v1 prefix and the unprefixed alias are the same handler.
      const path = route.startsWith('/v1/') ? route.slice(3) : route;
      expect(
        routesSource.includes(`'${path}'`),
        `docs/mainnet-checklist.md cites ${route}, which no handler registers`,
      ).toBe(true);
    }
  });

  it('quotes the caps, limits and defaults the code sets', () => {
    const cursor = srcFile('lib/cursor.ts');
    const limits = srcFile('lib/rate-limits.ts');
    const retention = srcFile('lib/retention.ts');

    const listCap = cursor.match(/limitParam[\s\S]{0,120}?\.max\((\d+)\)/)?.[1];
    expect(listCap).toBeDefined();
    expect(checklist, 'the list limit cap').toContain(listCap ?? '');

    const defaultRate = limits.match(/DEFAULT_RATE_LIMIT = \{ max: (\d+)/)?.[1];
    expect(checklist, 'the default rate limit').toContain(`${defaultRate} requests/min`);
    const listRate = limits.match(/LIST_ROUTE_RATE_LIMIT = \{ max: (\d+)/)?.[1];
    expect(checklist, 'the list route rate limit').toContain(`${listRate}/min`);

    expect(retention).toMatch(/RETENTION_DAYS[\s\S]{0,80}30/);
    expect(checklist, 'the retention default').toContain('Default 30');

    const sse = envSource.match(/SSE_MAX_CONNECTIONS[\s\S]{0,90}?default\((\d+)\)/)?.[1];
    expect(checklist, 'the SSE connection cap').toContain(`default ${sse}`);

    const lag = envSource.match(/READY_MAX_LAG_LEDGERS[\s\S]{0,90}?default\((\d+)\)/)?.[1];
    expect(checklist, 'the readiness lag threshold').toContain(`${lag} ledgers`);

    const webhookAge = envSource.match(
      /READY_WEBHOOK_MAX_AGE_MS[\s\S]{0,90}?default\((\d+_\d+)\)/,
    )?.[1];
    expect(webhookAge, 'the webhook freshness default is not expressed in minutes').toBe('900_000');
    expect(checklist, 'the webhook freshness window').toContain('15 minutes');

    const secretLength = envSource.match(/MIN_WEBHOOK_SECRET_LENGTH = (\d+)/)?.[1];
    expect(checklist, 'the webhook secret floor').toContain(`${secretLength} characters`);
  });

  it('describes the caching and database-failure contracts as implemented', () => {
    const cache = srcFile('lib/cache.ts');
    const cacheControl = cache.match(/CACHE_CONTROL = '([^']+)'/)?.[1];
    expect(cacheControl).toBeDefined();
    expect(checklist, 'the Cache-Control value').toContain(cacheControl ?? '');

    const noStore = new Set(
      [
        ...(cache.match(/const NO_STORE_ROUTES[\s\S]*?\]\);/)?.[0] ?? '').matchAll(/'(\/[^']+)'/g),
      ].map((m) => m[1] ?? ''),
    );
    for (const route of ['/health', '/ready', '/metrics', '/stream']) {
      expect(
        noStore,
        `${route} would be cached, which keeps a broken instance in rotation`,
      ).toContain(route);
    }

    const errors = srcFile('lib/errors.ts');
    expect(checklist).toContain('database_unavailable');
    expect(errors).toContain('database_unavailable');
    expect(errors).toMatch(/'retry-after'/);
  });

  it('tells you to watch only metrics the service exports', () => {
    const exported = new Set(
      [...srcFile('lib/metrics.ts').matchAll(/name: '([a-z_]+)'/g)].map((m) => m[1] ?? ''),
    );
    const cited = tokens.filter((t) => /^[a-z][a-z0-9]*(_[a-z0-9]+){2,}$/.test(t));
    expect(cited.length).toBeGreaterThanOrEqual(2);
    for (const metric of cited) {
      expect(
        exported,
        `docs/mainnet-checklist.md says watch ${metric}, which /metrics does not serve`,
      ).toContain(metric);
    }
  });

  it('names only alerts ops/alerts.yml defines, and counts them right', () => {
    const defined = [...repoFile('ops/alerts.yml').matchAll(/- alert: (\w+)/g)].map(
      (m) => m[1] ?? '',
    );
    expect(defined.length).toBe(6);
    expect(checklist).toContain('six rules');
    for (const name of checklist.match(/\bSci\w+\b/g) ?? []) {
      expect(defined, `${name} is not an alert this repository ships`).toContain(name);
    }
  });

  it('names only migration directories that were actually committed', () => {
    const paths = tokens.filter((t) => /^prisma\/migrations\/\d{14}_/.test(t));
    expect(paths.length).toBeGreaterThanOrEqual(2);
    for (const path of paths) {
      expect(
        existsSync(new URL(`../../${path}`, import.meta.url)),
        `no such migration: ${path}`,
      ).toBe(true);
    }
  });
});

describe('links in the checklist resolve', () => {
  const links = [...checklist.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? '');

  it('links only files inside the repository', () => {
    expect(
      links.some((l) => l.startsWith('http')),
      'an absolute URL would go stale silently',
    ).toBe(false);
    const relative = links.filter((l) => !l.startsWith('#'));
    expect(relative.length).toBeGreaterThanOrEqual(6);
    for (const link of relative) {
      const path = link.split('#')[0] ?? '';
      if (!path) continue;
      expect(existsSync(docUrl(path)), `${link} does not resolve from docs/`).toBe(true);
    }
  });

  it('anchors onto headings that exist', () => {
    for (const link of links.filter((l) => l.includes('#') && !l.startsWith('#'))) {
      const [path, anchor] = link.split('#');
      if (!path || !anchor) continue;
      const headings = [...readFileSync(docUrl(path), 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map(
        (m) => slug(m[1] ?? ''),
      );
      expect(headings, `${link} has no heading to land on`).toContain(anchor);
    }
  });
});

describe('the checklist is reachable and honest about its limits', () => {
  it('is linked from the README Deploying section', () => {
    const start = readme.indexOf('## Deploying');
    expect(start).toBeGreaterThan(-1);
    const section = readme.slice(start, readme.indexOf('\n## ', start));
    expect(section).toContain('docs/mainnet-checklist.md');
  });

  it('names the documents it complements rather than replaces', () => {
    for (const name of [
      'RUNBOOK.md',
      'architecture.md',
      'logging.md',
      'privacy.md',
      'api-policy.md',
    ]) {
      expect(checklist, `no pointer to ${name}`).toContain(name);
    }
  });

  it('says the checklist cannot sign itself off, and to dry-run it on testnet first', () => {
    expect(checklist).toMatch(/cannot grant itself sign-off/);
    expect(checklist).toMatch(/Dry-run the checklist against the testnet deployment/);
  });
});

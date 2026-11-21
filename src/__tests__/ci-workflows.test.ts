import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The repository's security and monitoring workflows are configuration, so
 * their acceptance criteria are asserted structurally against the file text:
 * that the triggers, permissions and actions each file was written with are
 * still there. Nothing here executes GitHub Actions.
 */
function workflow(name: string): string {
  return readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
}

describe('codeql.yml', () => {
  const yml = workflow('codeql.yml');

  it('runs on pull requests into main and on a weekly schedule', () => {
    expect(yml).toMatch(/^on:/m);
    expect(yml).toMatch(/^ {2}pull_request:/m);
    expect(yml).toMatch(/^ {2}schedule:/m);
    expect(yml).toMatch(/cron: '\d+ \d+ \* \* \d+'/);
  });

  it('analyses JavaScript and TypeScript', () => {
    expect(yml).toMatch(/languages: javascript-typescript/);
  });

  it('requests the permissions the results upload needs', () => {
    expect(yml).toMatch(/security-events: write/);
    expect(yml).toMatch(/contents: read/);
  });

  it('uses the CodeQL init and analyze actions', () => {
    expect(yml).toMatch(/github\/codeql-action\/init@v\d+/);
    expect(yml).toMatch(/github\/codeql-action\/analyze@v\d+/);
  });
});

describe('dependency-review.yml', () => {
  const yml = workflow('dependency-review.yml');

  it('runs on pull requests into main (#127)', () => {
    expect(yml).toMatch(/^on:/m);
    expect(yml).toMatch(/^ {2}pull_request:/m);
    expect(yml).toMatch(/^ {4}branches: \[main\]$/m);
  });

  it('uses the dependency review action and fails on high severity (#127)', () => {
    expect(yml).toMatch(/actions\/dependency-review-action@v\d+/);
    expect(yml).toMatch(/fail-on-severity: high/);
  });

  it('asks for no write permission it does not need', () => {
    expect(yml).toMatch(/contents: read/);
    expect(yml).not.toMatch(/write/);
  });

  it('reviews only when the repository dependency graph can serve a review (#127)', () => {
    // The action cannot run without the dependency graph, which no commit
    // can enable. The job checks that first and warns instead of failing
    // every pull request on a repository where a maintainer has not turned
    // it on yet.
    expect(yml).toMatch(/dependency-graph\/sbom/);
    expect(yml).toMatch(/if: steps\.support\.outputs\.enabled == 'true'/);
    expect(yml).toMatch(/::warning/);
  });
});

describe('ci.yml', () => {
  const yml = workflow('ci.yml');

  it('validates the alerting rules with promtool (#131)', () => {
    expect(yml).toMatch(/^ {2}alerts:/m);
    expect(yml).toMatch(/promtool/);
    // The file is mounted into the Prometheus image at /ops.
    expect(yml).toMatch(/check rules \/ops\/alerts\.yml/);
  });

  /**
   * The `test` job's own text, so an assertion cannot be satisfied by the
   * Node 24 job below it or by a comment elsewhere in the file.
   */
  function testJob(): string {
    const start = yml.indexOf('\n  test:\n');
    expect(start).toBeGreaterThan(-1);
    const rest = yml.slice(start + 1);
    const next = rest.slice(1).search(/^ {2}[a-z0-9-]+:$/m);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  it('runs the suite in UTC, Africa/Lagos and Pacific/Kiritimati (#306)', () => {
    const job = testJob();
    expect(job).toMatch(/^ {6}TZ: \$\{\{ matrix\.tz \}\}$/m);

    // UTC+1 is where this backend is deployed; UTC+14 is the furthest ahead
    // of UTC, so an instant late on one UTC day is already the next day
    // there. A local-date implementation cannot survive both.
    for (const tz of ['UTC', 'Africa/Lagos', 'Pacific/Kiritimati']) {
      expect(job).toMatch(new RegExp(`^ {12}tz: ${tz.replace('/', '\\/')}$`, 'm'));
    }
  });

  it('names each test entry so the zone runs cannot overwrite one another', () => {
    // GitHub reports checks by name: two matrix entries sharing one name
    // look like one job in the pull request UI, and the second silently
    // replaces the first. Engine alone is no longer enough now that zones
    // differ.
    const job = testJob();
    expect(job).toMatch(/^ {4}name: test \(\$\{\{ matrix\.engine \}\}, \$\{\{ matrix\.tz \}\}\)$/m);

    const entries = [...job.matchAll(/^ {10}- engine: (\S+)$/gm)].map((m) => m[1]);
    const zones = [...job.matchAll(/^ {12}tz: (\S+)$/gm)].map((m) => m[1]);
    expect(entries.length).toBeGreaterThan(1);
    expect(entries).toHaveLength(zones.length);
    const pairs = entries.map((engine, i) => `${engine}/${zones[i]}`);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(pairs).toContain('postgres/UTC');
  });
});

describe('monitor.yml', () => {
  const yml = workflow('monitor.yml');

  it('probes the readiness endpoint on a schedule', () => {
    expect(yml).toMatch(/^on:/m);
    expect(yml).toMatch(/^ {2}schedule:/m);
    expect(yml).toMatch(/\/ready/);
  });

  it('gives Render cold starts room to wake before failing', () => {
    expect(yml).toMatch(/--max-time \d{2,}/);
  });
});

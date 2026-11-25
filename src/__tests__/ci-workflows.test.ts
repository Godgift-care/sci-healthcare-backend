import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The repository's security, monitoring and publishing workflows are
 * configuration, so their acceptance criteria are asserted structurally
 * against the file text: that the triggers, permissions and actions each file
 * was written with are still there. Nothing here executes GitHub Actions.
 */
function workflow(name: string): string {
  return readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
}

function file(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

/**
 * One `steps:` entry of a job, by its exact `name:`, so an assertion can be
 * made about a single step rather than about the file as a whole. That
 * distinction is the point of some checks below: in `links.yml` (#301) one
 * step's failure is the pull request's failure and another's deliberately is
 * not, and reading the file as one string cannot tell those apart.
 *
 * A step runs from its own `- ` marker to the next one, which is what the
 * split gives us; every block scalar in these workflows is indented past the
 * six spaces a step marker sits at, so no `run:` body can look like one.
 */
function step(yml: string, name: string): string {
  const found = yml
    .split(/^ {6}- /m)
    .slice(1)
    .find((part) => part.startsWith(`name: ${name}\n`));
  if (!found) throw new Error(`no step named ${JSON.stringify(name)}`);
  return found;
}

const workflowFiles = readdirSync(new URL('../../.github/workflows', import.meta.url))
  .filter((name) => name.endsWith('.yml'))
  .sort();

describe('every workflow file', () => {
  it('spells `permissions` as a block mapping, never inline', () => {
    // `permissions: contents: read` on one line is not valid workflow YAML:
    // GitHub rejects the whole file, and the run then fails in seconds with
    // zero jobs and no pointer to the culprit. Every assertion above matches
    // text, so it stays green on exactly that mistake.
    for (const name of workflowFiles) {
      for (const line of workflow(name).split('\n')) {
        expect(/^\s*permissions: +\S+: \S/.test(line), `${name}: ${line.trim()}`).toBe(false);
      }
    }
  });
});

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

describe('lockfile.yml', () => {
  const yml = workflow('lockfile.yml');

  it('runs only when the lockfile itself moves (#313)', () => {
    expect(yml).toMatch(/^ {2}pull_request:/m);
    expect(yml).toMatch(/^ {2}push:/m);
    // Both triggers are path-filtered; a job that ran on every pull request
    // would duplicate the `npm ci` every other job already does.
    expect(yml.match(/- package-lock\.json/g)).toHaveLength(2);
  });

  it('checks the install against the npm Node 22 bundles, cheaply (#313)', () => {
    expect(yml).toMatch(/node-version: '22'/);
    // `--dry-run` so it answers without writing a tree, `--ignore-scripts` so
    // a package under review gets no lifecycle script to run with.
    expect(yml).toMatch(/npm ci --ignore-scripts --dry-run/);
    expect(yml).toMatch(/cache: npm/);
  });

  it('rejects a lockfile newer npm wrote, without quoting its contents into the shell (#313)', () => {
    // The version is read, reduced to digits, and only then compared: the
    // file is contributor content on a pull request, and this is a shell line.
    expect(yml).toMatch(/lockfileVersion/);
    expect(yml).toMatch(/match\(\/\^\[0-9\]\+\$\//);
    expect(yml).toMatch(/"invalid"/);
    expect(yml).toMatch(/-gt 3/);
    expect(yml).toMatch(/::error/);
    expect(yml).toMatch(/exit 1/);
  });

  it('prints the regeneration fix when it fails, and asks for no write permission (#313)', () => {
    expect(yml).toMatch(/^ {8}if: failure\(\)$/m);
    expect(yml).toMatch(/git checkout package-lock\.json/);
    expect(yml).toMatch(/nvm use 22/);
    expect(yml).toMatch(/^permissions:$/m);
    expect(yml).toMatch(/contents: read/);
    expect(yml).not.toMatch(/: write/);
  });

  it('is fixed the way CONTRIBUTING.md says (#313)', () => {
    const contributing = readFileSync(new URL('../../CONTRIBUTING.md', import.meta.url), 'utf8');
    expect(contributing).toMatch(/### Lockfile changes/);
    expect(contributing).toMatch(/nvm use 22/);
    expect(contributing).toMatch(/git checkout package-lock\.json/);
    expect(contributing).toMatch(/npm --version/);
  });
});

describe('ci.yml', () => {
  const yml = workflow('ci.yml');
  const migrationScript = readFileSync(
    new URL('../../scripts/check-populated-migrations.sh', import.meta.url),
    'utf8',
  );

  it('validates the alerting rules with promtool (#131)', () => {
    expect(yml).toMatch(/^ {2}alerts:/m);
    expect(yml).toMatch(/promtool/);
    // The file is mounted into the Prometheus image at /ops.
    expect(yml).toMatch(/check rules \/ops\/alerts\.yml/);
  });

  it('tests the latest migration against existing rows before checking schema drift (#277)', () => {
    expect(yml).toMatch(/scripts\/check-populated-migrations\.sh/);
    expect(yml).not.toMatch(/npx prisma migrate deploy/);
    expect(migrationScript).toContain('migration-fixture.sql');
    expect(migrationScript).toContain('prisma migrate diff');
    expect(migrationScript).toContain('Voucher amount fixture was not preserved');
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

describe('nightly-snapshot.yml (#207)', () => {
  const yml = workflow('nightly-snapshot.yml');

  it('exports on a schedule and can be dispatched manually', () => {
    expect(yml).toMatch(/^ {2}schedule:/m);
    expect(yml).toMatch(/cron: '\d+ \d+ \* \* \*'/);
    expect(yml).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it('skips cleanly with a notice when DATABASE_URL is absent', () => {
    expect(yml).toMatch(/DATABASE_URL: \$\{\{ secrets\.DATABASE_URL \}\}/);
    expect(yml).toMatch(/configured=false/);
    expect(yml).toMatch(/::notice::.*DATABASE_URL secret is not configured/);
    expect(yml).toMatch(/if: steps\.database\.outputs\.configured == 'true'/);
  });

  it('exports a Postgres snapshot and retains the artifact for 30 days', () => {
    expect(yml).toMatch(/\.\/scripts\/use-postgres\.sh/);
    expect(yml).toMatch(/npm run snapshot:export/);
    expect(yml).toMatch(/actions\/upload-artifact@v\d+/);
    expect(yml).toMatch(/retention-days: 30/);
  });
});

describe('links.yml', () => {
  const yml = workflow('links.yml');

  it('runs on pull requests that touch Markdown and weekly on main (#301)', () => {
    expect(yml).toMatch(/^on:/m);
    expect(yml).toMatch(/^ {2}pull_request:/m);
    expect(yml).toMatch(/^ {4}branches: \[main\]$/m);
    // The trigger is Markdown; the checker and its config count too, because
    // a change to either changes what the next pull request is held to.
    expect(yml).toMatch(/^ {6}- '\*\*\/\*\.md'$/m);
    expect(yml).toMatch(/^ {2}schedule:/m);
    expect(yml).toMatch(/cron: '\d+ \d+ \* \* 1'/);
    expect(yml).toMatch(/^ {2}workflow_dispatch:/m);
  });

  it('asks for no write permission it does not need (#301)', () => {
    expect(yml).toMatch(/^permissions:$/m);
    expect(yml).toMatch(/^ {2}contents: read$/m);
    expect(yml).not.toMatch(/: write$/m);
    // The checkout is read-only too: nothing here pushes or comments.
    expect(yml).toMatch(/persist-credentials: false/);
  });

  it('opens every block-level key as a block rather than inline (#301)', () => {
    // `permissions: contents: read` parses as the *string* "contents: read",
    // so the runner rejects the workflow and shows zero jobs while every
    // assertion above still passes. A key that owns a mapping has to end its
    // line, which is the one shape mistake a string-only test cannot see.
    for (const key of ['permissions', 'concurrency', 'jobs', 'env', 'steps', 'with']) {
      expect(yml, `${key}: must open a block`).toMatch(new RegExp(`^ {0,8}${key}:$`, 'm'));
    }
    expect(step(yml, 'Install lychee (pinned version, checksum verified)')).toMatch(
      /^ {8}run: \|$/m,
    );
  });

  it('installs lychee from an exact release with a verified checksum (#301)', () => {
    // Same rule the osv-scanner step in security.yml follows: a floating
    // download URL is one upstream rename away from a red run nobody asked
    // for, and an unpinned binary is a supply-chain hole.
    expect(yml).toMatch(/releases\/download\/lychee-v\d+\.\d+\.\d+\/\$asset/);
    expect(yml).toMatch(/[0-9a-f]{64} {2}\$RUNNER_TEMP\/\$asset"/);
    expect(yml).toMatch(/sha256sum -c -/);
    expect(yml).not.toMatch(/releases\/latest/);
  });

  it('fails the pull request on a broken link inside the repository (#301)', () => {
    const check = step(yml, 'Check internal links (fatal)');
    // `--scheme file` is what makes this half about files and sections in
    // this repository: everything out on the internet is the other step's
    // problem, and must not be able to redden this one.
    expect(check).toContain('--scheme file');
    expect(check).toContain('--config lychee.toml');
    // Without `set -e` the step reports lychee's exit code, and without
    // `pipefail` it would report the last command's.
    expect(check).toContain('set -euo pipefail');
    expect(check).not.toMatch(/continue-on-error/);
  });

  it('retries and reports external links instead of failing on them (#301)', () => {
    const check = step(yml, 'Check external links (retried and reported, not fatal)');
    expect(check).toContain('continue-on-error: true');
    expect(check).toContain('--scheme http');
    expect(check).toContain('--scheme https');
    // The report is the deliverable here, so it has to reach a human: the run
    // summary on the run page, and a warning annotation for the checklist.
    expect(check).toContain('--format markdown');
    expect(check).toContain('"$GITHUB_STEP_SUMMARY"');
    expect(check).toMatch(/::warning::/);
    // ...while the step itself still ends on lychee's exit code, so a run
    // that found something reads as ⚠ rather than as a clean pass.
    expect(check).toMatch(/exit "\$status"/);
  });

  it('draws the fatal/non-fatal line at exactly one step (#301)', () => {
    // A second `continue-on-error` would most likely mean someone softened
    // the internal check, which is the one thing this workflow exists for.
    expect(yml.match(/continue-on-error/g) ?? []).toHaveLength(1);
  });

  it('checks tracked Markdown only (#301)', () => {
    // An untracked scratch note or an ignored build artefact must never be
    // what breaks the run.
    expect(step(yml, 'Collect the Markdown files')).toContain(`git ls-files '*.md'`);
    expect(yml).toContain('--files-from "$RUNNER_TEMP/markdown.txt"');
  });
});

describe('lychee.toml', () => {
  const toml = readFileSync(new URL('../../lychee.toml', import.meta.url), 'utf8');

  it('retries external flakiness rather than calling it broken (#301)', () => {
    expect(toml).toMatch(/^max_retries = [1-9]\d*$/m);
    expect(toml).toMatch(/^retry_wait_time = [1-9]\d*$/m);
    expect(toml).toMatch(/^timeout = [1-9]\d*$/m);
    // A rate limit is an answer, not a dead link, and counting one as an
    // error only trains everyone to ignore the weekly report.
    expect(toml).toMatch(/^accept = \[.*"429".*\]$/m);
  });

  it('checks section anchors, so a renamed heading fails like a renamed file (#301)', () => {
    expect(toml).toMatch(/^include_fragments = "anchor-only"$/m);
  });

  it('keeps the scheme filter out of the config (#301)', () => {
    // Both steps read this one file, and the only thing that tells them apart
    // is which schemes they check. A scheme here would apply to both.
    expect(toml).not.toMatch(/^scheme/m);
  });
});

describe('pages.yml (#297)', () => {
  const yml = workflow('pages.yml');

  it('publishes on pushes to main and when dispatched by hand', () => {
    expect(yml).toMatch(/^on:/m);
    expect(yml).toMatch(/^ {2}push:/m);
    expect(yml).toMatch(/^ {4}branches: \[main\]$/m);
    expect(yml).toMatch(/^ {2}workflow_dispatch:$/m);
  });

  it('starts every job with no token at all', () => {
    // The least-privilege claim is only real if the workflow-level default is
    // empty: a job that forgets its own block then gets nothing, not `write`.
    expect(yml).toMatch(/^permissions: \{\}$/m);
  });

  it('requests only the three permissions a Pages deployment needs', () => {
    expect(yml).toMatch(/^ {6}contents: read$/m);
    expect(yml).toMatch(/^ {6}pages: write$/m);
    expect(yml).toMatch(/^ {6}id-token: write$/m);

    // Anything here would be a permission the job does not use: a second
    // write scope beyond Pages, or one held for longer than the job.
    expect(yml).not.toMatch(/write-all/);
    expect(yml).not.toMatch(/^ {6}(actions|checks|deployments|security-events|pull-requests): /m);
    expect(yml).toMatch(/actions\/checkout@v\d+/);
  });

  it('deploys the artifact with the Pages actions', () => {
    expect(yml).toMatch(/actions\/upload-pages-artifact@v\d+/);
    expect(yml).toMatch(/actions\/deploy-pages@v\d+/);
    expect(yml).toMatch(/path: _site/);
  });

  it('publishes the committed spec instead of regenerating one', () => {
    // The one `run:` step assembles the artifact. A second one can only mean
    // the job started installing and building, which would render whatever
    // the branch produced rather than the contract that was reviewed.
    expect(yml.match(/^\s*-?\s*run:/gm) ?? []).toHaveLength(1);
    expect(yml).toMatch(/cp openapi\.json _site\/openapi\.json/);
    expect(yml).not.toMatch(/actions\/setup-node/);
    expect(yml).not.toMatch(/openapi:update/);
    expect(yml).not.toMatch(/client:generate/);
  });

  it('says what breaks if the file is wrong', () => {
    // A Pages workflow that never runs is silent: CI stays green because no
    // job here depends on it. The job name and the environment are what the
    // repository's Pages settings and the deployment URL are read from.
    expect(yml).toMatch(/name: github-pages/);
    expect(yml).toMatch(/steps\.deployment\.outputs\.page_url/);
    expect(yml).toMatch(/- id: deployment/);
  });
});

describe('api-reference/index.html (#297)', () => {
  const html = file('api-reference/index.html');
  const scanConfig = JSON.parse(file('.github/security-scan.json')) as { allowedHosts: string[] };
  const spec: unknown = JSON.parse(file('openapi.json'));

  it('renders the committed spec from the artifact, not from the API', () => {
    expect(html).toMatch(/var SPEC = '\.\/openapi\.json';/);
    // The server's own spec is exactly what this page must not depend on.
    expect(html).not.toMatch(/onrender\.com\/(v\d\/)?openapi\.json/);
  });

  it('works under any URL prefix', () => {
    // Absolute paths would 404 on a fork or project site, which is how the
    // "deploy from a fork" check is meant to be run.
    expect(html).not.toMatch(/(?:src|href)="\/(?!\/)/);
  });

  it('loads no resource from a host the repository does not control', () => {
    // The pull request security gate reports an off-allow-list host as
    // `new-network-host`, and a review finding has to be cleared by a
    // maintainer — the right call for a page documenting a health-sector API,
    // because a well-known CDN can still serve bytes nobody read. An earlier
    // version of this file loaded Redoc from one, pinned to a version with a
    // published-subresource-integrity hash, and tripped it anyway.
    const hosts = [...html.matchAll(/\bhttps?:\/\/([a-zA-Z0-9.-]+)/g)]
      .map((match) => match[1] ?? '')
      .filter(Boolean);
    for (const host of hosts) {
      const lower = host.toLowerCase();
      expect(
        scanConfig.allowedHosts.some((a) => lower === a || lower.endsWith(`.${a}`)),
        `${host} is not on the scan allow-list`,
      ).toBe(true);
    }
    // A link a reader chooses is not a resource the page takes on load.
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/@import/i);
  });

  it('says nothing to anyone but the host that served it', () => {
    // One request, for the specification. This replaces the
    // `disable-telemetry="true"` the Redoc version needed for the guarantee.
    expect(html.match(/\bfetch\(/g) ?? []).toHaveLength(1);
    expect(html).toMatch(/fetch\(SPEC\)/);
    expect(html).not.toMatch(/sendBeacon|new WebSocket|new EventSource|new Image\(/);
  });

  it('gives the reader the contract when it cannot render', () => {
    expect(html).toMatch(/<noscript[^>]*>[\s\S]*?<a href="\.\/openapi\.json">/);
    // The loading notice lives inside the element the renderer replaces, so it
    // cannot survive into the finished page or outlive a failed fetch.
    expect(html).toMatch(/<div id="app">\s*<p class="notice">Loading/);
    expect(html).toMatch(/getElementById\('app'\)[\s\S]{0,90}\.replaceChildren\(/);
  });

  it('renders specification strings as text, never as markup', () => {
    // Summaries and descriptions are the routes' own text. Writing it through
    // HTML would turn an ordinary schema edit into script on every reader's
    // machine, on a page a maintainer regenerates without reading the prose.
    expect(html).not.toMatch(/\.innerHTML\s*=/);
    expect(html).not.toMatch(/document\.write/);
    expect(html).toMatch(/node\.append\(value\)/);
  });

  it('interprets every schema keyword the committed spec uses', () => {
    // The page renders this contract, not JSON Schema in general: it says so
    // with a keyword list and a runtime note. This pins the list against the
    // spec, so a schema the page cannot show fails the build instead of
    // silently publishing a thinner reference than openapi.json.
    const start = html.indexOf('var KNOWN_KEYWORDS');
    const handled = new Set(
      [...html.slice(start, html.indexOf('];', start)).matchAll(/'([^']+)'/g)].map((m) => m[1]),
    );
    expect(handled.size).toBeGreaterThan(0);

    const used = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const record = node as Record<string, unknown>;
      const isSchema =
        typeof record.type === 'string' ||
        record.properties ||
        record.items ||
        record.enum ||
        record.propertyNames ||
        record.$ref;
      if (isSchema) Object.keys(record).forEach((key) => used.add(key));
      Object.keys(record)
        .filter((key) => key !== 'example' && key !== 'examples')
        .forEach((key) => walk(record[key]));
    };
    walk(spec);

    // Pointers are resolved against components.schemas:
    expect(handled).toContain('$ref');
    expect([...used].filter((key) => !handled.has(key))).toEqual([]);
  });
});

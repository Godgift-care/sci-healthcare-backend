import { readFileSync } from 'node:fs';
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

  it('renders the committed spec from the artifact, not from the API', () => {
    expect(html).toMatch(/spec-url="\.\/openapi\.json"/);
    // The server's own spec is exactly what this page must not depend on.
    expect(html).not.toMatch(/onrender\.com\/(v\d\/)?openapi\.json/);
  });

  it('works under any URL prefix', () => {
    // Absolute paths would 404 on a fork or project site, which is how the
    // "deploy from a fork" check is meant to be run.
    expect(html).not.toMatch(/(?:src|href|spec-url)="\/(?!\/)/);
  });

  it('pins the renderer to one version and verifies its bytes', () => {
    expect(html).toMatch(/redoc@\d+\.\d+\.\d+\/bundles\/redoc\.standalone\.js/);
    expect(html).not.toMatch(/redoc@(\d+|latest|next)\//);
    expect(html).toMatch(/integrity="sha384-[A-Za-z0-9+/]{64}"/);
    // integrity without CORS is ignored by the browser for cross-origin scripts.
    expect(html).toMatch(/crossorigin="anonymous"/);
  });

  it('gives the reader the contract when it cannot render', () => {
    expect(html).toMatch(/<noscript[^>]*>[\s\S]*?<a href="\.\/openapi\.json">/);
    // Redoc renders into its own element and removes nothing, so a loading
    // notice outside <noscript> would stay on the page forever.
    expect(html).not.toMatch(/<div id="fallback">/);
  });

  it('sends no telemetry from a health-sector documentation page', () => {
    expect(html).toMatch(/disable-telemetry="true"/);
  });
});

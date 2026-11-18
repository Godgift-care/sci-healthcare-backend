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

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The repository's security and monitoring workflows are configuration, so
 * their acceptance criteria are asserted structurally against the file text:
 * that the triggers, permissions and actions each file was written with are
 * still there. Nothing here executes GitHub Actions.
 */
const workflowsDir = new URL('../../.github/workflows/', import.meta.url);

function workflow(name: string): string {
  return readFileSync(new URL(name, workflowsDir), 'utf8');
}

function workflowNames(): string[] {
  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml'))
    .sort();
}

type ActionUsage = { file: string; ref: string; comment: string };

/** Every `uses:` reference in every workflow, with its trailing comment. */
function actionUsages(): ActionUsage[] {
  const usages: ActionUsage[] = [];
  for (const file of workflowNames()) {
    for (const line of workflow(file).split('\n')) {
      const match = /^\s*(?:-\s+)?uses:\s*([^\s#]+)\s*(?:#\s*(.*))?$/.exec(line);
      const ref = match?.[1];
      if (ref === undefined) continue;
      usages.push({ file, ref, comment: match?.[2] ?? '' });
    }
  }
  return usages;
}

describe('every workflow', () => {
  const usages = actionUsages();

  it('pins each action to a full commit SHA, never a tag or branch (#283)', () => {
    // A tag or branch ref can be retargeted after the fact; a commit cannot.
    // 40 hex characters is what GitHub accepts for a pinned `uses:` line.
    expect(usages.length).toBeGreaterThan(0);
    const unpinned = usages
      .filter(({ ref }) => !/^[^\s@/]+\/[^\s@/]+(?:\/[^\s@]+)?@[0-9a-f]{40}$/.test(ref))
      .map(({ file, ref }) => `${file}: ${ref}`);
    expect(unpinned).toEqual([]);
  });

  it('names the release each pinned action resolves to (#283)', () => {
    // The comment is how a reviewer tells 9418214 from 11d5960 without
    // looking anything up, and how Dependabot's PR titles stay readable.
    const uncommented = usages
      .filter(({ comment }) => !/^v?\d+(\.\d+)*$/.test(comment.trim()))
      .map(({ file, ref }) => `${file}: ${ref}`);
    expect(uncommented).toEqual([]);
  });

  it('declares permissions explicitly (#284)', () => {
    // Without a top-level block, a job inherits the repository default, which
    // GitHub has historically widened. Each workflow states what it needs.
    const missing = workflowNames().filter((name) => !/^permissions:/m.test(workflow(name)));
    expect(missing).toEqual([]);
  });

  it('writes each permissions declaration as a block GitHub can parse (#284)', () => {
    // `permissions: contents: read` is shorter and is not valid YAML: a nested
    // mapping needs its own lines. GitHub then rejects the file, the run fails
    // before any job starts, and nothing says which workflow was at fault.
    // A flow mapping (`{ contents: read }`) parses, so only the bare form fails.
    const unreadable = workflowNames().filter((name) =>
      workflow(name)
        .split('\n')
        .some((line) => {
          const declared = /^permissions:\s*(.*)$/.exec(line)?.[1]?.trim() ?? '';
          return declared.length > 0 && !declared.startsWith('{') && declared.includes(':');
        }),
    );
    expect(unreadable).toEqual([]);
  });

  it('keeps repository contents read-only for the workflows that only read it (#284)', () => {
    // These never push, comment or upload artifacts, so `contents: write`
    // would only widen what a compromised action could do to the repository.
    // automerge.yml and security.yml are excluded on purpose: they merge and
    // post statuses, which is the write they exist for.
    for (const name of [
      'ci.yml',
      'quickstart-integration.yml',
      'codeql.yml',
      'dependency-review.yml',
      'monitor.yml',
    ]) {
      const yml = workflow(name);
      expect(yml).toMatch(/contents: read/);
      expect(yml).not.toMatch(/contents: write/);
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
    expect(yml).toMatch(/github\/codeql-action\/init@[0-9a-f]{40} # v\d+/);
    expect(yml).toMatch(/github\/codeql-action\/analyze@[0-9a-f]{40} # v\d+/);
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
    expect(yml).toMatch(/actions\/dependency-review-action@[0-9a-f]{40} # v\d+/);
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

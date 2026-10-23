import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Production entry points must run the compiled JavaScript in `dist/`, not
 * `tsx` (issue #161): a production image installs only production
 * dependencies, where `tsx` does not exist, and compiling on every start is
 * work the build step already did. The dev equivalents keep using `tsx` so a
 * contributor never has to build to run a script once.
 *
 * These assertions read `package.json` as text, the same way
 * `ci-workflows.test.ts` treats the workflows: the scripts are configuration,
 * and what matters is what command they name.
 */

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { scripts: Record<string, string> };

/** The maintenance scripts this issue moves onto `dist/`. */
const PRODUCTION_SCRIPTS = ['indexer:backfill', 'indexer:retry-failed', 'indexer:reconcile'] as const;

describe('production maintenance scripts run compiled JavaScript (#161)', () => {
  for (const name of PRODUCTION_SCRIPTS) {
    const entry = name.replace(/^indexer:/, '');

    it(`${name} points at dist/scripts/${entry}.js`, () => {
      expect(pkg.scripts[name]).toBe(`node dist/scripts/${entry}.js`);
    });

    it(`${name} keeps a tsx dev equivalent that runs the same source`, () => {
      expect(pkg.scripts[`${name}:dev`]).toBe(`tsx src/scripts/${entry}.ts`);
    });

    it(`src/scripts/${entry}.ts exists, so the build emits its dist file`, () => {
      // tsconfig.json includes src/**/*.ts with outDir dist and rootDir src,
      // so the presence of the source file is what guarantees the compiled
      // entry point the production script names.
      expect(
        existsSync(fileURLToPath(new URL(`../scripts/${entry}.ts`, import.meta.url))),
      ).toBe(true);
    });
  }

  it('the process entry points also run dist, not tsx', () => {
    expect(pkg.scripts.start).toBe('node dist/index.js');
    expect(pkg.scripts['start:api']).toBe('node dist/api.js');
    expect(pkg.scripts['start:indexer']).toBe('node dist/worker.js');
  });

  it('dev entry points are unchanged and still run through tsx', () => {
    expect(pkg.scripts.dev).toBe('tsx watch src/index.ts');
    expect(pkg.scripts['dev:api']).toBe('tsx watch src/api.ts');
    expect(pkg.scripts['dev:indexer']).toBe('tsx watch src/worker.ts');
  });
});

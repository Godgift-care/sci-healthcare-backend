import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Issue #312 makes `npm run typecheck` cover every TypeScript project in the
 * repo, from one shared strict base. Configuration this static is only worth
 * having if it cannot rot quietly, so the shape is asserted against the files:
 *
 * - a project added tomorrow without being wired into `typecheck` fails here,
 *   which is exactly how `scripts/`, `packages/client` and the example slipped
 *   out of the check in the first place;
 * - a leaf that re-declares a strict flag wins over `extends` and lowers the
 *   bar for one project only, so no leaf may name a shared flag at all;
 * - `outDir`/`rootDir`/`include` must stay out of the base: `extends` resolves
 *   them relative to the file that declares them, so a leaf inheriting
 *   `outDir: "dist"` would emit into the server's build directory.
 */

const STRICT_FLAGS = [
  'strict',
  'noUncheckedIndexedAccess',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch',
  'exactOptionalPropertyTypes',
  'esModuleInterop',
  'skipLibCheck',
] as const;

const PATH_BEARING_OPTIONS = ['outDir', 'rootDir', 'include', 'exclude'] as const;

type TsConfig = {
  extends?: string;
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
};

const read = (rel: string): string =>
  readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

const parse = (rel: string): TsConfig => JSON.parse(read(rel)) as TsConfig;

const base = parse('tsconfig.base.json');

/**
 * Every project config in the repo: the server, the tooling check, and one per
 * directory under `packages/` and `examples/` that carries a tsconfig.
 */
function projectConfigs(): string[] {
  const found = ['tsconfig.json', 'tsconfig.tooling.json'];
  for (const workspace of ['packages', 'examples']) {
    for (const entry of readdirSync(new URL(`../../${workspace}/`, import.meta.url), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      const rel = `${workspace}/${entry.name}/tsconfig.json`;
      if (existsSync(new URL(`../../${rel}`, import.meta.url))) found.push(rel);
    }
  }
  return found.sort();
}

const configs = projectConfigs();
const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
const scripts = pkg.scripts ?? {};

/** The configs each `typecheck*` script compiles, and whether it stays read-only. */
const typecheckTargets = new Map<string, boolean>();
for (const [name, body] of Object.entries(scripts)) {
  if (!/^typecheck(:|$)/.test(name)) continue;
  for (const match of body.matchAll(/tsc\s+-p\s+(\S+)([^&]*)/g)) {
    typecheckTargets.set(match[1]!, match[2]!.includes('--noEmit'));
  }
}

/** Script names the top-level `typecheck` actually runs. */
const typecheckInvokes = new Set(
  [...(scripts.typecheck ?? '').matchAll(/npm run (typecheck[:\w-]*)/g)].map((m) => m[1]!),
);

describe('tsconfig.base.json', () => {
  it('is the one place the strict options are declared', () => {
    for (const flag of STRICT_FLAGS) {
      expect(base.compilerOptions?.[flag], flag).toBe(true);
    }
  });

  it('declares no path-bearing option, which extends would resolve from the root', () => {
    for (const key of PATH_BEARING_OPTIONS) {
      expect(base.compilerOptions?.[key], key).toBeUndefined();
    }
    expect(base.include).toBeUndefined();
    expect(base.exclude).toBeUndefined();
  });
});

describe('npm run typecheck', () => {
  it('finds the project configs it is supposed to cover (canary)', () => {
    expect(configs).toContain('tsconfig.json');
    expect(configs).toContain('tsconfig.tooling.json');
    expect(configs).toContain('packages/client/tsconfig.json');
    expect(configs).toContain('examples/telegram-bot/tsconfig.json');
  });

  it('compiles every project config in the repository', () => {
    expect([...typecheckTargets.keys()].sort()).toEqual(configs);
  });

  it('runs every typecheck script it defines', () => {
    const defined = Object.keys(scripts).filter((name) => name.startsWith('typecheck:'));
    expect([...typecheckInvokes].sort()).toEqual(defined.sort());
  });

  it('checks without emitting, so no gate leaves build output behind', () => {
    for (const [config, noEmit] of typecheckTargets) {
      expect(noEmit, config).toBe(true);
    }
  });
});

describe('each project config', () => {
  for (const rel of configs) {
    const config = parse(rel);

    it(`extends the shared base (${rel})`, () => {
      expect(typeof config.extends, 'extends').toBe('string');
      // Resolving the string is the assertion: a wrong `../` depth points at a
      // file that does not exist and tsc fails open only because it errors out.
      const ownDirectory = new URL(`../../${rel}`, import.meta.url);
      expect(existsSync(new URL(config.extends!, ownDirectory)), config.extends).toBe(true);
    });

    it(`redeclares none of the shared strict options (${rel})`, () => {
      for (const flag of STRICT_FLAGS) {
        expect(config.compilerOptions?.[flag], flag).toBeUndefined();
      }
    });
  }

  it('keeps the tooling check pointed at the code that runs but never builds', () => {
    const tooling = parse('tsconfig.tooling.json');
    expect(tooling.include).toContain('scripts/**/*.ts');
    expect(tooling.include).toContain('test/**/*.ts');
  });
});

describe('the projects #312 newly brought under typecheck', () => {
  const sources = ['scripts', 'test', 'examples/telegram-bot/src', 'packages/client/src'];

  /**
   * `as any` is the way a strict config gets satisfied without being satisfied,
   * and the issue's second acceptance criterion forbids adding it. Files that
   * only ever ran through `tsx` had no reason to grow any, so the guard starts
   * clean rather than grandfathering.
   */
  function anyCasts(rel: string): string[] {
    const url = new URL(`../../${rel}`, import.meta.url);
    return readdirSync(url, { withFileTypes: true }).flatMap((entry) => {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : anyCasts(child);
      return entry.name.endsWith('.ts') && /\bas any\b/.test(read(child)) ? [child] : [];
    });
  }

  for (const rel of sources) {
    it(`contains no as any in ${rel}/`, () => {
      expect(anyCasts(rel)).toEqual([]);
    });
  }
});

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Issue #302 split the README into focused pages. The split is only safe while
 * every relative link in the documentation still resolves and the README stays
 * short, so both are asserted here rather than checked once by hand.
 *
 * Asset references (`docs/banner.png` and friends) are out of scope: they are
 * binary files a maintainer can add out of band, and one of them has pointed at
 * a missing file since before the split.
 */

const root = new URL('../../', import.meta.url);

function docFiles(): string[] {
  const docs = readdirSync(new URL('docs/', root))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`);
  return ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md', ...docs].filter((f) =>
    existsSync(new URL(f, root)),
  );
}

/** GitHub's anchor rule for a heading line; returns null for a non-heading. */
function slugOf(line: string): string | null {
  const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  if (!match?.[2]) return null;
  return match[2]
    .toLowerCase()
    .replaceAll(/[^a-z0-9 _-]/g, '')
    .trim()
    .replaceAll(/\s+/g, '-');
}

function headingsOf(file: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of readFileSync(new URL(file, root), 'utf8').split('\n')) {
    const slug = slugOf(line);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

const ASSET = /\.(png|jpe?g|gif|svg|webp|ico)$/i;

/** Every `[text](target)` link in a page, skipping the external ones. */
function relativeLinks(file: string): string[] {
  const text = readFileSync(new URL(file, root), 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (target === undefined) continue;
    if (/^(https?:|mailto:|data:)/.test(target)) continue;
    found.push(target);
  }
  return found;
}

describe('documentation links (#302)', () => {
  const files = docFiles();

  it('covers the pages the README was split into', () => {
    // The split is what this test exists for; if these files vanish the
    // assertions below quietly check an unsplit README again.
    for (const page of [
      'docs/api-reference.md',
      'docs/webhooks.md',
      'docs/environment.md',
      'docs/tracing.md',
    ]) {
      expect(files, page).toContain(page);
    }
  });

  for (const file of files) {
    it(`resolves every relative link in ${file}`, () => {
      for (const target of relativeLinks(file)) {
        if (target.startsWith('#')) continue;
        const [path] = target.split('#');
        if (path === undefined || path === '' || ASSET.test(path)) continue;
        expect(existsSync(new URL(path, new URL(file, root))), `${file} -> ${target}`).toBe(true);
      }
    });

    it(`resolves every anchor in ${file}`, () => {
      for (const target of relativeLinks(file)) {
        const [path, hash] = target.split('#');
        if (hash === undefined || hash === '') continue;
        const owner = path === '' || path === undefined ? file : path;
        if (!existsSync(new URL(owner, root))) continue;
        expect(headingsOf(owner).has(hash), `${file} -> #${hash}`).toBe(true);
      }
    });
  }
});

describe('README length (#302)', () => {
  const readme = readFileSync(new URL('README.md', root), 'utf8');

  it('keeps the README under 250 lines', () => {
    expect(readme.split('\n').length - 1).toBeLessThan(250);
  });

  it('links every page it was split into', () => {
    for (const page of ['api-reference', 'webhooks', 'environment', 'tracing']) {
      expect(readme, `docs/${page}.md`).toContain(`docs/${page}.md`);
    }
  });

  it('does not still carry the reference material it moved out', () => {
    // A heading would mean the section came back while the page stayed, so the
    // two copies could drift apart.
    for (const heading of ['## API\n', '## Webhooks\n', '## Environment\n']) {
      expect(readme).not.toContain(heading);
    }
    expect(readme).not.toContain('| `DATABASE_URL` |');
  });
});

import { readFileSync, readdirSync, existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * Architecture decision records are documentation, and documentation rots the
 * way code does: a record that names a file which no longer exists, or a
 * decision whose mechanism moved, is worse than no record because it is
 * trusted. So these are checked rather than reviewed.
 *
 * The files are parsed as text, not imported: there is nothing to import, and
 * the acceptance criterion is about the shape of the prose.
 * (issue #298)
 */

const adrDir = new URL('../../docs/adr/', import.meta.url);

function adrFiles(): string[] {
  return readdirSync(adrDir).filter((name) => /^\d{4}-.+\.md$/.test(name));
}

function read(name: string): string {
  return readFileSync(new URL(name, adrDir), 'utf8');
}

const index = readFileSync(new URL('../../docs/adr/README.md', import.meta.url), 'utf8');
const architecture = readFileSync(new URL('../../docs/architecture.md', import.meta.url), 'utf8');

/** The five decisions this repository carries, excluding the template. */
const RECORDS = adrFiles().filter((name) => !name.startsWith('0000-'));

/** Every level-2 heading in a document, in order. */
function headings(markdown: string): string[] {
  return [...markdown.matchAll(/^## (.+)$/gm)].map((m) => (m[1] ?? '').trim());
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}`);
  if (start === -1) return '';
  const rest = markdown.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the ADR template', () => {
  it('is the first file in the directory', () => {
    expect(adrFiles()[0]).toMatch(/^0000-/);
  });

  it('carries the three sections every record must have', () => {
    const template = read(adrFiles()[0]!);
    // The sections are asserted inside the template's fenced example, which
    // is the thing a contributor copies.
    expect(template).toMatch(/^## Structure$/m);
    for (const heading of ['Context', 'Decision', 'Consequences']) {
      expect(template).toContain(`## ${heading}`);
    }
    expect(template).toMatch(/\*\*Status:\*\*/);
    expect(template).toMatch(/\*\*Date:\*\*/);
    expect(template).toMatch(/\*\*Code:\*\*/);
  });

  it('says what earns a record', () => {
    expect(headings(read(adrFiles()[0]!))).toContain('What earns a record');
  });
});

describe('every decision record', () => {
  it('there are five', () => {
    // The issue asks for the five most consequential decisions; the count is
    // asserted so a sixth cannot silently replace one of them.
    expect(RECORDS).toHaveLength(5);
  });

  it('is numbered from a file name and titled the same in the document', () => {
    for (const file of RECORDS) {
      const number = file.slice(0, 4);
      expect(number).toMatch(/^\d{4}$/);
      expect(read(file)).toMatch(new RegExp(`^# ADR-${number}: .+\\n`));
    }
  });

  it('states context, decision and consequences', () => {
    for (const file of RECORDS) {
      const text = read(file);
      const found = headings(text);
      for (const required of ['Context', 'Decision', 'Consequences']) {
        expect(found, `${file} has no "## ${required}"`).toContain(required);
      }
    }
  });

  it('is dated and has a status', () => {
    for (const file of RECORDS) {
      const text = read(file);
      expect(text).toMatch(/^\*\*Status:\*\* (Accepted|Superseded by ADR-\d{4}|Deprecated)$/m);
      expect(text).toMatch(/^\*\*Date:\*\* \d{4}-\d{2}-\d{2}/m);
      expect(text).toMatch(/^\*\*Code:\*\* /m);
    }
  });

  it('names what was rejected, so the alternative is not re-litigated', () => {
    for (const file of RECORDS) {
      expect(section(read(file), 'Decision')).toMatch(/\nRejected: /);
    }
  });

  it('admits costs in Consequences', () => {
    for (const file of RECORDS) {
      const consequences = section(read(file), 'Consequences');
      // A list of benefits is not a consequence section. Each record has to
      // carry at least one obligation or downside for the section to mean
      // anything.
      expect(consequences).toMatch(/^- /m);
      expect(consequences).toMatch(
        /(not |never |rather than |instead of |must |needs |risk|costs|refuses|deliberately|forgo)/i,
      );
    }
  });

  it('points at code that exists', () => {
    // The **Code:** line is the record's contract with the reader. A path
    // there that no longer resolves means the decision moved or died.
    for (const file of RECORDS) {
      const line = read(file).match(/^\*\*Code:\*\* (.+)$/m)?.[1] ?? '';
      const paths = [...line.matchAll(/`([^`]+)`/g)]
        .map((m) => m[1] ?? '')
        .filter((p) => p.includes('/') && !p.includes('*') && !p.includes(' '));
      expect(paths.length, `${file} names no code`).toBeGreaterThan(0);
      for (const p of paths) {
        expect(existsSync(new URL(`../../${p}`, import.meta.url)), `${file} points at ${p}`).toBe(
          true,
        );
      }
    }
  });
});

describe('the records are findable', () => {
  it('each is linked from docs/architecture.md', () => {
    for (const file of RECORDS) {
      expect(architecture, file).toContain(`(adr/${file})`);
    }
  });

  it('architecture.md links nothing that is missing', () => {
    const linked = [...architecture.matchAll(/\((adr\/[^)\s]+)\)/g)].map((m) => m[1] ?? '');
    expect(linked.length).toBeGreaterThan(0);
    for (const link of linked) {
      const target = link.replace('adr/', '');
      expect(target === 'README.md' || existsSync(new URL(target, adrDir)), link).toBe(true);
    }
  });

  it('the index lists every record and nothing else', () => {
    const indexed = [...index.matchAll(/\| \[(\d{4})\]\(([^)]+)\) \|/g)].map((m) => m[2] ?? '');
    expect(indexed.sort()).toEqual([...adrFiles()].sort());
  });

  it('the index row for a record repeats its own title', () => {
    for (const file of RECORDS) {
      const title = read(file).match(/^# ADR-\d{4}: (.+)$/m)?.[1];
      expect(index, `${file} title in the index`).toContain(`${title}`);
    }
  });

  it('records say where they belong in the pipeline document', () => {
    // A link is only useful if the reader knows which section it explains.
    for (const file of RECORDS) {
      const row = architecture.match(new RegExp(`^\\| \\[\\d{4}\\]\\(adr/${file}\\) \\|(.+)$`, 'm'));
      expect(row, `${file} is not in the decisions table`).not.toBeNull();
      expect((row?.[1] ?? '').trim().length).toBeGreaterThan(0);
    }
  });
});

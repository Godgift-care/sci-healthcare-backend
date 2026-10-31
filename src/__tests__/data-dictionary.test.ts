import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The data dictionary (`docs/data-dictionary.md`) must match the Prisma
 * schema: every model and every column documented with its type and
 * nullability, and nothing documented that the schema does not have.
 *
 * The schema is parsed as text, not imported, because importing the
 * generated client would need `prisma generate` first (issue #150).
 */

const schemaSource = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const dictionary = readFileSync(new URL('../../docs/data-dictionary.md', import.meta.url), 'utf8');

type SchemaField = {
  name: string;
  /** Type exactly as the schema spells it, e.g. `String`, `Int?`, `Voucher[]`. */
  type: string;
  nullable: boolean;
  isList: boolean;
};

type SchemaModel = { name: string; fields: SchemaField[] };

/** Parses `model Name { ... }` blocks into models and their fields. */
function parseSchema(src: string): SchemaModel[] {
  const models: SchemaModel[] = [];
  const modelRe = /^model (\w+) \{$([\s\S]*?)^\}$/gm;
  for (const match of src.matchAll(modelRe)) {
    const name = match[1];
    const body = match[2] ?? '';
    if (name === undefined) continue;

    const fields: SchemaField[] = [];
    for (const line of body.split('\n')) {
      // Comments, blank lines and block attributes (`@@index(...)`) are not
      // fields; the field regex below cannot start on `@` anyway.
      const m = line.match(/^ {2}(\w+)\s+(\w+)(\[\])?(\?)?/);
      if (!m) continue;
      const fieldName = m[1]!;
      const typeName = m[2]!;
      const isList = m[3] !== undefined;
      fields.push({
        name: fieldName,
        type: `${typeName}${isList ? '[]' : ''}${m[4] !== undefined ? '?' : ''}`,
        nullable: m[4] !== undefined,
        isList,
      });
    }
    models.push({ name, fields });
  }
  return models;
}

/** The `## \`Model\`` section of the dictionary, up to the next heading. */
function modelSection(model: string): string {
  const heading = `## \`${model}\``;
  const start = dictionary.indexOf(heading);
  if (start === -1) return '';
  const rest = dictionary.slice(start + heading.length);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

type DictRow = { column: string; type: string; nullable: string; source: string };

/** First-cell rows of a model's markdown table. */
function dictRows(section: string): Map<string, DictRow> {
  const rows = new Map<string, DictRow>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim().replaceAll('`', ''));
    const [column, type, nullable, source] = cells;
    if (column === undefined || column === 'Column') continue;
    rows.set(column, {
      column,
      type: type ?? '',
      nullable: nullable ?? '',
      source: source ?? '',
    });
  }
  return rows;
}

describe('docs/data-dictionary.md', () => {
  const models = parseSchema(schemaSource);

  it('parses the schema (canary for the assertions below)', () => {
    const voucher = models.find((m) => m.name === 'Voucher');
    expect(voucher?.fields.map((f) => f.name)).toContain('seq');
    expect(voucher?.fields.find((f) => f.name === 'seq')).toEqual({
      name: 'seq',
      type: 'BigInt?',
      nullable: true,
      isList: false,
    });
    expect(models.find((m) => m.name === 'WebhookDelivery')?.fields.map((f) => f.name)).toContain(
      'nextAttemptAt',
    );
    expect(models.length).toBeGreaterThanOrEqual(15);
  });

  it('documents every model in the schema, and only those', () => {
    const documented = [...dictionary.matchAll(/^## `(\w+)`$/gm)].map((m) => m[1]!);
    expect(documented.sort()).toEqual(models.map((m) => m.name).sort());
  });

  it('documents every column of every model, and only those', () => {
    for (const model of models) {
      const rows = dictRows(modelSection(model.name));
      const schemaColumns = model.fields.map((f) => f.name);
      expect([...rows.keys()].sort(), model.name).toEqual([...schemaColumns].sort());
    }
  });

  it('records the schema type of every column', () => {
    for (const model of models) {
      const rows = dictRows(modelSection(model.name));
      for (const field of model.fields) {
        expect(rows.get(field.name)?.type, `${model.name}.${field.name}`).toBe(field.type);
      }
    }
  });

  it('agrees with the schema on nullability', () => {
    for (const model of models) {
      const rows = dictRows(modelSection(model.name));
      for (const field of model.fields) {
        const expected = field.isList ? '—' : field.nullable ? 'Yes' : 'No';
        expect(rows.get(field.name)?.nullable, `${model.name}.${field.name}`).toBe(expected);
      }
    }
  });

  it('says where every column comes from', () => {
    for (const model of models) {
      const rows = dictRows(modelSection(model.name));
      for (const field of model.fields) {
        expect(rows.get(field.name)?.source, `${model.name}.${field.name}`).not.toBe('');
      }
    }
  });
});

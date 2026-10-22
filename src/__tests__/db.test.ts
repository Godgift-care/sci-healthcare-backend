import { describe, expect, it } from 'vitest';

import { buildDatabaseUrl } from '../db.js';

describe('buildDatabaseUrl', () => {
  it('applies connection_limit and statement_timeout to a Postgres URL', () => {
    const raw = 'postgresql://sci:sci@localhost:5432/sci_healthcare';
    const result = buildDatabaseUrl(raw, {
      poolSize: 5,
      statementTimeoutMs: 10000,
    });

    const parsed = new URL(result);
    expect(parsed.searchParams.get('connection_limit')).toBe('5');
    expect(parsed.searchParams.get('statement_timeout')).toBe('10000');
    expect(parsed.protocol).toBe('postgresql:');
    expect(parsed.host).toBe('localhost:5432');
    expect(parsed.pathname).toBe('/sci_healthcare');
  });

  it('preserves existing query parameters on a Postgres URL', () => {
    const raw = 'postgresql://sci:sci@localhost:5432/sci_healthcare?schema=public&sslmode=require';
    const result = buildDatabaseUrl(raw, {
      poolSize: 10,
      statementTimeoutMs: 5000,
    });

    const parsed = new URL(result);
    expect(parsed.searchParams.get('schema')).toBe('public');
    expect(parsed.searchParams.get('sslmode')).toBe('require');
    expect(parsed.searchParams.get('connection_limit')).toBe('10');
    expect(parsed.searchParams.get('statement_timeout')).toBe('5000');
  });

  it('overwrites existing parameters if already in the Postgres URL', () => {
    const raw = 'postgresql://sci:sci@localhost:5432/sci_healthcare?connection_limit=2&statement_timeout=1000';
    const result = buildDatabaseUrl(raw, {
      poolSize: 8,
      statementTimeoutMs: 15000,
    });

    const parsed = new URL(result);
    expect(parsed.searchParams.get('connection_limit')).toBe('8');
    expect(parsed.searchParams.get('statement_timeout')).toBe('15000');
  });

  it('leaves SQLite URLs completely untouched', () => {
    const sqliteUrls = [
      'file:./dev.db',
      'file:../prisma/test.db',
      'sqlite:./local.db',
    ];

    for (const raw of sqliteUrls) {
      const result = buildDatabaseUrl(raw, {
        poolSize: 5,
        statementTimeoutMs: 10000,
      });
      expect(result).toBe(raw);
    }
  });

  it('returns raw URL unchanged when no options are provided', () => {
    const raw = 'postgresql://sci:sci@localhost:5432/sci_healthcare';
    expect(buildDatabaseUrl(raw)).toBe(raw);
    expect(buildDatabaseUrl(raw, {})).toBe(raw);
  });
});

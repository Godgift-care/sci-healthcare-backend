import { describe, expect, it } from 'vitest';

import { schema } from '../env.js';

const validBaseEnv = {
  DATABASE_URL: 'file:./dev.db',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  REGISTRY_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M',
  VOUCHER_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M',
  RECEIPT_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M',
};

describe('INDEXER_PAGE_SIZE validation', () => {
  it('defaults to 200', () => {
    expect(schema.parse(validBaseEnv).INDEXER_PAGE_SIZE).toBe(200);
  });

  it.each([0, 1001, -1])('rejects out-of-range value %i', (value) => {
    expect(schema.safeParse({ ...validBaseEnv, INDEXER_PAGE_SIZE: value }).success).toBe(false);
  });

  it('accepts values from 1 through 1000', () => {
    expect(schema.parse({ ...validBaseEnv, INDEXER_PAGE_SIZE: 1 }).INDEXER_PAGE_SIZE).toBe(1);
    expect(schema.parse({ ...validBaseEnv, INDEXER_PAGE_SIZE: 1000 }).INDEXER_PAGE_SIZE).toBe(1000);
  });
});

describe('CORS_ORIGIN validation in env schema', () => {
  it('rejects wildcard origin "*" when NODE_ENV is production', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      NODE_ENV: 'production',
      CORS_ORIGIN: '*',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('CORS_ORIGIN'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain('Wildcard CORS origin "*" is not allowed in production');
    }
  });

  it('rejects wildcard in comma-separated origins when NODE_ENV is production', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.sci.care, *',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path.includes('CORS_ORIGIN'));
      expect(issue).toBeDefined();
    }
  });

  it('rejects non-http(s) origins in production', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'ftp://files.sci.care',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid URL strings in production', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('accepts valid http and https URLs in production', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      NODE_ENV: 'production',
      CORS_ORIGIN: 'https://app.sci.care, https://admin.sci.care',
    });
    expect(result.success).toBe(true);
  });

  it('allows wildcard origin "*" in development', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      NODE_ENV: 'development',
      CORS_ORIGIN: '*',
    });
    expect(result.success).toBe(true);
  });

  it('allows http localhost in development', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      NODE_ENV: 'development',
      CORS_ORIGIN: 'http://localhost:3000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid non-wildcard URLs even in development', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      NODE_ENV: 'development',
      CORS_ORIGIN: 'invalid-origin-string',
    });
    expect(result.success).toBe(false);
  });
});

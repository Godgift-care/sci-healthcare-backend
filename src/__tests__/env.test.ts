import { describe, expect, it } from 'vitest';

import {
  MIN_WEBHOOK_SECRET_LENGTH,
  parseWebhookEndpoints,
  parseWebhookSecrets,
  schema,
} from '../env.js';

const SECRET = 'a-long-enough-webhook-secret';
const OTHER_SECRET = 'another-long-enough-secret';
const CLINIC = `G${'A'.repeat(55)}`;

const validBaseEnv = {
  DATABASE_URL: 'file:./dev.db',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  REGISTRY_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M',
  VOUCHER_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M',
  RECEIPT_CONTRACT_ID: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHK3M',
};

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

describe('webhook secret rotation (#262)', () => {
  it('keeps the configured order and drops blanks and duplicates', () => {
    expect(parseWebhookSecrets('newest, older,, new ', 'older', ' legacy ')).toEqual([
      'newest',
      'older',
      'new',
      'legacy',
    ]);
  });

  it('accepts WEBHOOK_SECRETS alongside the legacy WEBHOOK_SECRET', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      WEBHOOK_URLS: 'https://clinic.example/hooks',
      WEBHOOK_SECRETS: `${SECRET},${OTHER_SECRET}`,
      WEBHOOK_SECRET: 'a-legacy-webhook-secret',
    });
    expect(result.success).toBe(true);
  });

  it('refuses a short key when an endpoint is configured', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      WEBHOOK_URLS: 'https://clinic.example/hooks',
      WEBHOOK_SECRETS: 'short',
    });
    expect(result.success).toBe(false);
  });

  it('refuses an endpoint with no key at all', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      WEBHOOK_URLS: 'https://clinic.example/hooks',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join('\n')).toContain('WEBHOOK_SECRETS');
    }
  });
});

describe('WEBHOOK_ENDPOINTS parsing (#263)', () => {
  const parse = (json: string) => parseWebhookEndpoints(json, [SECRET]);

  it('parses per-endpoint secrets, event filters and a clinic filter', () => {
    const endpoints = parse(
      JSON.stringify([
        {
          url: 'https://clinic-a.example/hooks',
          secret: OTHER_SECRET,
          events: ['voucher_settled'],
          provider: CLINIC,
        },
        { url: 'https://all.example/hooks' },
      ]),
    );

    expect(endpoints).toEqual([
      {
        url: 'https://clinic-a.example/hooks',
        secrets: [OTHER_SECRET],
        events: ['voucher_settled'],
        provider: CLINIC,
      },
      {
        url: 'https://all.example/hooks',
        secrets: [SECRET],
        events: null,
        provider: null,
      },
    ]);
  });

  it('returns an empty list for a blank setting', () => {
    expect(parse('   ')).toEqual([]);
  });

  it('fails with the offending property for malformed JSON and unknown keys', () => {
    expect(() => parse('{not json')).toThrow(/Invalid WEBHOOK_ENDPOINTS JSON/);
    expect(() =>
      parse(JSON.stringify([{ url: 'https://x.example', event: ['voucher_settled'] }])),
    ).toThrow(/Unrecognized key: "event"/);
    expect(() => parse(JSON.stringify({ url: 'https://x.example' }))).toThrow(/expected array/i);
  });

  it('rejects a bad URL, a duplicate URL, a bad provider and a missing secret', () => {
    expect(() => parse(JSON.stringify([{ url: 'not-a-url' }]))).toThrow(/not a valid URL/);
    expect(() => parse(JSON.stringify([{ url: 'ftp://x.example' }]))).toThrow(/not http\(s\)/);
    expect(() =>
      parse(JSON.stringify([{ url: 'https://x.example' }, { url: 'https://x.example' }])),
    ).toThrow(/duplicate url/);
    expect(() => parse(JSON.stringify([{ url: 'https://x.example', provider: 'Gshort' }]))).toThrow(
      /56-character address/,
    );
    expect(() => parseWebhookEndpoints(JSON.stringify([{ url: 'https://x.example' }]), [])).toThrow(
      /has no secret/,
    );
    expect(() => parse(JSON.stringify([{ url: 'https://x.example', secret: 'short' }]))).toThrow(
      new RegExp(String(MIN_WEBHOOK_SECRET_LENGTH)),
    );
  });

  it('fails the environment at startup, naming the variable', () => {
    const result = schema.safeParse({ ...validBaseEnv, WEBHOOK_ENDPOINTS: '[{"url":' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes('WEBHOOK_ENDPOINTS'))).toBe(true);
    }
  });

  it('lets WEBHOOK_ENDPOINTS replace the flat URL list', () => {
    const result = schema.safeParse({
      ...validBaseEnv,
      WEBHOOK_URLS: 'https://flat.example/hooks',
      WEBHOOK_ENDPOINTS: JSON.stringify([{ url: 'https://per-endpoint.example/hooks' }]),
      WEBHOOK_SECRET: SECRET,
    });
    expect(result.success).toBe(true);
  });
});

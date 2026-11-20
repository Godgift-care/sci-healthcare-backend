import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  apiKeyIdForHeader,
  createApiKeyCredential,
  MAX_API_KEYS_PER_INTEGRATOR,
  parseApiKeyHashes,
} from '../lib/api-keys.js';
import { maxRequestsForRequest } from '../lib/rate-limits.js';
import { env } from '../env.js';

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

describe('API key hashes', () => {
  it('matches configured keys and returns the digest for an isolated rate-limit bucket', () => {
    const hashes = parseApiKeyHashes(`clinic-a:${sha256('current-secret')}`);
    expect(apiKeyIdForHeader('current-secret', hashes)).toBe(sha256('current-secret'));
    expect(apiKeyIdForHeader('wrong-secret', hashes)).toBeNull();
    expect(apiKeyIdForHeader(undefined, hashes)).toBeNull();
    expect(apiKeyIdForHeader(['current-secret'], hashes)).toBeNull();
  });

  it('supports rotation with at most two hashes for one integrator', () => {
    const oldHash = sha256('old-secret');
    const newHash = sha256('new-secret');
    const hashes = parseApiKeyHashes(`clinic-a:${oldHash},clinic-a:${newHash}`);

    expect(hashes).toHaveLength(MAX_API_KEYS_PER_INTEGRATOR);
    expect(apiKeyIdForHeader('old-secret', hashes)).toBe(oldHash);
    expect(apiKeyIdForHeader('new-secret', hashes)).toBe(newHash);
    expect(() =>
      parseApiKeyHashes(
        `clinic-a:${oldHash},clinic-a:${newHash},clinic-a:${sha256('third-secret')}`,
      ),
    ).toThrow('at most 2 active API keys');
  });

  it('rejects malformed or duplicate hashes without echoing their value', () => {
    expect(() => parseApiKeyHashes('missing-separator')).toThrow('name:sha256hex');
    expect(() => parseApiKeyHashes(`clinic-a:${'g'.repeat(64)}`)).toThrow('name:sha256hex');
    expect(() =>
      parseApiKeyHashes(`clinic-a:${sha256('secret')},clinic-b:${sha256('secret')}`),
    ).toThrow('duplicate API key hashes');
  });

  it('generates a once-displayable secret with a SHA-256 hash', () => {
    const credential = createApiKeyCredential('clinic-a');
    expect(credential.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(credential.hash).toBe(sha256(credential.key));
  });

  it('uses the keyed quota only for recognized keys', () => {
    expect(maxRequestsForRequest({ apiKeyId: null }, 30)).toBe(30);
    expect(maxRequestsForRequest({ apiKeyId: '4a44dc15' }, 30)).toBe(env.RATE_LIMIT_KEYED_MAX);
  });
});

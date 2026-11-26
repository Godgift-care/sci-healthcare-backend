import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';

describe('API key request metrics', () => {
  it('labels requests with a short hash id and never exposes the key', async () => {
    const app = await buildApp({ logger: false });
    const apiKey = 'test-api-key-for-rate-limit-tests';
    const keyId = createHash('sha256').update(apiKey).digest('hex').slice(0, 8);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { 'x-api-key': apiKey },
      });
      expect(response.statusCode).toBe(200);

      const metrics = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.body).toContain(`api_key_requests_total{api_key_id="${keyId}"} 1`);
      expect(metrics.body).not.toContain(apiKey);
    } finally {
      await app.close();
    }
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The image's HEALTHCHECK is operator-facing configuration rather than code,
 * so the contract is asserted against the two files that define it. In
 * particular, a Compose-level `healthcheck:` would silently replace the image
 * one, which is the drift this test exists to prevent (#225).
 */
const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');

function apiBlock(): string {
  const match = compose.match(/^ {2}api:\n([\s\S]*?)(?=^ {2}\S|^volumes:)/m);
  expect(match, 'api service block').not.toBeNull();
  return match![1]!;
}

describe('Docker image healthcheck (#225)', () => {
  it('runs a Node-based liveness probe against /health', () => {
    expect(dockerfile).toMatch(/^HEALTHCHECK /m);
    const healthcheck = dockerfile.match(/^HEALTHCHECK [\s\S]*?\n(?=\n|CMD)/m)?.[0] ?? '';
    expect(healthcheck).toContain('CMD ["node", "-e"');
    expect(healthcheck).toContain("'/health'");
    expect(healthcheck).toContain('process.exit(r.ok ? 0 : 1)');
    expect(healthcheck).toContain('--start-period=40s');
  });

  it('adds no package or image layer for the probe', () => {
    const healthcheck = dockerfile.match(/^HEALTHCHECK [\s\S]*?\n(?=\n|CMD)/m)?.[0] ?? '';
    expect(healthcheck).not.toMatch(/\b(curl|wget|apt-get|npm install|apk add)\b/);
    expect(healthcheck).not.toContain('RUN');
  });

  it('lets Compose use the image healthcheck instead of probing readiness', () => {
    const block = apiBlock().replace(/^\s*#.*$/gm, '');
    expect(block).not.toMatch(/^\s{4}healthcheck:/m);
    expect(block).not.toContain('/ready');
    expect(compose).toContain('condition: service_healthy');
  });
});

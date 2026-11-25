import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { computeMedian, evaluateRegression } from '../lib/perf.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('Performance regression detection (#309)', () => {
  it('computes correct median across odd and even sample sizes', () => {
    expect(computeMedian([10, 20, 30])).toBe(20);
    expect(computeMedian([30, 10, 20])).toBe(20);
    expect(computeMedian([10, 20, 30, 40])).toBe(25);
    expect(computeMedian([15])).toBe(15);
    expect(computeMedian([])).toBe(0);
  });

  it('filters out noise using 3-run median so transient spikes do not fail the job', () => {
    const baselineConfig = {
      tolerance: 0.5,
      routes: {
        '/v1/vouchers?status=Funded&limit=20': { p95: 20 },
      },
    };

    // Run 1: 18ms, Run 2: 75ms (noisy spike!), Run 3: 19ms
    // Median is 19ms, which is well within 20 * 1.5 = 30ms threshold.
    const results = {
      '/v1/vouchers?status=Funded&limit=20': [18, 75, 19],
    };

    const evaluation = evaluateRegression(results, baselineConfig);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.details[0]?.median).toBe(19);
    expect(evaluation.details[0]?.threshold).toBe(30);
    expect(evaluation.details[0]?.regressed).toBe(false);
  });

  it('deliberate N+1 regression consistently exceeding tolerance fails the job', () => {
    const baselineConfig = {
      tolerance: 0.5,
      routes: {
        '/v1/vouchers?status=Funded&limit=20': { p95: 20 },
      },
    };

    // Deliberate N+1 query regression causes all runs to spike significantly:
    // Run 1: 55ms, Run 2: 60ms, Run 3: 58ms
    // Median is 58ms, which breaches the 30ms threshold.
    const results = {
      '/v1/vouchers?status=Funded&limit=20': [55, 60, 58],
    };

    const evaluation = evaluateRegression(results, baselineConfig);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.details[0]?.median).toBe(58);
    expect(evaluation.details[0]?.threshold).toBe(30);
    expect(evaluation.details[0]?.regressed).toBe(true);
  });

  it('verifies committed baseline file structure and validity', () => {
    const baselinePath = path.join(ROOT, 'scripts', 'perf-baseline.json');
    const content = JSON.parse(readFileSync(baselinePath, 'utf8'));

    expect(content.tolerance).toBeGreaterThan(0);
    expect(content.tolerance).toBeLessThanOrEqual(1.0);
    expect(content.runs).toBeGreaterThanOrEqual(3);
    expect(content.routes).toBeDefined();

    const routeKeys = Object.keys(content.routes);
    expect(routeKeys.length).toBeGreaterThanOrEqual(3);

    for (const key of routeKeys) {
      expect(key.startsWith('/v1/')).toBe(true);
      expect(content.routes[key].p95).toBeGreaterThan(0);
    }
  });
});

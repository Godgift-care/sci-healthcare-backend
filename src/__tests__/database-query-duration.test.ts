import { describe, expect, it, vi } from 'vitest';

import { observeDatabaseQuery, databaseQueryDuration } from '../lib/database-query-metrics.js';

describe('database query duration metrics (#218)', () => {
  it('records duration by model and operation, with no query values in labels', async () => {
    const sensitive = 'beneficiaryRef=private-patient-reference';
    const warning = vi.fn();
    const result = await observeDatabaseQuery(
      'Voucher',
      'findMany',
      async () => [{ beneficiaryRef: sensitive }],
      100,
      warning,
      (() => {
        const ticks = [10, 30];
        return () => ticks.shift() ?? 30;
      })(),
    );
    expect(result[0]?.beneficiaryRef).toBe(sensitive);
    expect(warning).not.toHaveBeenCalled();
    const metric = await databaseQueryDuration.get();
    expect(metric.labelNames).toEqual(['model', 'operation']);
    expect(JSON.stringify(metric.values)).not.toContain(sensitive);
    expect(metric.values.some((v) => v.labels.model === 'Voucher' && v.labels.operation === 'findMany')).toBe(true);
  });

  it('warns for a deliberately slow query without logging arguments or beneficiary references', async () => {
    const sensitive = 'beneficiaryRef=secret-reference';
    const warning = vi.fn();
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(750);
    await expect(
      observeDatabaseQuery('Voucher', 'findFirst', async () => ({ beneficiaryRef: sensitive }), 500, warning, clock),
    ).resolves.toEqual({ beneficiaryRef: sensitive });
    expect(warning).toHaveBeenCalledExactlyOnceWith({
      model: 'Voucher',
      operation: 'findFirst',
      durationMs: 750,
    });
    expect(JSON.stringify(warning.mock.calls)).not.toContain(sensitive);
  });

  it('observes failed queries without logging their potentially sensitive error text', async () => {
    const warning = vi.fn();
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(900);
    await expect(
      observeDatabaseQuery('Voucher', 'findFirst', async () => {
        throw new Error('beneficiaryRef=secret');
      }, 500, warning, clock),
    ).rejects.toThrow('beneficiaryRef=secret');
    expect(warning).not.toHaveBeenCalled();
  });
});

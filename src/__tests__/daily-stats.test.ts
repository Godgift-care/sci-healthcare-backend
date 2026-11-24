import { describe, expect, it } from 'vitest';

import { aggregateDailySeries, periodStart, type DailyStatRow } from '../lib/daily-stats.js';

function row(date: string, funded = 0, fundedAmount = '0'): DailyStatRow {
  return {
    date,
    fundedCount: funded,
    fundedAmount,
    settledCount: 0,
    settledAmount: '0',
    refundedCount: 0,
    refundedAmount: '0',
  };
}

describe('periodStart', () => {
  it('leaves a day as itself', () => {
    expect(periodStart('2026-11-24', 'day')).toBe('2026-11-24');
  });

  it('labels a week by its Monday in UTC', () => {
    // 2026-11-24 is a Tuesday; its ISO week began on Monday 2026-11-23.
    expect(periodStart('2026-11-24', 'week')).toBe('2026-11-23');
    expect(periodStart('2026-11-23', 'week')).toBe('2026-11-23');
    // A Sunday belongs to the week that started six days earlier, not the
    // next one.
    expect(periodStart('2026-11-22', 'week')).toBe('2026-11-16');
    // The week containing 1 January crosses the year boundary.
    expect(periodStart('2026-01-01', 'week')).toBe('2025-12-29');
  });

  it('labels a month by its first day', () => {
    expect(periodStart('2026-11-24', 'month')).toBe('2026-11-01');
    expect(periodStart('2026-01-01', 'month')).toBe('2026-01-01');
  });
});

describe('aggregateDailySeries', () => {
  it('returns every period, zeroed, when filling', () => {
    const series = aggregateDailySeries(
      [row('2026-11-02', 1, '100'), row('2026-11-04', 2, '200')],
      '2026-11-01',
      '2026-11-04',
      'day',
      true,
    );

    expect(series.map((point) => point.date)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    expect(series[0]!.funded).toEqual({ count: 0, amount: '0' });
    expect(series[2]!.funded).toEqual({ count: 0, amount: '0' });
  });

  it('omits periods with no row when not filling', () => {
    const series = aggregateDailySeries(
      [row('2026-11-02', 1, '100'), row('2026-11-04', 2, '200')],
      '2026-11-01',
      '2026-11-04',
      'day',
      false,
    );

    expect(series.map((point) => point.date)).toEqual(['2026-11-02', '2026-11-04']);
  });

  it('sums weeks across a month and year boundary exactly', () => {
    const rows = [
      row('2025-12-29', 1, '9007199254740993'),
      row('2025-12-31', 2, '9007199254740995'),
      row('2026-01-01', 1, '9007199254740997'),
      row('2026-01-05', 3, '9007199254740999'),
    ];

    const series = aggregateDailySeries(rows, '2025-12-29', '2026-01-05', 'week', true);

    // Two ISO weeks: 29 Dec 2025 – 4 Jan 2026, then the week of 5 Jan.
    expect(series.map((point) => point.date)).toEqual(['2025-12-29', '2026-01-05']);
    expect(series[0]!.funded).toEqual({
      count: 4,
      // 9 007 199 254 740 993 + ... + 9 007 199 254 740 997, summed as BigInt.
      amount: '27021597764222985',
    });
    expect(series[1]!.funded).toEqual({ count: 3, amount: '9007199254740999' });
  });

  it('sums months across a year boundary exactly', () => {
    const series = aggregateDailySeries(
      [row('2025-12-01', 1, '10'), row('2025-12-31', 2, '20'), row('2026-01-01', 3, '30')],
      '2025-12-01',
      '2026-01-31',
      'month',
      true,
    );

    expect(series).toEqual([
      {
        date: '2025-12-01',
        funded: { count: 3, amount: '30' },
        settled: { count: 0, amount: '0' },
        refunded: { count: 0, amount: '0' },
      },
      {
        date: '2026-01-01',
        funded: { count: 3, amount: '30' },
        settled: { count: 0, amount: '0' },
        refunded: { count: 0, amount: '0' },
      },
    ]);
  });

  it('gives a partially covered week the zeroes of a missing day', () => {
    const series = aggregateDailySeries(
      [row('2026-11-25', 1, '5')],
      '2026-11-25',
      '2026-11-27',
      'week',
      true,
    );

    expect(series).toHaveLength(1);
    expect(series[0]!.date).toBe('2026-11-23');
    expect(series[0]!.funded).toEqual({ count: 1, amount: '5' });
  });
});

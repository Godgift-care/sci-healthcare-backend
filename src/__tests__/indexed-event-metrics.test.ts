import { beforeEach, describe, expect, it } from 'vitest';

import { eventMetricLabels, eventsApplied, eventsSkipped } from '../lib/metrics.js';

beforeEach(() => {
  eventsApplied.reset();
  eventsSkipped.reset();
});

describe('indexed event metric labels', () => {
  it('preserves known contracts and names and groups unknown values into other', () => {
    expect(eventMetricLabels('registry', 'provider_registered')).toEqual({
      contract: 'registry', name: 'provider_registered',
    });
    expect(eventMetricLabels('voucher', 'voucher_created')).toEqual({
      contract: 'voucher', name: 'voucher_created',
    });
    expect(eventMetricLabels('arbitrary-contract-id', 'unexpected_event_123')).toEqual({
      contract: 'other', name: 'other',
    });
    expect(eventMetricLabels('receipt', 'unexpected_event_123')).toEqual({
      contract: 'receipt', name: 'other',
    });
  });

  it('counts a mixed batch by contract and name without unbounded series', async () => {
    const batch = [
      { contract: 'registry', name: 'provider_registered', skipped: false },
      { contract: 'registry', name: 'provider_registered', skipped: false },
      { contract: 'voucher', name: 'voucher_created', skipped: false },
      { contract: 'voucher', name: 'unknown_new_event', skipped: true },
      { contract: 'unrecognised-contract', name: 'unrecognised_name', skipped: true },
    ];
    for (const event of batch) {
      const labels = eventMetricLabels(event.contract, event.name);
      (event.skipped ? eventsSkipped : eventsApplied).inc(labels);
    }
    const applied = await eventsApplied.get();
    const skipped = await eventsSkipped.get();
    expect(applied.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ labels: { contract: 'registry', name: 'provider_registered' }, value: 2 }),
      expect.objectContaining({ labels: { contract: 'voucher', name: 'voucher_created' }, value: 1 }),
    ]));
    expect(skipped.values).toEqual(expect.arrayContaining([
      expect.objectContaining({ labels: { contract: 'voucher', name: 'other' }, value: 1 }),
      expect.objectContaining({ labels: { contract: 'other', name: 'other' }, value: 1 }),
    ]));
    expect(applied.values).toHaveLength(2);
    expect(skipped.values).toHaveLength(2);
  });
});

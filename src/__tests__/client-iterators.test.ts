import { describe, expect, it } from 'vitest';

import { createClient } from '../../packages/client/dist/index.js';

/**
 * #286 — async iterators over paginated lists, and #290 — `streamEvents`,
 * the iterator over the live stream, exercised against a stub transport (no
 * server, no sockets) so the request counting, the cursor loop and the frame
 * boundaries are observable directly.
 */

type Recorded = { url: string };

/** A `fetch` that serves canned JSON pages and records each request. */
function stubJsonFetch(pages: Record<string, unknown>[]): {
  fetchImpl: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  let call = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    requests.push({ url });
    const body = pages[call] ?? {};
    call += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, requests };
}

describe('client paginated iterators (#286)', () => {
  it('walks every page and stops cleanly at the last one', async () => {
    const { fetchImpl, requests } = stubJsonFetch([
      { vouchers: [{ id: '1' }, { id: '2' }], nextCursor: 'c1' },
      { vouchers: [{ id: '3' }], nextCursor: 'c2' },
      { vouchers: [{ id: '4' }], nextCursor: null },
    ]);
    const client = createClient({ baseUrl: 'http://x.invalid', fetch: fetchImpl });

    const seen: string[] = [];
    for await (const v of client.vouchersIterate({ provider: 'GABC' })) {
      seen.push(v.id);
    }

    expect(seen).toEqual(['1', '2', '3', '4']);
    // Three pages: the loop requested a page only while a cursor came back.
    expect(requests.length).toBe(3);
    // The cursor from each page was carried into the next request.
    expect(requests[1]!.url).toContain('cursor=c1');
    expect(requests[2]!.url).toContain('cursor=c2');
  });

  it('makes no further request once the consumer breaks out of the loop', async () => {
    const { fetchImpl, requests } = stubJsonFetch([
      { vouchers: [{ id: '1' }, { id: '2' }], nextCursor: 'c1' },
      { vouchers: [{ id: '3' }, { id: '4' }], nextCursor: 'c2' },
      { vouchers: [{ id: '5' }], nextCursor: null },
    ]);
    const client = createClient({ baseUrl: 'http://x.invalid', fetch: fetchImpl });

    const collected: string[] = [];
    for await (const v of client.vouchersIterate()) {
      collected.push(v.id);
      if (collected.length === 2) break; // leave mid-first-page
    }

    expect(collected).toEqual(['1', '2']);
    // Only the first page was ever fetched: leaving the loop suspended at a
    // yield never fires the next request.
    expect(requests.length).toBe(1);
  });

  it('iterates providers, receipts and the (uncursored) services catalogue', async () => {
    const providers = stubJsonFetch([{ providers: [{ address: 'GA' }], nextCursor: null }]);
    const pc = createClient({ baseUrl: 'http://x.invalid', fetch: providers.fetchImpl });
    const gotProviders: string[] = [];
    for await (const p of pc.providersIterate()) gotProviders.push(p.address);
    expect(gotProviders).toEqual(['GA']);

    const receipts = stubJsonFetch([
      { receipts: [{ voucherId: 'r1' }], nextCursor: 'rc' },
      { receipts: [{ voucherId: 'r2' }], nextCursor: null },
    ]);
    const rc = createClient({ baseUrl: 'http://x.invalid', fetch: receipts.fetchImpl });
    const gotReceipts: string[] = [];
    for await (const r of rc.receiptsIterate({ provider: 'G' })) gotReceipts.push(r.voucherId);
    expect(gotReceipts).toEqual(['r1', 'r2']);

    const services = stubJsonFetch([{ total: 2, services: [{ code: 101 }, { code: 102 }] }]);
    const sc = createClient({ baseUrl: 'http://x.invalid', fetch: services.fetchImpl });
    const codes: number[] = [];
    for await (const s of sc.servicesIterate()) codes.push(s.code);
    expect(codes).toEqual([101, 102]);
    // One request: the services route is a single page.
    expect(services.requests.length).toBe(1);
  });
});

describe('client.streamEvents (#290)', () => {
  /** A `fetch` that answers every request with one SSE body and ends it. */
  function sseFetch(frames: (call: number) => string[]): typeof fetch {
    let calls = 0;
    return (async () => {
      const mine = calls;
      calls += 1;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of frames(mine)) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
  }

  const frame = (type: string, voucherId: string, ledger: number, status = 'Funded'): string =>
    `data: {"type":"${type}","voucherId":"${voucherId}","providerAddress":"GA",` +
    `"status":"${status}","ledger":${ledger},"txHash":"aa","at":"2026-01-01T00:00:00Z"}\n\n`;

  /** Collects from the iterator and stops it with the caller's abort. */
  async function collect(
    client: ReturnType<typeof createClient>,
    expected: number,
    filters: { voucher?: string; provider?: string },
    options: { minBackoffMs?: number; maxBackoffMs?: number } = {},
  ): Promise<string[]> {
    const controller = new AbortController();
    const seen: string[] = [];
    for await (const event of client.streamEvents(filters, {
      signal: controller.signal,
      ...options,
    })) {
      seen.push(`${event.type}:${event.voucherId}:${event.ledger}`);
      if (seen.length === expected) controller.abort();
    }
    return seen;
  }

  it('yields one event per data frame and ignores comment frames', async () => {
    const client = createClient({
      baseUrl: 'http://x.invalid',
      fetch: sseFetch(() => [
        ': connected\n\n',
        frame('voucher_funded', 'v1', 10),
        ': heartbeat\n\n',
        frame('voucher_settled', 'v1', 11, 'Settled'),
      ]),
    });

    expect(await collect(client, 2, { provider: 'GA' })).toEqual([
      'voucher_funded:v1:10',
      'voucher_settled:v1:11',
    ]);
  });

  it('reassembles a frame split across two chunks', async () => {
    const whole = frame('voucher_disbursed', 'v7', 21, 'Disbursed');
    const client = createClient({
      baseUrl: 'http://x.invalid',
      // The boundary falls inside the JSON value, which is the case a
      // byte-at-a-time reader has to survive.
      fetch: (async () => {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`: connected\n\n${whole.slice(0, 24)}`));
            controller.enqueue(encoder.encode(whole.slice(24)));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }) as typeof fetch,
    });

    expect(await collect(client, 1, { voucher: 'v7' })).toEqual(['voucher_disbursed:v7:21']);
  });

  it('follows a stream the server closed by reconnecting, not by ending', async () => {
    const client = createClient({
      baseUrl: 'http://x.invalid',
      fetch: sseFetch((call) =>
        call === 0
          ? [': connected\n\n', frame('voucher_funded', 'v1', 10)]
          : [frame('voucher_settled', 'v1', 11, 'Settled')],
      ),
    });

    // Zero backoff so the reconnect is observable inside the test.
    expect(
      await collect(client, 2, { provider: 'GA' }, { minBackoffMs: 0, maxBackoffMs: 0 }),
    ).toEqual(['voucher_funded:v1:10', 'voucher_settled:v1:11']);
  });

  it('rejects a stream request with no filter', async () => {
    const client = createClient({ baseUrl: 'http://x.invalid', fetch: sseFetch(() => []) });
    await expect(async () => {
      for await (const _ of client.streamEvents({})) void _;
    }).rejects.toThrow(/exactly one/);
  });

  it('surfaces a status the stream will not retry as a rejection', async () => {
    let calls = 0;
    const client = createClient({
      baseUrl: 'http://x.invalid',
      fetch: (async () => {
        calls += 1;
        return new Response('{"error":"not_found"}', { status: 404 });
      }) as typeof fetch,
    });

    await expect(async () => {
      for await (const _ of client.streamEvents({ provider: 'GA' })) void _;
    }).rejects.toThrow(/Stream request failed/);
    // 404 is fatal: reconnecting identically would be a loop, not a retry.
    expect(calls).toBe(1);
  });

  it('stops reading and reconnecting once the consumer breaks out of the loop', async () => {
    let calls = 0;
    let aborted = false;
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const client = createClient({
      baseUrl: 'http://x.invalid',
      // A transport that behaves like `fetch`: an aborted request signal makes
      // the pending body read reject with an `AbortError`.
      fetch: (async (_input, init) => {
        calls += 1;
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            source = controller;
            for (let i = 0; i < 100; i += 1) {
              controller.enqueue(encoder.encode(frame(`e${i}`, 'v', i)));
            }
            // Never closed: only the consumer can end this stream.
          },
        });
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          const failure = new Error('The operation was aborted');
          failure.name = 'AbortError';
          try {
            source?.error(failure);
          } catch {
            // An already-errored controller needs nothing.
          }
        });
        return new Response(stream, { status: 200 });
      }) as typeof fetch,
    });

    let count = 0;
    for await (const _ of client.streamEvents({ provider: 'GA' })) {
      void _;
      count += 1;
      if (count === 3) break;
    }
    expect(count).toBe(3);

    // Breaking out closes the handle, which aborts the still-open read on a
    // later tick — and a handle that closed never reconnects.
    for (let tick = 0; tick < 50 && !aborted; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(aborted).toBe(true);
    expect(calls).toBe(1);
  });
});

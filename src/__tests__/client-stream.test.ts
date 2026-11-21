import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiError,
  createClient,
  type StreamHandle,
  type VoucherStreamEvent,
} from '../../packages/client/dist/index.js';
import { buildApp } from '../app.js';
import { publishVoucherSignals } from '../lib/event-bus.js';

/**
 * #287 — the typed client's live-stream subscription.
 *
 * Driven against a real socket rather than `app.inject()`, because the
 * behaviour under test is what happens when a connection dies: reconnection,
 * backoff, resume and the heartbeat timeout are all properties of a stream
 * that outlives one request.
 */

type Conn = { write(frame: string): void; end(): void };

function openSse(res: ServerResponse): Conn {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  // Headers only reach the client with the first write, exactly as the real
  // route sends `: connected` before anything else.
  res.write(': connected\n\n');
  return {
    write: (frame: string) => res.write(frame),
    end: () => res.end(),
  };
}

type Harness = {
  baseUrl: string;
  /** One entry per request the client made, in order. */
  requests: { query: string; lastEventId: string | null; accept: string | undefined }[];
  close(): Promise<void>;
};

const harnesses: Harness[] = [];
const handles: StreamHandle[] = [];

/** What a harness hands `startServer`: one request, one stream. */
type SseListener = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** Node types a repeated header as an array; the client always sends one. */
function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

async function startServer(listener: SseListener): Promise<Harness> {
  const requests: Harness['requests'] = [];
  const tracked = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      query: url.searchParams.toString(),
      lastEventId: singleHeader(req.headers['last-event-id']),
      accept: req.headers.accept,
    });
    listener(req, res);
  });

  await new Promise<void>((resolve) => tracked.listen(0, '127.0.0.1', resolve));
  const port = (tracked.address() as AddressInfo).port;
  const sockets = new Set<import('node:net').Socket>();
  tracked.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let closedOnce = false;
  const harness: Harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      if (closedOnce) return;
      closedOnce = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve, reject) =>
        tracked.close((err?: Error | null) => (err ? reject(err) : resolve())),
      );
    },
  };
  harnesses.push(harness);
  return harness;
}

/** A stream that writes one frame per `data:` handed to it, then stays open. */
function frameServer(frames: string[]): { (req: IncomingMessage, res: ServerResponse): void } {
  return (_req, res) => {
    const conn = openSse(res);
    for (const frame of frames) conn.write(`data: ${frame}\n\n`);
  };
}

const SETTLED = JSON.stringify({
  type: 'voucher_settled',
  voucherId: '5001',
  providerAddress: 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK',
  status: 'Settled',
  ledger: 101,
  txHash: 'b'.repeat(64),
  at: '2026-11-18T00:00:00.000Z',
});

/** Settles the wait for a reconnect without sleeping on a fixed timer. */
async function until(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  for (const handle of handles.splice(0)) handle.close();
  for (const harness of harnesses.splice(0)) await harness.close();
});

describe('Client#stream', () => {
  it('delivers typed events for the filter it was given', async () => {
    const server = await startServer(frameServer([SETTLED]));
    const events: VoucherStreamEvent[] = [];
    const client = createClient({ baseUrl: server.baseUrl });

    const handle = client.stream({ voucher: '5001' }, { onEvent: (e) => events.push(e) });
    handles.push(handle);
    await until(() => events.length === 1);

    expect(handle.lastEventId).toBeNull();
    expect(events[0]).toEqual({
      type: 'voucher_settled',
      voucherId: '5001',
      providerAddress: expect.stringMatching(/^G/),
      status: 'Settled',
      ledger: 101,
      txHash: 'b'.repeat(64),
      at: '2026-11-18T00:00:00.000Z',
    });
    expect(server.requests[0]?.query).toBe('voucher=5001');
    expect(server.requests[0]?.accept).toBe('text/event-stream');

    handle.close();
    await handle.done;
  });

  it('requires exactly one filter and asks the server for nothing', () => {
    const client = createClient({ baseUrl: 'http://127.0.0.1:1' });

    expect(() => client.stream({})).toThrowError(/exactly one of/i);
    expect(() => client.stream({ voucher: '1', provider: 'G' })).toThrowError(ApiError);
    try {
      client.stream({ voucher: '1', provider: 'G' });
    } catch (error) {
      // Status 0 means the request never left, as for a network failure.
      expect((error as ApiError).status).toBe(0);
      expect((error as ApiError).error).toBe('invalid_query');
    }
  });

  it('passes the clinic filter and never an unfiltered query', async () => {
    const server = await startServer(frameServer([]));
    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream({ provider: 'GCLINIC' }, {});
    handles.push(handle);

    await until(() => server.requests.length === 1);
    expect(server.requests[0]?.query).toBe('provider=GCLINIC');
  });

  it('reconnects after the server drops the connection', async () => {
    const seen: Conn[] = [];
    const server = await startServer((_req, res) => {
      const conn = openSse(res);
      seen.push(conn);
      // First connection dies immediately after one frame; the second delivers.
      conn.write(`data: ${SETTLED}\n\n`);
      if (seen.length === 1) conn.end();
    });

    const events: VoucherStreamEvent[] = [];
    const reconnects: { attempt: number; delayMs: number }[] = [];
    const client = createClient({ baseUrl: server.baseUrl });

    const handle = client.stream(
      { voucher: '5001' },
      {
        onEvent: (e) => events.push(e),
        onReconnect: (info) => reconnects.push({ attempt: info.attempt, delayMs: info.delayMs }),
      },
      { minBackoffMs: 10, maxBackoffMs: 40, random: () => 1 },
    );
    handles.push(handle);

    await until(() => events.length >= 2 && reconnects.length >= 1);
    expect(reconnects[0]).toEqual({ attempt: 1, delayMs: 10 });
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
  });

  it('resumes with Last-Event-ID once the server frames ids', async () => {
    const server = await startServer((_req, res) => {
      const conn = openSse(res);
      conn.write(`id: 41\ndata: ${SETTLED}\n\n`);
      if (server.requests.length === 1) conn.end();
    });

    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream({ voucher: '5001' }, {}, { minBackoffMs: 5, random: () => 1 });
    handles.push(handle);

    await until(() => server.requests.length >= 2);
    await until(() => handle.lastEventId === '41');

    expect(server.requests[0]?.lastEventId).toBeNull();
    expect(server.requests[1]?.lastEventId).toBe('41');
  });

  it('close() stops reconnecting', async () => {
    let connects = 0;
    const server = await startServer((_req, res) => {
      connects += 1;
      openSse(res).end();
    });

    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream({ voucher: '5001' }, {}, { minBackoffMs: 5, random: () => 1 });

    await until(() => connects >= 2);
    handle.close();
    await handle.done;

    const at = connects;
    expect(handle.closed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(connects).toBe(at);
  });

  it('treats a silent connection as dead and reconnects', async () => {
    const server = await startServer((_req, res) => {
      openSse(res); // never writes again: no heartbeat, no frame
    });

    const errors: ApiError[] = [];
    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream(
      { voucher: '5001' },
      {
        onError: (error) => errors.push(error as ApiError),
      },
      { heartbeatTimeoutMs: 30, minBackoffMs: 5, random: () => 1 },
    );
    handles.push(handle);

    await until(() => errors.some((e) => e.error === 'heartbeat_timeout'));
    await until(() => server.requests.length >= 2);
  });

  it('reports a malformed frame without losing the feed', async () => {
    const server = await startServer((_req, res) => {
      const conn = openSse(res);
      conn.write('data: {not json}\n\n');
      conn.write(`data: ${SETTLED}\n\n`);
    });

    const events: VoucherStreamEvent[] = [];
    const errors: unknown[] = [];
    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream(
      { voucher: '5001' },
      {
        onEvent: (e) => events.push(e),
        onError: (error, info) => {
          errors.push(error);
          expect(info.fatal).toBe(false);
        },
      },
      { heartbeatTimeoutMs: 20, minBackoffMs: 5, random: () => 1 },
    );
    handles.push(handle);

    await until(() => events.length === 1);
    expect((errors[0] as ApiError).error).toBe('bad_frame');
  });

  it('stops rather than hammering a stream it is not allowed to open', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
    });

    const errors: { fatal: boolean; status: number }[] = [];
    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream(
      { voucher: '5001' },
      {
        onError: (error, info) =>
          errors.push({ fatal: info.fatal, status: (error as ApiError).status }),
      },
      { minBackoffMs: 5, random: () => 1 },
    );
    handles.push(handle);

    await handle.done;
    expect(errors).toEqual([{ fatal: true, status: 401 }]);
    expect(server.requests).toHaveLength(1);
  });

  it('retries a full stream, which is a momentary condition', async () => {
    const server = await startServer((_req, res) => {
      if (server.requests.length === 1) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"error":"stream_full"}');
        return;
      }
      openSse(res).write(`data: ${SETTLED}\n\n`);
    });

    const events: VoucherStreamEvent[] = [];
    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream(
      { voucher: '5001' },
      { onEvent: (e) => events.push(e) },
      {
        minBackoffMs: 5,
        random: () => 1,
      },
    );
    handles.push(handle);

    await until(() => events.length === 1);
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
  });

  it('grows the backoff exponentially up to the ceiling', async () => {
    const server = await startServer((_req, res) => {
      openSse(res).end();
    });

    const delays: number[] = [];
    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream(
      { voucher: '5001' },
      { onReconnect: (info) => delays.push(info.delayMs) },
      { minBackoffMs: 10, maxBackoffMs: 40, random: () => 1 },
    );

    await until(() => delays.length >= 5);
    handle.close();
    await handle.done;

    // 10, 20, 40, then capped: never smaller, never past the ceiling.
    expect(delays.slice(0, 5)).toEqual([10, 20, 40, 40, 40]);
  });

  it('restarts the backoff only once a connection has proved stable', async () => {
    let connects = 0;
    const server = await startServer((_req, res) => {
      connects += 1;
      const conn = openSse(res);
      // The third connection survives the stability window; the others are
      // accepted and closed at once, which must not look like success.
      if (connects === 3) setTimeout(() => conn.end(), 60);
      else conn.end();
    });

    const delays: number[] = [];
    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream(
      { voucher: '5001' },
      { onReconnect: (info) => delays.push(info.delayMs) },
      { minBackoffMs: 10, maxBackoffMs: 40, stableAfterMs: 30, random: () => 1 },
    );

    await until(() => delays.length >= 4);
    handle.close();
    await handle.done;

    // Growth, growth, reset after the connection that held, growth again.
    expect(delays.slice(0, 4)).toEqual([10, 20, 10, 20]);
  });

  it('keeps the client default headers on the stream request', async () => {
    let authorization: string | undefined;
    const server = await startServer((req, res) => {
      authorization = req.headers.authorization as string | undefined;
      openSse(res);
    });

    const client = createClient({
      baseUrl: server.baseUrl,
      headers: { authorization: 'Bearer token-1' },
    });
    const handle = client.stream({ voucher: '5001' }, {});
    handles.push(handle);

    await until(() => server.requests.length === 1);
    expect(authorization).toBe('Bearer token-1');
  });

  it('stops when the caller-supplied signal aborts', async () => {
    const server = await startServer((_req, res) => {
      openSse(res).end();
    });

    const controller = new AbortController();
    const client = createClient({ baseUrl: server.baseUrl });
    const handle = client.stream(
      { voucher: '5001' },
      {},
      { signal: controller.signal, minBackoffMs: 5, random: () => 1 },
    );

    await until(() => server.requests.length >= 1);
    controller.abort();
    await handle.done;

    const at = server.requests.length;
    await vi.waitFor(() => expect(server.requests.length).toBe(at), { timeout: 150, interval: 10 });
    expect(handle.closed).toBe(true);
  });
});

describe('Client#stream against the real /stream route', () => {
  const CLINIC = 'GDOOCNK2HL6TB2Y7FDYNNMG4GTM2PNPY4XCTWG2INFPYYVA66FCPZKBK';

  it('parses the frames this backend actually emits', async () => {
    const app = await buildApp({ logger: false });
    await app.ready();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    try {
      const client = createClient({ baseUrl: address });
      const events: VoucherStreamEvent[] = [];

      let opened = false;
      const handle = client.stream(
        { voucher: '77001' },
        {
          onOpen: () => {
            opened = true;
          },
          onEvent: (event) => events.push(event),
        },
      );

      // The route only forwards to listeners already subscribed, so the
      // publish has to wait for the connection to be live.
      await until(() => opened);
      const published = publishVoucherSignals([
        {
          type: 'voucher_settled',
          voucherId: '77001',
          providerAddress: CLINIC,
          status: 'Settled',
          ledger: 4242,
          txHash: 'c'.repeat(64),
          at: '2026-11-19T00:00:00.000Z',
        },
        {
          type: 'voucher_claimed',
          voucherId: '77002',
          providerAddress: CLINIC,
          status: 'Claimed',
          ledger: 4243,
          txHash: 'd'.repeat(64),
          at: '2026-11-19T00:00:05.000Z',
        },
      ]);
      // The bus answers with the listeners it handed work to — this one
      // connection — not the number of signals.
      expect(published).toBe(1);

      await until(() => events.length === 1, 4_000);
      // The other voucher's transition is filtered out server-side, and the
      // frame carries no beneficiary reference for the client to leak.
      expect(events).toEqual([
        {
          type: 'voucher_settled',
          voucherId: '77001',
          providerAddress: CLINIC,
          status: 'Settled',
          ledger: 4242,
          txHash: 'c'.repeat(64),
          at: '2026-11-19T00:00:00.000Z',
        },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/beneficiary/i);

      handle.close();
      await handle.done;
    } finally {
      await app.close();
    }
  });
});

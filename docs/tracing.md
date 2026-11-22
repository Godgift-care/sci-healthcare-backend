# Tracing (OpenTelemetry)

How to turn tracing on for this service and what it covers. The canonical
home of the OpenTelemetry setup notes, split out of the README.

[Back to the README](../README.md).

Tracing answers "where did the time go in that slow request or indexing
cycle": the Soroban RPC, the database, or our own code.

**On by environment, off by default.** The SDK starts only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set; with it unset nothing is started,
nothing is exported, and every tracing call in the codebase is a no-op
(`src/tracing.ts`). Which collector to talk to, over which protocol and with
what headers, is the standard OTLP contract (`OTEL_EXPORTER_OTLP_ENDPOINT`,
`OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS`) plus
`OTEL_SERVICE_NAME` to name the service; the app reads none of its own
tracing variables and stores no credentials.

What you get when it is on:

- **HTTP routes** — spans from the `http` instrumentation (client/server) and
  the Fastify instrumentation (one span per routed request).
- **Database queries** — the Prisma instrumentation wraps Prisma Client, and
  the indexer's projection transaction is additionally wrapped in an explicit
  `db.transaction` span bounded by the commit itself, so a slow transaction is
  visible even before per-query spans are.
- **RPC calls** — explicit `rpc.getHealth`, `rpc.getContractEvents` and
  `rpc.getLatestLedger` spans around the Soroban calls in `src/stellar/indexer.ts`.
- **Indexer cycles** — one `indexer.cycle` span per `tick()`, with an
  `indexer.events_applied` attribute, so a cycle's time splits into its RPC
  waits, its transaction and its idle poll.

To watch it locally, run any OTLP-speaking collector (Jaeger all-in-one
exposes `http://localhost:4318`), then:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_SERVICE_NAME=sci-healthcare-backend npm run dev
```

A single `GET /v1/vouchers` request should appear as one trace; one indexer
`tick` appears as an `indexer.cycle` with its child spans. The API entry
points call `startTracingIfConfigured()` as the first thing they do
(`src/index.ts`, `src/api.ts`, `src/worker.ts`).

One caveat, stated honestly because it is a property of Node's module system,
not of this wiring: auto-instrumentation hooks a module when that module is
first loaded, and this backend is an ESM package. The manual spans (cycles,
RPC, transaction) are always exact; for the HTTP/Fastify/Prisma instrumenta-
tions to catch their modules, start the process with the OpenTelemetry ESM
hook, e.g.
`node --experimental-loader=@opentelemetry/instrumentation/hook.mjs dist/index.js`.
`src/__tests__/tracing.test.ts` proves the gating (SDK constructed and
started only when the endpoint variable is set) and drives a real
`Indexer.tick()` against an in-memory exporter to assert the cycle, RPC and
transaction spans are emitted with their attributes.

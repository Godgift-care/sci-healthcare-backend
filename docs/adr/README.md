# Architecture decision records

A record of a decision that is expensive to reverse and impossible to explain
from the code alone. The code says what it does; these say why it does not do
the obvious other thing.

Read [../architecture.md](../architecture.md) for how the pipeline works.
Read these when you are about to ask "why is it like this".

## Index

| ID | Decision | Status |
| --- | --- | --- |
| [0000](0000-template.md) | The template and what earns a record | — |
| [0001](0001-i128-amounts-as-decimal-strings.md) | i128 amounts are decimal strings, never numbers | Accepted |
| [0002](0002-keyset-pagination-not-offset.md) | List routes paginate by keyset cursor, not by offset | Accepted |
| [0003](0003-single-writer-lease.md) | One indexer at a time, guarded by a database lease row | Accepted |
| [0004](0004-database-is-a-projection.md) | The database is a projection of the chain, and this service never writes to the chain | Accepted |
| [0005](0005-sqlite-committed-postgres-deployed.md) | One schema for two engines — SQLite committed, Postgres deployed | Accepted |

`src/__tests__/adr-docs.test.ts` keeps this table and the files in step.

## Decisions that are real but not yet recorded

Worth an ADR when someone next asks about them; listed here so the absence is
deliberate rather than an oversight.

- **The `/v1` prefix with unversioned aliases.** The compatibility promise,
  the `Deprecation` and successor-version headers and the notice period are
  documented in [../api-policy.md](../api-policy.md), which is where they are
  enforced from.
- **Amounts moving to a `Decimal` column.** The plan, the backfill and the
  reasons it cannot be one edit are in
  [../amount-numeric-migration-plan.md](../amount-numeric-migration-plan.md).
- **`beneficiaryRef` as an opaque HMAC rather than an identifier.** Covered by
  [../../README.md](../../README.md) webhooks section and
  [../privacy.md](../privacy.md); it would become its own record if the
  hashing scheme ever changed.
- **Webhook delivery: at-least-once, HMAC-signed, with an outbox.** Documented
  in the README; the retry schedule is a configuration decision, the outbox is
  not.

## Writing one

Copy [0000-template.md](0000-template.md). A record is written after the code
lands, and if it contradicts the code the code wins until the record is
corrected — which is the failure mode the test above exists to catch.

# ADR-0005: One schema for two engines — SQLite committed, Postgres deployed

**Status:** Accepted
**Date:** 2026-09-02 (`aa0cbfd` added `scripts/use-postgres.sh` on the same day as the schema)
**Code:** `prisma/schema.prisma` (`datasource.db.provider`), `scripts/use-postgres.sh`, `prisma/migrations/`, `.github/workflows/ci.yml` (`test`, `migrations` jobs)

## Context

The same schema has to serve two very different audiences. A contributor
cloning this repository should be able to `npm ci` and have a working database
in seconds, with no service to install and no credentials to obtain — and so
should the test suite, which runs thousands of queries per CI job. Production
is a long-lived, concurrently-written read model on a managed Postgres.

Prisma will not read the datasource `provider` from an environment variable;
it must be a literal in `schema.prisma`. So one file has to pick a side, and
the choice is visible in every clone.

## Decision

The committed schema says `sqlite`. Deployment switches it, deliberately and
in the open:

- `scripts/use-postgres.sh` rewrites the literal to `postgresql` before
  `prisma generate`, and CI runs it only in the Postgres leg of the test
  matrix. The switched file is never committed.
- Development and tests use `prisma db push` against a throwaway file;
  production uses **versioned migrations** in `prisma/migrations/`, applied on
  start by `npm run db:migrate` (`prisma migrate deploy`).
- CI runs the identical suite on both engines rather than treating SQLite as
  representative, because they disagree in ways that only show up with real
  data — string collation and comparison, and `NULL` ordering.
- The `migrations` job applies every migration to a fresh Postgres and then
  runs `prisma migrate diff --exit-code` against the schema. A schema change
  without a migration fails CI rather than being discovered on deploy.

Rejected: Postgres everywhere, with contributors running a container to do
anything (the onboarding cost is real and the CI matrix already pays it once);
two schema files to keep in step (they drift, and the drift is silent);
`db push` in production (no review, no history, no rollback point).

## Consequences

Worth knowing:

- A migration must be written against Postgres and then committed with the
  provider restored to SQLite. Forgetting the restore puts the SQLite job's
  `prisma generate` on the wrong dialect; committing the switch breaks every
  clone until someone reverts it.
- SQLite's type system is looser than Postgres's, so a schema that "works on
  SQLite" is not evidence of anything. Anything relying on `NUMERIC`, partial
  indexes, `LATERAL`, or case-sensitive `LIKE` needs the Postgres leg to be
  true — which is why the amount columns went `String` → `Decimal` through a
  plan (`docs/amount-numeric-migration-plan.md`) rather than an edit.
- Local databases are disposable by design (`prisma/test.db` is deleted and
  recreated on every test run). A Postgres `DATABASE_URL` in the environment
  is honoured as given — the suite drops and recreates the `public` schema
  rather than using `--force-reset`, but it does not verify the URL is a
  throwaway, so exporting one means exporting a database you are prepared to
  lose. The seed script is stricter: `assertLocalDatabase` refuses anything
  but a SQLite file or Postgres on loopback.
- Connection behaviour differs enough that pooling settings are a production
  concern only: `DATABASE_POOL_SIZE` and `DATABASE_STATEMENT_TIMEOUT_MS` are
  bound for the deployed instance and irrelevant to the file-backed one.
- Migration history is append-only. A `prisma migrate diff` failure in CI means
  either a missing migration or a hand-edited one; neither is fixed by
  deleting a directory from `prisma/migrations/`.

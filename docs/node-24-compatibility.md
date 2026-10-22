# Node 24 CI compatibility

The `node-24-compatibility` job in `.github/workflows/ci.yml` runs the coverage
suite on Node 24 against both SQLite and Postgres. It is non-blocking while Node
24 compatibility is being evaluated; required CI jobs continue to use Node 22.

## Results

| Engine | Status |
| --- | --- |
| SQLite | Pending first Node 24 CI run |
| Postgres | Pending first Node 24 CI run |

No blockers have been confirmed yet. The GitHub Actions job logs will contain
the failing step and error details if either engine exposes a compatibility
issue; update this table with the run result and any blocker once CI executes.
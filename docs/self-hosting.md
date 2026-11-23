# Self-hosting on one VPS

The whole stack — Postgres, the API and indexer, and TLS — runs from
`deployments/docker-compose.prod.yml` on a single server with two public ports. This is the
guide for that, start to finish.

It is a different thing from [`docker-compose.yml`](../docker-compose.yml),
which is the throwaway local stack: same image, no proxy, and a schema applied
with `prisma db push`. The production file publishes no database or API port,
takes its password from an env file, and applies the reviewed migrations in
[`prisma/migrations`](../prisma/migrations) instead of pushing a schema over
whatever is already there.

It is also optional. [Render](../README.md) remains the reference
deployment, and `render.yaml` sets it up in one click. A VPS is worth it when
the indexer has to run continuously and the free tier's spin-down stops being
acceptable: `/ready` goes 503 while the API sleeps, and a sleeping indexer is
the one failure mode this service cannot recover from on its own.

## What you need

- One server with a public IPv4 address. The service is small once it is
  running; the image build is the heavy part, because `npm ci` and
  `prisma generate` both want memory at the same time. On a 1 GB box, give the
  build swap to spill into or it will be killed part-way through with no more
  error than the container exiting.
- A hostname that resolves to it. `api.example.org` is enough — a subdomain
  keeps the certificate to one name and leaves the apex's mail records alone.
- Docker with the compose plugin, and permission to open ports 80 and 443.
- `jq` and `dig`, if you want the inspection commands here verbatim
  (`apt install jq dnsutils`); everything else runs from Docker or `curl`.
- The contract ids for the network you intend to index. The current testnet
  values are in the [README](../README.md); mainnet ids come from your own
  `scripts/deploy.sh` run in the contracts repo.

## 1. Point the DNS at the server first

Caddy's certificate is requested on the first boot, and it only succeeds if the
name already resolves and port 80 answers. Do the A record before you start
anything, and check it:

```bash
dig +short api.example.org
```

If you get the server's address back, the rest of this is mechanical. If you do
not, the first `up` will look like it worked — containers running, API healthy
inside the network — while `https://api.example.org` refuses to finish. That
ordering is the most common way to lose an hour to this guide.

## 2. Install Docker

```bash
apt-get update
apt-get install -y docker.io docker-compose-v2
docker compose version
```

Nothing is fetched and executed as root on the way in, which is the point: the
engine and the compose plugin both come from the distribution's own archive.
`docker-compose-v2` is the package that provides `docker compose` — with a
space, the subcommand form every command in this guide uses — as opposed to the
older standalone `docker-compose` binary, which will not do. If your release
does not carry that name, the same plugin from Docker's repository is
`docker-compose-plugin`; either is fine, and `docker compose version` is how you
tell which one you have.

Docker's own installer is the other route and is what most write-ups show. It
adds Docker's apt repository, and it is a script you are about to run as root, so
fetch it, read it, then run the file you read rather than a stream you did not:

```bash
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
less /tmp/get-docker.sh
sh /tmp/get-docker.sh
```

## 3. Open the firewall

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```

Only those three. 5432 is not on the list because the compose file never
publishes it, and it stays that way — see
[Why nothing else is published](#8-why-nothing-else-is-published).

## 4. Get the code and write the env file

```bash
git clone https://github.com/Godgift-care/sci-healthcare-backend.git
cd sci-healthcare-backend
cp .env.prod.example .env
```

`.env` is gitignored; [`.env.prod.example`](../.env.prod.example) is the
committed template, and the whole point of the split is that the secrets never
have to be in the repository or in an image layer. Fill in:

| Variable | What it is |
| --- | --- |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24`. Also feeds the API's `DATABASE_URL` — see below. |
| `SITE_ADDRESS` | The hostname from step 1, exactly: `api.example.org`. |
| `CORS_ORIGIN` | The frontend's origin. `*` is rejected in production, and the app will not start until this is a real URL. |
| `REGISTRY_CONTRACT_ID`, `VOUCHER_CONTRACT_ID`, `RECEIPT_CONTRACT_ID` | Required, 56 characters each. |
| `INDEXER_START_LEDGER` | The deploy ledger. Read the next section before leaving it at `0`. |

`STELLAR_NETWORK` and `NETWORK_PASSPHRASE` have to agree; the app compares them
at boot and exits if they do not, which is the reason both are in the file
rather than one derived from the other.

Anything else the app accepts can go in the same file — the full list with
defaults is the [Environment reference](environment.md). The database credentials are the one group
that is used twice: the `x-database-url` anchor at the top of the compose file
assembles `DATABASE_URL` from `POSTGRES_USER`, `POSTGRES_PASSWORD` and
`POSTGRES_DB`, so the API, the migration job and the Postgres container cannot
drift apart. To use a managed Postgres instead, change that one line to the
provider's connection string and delete the `db` service.

### The ledger you start at is a decision

`INDEXER_START_LEDGER=0` begins at the chain tip and indexes forward from
there. That is a legitimate choice and it is not the same as a complete
history: every voucher funded before the first boot is simply absent, and the
API answers 200 with a shrug while it is missing them.

Set it to the ledger the contracts were deployed at to backfill — `render.yaml`
uses `5063070` for the current testnet deployment. Two limits apply to a
backfill: Soroban RPC retains only a rolling window of ledgers, so a start that
far back may need an archive or a fresh deployment, and the catch-up is the
heavy part of the process. Watch it through:

```bash
watch -n 10 'curl -s https://api.example.org/ready | jq "{status, lag: .checks.lagLedgers, indexed: .checks.indexedLedger}"'
```

`lagLedgers` falling means the indexer is working. It going to zero is what
"caught up" means.

## 5. Start it

```bash
docker compose -f deployments/docker-compose.prod.yml up -d --build
```

The first build takes a few minutes: it installs dependencies, flips the Prisma
schema to Postgres (`scripts/use-postgres.sh`, which is what keeps a cloned
repo able to run its tests without a database), generates the client and builds
`dist/`. The `runtime` image that actually serves is production dependencies
only, and runs as the unprivileged `node` user.

Ordering is enforced, not hoped at: `migrate` waits for Postgres to report
healthy, applies the migrations and exits, and `api` starts only after that job
has *succeeded*. A schema that will not migrate therefore never serves traffic,
which is the failure mode worth designing against on a box nobody is watching.

Then:

```bash
curl -i https://api.example.org/ready
```

`HTTP/2 200` and `{"status":"ready", ...}` is the whole acceptance test for
this guide. `checks.indexedLedger` is `null` for the first few seconds — that
field is written by the indexer's first completed cycle, and readiness does not
wait for it. What else the fields mean is
[docs/RUNBOOK.md](RUNBOOK.md).

## 6. Backups

One command, and it runs the client from the container that already has it:

```bash
docker compose -f deployments/docker-compose.prod.yml exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" --format=custom "$POSTGRES_DB"' > sci-$(date +%F).dump
```

`--format=custom` matters: it is the only `pg_dump` output that lets
`pg_restore` pick tables, and it compresses itself. The single-quoted `sh -c`
is what makes the command work at all: `POSTGRES_USER` and `POSTGRES_DB` live in
the container's environment, and anything the host shell expands first expands
to nothing.

Two things to know before trusting a backup.

The database is a cache of the chain, so a lost one is not lost data — you can
drop it, set `INDEXER_START_LEDGER` to the deploy ledger and re-index. The
backup is about the *time* that takes and the window you lose, not about
permanently destroying anything. The exception is the cursor and the drift
records (`IndexerState`, `ReconcileMismatch`, `FailedEvent`), which describe
what this deployment has already verified and cannot be recovered by anyone
else.

Restore, which is also the way to test that a backup is a backup:

```bash
docker compose -f deployments/docker-compose.prod.yml stop api
docker compose -f deployments/docker-compose.prod.yml exec -T db \
  sh -c 'pg_restore -U "$POSTGRES_USER" --clean --if-exists -d "$POSTGRES_DB"' < sci-2026-11-18.dump
docker compose -f deployments/docker-compose.prod.yml up -d api
```

`--clean --if-exists` drops what the dump recreates instead of failing on the
first existing table, and the API is stopped for the duration so nothing writes
underneath it.

Nightly, keeping a week, in `/etc/cron.d/sci-backup` on the host:

```cron
17 3 * * * root cd /root/sci-healthcare-backend && docker compose -f deployments/docker-compose.prod.yml exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" --format=custom "$POSTGRES_DB"' > /root/backups/sci-$(date +\%F).dump && find /root/backups -name 'sci-*.dump' -mtime +7 -delete
```

The percentages have to be escaped in a crontab, and the redirect stays outside
the quoted `sh -c` because the file belongs to the host. A backup copied to only
one machine is a backup to none, so point `rsync` at a second host or a bucket
before you sleep on this.

Caddy's certificate and its Let's Encrypt account key live in the `caddy-data`
volume. Losing it costs a re-issue, and re-issues are rate-limited per
hostname, so snapshot that volume in the same window:

```bash
docker run --rm -v sci-healthcare_caddy-data:/data -v /root/backups:/backup alpine \
  tar czf /backup/caddy-data-$(date +%F).tar.gz -C /data .
```

The volume is named `<project>_<volume>`, and the project name is set to
`sci-healthcare` at the top of the compose file, so `sci-healthcare_caddy-data`
is stable whatever directory the file lives in. `docker volume ls` confirms it
before you write the cron job.

## 7. Upgrades

```bash
cd /root/sci-healthcare-backend
docker compose -f deployments/docker-compose.prod.yml ps        # what is running now
git fetch origin && git log --oneline HEAD..origin/main
```

Read that log before pulling. It is the only step with a judgement in it: a
release that changes `prisma/migrations` is a schema change and gets a backup
first, and a release whose migrations are not backward-compatible needs the API
stopped while they run rather than after.

```bash
# 1. Back up, if this release touches the schema.
docker compose -f deployments/docker-compose.prod.yml exec -T db \
  sh -c 'pg_dump -U "$POSTGRES_USER" --format=custom "$POSTGRES_DB"' > pre-upgrade.dump

# 2. Note where you are, so the rollback below has a target.
git rev-parse HEAD

# 3. Take the code and build the new image without starting it.
git pull --ff-only origin main
docker compose -f deployments/docker-compose.prod.yml build

# 4. Migrate first, with the old API still serving.
docker compose -f deployments/docker-compose.prod.yml run --rm --no-deps migrate
```

Step 4 is the one that makes this an upgrade rather than a restart, and it only
works because `prisma migrate deploy` is forward-only and idempotent: it
applies whatever is outstanding and exits, so running it against a current
database changes nothing. Doing it while the old API is up means the new schema
is in place before the new code reads it, and if it fails, the old code is
still serving and nothing has been swapped.

```bash
# 5. Start the new API.
docker compose -f deployments/docker-compose.prod.yml up -d
curl -sf https://api.example.org/ready >/dev/null && echo ready
```

To undo it:

```bash
docker compose -f deployments/docker-compose.prod.yml stop api
git checkout <the sha from step 2>
docker compose -f deployments/docker-compose.prod.yml up -d --build api
```

`--build` is what makes the rollback real: `up` on its own reuses the image it
already has, and an image built from the commit you have just reverted is not
that image. A database migrated forward is not automatically compatible with
the older code either — that is what the backup in step 1 is for, and it is why
a release that touches `prisma/migrations` is the one worth rehearsing
somewhere else first.

## 8. Why nothing else is published

`api` and `db` deliberately have no `ports:`, and for the API that is not
tidiness.

The app sets `trustProxy: true`, because behind a proxy it is the only way to
learn which client a request came from: Fastify takes the address from
`X-Forwarded-For`, which Caddy sets. It does not check who set it. So a
container reachable directly on 8080 is a service where any client can name any
IP it likes, and the per-IP rate limits — the thing standing between an
anonymous read API and someone enumerating every voucher — stop meaning
anything. Caddy is not just the TLS terminator here; it is the only way in, and
publishing the API alongside it quietly removes a control.

The same argument is why `db` has no port. A Postgres on a public interface
with a password is a question of time, and nothing outside this compose network
needs to ask it.

## 9. If it does not come up

| Symptom | Cause and fix |
| --- | --- |
| `up` fails with `required variable POSTGRES_PASSWORD is missing a value` | Compose interpolates from `.env` and refuses to guess, and an empty `KEY=` counts as missing. `cp .env.prod.example .env` and fill it in. |
| App exits at boot listing env problems | Validation is deliberately upfront: a missing contract id or a `CORS_ORIGIN` of `*` in production stops the process rather than serving blanks. The message names the variable. |
| `NETWORK_PASSPHRASE mismatch` | `STELLAR_NETWORK` and the passphrase disagree — mainnet's passphrase with `testnet` is the usual one. Set both from the same block in the example file. |
| Containers healthy, `https://` never completes | Certificate order failed: the name does not resolve here yet, or :80 is filtered. `docker compose -f deployments/docker-compose.prod.yml logs caddy`. |
| `/ready` answers 503 with `checks.database` an error | Postgres is not up or the password in `.env` no longer matches the volume's. The volume keeps the original credential after a password change — see the note in step 4. |
| `/ready` answers 503 with `checks.indexer: "gap"` | The cursor fell outside the RPC retention window. [docs/RUNBOOK.md](RUNBOOK.md) has the two ways out. |
| `/ready` is 200 but the data is old | `lagLedgers` climbing means the indexer is not keeping up. Check `checks.rpcUrl`, then the configured endpoints; a single public RPC is the usual limit. |

## See also

- [`deployments/docker-compose.prod.yml`](../deployments/docker-compose.prod.yml) — the stack itself.
- [docs/RUNBOOK.md](RUNBOOK.md) — alerts, the uptime probe, and what every
  `/ready` field means when it is not 200.
- [docs/architecture.md](architecture.md) — why the read model can be rebuilt
  from the chain, which is what makes a lost database survivable.
- [CONTRIBUTING.md](../CONTRIBUTING.md) — the local dev stack and the test
  suite, for changes rather than deployments.

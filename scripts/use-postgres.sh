#!/usr/bin/env bash
#
# Switches the Prisma datasource from SQLite to Postgres.
#
# Prisma will not read the provider from an environment variable, so it has
# to be a literal in the schema. The committed schema uses `sqlite` on
# purpose: a contributor can clone this repo and have a working database with
# no services to install, which matters more for onboarding than it costs
# here. Deployment targets run this first.
#
# It also lands the i128 amount columns as NUMERIC(39,0) (#273). Columns marked
# `// pg:decimal` in the schema are `String` on SQLite, which has no exact
# arbitrary-precision type, and `Decimal @db.Decimal(39, 0)` on Postgres. The
# API still serves decimal strings: `src/db.ts` turns every Decimal read back
# into a string. Migration `20261119000001_amount_numeric_to_decimal` is what
# changes the deployed columns.
set -euo pipefail

SCHEMA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/prisma/schema.prisma"

if grep -q 'provider = "postgresql"' "$SCHEMA"; then
  echo "schema already targets postgresql"
  exit 0
fi

sed -i 's/provider = "sqlite"/provider = "postgresql"/' "$SCHEMA"
grep -q 'provider = "postgresql"' "$SCHEMA" || { echo "failed to switch provider"; exit 1; }
sed -i -E '/\/\/ pg:decimal$/ s/\bString(\??)/Decimal\1 @db.Decimal(39, 0)/' "$SCHEMA"
[ "$(grep -c '@db.Decimal(39, 0)' "$SCHEMA")" -eq "$(grep -c '// pg:decimal$' "$SCHEMA")" ] \
  || { echo "failed to switch amount columns to Decimal"; exit 1; }
echo "schema switched to postgresql"

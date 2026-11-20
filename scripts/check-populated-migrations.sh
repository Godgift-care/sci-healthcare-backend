#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$ROOT/prisma/migrations"
mapfile -t migration_dirs < <(find "$MIGRATIONS" -mindepth 1 -maxdepth 1 -type d -print | sort)

if ((${#migration_dirs[@]} < 2)); then
  echo "At least two migrations are required to test an upgrade with existing data." >&2
  exit 1
fi

latest="${migration_dirs[-1]}"
temporary="$(mktemp -d)"
saved="$temporary/$(basename "$latest")"

restore_latest_migration() {
  if [[ -d "$saved" ]]; then
    mv "$saved" "$latest"
  fi
  rmdir "$temporary"
}
trap restore_latest_migration EXIT

cd "$ROOT"
mv "$latest" "$saved"
npx prisma migrate deploy
npx prisma db execute --stdin --schema "$ROOT/prisma/schema.prisma" \
  < "$ROOT/scripts/migration-fixture.sql"
mv "$saved" "$latest"

npx prisma migrate deploy
npx prisma db execute --stdin --schema "$ROOT/prisma/schema.prisma" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Voucher"
    WHERE "id" = 'migration-fixture-voucher'
      AND "amount" = 10000000::numeric
      AND "settledNet" = 9000000::numeric
      AND "settledFee" = 1000000::numeric
  ) THEN
    RAISE EXCEPTION 'Voucher amount fixture was not preserved by migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Receipt"
    WHERE "voucherId" = 'migration-fixture-voucher' AND "amount" = 10000000::numeric
  ) THEN
    RAISE EXCEPTION 'Receipt amount fixture was not preserved by migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "FaucetDrip"
    WHERE "id" = 'migration-fixture-drip' AND "amount" = 10000000::numeric
  ) THEN
    RAISE EXCEPTION 'FaucetDrip amount fixture was not preserved by migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Service"
    WHERE "id" = 'migration-fixture-service' AND "price" = 20000000::numeric
  ) OR NOT EXISTS (
    SELECT 1 FROM "ServicePriceChange"
    WHERE "id" = 'migration-fixture-price-change' AND "price" = 20000000::numeric
  ) THEN
    RAISE EXCEPTION 'Service price fixtures were not preserved by migration';
  END IF;
END $$;
SQL

npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel "$ROOT/prisma/schema.prisma" \
  --exit-code

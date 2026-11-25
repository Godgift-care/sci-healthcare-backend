INSERT INTO "Provider" ("address", "name", "country", "status", "registeredAt", "updatedAt")
VALUES (
  'migration-fixture-provider',
  'Migration Fixture Clinic',
  'KE',
  'Active',
  '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:00Z'
);

INSERT INTO "Service" ("id", "code", "label", "price", "active", "providerAddress")
VALUES (
  'migration-fixture-service',
  101,
  'Migration Fixture Service',
  '20000000',
  true,
  'migration-fixture-provider'
);

INSERT INTO "Voucher" (
  "id",
  "funder",
  "beneficiaryRef",
  "serviceCode",
  "amount",
  "status",
  "createdAt",
  "expiresAt",
  "settledNet",
  "settledFee",
  "updatedAt",
  "providerAddress"
)
VALUES (
  'migration-fixture-voucher',
  'migration-fixture-funder',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  101,
  '10000000',
  'Settled',
  '2026-01-01T00:00:00Z',
  '2026-02-01T00:00:00Z',
  '9000000',
  '1000000',
  '2026-01-01T00:00:00Z',
  'migration-fixture-provider'
);

INSERT INTO "Receipt" ("voucherId", "beneficiaryRef", "providerAddress", "serviceCode", "amount", "settledAt")
VALUES (
  'migration-fixture-voucher',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'migration-fixture-provider',
  101,
  '10000000',
  '2026-01-01T00:00:00Z'
);

INSERT INTO "FaucetDrip" ("id", "wallet", "amount", "ledger", "drippedAt")
VALUES ('migration-fixture-drip', 'migration-fixture-wallet', '10000000', 1, '2026-01-01T00:00:00Z');

INSERT INTO "ServicePriceChange" ("id", "providerAddress", "code", "price", "ledger", "changedAt")
VALUES (
  'migration-fixture-price-change',
  'migration-fixture-provider',
  101,
  '20000000',
  1,
  '2026-01-01T00:00:00Z'
);

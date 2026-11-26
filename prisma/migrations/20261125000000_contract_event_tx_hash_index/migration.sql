-- Speed up contract-event lookups by their Stellar transaction hash.
CREATE INDEX "ContractEvent_txHash_idx" ON "ContractEvent"("txHash");

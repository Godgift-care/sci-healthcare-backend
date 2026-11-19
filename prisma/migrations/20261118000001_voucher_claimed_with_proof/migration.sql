-- feat(indexer): record whether a claim carried a presence proof (#318).
-- Nullable: the claim event itself does not say, so a row written before its
-- options were read (or by any path that could not read them) stays null
-- rather than claiming the clinic did not prove presence.
ALTER TABLE "Voucher" ADD COLUMN     "claimedWithProof" BOOLEAN;

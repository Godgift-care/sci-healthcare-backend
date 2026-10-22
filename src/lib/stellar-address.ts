import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';

/**
 * A Stellar account address (`G…`) as a query parameter (#171).
 *
 * The length check alone accepts any 56 characters, so a typo — which almost
 * always breaks the strkey checksum — used to reach the database and come
 * back as an empty result. Checking the checksum turns it into a 400 that
 * says what is wrong.
 */
export const accountAddress = z
  .string()
  .length(56)
  .refine((s) => StrKey.isValidEd25519PublicKey(s), 'must be a valid Stellar account address');

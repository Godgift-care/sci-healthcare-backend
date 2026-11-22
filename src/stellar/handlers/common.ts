import type { Db } from './types.js';

/**
 * Look up the deployment ID for a given contract ID.
 * Returns null if the contract is not tracked in the Deployment table.
 */
export async function lookupDeploymentId(contractId: string, db: Db): Promise<number | null> {
  const deployment = await db.deployment.findUnique({
    where: { contractId },
    select: { id: true },
  });
  return deployment?.id ?? null;
}

import { type Database, inTransaction } from '../database';
import { requireMembership, requireNotArchived } from '../groups/groups';
import { Refusal } from '../refusal';

/** Who bears the provider's fee: the payer, the payee, or both, shared. */
export const FEE_BEARERS = ['payer', 'payee', 'shared'] as const;
export type FeeBearer = (typeof FEE_BEARERS)[number];

/** Who bears the provider's fee in `groupId` now. A group no owner has decided for: the payee. */
export async function feePolicyOf(db: Database, groupId: string): Promise<FeeBearer> {
  const row = await db.row<{ fee_borne_by: FeeBearer }>('SELECT fee_borne_by FROM groups WHERE id = ?', [groupId]);
  return row?.fee_borne_by ?? 'payee';
}

/**
 * Sets who bears the provider's fee in `groupId` to `borneBy`, by its owner. Anyone outside the group is refused with
 * `404`, as for a group that does not exist; a member who is not its owner with `403`; an archived group is read only,
 * so it is refused with `409`. Nothing else changes: the settlements already asked for keep the fee they were asked with.
 * Written in one transaction, under the write lock.
 */
export function setFeePolicy(db: Database, groupId: string, accountId: string, borneBy: FeeBearer): Promise<void> {
  return inTransaction(db, async () => {
    const group = await requireMembership(db, groupId, accountId);
    await requireNotArchived(db, groupId);
    if (group.ownerId !== accountId) {
      throw new Refusal(403, 'NotPermitted', 'Only the owner of the group may decide who bears the provider’s fee.');
    }
    await db.execute('UPDATE groups SET fee_borne_by = ? WHERE id = ?', [borneBy, groupId]);
  });
}

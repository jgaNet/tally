import type { Database, Querier } from './database';
import { type FeeBearer, FEE_BEARERS, isFeeBearer } from './fees';
import { assertNotArchived, findGroupOfMember } from './groups';
import { Refusal } from './refusal';
import { inReadSnapshot, inTransaction } from './transactions';

/**
 * Who bears the payment provider's fee of a group, until its owner decides: the payee, as every payment bore it before
 * the owner could decide.
 */
export const DEFAULT_FEE_BEARER: FeeBearer = 'payee';

/** Who bears the provider's fee in the group, as the group's row holds it. Reading changes nothing. */
export async function feeBearerOfGroup(db: Querier, groupId: string): Promise<FeeBearer> {
  const row = await db
    .prepare('SELECT fee_borne_by FROM groups WHERE id = ?')
    .get<{ fee_borne_by: FeeBearer }>(groupId);
  return row?.fee_borne_by ?? DEFAULT_FEE_BEARER;
}

/**
 * The fee policy of the group, as a current member of the group reads it: who bears the provider's fee. Refused with
 * `404` when `readerId` is not a current member, as if the group did not exist. Reading changes nothing.
 */
export async function feePolicyOf(db: Database, readerId: string, groupId: string): Promise<{ borneBy: FeeBearer }> {
  return inReadSnapshot(db, async snapshot => {
    if (!(await findGroupOfMember(snapshot, readerId, groupId))) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    return { borneBy: await feeBearerOfGroup(snapshot, groupId) };
  });
}

/**
 * Sets who bears the provider's fee of the group: its owner only. Refused with `404` for a non-member, `409` as
 * `GroupIsArchived` when the group is archived, `403` as `NotOwner` for a member who is not the owner, and `422` as
 * `FeeBearerIsUnsupported` when `borneBy` is not `payer`, `payee` or `shared`. A refused change changes nothing. Payments
 * already asked for keep the policy they were asked with (see `settlements.ts`).
 */
export async function setFeePolicy(
  db: Database,
  input: { groupId: string; callerId: string; borneBy: string },
): Promise<void> {
  const { groupId, callerId, borneBy } = input;
  await inTransaction(db, async tx => {
    const group = await findGroupOfMember(tx, callerId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    assertNotArchived(group);
    if (group.ownerId !== callerId) {
      throw new Refusal(403, 'NotOwner', 'Only the owner of the group may decide who bears its provider fee.');
    }
    if (!isFeeBearer(borneBy)) {
      throw new Refusal(422, 'FeeBearerIsUnsupported', `Who bears the fee must be one of ${FEE_BEARERS.join(', ')}.`);
    }
    await tx.prepare('UPDATE groups SET fee_borne_by = ? WHERE id = ?').run(borneBy, groupId);
  });
}

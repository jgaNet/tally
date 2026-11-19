import { IGroupMembers } from './IGroupMembers';

/**
 * Whether any of the accounts is deleted (request 35), asked through Ledger's own `GroupMembers` port: the payer and the members of a split. A
 * deleted account is in no new split and no recurring expense, and a recurring expense it is in ends on its day. Each account is asked once.
 */
export const anyDeletedOf = async (
  groupMembers: Pick<IGroupMembers, 'deletedOf'>,
  accountIds: readonly string[],
): Promise<boolean> => {
  for (const accountId of new Set(accountIds)) {
    if (await groupMembers.deletedOf(accountId)) return true;
  }
  return false;
};

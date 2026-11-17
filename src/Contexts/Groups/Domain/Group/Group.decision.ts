import { Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { Currency } from './Currency';
import { BalanceNotZeroException, OwnerCannotLeaveException } from './GroupExceptions';
import { GroupName } from './GroupName';

/** What a creation says: the name and the currency as typed. */
export interface CreateGroupCommand {
  name: string;
  currency: string;
}

/** The values a new group is made of, once they are allowed. */
export interface NewGroupValues {
  name: GroupName;
  currency: Currency;
}

/**
 * Group creation, as the storm decided it: a name of 1 to 60 characters that is not only spaces, and one of the six
 * currencies, fixed for good. It answers the validated values; the use case makes the group from them with
 * `Group.register`, which records `GroupCreated` (ADR 3 says why the group is not made here).
 */
export const decideCreateGroup: Decision<NewGroupValues, CreateGroupCommand, never, undefined> = (_given, command) => {
  const name = GroupName.create(command.name);
  if (name.isFailure()) return name;
  const currency = Currency.create(command.currency);
  if (currency.isFailure()) return currency;
  return decided({ name: name.data, currency: currency.data });
};

/** What a member leaving says: only who asks for it (the caller). */
export interface LeaveGroupCommand {
  by: string;
}

/** What a leaving is given: the group's owner, and the caller's balance in the group, read from Ledger (MemberBalances). */
export interface LeavingGroup {
  ownerId: string;
  balance: number;
}

/**
 * A member leaves a group, as the storm decided it (request 9): the owner never does, and a member does only once their
 * balance in the group is 0, so that the group's balances still add up to 0 (the balance is read from Ledger before this
 * decides). It answers no state: the use case takes the member out with `Group.leave`, which records `MemberLeft`.
 */
export const decideLeaveGroup: Decision<undefined, LeaveGroupCommand, never, LeavingGroup> = (
  { ownerId, balance },
  { by },
) => {
  if (by === ownerId) return Result.fail(new OwnerCannotLeaveException());
  if (balance !== 0) return Result.fail(new BalanceNotZeroException());
  return decided(undefined);
};

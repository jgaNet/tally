import { Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { Currency } from './Currency';
import { OwnerCannotLeaveException, PaymentWaitingException } from './GroupExceptions';
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

/**
 * What a leaving is given: the group's owner, the caller's balance in the group (read from Ledger, MemberBalances), and whether a
 * payment of the caller's through the provider is waiting, pending or being refunded (read from Settlements, WaitingPayments).
 */
export interface LeavingGroup {
  ownerId: string;
  balance: number;
  waiting: boolean;
}

/** What a leaving answers: the balance that passes to the owner in the same step (request 20). */
export interface LeftGroupValues {
  balancePassed: number;
}

/**
 * A member leaves a group, as request 20 has it: the owner never does; a member may whatever their balance, which passes to the
 * owner (the answer's `balancePassed`, so the group's balances still add up to 0); and a member does not while a payment of theirs
 * through the provider waits, since a payment that lands after they left would change a former member's balance. It answers the
 * balance to pass: the use case takes the member out with `Group.leave`, which records `MemberLeft` and `BalancePassed`.
 */
export const decideLeaveGroup: Decision<LeftGroupValues, LeaveGroupCommand, never, LeavingGroup> = (
  { ownerId, balance, waiting },
  { by },
) => {
  if (by === ownerId) return Result.fail(new OwnerCannotLeaveException());
  if (waiting) return Result.fail(new PaymentWaitingException());
  return decided({ balancePassed: balance });
};

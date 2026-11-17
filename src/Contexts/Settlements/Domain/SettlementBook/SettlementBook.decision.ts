import { Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import {
  InvalidSettlementAmountException,
  SettlementMoreThanIsOwedException,
  SettlementMoreThanOwedException,
  SettlementPayerNotMemberException,
  SettlementToSelfException,
} from './SettlementExceptions';

/** What a cash settlement says: the payee (the caller, who received the money), the payer, and the amount. */
export interface RecordCashSettlementCommand {
  payee: string;
  from: string;
  amount: number;
}

/**
 * What the decision is given (ADR 11): the members of the group, in the order they joined, and the balance of every member as
 * the balances read them: what a member owes (negative) or is owed (positive), a member not in the map at 0. The use case read
 * them after it read the book, so a settlement recorded since is counted here.
 */
export interface SettlementGiven {
  memberIds: readonly string[];
  balances: ReadonlyMap<string, number>;
}

/** The values of a settlement once they are allowed: who paid whom, how much. */
export interface NewSettlementValues {
  from: string;
  to: string;
  amount: number;
}

/**
 * Recording a settlement in cash (request 12, ADR 11): the payer is a member and not the payee; the amount is a whole number of
 * at least 1; it is no more than what the payer owes (the opposite of their balance) and no more than what the payee is owed
 * (their balance), both at the balances given. Otherwise it is refused and nothing changes. Answers the settlement's values; the
 * use case records it in the book with `SettlementBook.recordCash`.
 */
export const decideRecordCashSettlement: Decision<
  NewSettlementValues,
  RecordCashSettlementCommand,
  never,
  SettlementGiven
> = ({ memberIds, balances }, { payee, from, amount }) => {
  if (!memberIds.includes(from)) return Result.fail(new SettlementPayerNotMemberException());
  if (from === payee) return Result.fail(new SettlementToSelfException());
  if (!Number.isInteger(amount) || amount < 1) return Result.fail(new InvalidSettlementAmountException());
  if (amount > -(balances.get(from) ?? 0)) return Result.fail(new SettlementMoreThanOwedException());
  if (amount > (balances.get(payee) ?? 0)) return Result.fail(new SettlementMoreThanIsOwedException());
  return decided({ from, to: payee, amount });
};

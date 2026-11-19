import { Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';
import { AccountDeletedException, AccountSuspendedException, isCurrencyCode } from '@SharedKernel/Domain';

import { NettingCurrencyUnknownException, NettingWithSelfException, NothingToNetException } from './NettingExceptions';

/**
 * A group two members share, as the netting reads it: its currency, whether it is archived (request 27), and the balances the book counts,
 * what is still owed with the payments waiting at the provider counted as paid (`SettlementBook.stillOwed`, ADR 12).
 */
export interface SharedGroupGiven {
  groupId: string;
  currency: string;
  archived: boolean;
  balances: ReadonlyMap<string, number>;
}

/** The groups the two members share, the earliest created first; the use case reads them in one transaction with the books (ADR 17). */
export interface NetDebtsGiven {
  groups: readonly SharedGroupGiven[];
  /** Whether the asker is suspended (request 34): then it asks for no netting, in any group. */
  suspended: boolean;
  /** Whether the asker or the other member is deleted (request 35): then no netting is made between them. */
  deleted: boolean;
}

/** What a netting asks: who asks, with whom, and in which currency. */
export interface NetDebtsCommand {
  by: string;
  with: string;
  currency: string;
}

/** One settlement a netting makes: in `groupId`, `from` pays `to` `amount`. */
export interface NetTransfer {
  groupId: string;
  from: string;
  to: string;
  amount: number;
}

/** What a netting decides: its values and the settlements it makes, the caller's paid first, then the other's, each group in order. */
export interface NettingDecided {
  by: string;
  with: string;
  currency: string;
  amount: number;
  transfers: NetTransfer[];
}

/**
 * Netting what two members owe each other across their groups (request 32, ADR 30). In each group, what one can pay the other is the smaller of
 * what the payer still owes and what the payee is still owed, when the payer owes and the payee is owed; the amount netted is the smaller of
 * the two totals across the groups. Then the caller pays the other the amount, group by group in the order the groups were created, each the
 * smaller of what is left to net and what the caller can pay there, and the other pays the caller the same amount the same way. A netting with
 * oneself, in a currency that is not Tally's, or with nothing to net (an amount of 0) is refused and nothing changes. Pure: it reads no store and
 * no clock, and records nothing; the use case records the settlements and the netting.
 */
export const decideNetDebts: Decision<NettingDecided, NetDebtsCommand, never, NetDebtsGiven> = (
  { groups, suspended, deleted },
  { by, with: other, currency },
) => {
  if (suspended) return Result.fail(new AccountSuspendedException());
  if (deleted) return Result.fail(new AccountDeletedException());
  if (by === other) return Result.fail(new NettingWithSelfException());
  if (!isCurrencyCode(currency)) return Result.fail(new NettingCurrencyUnknownException());

  const shared = groups.filter(group => group.currency === currency && !group.archived);
  const outward = capacitiesOf(shared, by, other);
  const inward = capacitiesOf(shared, other, by);
  const amount = Math.min(totalOf(outward), totalOf(inward));
  if (amount === 0) return Result.fail(new NothingToNetException());

  const transfers = [...allocate(outward, by, other, amount), ...allocate(inward, other, by, amount)];
  return decided({ by, with: other, currency, amount, transfers });
};

/** What `payer` can pay `payee` in each group, in the order given: the smaller of what the payer owes and what the payee is owed, else 0. */
function capacitiesOf(
  groups: readonly SharedGroupGiven[],
  payer: string,
  payee: string,
): { groupId: string; capacity: number }[] {
  return groups.map(group => {
    const owes = Math.max(0, -(group.balances.get(payer) ?? 0));
    const owed = Math.max(0, group.balances.get(payee) ?? 0);
    return { groupId: group.groupId, capacity: Math.min(owes, owed) };
  });
}

const totalOf = (capacities: { capacity: number }[]): number =>
  capacities.reduce((sum, { capacity }) => sum + capacity, 0);

/** The settlements that pay `amount` from `payer` to `payee`, group by group, each the smaller of what is left and what the group allows. */
function allocate(
  capacities: { groupId: string; capacity: number }[],
  from: string,
  to: string,
  amount: number,
): NetTransfer[] {
  const transfers: NetTransfer[] = [];
  let left = amount;
  for (const { groupId, capacity } of capacities) {
    if (left === 0) break;
    const pay = Math.min(left, capacity);
    if (pay > 0) {
      transfers.push({ groupId, from, to, amount: pay });
      left -= pay;
    }
  }
  return transfers;
}

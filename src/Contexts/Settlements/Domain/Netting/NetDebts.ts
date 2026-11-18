import { IResult, Result } from '@Architecture/Domain';
import { CURRENCIES } from '@SharedKernel/Domain/Currency';

import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';
import {
  NettingWithSelfException,
  NothingToNetException,
  UnsupportedNettingCurrencyException,
} from '@Contexts/Settlements/Domain/Netting/NettingExceptions';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { MemberBalance } from '@Contexts/Settlements/Domain/Suggestion/DTOs';

/**
 * A group two members share, as a netting reads it (request 32): its book, its current members, whether it is archived, its currency,
 * and Ledger's balances of it as they are now (settled amounts included), in the order the groups were created.
 */
export interface SharedGroupDebts {
  groupId: string;
  book: SettlementBook;
  currency: string;
  archived: boolean;
  members: string[];
  balances: MemberBalance[];
}

/** What the caller asks: the other member (`with`), the currency, the groups they share, and the time the settlements are made. */
export interface NetDebtsCommand {
  by: string;
  with: string;
  currency: string;
  groups: SharedGroupDebts[];
  at: Date;
}

/**
 * The domain service NetDebts (request 32, docs/adr/0032): what `by` and `with` owe each other across the groups they share, netted in
 * one currency, as settlements that count at once.
 *
 * In each group, what `by` can pay `with` is the smaller of what `by` still owes and what `with` is still owed, when `by` owes and
 * `with` is owed (`SettlementBook.capacityOf()`, which counts the payments waiting at the provider as paid); the same, the other way
 * round, for what `with` can pay `by`. The amount netted is the smaller of the two totals, and 0 is refused (`NothingToNet`).
 *
 * The settlements are made group by group, in the order the groups were created: `by` pays `with` the amount, in each group the smaller
 * of what is left to net and what `by` can pay there; then `with` pays `by` the same amount, the same way. Each is recorded in its
 * group's book (`recordNet()`), which mutates the books given: the use case stores them, and the netting, in one transaction. Nothing is
 * decided on a book that is not stored at the version it was read at (CONC-OPTIMISTIC).
 *
 * Refused, and nothing recorded: a netting with oneself, a currency that is not one of Tally's, and a netting that nets nothing.
 */
export class NetDebts {
  static decide({ by, with: other, currency, groups, at }: NetDebtsCommand): IResult<Netting> {
    if (by === other) return Result.fail(new NettingWithSelfException());
    if (!(CURRENCIES as readonly string[]).includes(currency)) {
      return Result.fail(new UnsupportedNettingCurrencyException());
    }

    const shared = groups.filter(group => group.currency === currency && !group.archived);
    // Both legs are decided on the capacities read now, before any settlement of the netting is recorded (CONC-OPTIMISTIC).
    const legs = [
      { from: by, to: other, capacities: shared.map(group => capacityOf(group, by, other)) },
      { from: other, to: by, capacities: shared.map(group => capacityOf(group, other, by)) },
    ];
    const amount = Math.min(sum(legs[0].capacities), sum(legs[1].capacities));
    if (amount < 1) return Result.fail(new NothingToNetException());

    const settlements: string[] = [];
    for (const { from, to, capacities } of legs) {
      let left = amount;
      for (const [index, group] of shared.entries()) {
        const pay = Math.min(left, capacities[index]);
        if (pay < 1) continue;
        const recorded = group.book.recordNet({
          by,
          from,
          to,
          amount: pay,
          members: group.members,
          balances: balancesOf(group, from, to),
          archived: group.archived,
          at,
        });
        if (recorded.isFailure()) return Result.fail(recorded.error);
        settlements.push(recorded.data.id);
        left -= pay;
      }
      // The capacities add up to the amount netted, so a leg always pays all of it; anything else is a programming error.
      if (left !== 0) throw new Error(`A netting leg of ${amount} left ${left} unpaid`);
    }

    return Netting.create({ by, with: other, currency, amount, settlements });
  }
}

/** What `from` can pay `to` in the group, read from the balances as Ledger has them and the book's pending payments. */
function capacityOf(group: SharedGroupDebts, from: string, to: string): number {
  return group.book.capacityOf({ from, to, balances: balancesOf(group, from, to) });
}

function balancesOf(group: SharedGroupDebts, payer: string, payee: string): { payer: number; payee: number } {
  const balanceOf = (memberId: string) => group.balances.find(balance => balance.memberId === memberId)?.balance ?? 0;
  return { payer: balanceOf(payer), payee: balanceOf(payee) };
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

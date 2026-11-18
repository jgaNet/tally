import { IResult, Result } from '@Architecture/Domain';
import { isCurrency } from '@SharedKernel/Domain/Currency';

import { BalanceOfMember, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';
import {
  NettingWithSelfException,
  NothingToNetException,
  UnknownCurrencyException,
} from '@Contexts/Settlements/Domain/Netting/NettingExceptions';

/**
 * A group the two people share, in the currency, not archived, as the handler read it: its book (opened when it has no settlement
 * yet), its current members, and its balances. The groups are given in the order they were created, the earliest first.
 */
export interface NettingGroup {
  groupId: string;
  book: SettlementBook;
  members: string[];
  balances: BalanceOfMember[];
}

/**
 * The domain service that nets what two people owe each other across their groups (request 32, the storm `net-across-groups`).
 *
 * In each group, what `by` can pay `other` is the smaller of what `by` still owes and what `other` is still owed, the payments
 * waiting at the provider counted as paid; the same, the other way round, for what `other` can pay `by`. The amount netted is the
 * smaller of the two totals. When it is 0, nothing is netted and the netting is refused. Otherwise `by` pays `other` the amount, group
 * by group, in creation order, each group paying the smaller of what is left to net and what can be paid there; and `other` pays
 * `by` the same amount the same way, where they can. Each payment is recorded in its group's book as a settlement that is paid at
 * once (method `net`), and the netting is made of them, in the order made.
 *
 * It changes the books it is given and records nothing else: the handler saves the books and the netting in one transaction, and a
 * conflict on any of them decides the whole netting again (CONC-OPTIMISTIC), so it is all or nothing and no book is written past
 * what it owes.
 */
export class NetDebts {
  static between({
    by,
    other,
    currency,
    groups,
    at,
  }: {
    by: string;
    other: string;
    currency: string;
    groups: NettingGroup[];
    at: Date;
  }): IResult<Netting> {
    if (by === other) return Result.fail(new NettingWithSelfException());
    if (!isCurrency(currency)) return Result.fail(new UnknownCurrencyException());

    const byPays = groups.map(group => group.book.payable({ payer: by, payee: other, balances: group.balances }));
    const otherPays = groups.map(group => group.book.payable({ payer: other, payee: by, balances: group.balances }));
    const amount = Math.min(sum(byPays), sum(otherPays));
    if (amount === 0) return Result.fail(new NothingToNetException());

    const settlements: string[] = [];
    const directions = [
      { payer: by, payee: other, capacities: byPays },
      { payer: other, payee: by, capacities: otherPays },
    ];
    for (const { payer, payee, capacities } of directions) {
      let left = amount;
      for (const [index, group] of groups.entries()) {
        const payment = Math.min(left, capacities[index]);
        if (payment === 0) continue;

        const recorded = group.book.recordNet(
          { payer, payee, amount: payment, at, members: group.members, balances: group.balances },
          by,
        );
        if (recorded.isFailure()) return Result.fail(recorded.error);
        settlements.push(recorded.data._id);
        left -= payment;
      }
    }

    return Result.ok(Netting.create({ by, with: other, currency, amount, settlements }));
  }
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

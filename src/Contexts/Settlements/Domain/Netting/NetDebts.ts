import { AccountDeleted, AccountSuspended } from '@SharedKernel/Domain';
import { Exception, Id, IResult, Result } from '@Architecture/Domain';
import { Settlement, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import {
  NETTING_CURRENCIES,
  NettingWithOneself,
  NothingToNet,
  UnknownNettingCurrency,
} from '@Contexts/Settlements/Domain/Netting/NettingExceptions';

/** A group two members share, as a netting reads it in its transaction: its book, its balances and its members (request 32). */
export interface NettingGroup {
  readonly groupId: Id;
  readonly book: SettlementBook;
  readonly balances: ReadonlyMap<string, number>;
  readonly members: readonly string[];
}

/** What a netting made: the amount netted, and the settlements that made it, in the order they were made. */
export interface NettingPlan {
  readonly amount: number;
  readonly settlements: Settlement[];
}

/** The refusal of a netting between two members in a currency, before any group is read, or none (request 32). */
export function refusalOfNetting({
  by,
  with: other,
  currency,
  callerSuspended = false,
  otherDeleted = false,
}: {
  by: Id;
  with: Id;
  currency: string;
  /** Whether the member who asks is suspended (request 34): a suspended account nets nothing. */
  callerSuspended?: boolean;
  /** Whether the person netted with deleted their account (request 35): no one nets with a deleted account, refused by AccountDeleted. */
  otherDeleted?: boolean;
}): Exception | undefined {
  if (callerSuspended) return new AccountSuspended();
  if (otherDeleted) return new AccountDeleted();
  if (by.equals(other)) return new NettingWithOneself();
  if (!(NETTING_CURRENCIES as readonly string[]).includes(currency)) return new UnknownNettingCurrency();
  return undefined;
}

/**
 * NetDebts, the domain service of a netting (request 32, ADR 23). In each group the two share, what the first can pay the
 * second is the smaller of what the first still owes and what the second is still owed, when the first owes and the second is
 * owed; the same the other way round. The netting is the smaller of the two totals, and when that is 0 it is refused, and
 * nothing changes. The first's settlements come first, each group in the order the groups were given (the earliest first),
 * each the smaller of what is left to net and what can be paid there; then the second's, the same way. Each settlement is
 * recorded by its group's book, on the balances the caller read in this transaction, so no book is ever paid past what it owes.
 */
export class NetDebts {
  static net({
    by,
    with: other,
    currency,
    groups,
    at,
  }: {
    by: Id;
    with: Id;
    currency: string;
    groups: readonly NettingGroup[];
    at: Date;
  }): IResult<NettingPlan> {
    const refusal = refusalOfNetting({ by, with: other, currency });
    if (refusal) return Result.fail(refusal);

    const payByToOther = groups.map(group => payable(group, by, other));
    const payOtherToBy = groups.map(group => payable(group, other, by));
    const amount = Math.min(sum(payByToOther), sum(payOtherToBy));
    if (amount < 1) return Result.fail(new NothingToNet());

    const settlements: Settlement[] = [];
    for (const [payer, payee, capacities] of [
      [by, other, payByToOther],
      [other, by, payOtherToBy],
    ] as const) {
      let left = amount;
      for (const [index, group] of groups.entries()) {
        const take = Math.min(left, capacities[index]);
        if (take < 1) continue;
        left -= take;
        const recorded = group.book.recordNet({
          payer,
          payee,
          amount: take,
          balances: group.balances,
          members: group.members,
          at,
        });
        if (recorded.isFailure()) return Result.fail(recorded.error);
        settlements.push(recorded.data);
      }
    }
    return Result.ok({ amount, settlements });
  }
}

/** What `payer` can pay `payee` in this group: the smaller of what the payer still owes and what the payee is still owed. */
function payable(group: NettingGroup, payer: Id, payee: Id): number {
  const owing = group.book.stillOwing(group.balances);
  const owesByPayer = Math.max(0, -(owing.get(payer.value) ?? 0));
  const owedToPayee = Math.max(0, owing.get(payee.value) ?? 0);
  return Math.min(owesByPayer, owedToPayee);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

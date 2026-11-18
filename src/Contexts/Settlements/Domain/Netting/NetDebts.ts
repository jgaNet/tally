import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/** A group two members share in the currency asked, as a netting reads it: its book as it stands, and whether it is archived. */
export interface NettingGroup {
  readonly groupId: string;
  readonly book: SettlementBook;
  readonly archived: boolean;
}

/** One settlement a netting makes in one group: who pays whom, how much (in the group's currency's hundredths). */
export interface NettingPayment {
  readonly groupId: string;
  readonly from: string;
  readonly to: string;
  readonly amount: number;
}

/** What a netting makes: the amount netted, and the payments, the first member's to the second, then the second's to the first. */
export interface NettingPlan {
  readonly amount: number;
  readonly payments: readonly NettingPayment[];
}

/**
 * What two members can net across the groups they share (feature 32, request 32, the storm's `NetDebts` decision): in each group that is
 * not archived, what `from` can pay `to` there is the smaller of what `from` still owes and what `to` is still owed, when `from` owes and
 * `to` is owed; the amount netted is the smaller of the two totals, the one way and the other. Each direction's payments are made group by
 * group in the order the groups were given (the earliest made first), each the smaller of what is left to net and what the payer can pay
 * there. A group is paid in one direction only, since in it one of the two owes the other, so each group gets at most one payment.
 *
 * A pure function of the books as they stand (the balances, and the payments waiting at the provider, counted as paid): it asks no port
 * and reads no clock. Answers `undefined` when nothing can be netted, which is refused by name and changes nothing.
 */
export function planNetting(by: string, withId: string, groups: readonly NettingGroup[]): NettingPlan | undefined {
  const open = groups.filter(group => !group.archived);
  const total = (from: string, to: string) => open.reduce((sum, group) => sum + payable(group.book, from, to), 0);
  const amount = Math.min(total(by, withId), total(withId, by));
  if (amount < 1) return undefined;
  return {
    amount,
    payments: [...paymentsFrom(by, withId, open, amount), ...paymentsFrom(withId, by, open, amount)],
  };
}

/** What `from` can pay `to` in the group: the smaller of what `from` still owes and what `to` is still owed, or 0 unless both hold. */
function payable(book: SettlementBook, from: string, to: string): number {
  const owes = -book.balanceOf(from);
  const owed = book.balanceOf(to);
  return owes > 0 && owed > 0 ? Math.min(owes, owed) : 0;
}

/** The payments `from` makes to `to`, group by group, until the amount is netted. */
function paymentsFrom(from: string, to: string, groups: readonly NettingGroup[], amount: number): NettingPayment[] {
  const payments: NettingPayment[] = [];
  let left = amount;
  for (const group of groups) {
    const pay = Math.min(left, payable(group.book, from, to));
    if (pay < 1) continue;
    payments.push({ groupId: group.groupId, from, to, amount: pay });
    left -= pay;
  }
  return payments;
}

import { GroupBalance } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { WaitingSettlement } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';

/**
 * What each of the members still owes in a group (ADR 10): their balance as the expenses and the paid settlements count it,
 * with the payments waiting at the provider counted as paid, as a settlement moves the balances of its payer up and of its
 * payee down. A member owed money, or nothing, owes nothing and is not listed. Pure: the caller reads the balances and the
 * waiting payments, and says who the current members are.
 */
export function stillOwed({
  members,
  balances,
  waiting,
}: {
  members: string[];
  balances: GroupBalance[];
  waiting: WaitingSettlement[];
}): { memberId: string; owes: number }[] {
  const balance = new Map<string, number>();
  for (const { memberId, balance: amount } of balances) balance.set(memberId, amount);
  for (const { from, to, amount } of waiting) {
    balance.set(from, (balance.get(from) ?? 0) + amount);
    balance.set(to, (balance.get(to) ?? 0) - amount);
  }

  const owing: { memberId: string; owes: number }[] = [];
  for (const memberId of members) {
    const amount = balance.get(memberId) ?? 0;
    if (amount < 0) owing.push({ memberId, owes: -amount });
  }
  return owing;
}

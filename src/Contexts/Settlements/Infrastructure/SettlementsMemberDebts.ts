import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { IWaitingEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingEffects';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { IMemberDebts, MemberDebt } from '@Contexts/Settlements/Domain/Settlement/Ports/IMemberDebts';
import { IGroupCurrency } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupCurrency';

/**
 * Settlements' member debts, from its own ports: the balances Ledger has (GroupBalances), the payments waiting at the
 * provider (counted as paid, as the suggestions count them) and the current members Groups lists (SettlementMembers). It
 * reads group by group, each read on its own, so a settlement decided between two reads is seen by the next run. Each debt
 * is in its group's currency (GroupCurrency), which the group was made in (request 40).
 */
export class SettlementsMemberDebts implements IMemberDebts {
  constructor(
    private readonly balances: IGroupBalances,
    private readonly waiting: IWaitingEffects,
    private readonly members: ISettlementMembers,
    private readonly currencies: IGroupCurrency,
  ) {}

  async owedByMember(): Promise<MemberDebt[]> {
    const debts: MemberDebt[] = [];
    for (const groupId of await this.balances.groupIds()) {
      const currency = await this.currencies.currencyOf(groupId);
      if (currency === null) continue;
      const balances = await this.balances.balancesOf(groupId);
      const waiting = await this.waiting.effectsOf(groupId);
      for (const memberId of await this.members.currentMembers(groupId)) {
        // Tally tells a deleted account nothing any more (request 35): it is no one's debtor to remind.
        if (await this.members.isDeleted(memberId)) continue;
        const net = (balances.get(memberId) ?? 0) + (waiting.get(memberId) ?? 0);
        if (net < 0) debts.push({ groupId, memberId, owed: -net, currency });
      }
    }
    return debts;
  }
}

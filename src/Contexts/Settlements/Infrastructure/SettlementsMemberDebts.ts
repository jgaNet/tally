import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { IWaitingEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingEffects';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { IMemberDebts, MemberDebt } from '@Contexts/Settlements/Domain/Settlement/Ports/IMemberDebts';

/**
 * Settlements' member debts, from its own ports: the balances Ledger has (GroupBalances), the payments waiting at the
 * provider (counted as paid, as the suggestions count them) and the current members Groups lists (SettlementMembers). It
 * reads group by group, each read on its own, so a settlement decided between two reads is seen by the next run.
 */
export class SettlementsMemberDebts implements IMemberDebts {
  constructor(
    private readonly balances: IGroupBalances,
    private readonly waiting: IWaitingEffects,
    private readonly members: ISettlementMembers,
  ) {}

  async owedByMember(): Promise<MemberDebt[]> {
    const debts: MemberDebt[] = [];
    for (const groupId of await this.balances.groupIds()) {
      const balances = await this.balances.balancesOf(groupId);
      const waiting = await this.waiting.effectsOf(groupId);
      for (const memberId of await this.members.currentMembers(groupId)) {
        // Tally tells a deleted account nothing any more (request 35): it is no one's debtor to remind.
        if (await this.members.isDeleted(memberId)) continue;
        const net = (balances.get(memberId) ?? 0) + (waiting.get(memberId) ?? 0);
        if (net < 0) debts.push({ groupId, memberId, owed: -net });
      }
    }
    return debts;
  }
}

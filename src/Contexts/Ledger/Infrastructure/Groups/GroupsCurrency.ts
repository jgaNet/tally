import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';

/**
 * Ledger's port onto Groups for the group's currency, answered over Groups' read model: the group is read for its
 * member asking, so a group that is not theirs is not found (ADR 12). Membership is the read model's to say.
 */
export class GroupsCurrency implements IGroupCurrency {
  constructor(private groups: IGroupQueries) {}

  async currencyOf(groupId: string, askedBy: string): Promise<string | null> {
    const group = await this.groups.findGroupOf(askedBy, groupId);
    return group ? group.currency : null;
  }
}

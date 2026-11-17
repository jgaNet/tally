import { IGroupQueries } from '@Contexts/Groups/Domain/Group/Ports/IGroupQueries';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';

/**
 * Ledger's GroupCurrency, answered over Groups' read model (docs/adr/0020): the currency of a group, for a caller who is one of its
 * members. Translated here into Ledger's words: the currency's code, nothing else of the group.
 */
export class GroupCurrencyOfGroups implements IGroupCurrency {
  constructor(private readonly groups: IGroupQueries) {}

  async currencyOf(callerId: string, groupId: string): Promise<string | undefined> {
    const group = await this.groups.findGroupOf(callerId, groupId);
    return group?.currency;
  }
}

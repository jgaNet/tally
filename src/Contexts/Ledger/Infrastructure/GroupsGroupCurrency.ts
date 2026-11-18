import { Id } from '@Architecture/Domain';
import { IGroupCurrency as GroupsGroupCurrencyPort } from '@Contexts/Groups/Domain/Group/Ports/IGroupCurrency';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';

/** Ledger's GroupCurrency, answered from Groups' read side (ADR 14): the currency Groups made the group in. */
export class GroupsGroupCurrency implements IGroupCurrency {
  constructor(private readonly groups: GroupsGroupCurrencyPort) {}

  currencyOf(groupId: Id): Promise<string | null> {
    return this.groups.currencyOf(groupId.value);
  }
}

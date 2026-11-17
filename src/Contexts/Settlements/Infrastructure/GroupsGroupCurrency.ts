import { IGroupCurrency as GroupsGroupCurrencyPort } from '@Contexts/Groups/Domain/Group/Ports/IGroupCurrency';
import { IGroupCurrency } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupCurrency';

/**
 * Settlements' GroupCurrency, answered over Groups' read side (ADR 8): the currency Groups made the group in. Settlements
 * never reaches into Groups' application or infrastructure.
 */
export class GroupsGroupCurrency implements IGroupCurrency {
  constructor(private readonly groups: GroupsGroupCurrencyPort) {}

  currencyOf(groupId: string): Promise<string | null> {
    return this.groups.currencyOf(groupId);
  }
}

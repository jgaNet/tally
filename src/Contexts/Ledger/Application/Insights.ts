import { IResult, Result } from '@Architecture/Domain';
import { callerOf, query } from '@Architecture/Application/Lite/UseCase';

import { GroupCurrencyOf, IExpenseStore, InsightView } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupCurrency } from '@Contexts/Ledger/Application/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';

/**
 * What the signed-in person spent, by month, currency and category (feature 37, request 37, the storm's `GetMyInsights`): their shares in
 * the expenses of every group they are a member of now, each counted in its group's currency. A group they have left counts for nothing;
 * a deleted expense has no shares, so it counts for nothing. The groups and their currencies are read through the owned ports, and the
 * lines are the store's to answer in their order. Each person reads their own: the caller's id is the only account it reads.
 */
export const getMyInsights = query(
  'GetMyInsights',
  (expenses: IExpenseStore, groupMembers: IGroupMembers, groupCurrency: IGroupCurrency) =>
    async (_input: undefined, context): Promise<IResult<InsightView[]>> => {
      const memberId = callerOf(context);
      const groups: GroupCurrencyOf[] = [];
      for (const groupId of await groupMembers.groupsOf(memberId)) {
        const currency = await groupCurrency.currencyOf(groupId);
        if (currency !== undefined) groups.push({ groupId, currency });
      }
      return Result.ok(await expenses.insightsOf(memberId, groups));
    },
);

import { Module } from '@Architecture/Application';
import { groupMembership } from '@Contexts/Groups/module.local';
import { groupBalanceSums } from '@Contexts/Ledger/module.local';
import { GetSuggestedSettlementsQueryHandler } from '@Contexts/Settlements/Application/Queries';
import { GroupsSettlementMembers } from '@Contexts/Settlements/Infrastructure/GroupsSettlementMembers';
import { LedgerGroupBalances } from '@Contexts/Settlements/Infrastructure/LedgerGroupBalances';

/**
 * The Settlements context (conventions/domain.yaml, ADR 5). Its first request is the suggestion (feature 11): the
 * transfers that would bring every balance of a group to 0, read through two ports it owns. Its balances come from
 * Ledger's read side and its members, in their join order, from Groups' read side; the composition root does not
 * need to pass either, as this wiring imports only what those wirings export.
 */
export const localSettlementsModule = new Module({
  name: 'Settlements',
  queries: [
    new GetSuggestedSettlementsQueryHandler(
      new LedgerGroupBalances(groupBalanceSums),
      new GroupsSettlementMembers(groupMembership),
    ),
  ],
});

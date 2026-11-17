import { Module } from '@Architecture/Application';

import { memberBalances as ledgerMemberBalances } from '@Contexts/Ledger/module.local';
import { groupMembers as groupsMembers } from '@Contexts/Groups/module.local';
import { GetSuggestedSettlementsQueryHandler } from '@Contexts/Settlements/Application/Queries';
import { GroupBalancesFromLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesFromLedger';
import { SettlementMembersFromGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersFromGroups';

/**
 * The Settlements context, declared by checkpoint 2's strategic session before request 11 (conventions/domain.yaml, ADR 5),
 * and carried from request 11 on (ADR 6): the two ports it owns are answered over Ledger's and Groups' read models. Both are
 * read when they are asked, as the other wiring files' ports are (ADR 4).
 */
const balances = new GroupBalancesFromLedger(() => ledgerMemberBalances);
const members = new SettlementMembersFromGroups(() => groupsMembers);

export const localSettlementsModule = new Module({
  name: 'Settlements',
  queries: [new GetSuggestedSettlementsQueryHandler(balances, members)],
});

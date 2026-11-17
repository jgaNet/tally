import { Module } from '@Architecture/Application';

import { ledgerBalanceQueries } from '@Bootstrap/Fastify/readModels';
import { groupQueries } from '@Contexts/Groups/module.local';
import { GetSuggestedSettlementsQueryHandler } from '@Contexts/Settlements/Application/Queries';
import { LedgerGroupBalances } from '@Contexts/Settlements/Infrastructure/Ledger/LedgerGroupBalances';
import { GroupsSettlementMembers } from '@Contexts/Settlements/Infrastructure/Groups/GroupsSettlementMembers';

/**
 * The Settlements context (conventions/domain.yaml, ADR 6, ADR 7). A suggestion reads the balances through a port it owns,
 * answered over Ledger's balances read model, and the members in the order they joined through a port it owns, answered
 * over Groups' read model. Both read models are passed in, from the composition root and from Groups' wiring (ARCH-WIRING).
 * It has no command or reaction yet: the features that need them bring them.
 */
const groupBalances = new LedgerGroupBalances(ledgerBalanceQueries);
const settlementMembers = new GroupsSettlementMembers(groupQueries);

export const localSettlementsModule = new Module({
  name: 'Settlements',
  queries: [new GetSuggestedSettlementsQueryHandler(groupBalances, settlementMembers)],
});

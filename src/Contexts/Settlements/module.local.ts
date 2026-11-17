import { LiteModule } from '@Architecture/Application/Lite/LiteModule';

import { groupsReadModel, ledgerReadModel } from '@Bootstrap/Fastify/readModels';
import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';
import { GroupBalancesOfLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesOfLedger';
import { SettlementMembersOfGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersOfGroups';

/**
 * The Settlements context (conventions/domain.yaml, ADR 11, ADR 0012): the transfers that would bring the balances to 0. It has no
 * adapters of its own yet: the balances are read over Ledger's read model and the members over Groups', both opened by the
 * composition root, which keeps the modules from importing each other (docs/adr/0009).
 */
const balances = new GroupBalancesOfLedger(ledgerReadModel);
const members = new SettlementMembersOfGroups(groupsReadModel);

export const localSettlementsModule = new LiteModule({
  name: 'Settlements',
  useCases: [getSuggestedSettlements(balances, members)],
});

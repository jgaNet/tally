import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { ledgerBalancesReadModel } from '@Contexts/Ledger/module.local';
import { groupsMembersReadModel } from '@Contexts/Groups/module.local';
import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Settlements';
import { GroupBalancesOfLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesOfLedger';
import { SettlementMembersOfGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersOfGroups';

/**
 * The Settlements context, as data (ADR 9, ADR 10). It keeps no state of its own yet: the suggested transfers are read at the
 * request, from the balances Ledger keeps and the members Groups keeps, each through a port Settlements owns, answered over
 * the other context's read model. Both read models are given as functions, read at a request and not when the modules are
 * built, as the other wirings do (ADR 7).
 */
const groupBalances = new GroupBalancesOfLedger(() => ledgerBalancesReadModel);
const settlementMembers = new SettlementMembersOfGroups(() => groupsMembersReadModel);

export const localSettlementsModule = new LiteModule({
  name: 'Settlements',
  useCases: [getSuggestedSettlements(groupBalances, settlementMembers)],
});

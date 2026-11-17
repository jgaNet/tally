import { LiteModule } from '@Architecture/Application/Lite/LiteModule';

import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';
import { BalanceRoster, BalancesFromLedger } from '@Contexts/Settlements/Infrastructure/BalancesFromLedger';
import { GroupRoster, MembersFromGroups } from '@Contexts/Settlements/Infrastructure/MembersFromGroups';

/**
 * The Settlements context (conventions/domain.yaml, ADR 8, ADR 9): its wiring, as data. It keeps nothing of its own yet: the
 * suggested settlements (request 11) read the members of a group through `roster`, Groups' read model, and the balances through
 * `balances`, Ledger's read model, both given by the composition root; this file imports no other context. The module lists each
 * use case once.
 */
export function settlementsWiring(roster: GroupRoster, balances: BalanceRoster): LiteModule {
  return new LiteModule({
    name: 'Settlements',
    useCases: [getSuggestedSettlements(new MembersFromGroups(roster), new BalancesFromLedger(balances))],
  });
}

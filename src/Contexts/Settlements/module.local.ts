import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { getSuggestedSettlements } from '@Contexts/Settlements/Application/Suggestions';
import { getSettlement, recordCashSettlement } from '@Contexts/Settlements/Application/Settlements';
import { ISettlementRoster } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementRoster';
import { BalanceRoster, BalancesFromLedger } from '@Contexts/Settlements/Infrastructure/BalancesFromLedger';
import { GroupRoster, MembersFromGroups } from '@Contexts/Settlements/Infrastructure/MembersFromGroups';
import { SqliteSettlementRoster } from '@Contexts/Settlements/Infrastructure/SqliteSettlementRoster';
import {
  SqliteSettlementStore,
  settlementsTablesSchema,
} from '@Contexts/Settlements/Infrastructure/SqliteSettlementStore';

/**
 * The Settlements context (conventions/domain.yaml, ADRs 8, 9 and 10): its wiring, as data. Its tables are opened by the composition
 * root with `settlementsSchema`, after the groups' (they name a group). The suggested settlements (request 11) read the members of a
 * group through `roster`, Groups' read model, and the balances through `balances`, Ledger's read model; a cash settlement (request 12)
 * is decided in the group's book, read the same way and kept in this context's own tables. This file imports no other context. The
 * module lists each use case once.
 */
export const settlementsSchema = settlementsTablesSchema;

/**
 * What the settlements of a group do to its members' balances, as Settlements' read model gives it to Ledger (ADR 10). It is over the
 * database alone, so the composition root can build it before Ledger's own wiring, which counts it.
 */
export function settlementRoster(database: SqliteDatabase): ISettlementRoster {
  return new SqliteSettlementRoster(database);
}

export function settlementsWiring(database: SqliteDatabase, roster: GroupRoster, balances: BalanceRoster): LiteModule {
  const store = new SqliteSettlementStore(database);
  const members = new MembersFromGroups(roster);
  const counted = new BalancesFromLedger(balances);

  return new LiteModule({
    name: 'Settlements',
    useCases: [
      getSuggestedSettlements(members, counted),
      recordCashSettlement(store, members, counted, systemClock),
      getSettlement(store, members),
    ],
  });
}

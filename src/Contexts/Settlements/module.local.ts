import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { ledgerBalancesReadModel } from '@Contexts/Ledger/module.local';
import { groupsMembersReadModel } from '@Contexts/Groups/module.local';
import {
  getSettlement,
  getSuggestedSettlements,
  recordCashSettlement,
} from '@Contexts/Settlements/Application/Settlements';
import { GroupBalancesOfLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesOfLedger';
import { SettlementMembersOfGroups } from '@Contexts/Settlements/Infrastructure/SettlementMembersOfGroups';
import { SettlementsDatabase } from '@Contexts/Settlements/Infrastructure/SettlementsDatabase';
import { SqliteSettlements } from '@Contexts/Settlements/Infrastructure/SqliteSettlements';

/**
 * The Settlements context, as data (ADR 9, ADR 10, ADR 11). Its settlement books and settlements are in SQLite at
 * `SETTLEMENTS_DATABASE_PATH`, or the application's database file (`DATABASE_PATH`) when that is not set, read when the first
 * request needs it. It reads the balances through a port it owns over Ledger's balances read model, and the members through one
 * over Groups' read model; both read models are given as functions, read at a request and not when the modules are built (ADR 7).
 * Ledger reads the settlements through its own `SettledAmounts` port over `settlementsReadModel`, the one thing of this file
 * another context reaches.
 */
const database = new SettlementsDatabase(
  () => process.env.SETTLEMENTS_DATABASE_PATH || process.env.DATABASE_PATH || 'tally.sqlite',
);
export const settlementsReadModel = new SqliteSettlements(database);

const groupBalances = new GroupBalancesOfLedger(() => ledgerBalancesReadModel);
const settlementMembers = new SettlementMembersOfGroups(() => groupsMembersReadModel);

export const localSettlementsModule = new LiteModule({
  name: 'Settlements',
  useCases: [
    getSuggestedSettlements(groupBalances, settlementMembers),
    recordCashSettlement(settlementsReadModel, groupBalances, settlementMembers, systemClock),
    getSettlement(settlementsReadModel, settlementMembers),
  ],
});

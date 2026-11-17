import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';

import { SqliteBalanceQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteBalanceQueries';
import { SettlementsSettledAmounts } from '@Contexts/Ledger/Infrastructure/Settlements/SettlementsSettledAmounts';
import { SqliteSettlementQueries } from '@Contexts/Settlements/Infrastructure/Queries/SqliteSettlementQueries';

/**
 * Ledger's balances read model, for the Groups context (ADR 5). Groups asks it a member's balance when it decides
 * whether the member may leave. The composition root builds it, and not Ledger's wiring: Ledger's wiring already
 * imports Groups' wiring for Groups' read model, and a wiring that imported Ledger's back would close an import cycle.
 * It is the same stateless read over the application's file that Ledger's own wiring builds, and it counts the settlements
 * paid as Ledger does (ADR 8), so leaving a group counts them too.
 */
export const ledgerBalanceQueries = new SqliteBalanceQueries(
  applicationDatabase(),
  new SettlementsSettledAmounts(new SqliteSettlementQueries(applicationDatabase())),
);

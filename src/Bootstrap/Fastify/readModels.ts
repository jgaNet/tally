import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';

import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/Queries/SqliteGroupQueries';
import { SqliteBalanceQueries } from '@Contexts/Ledger/Infrastructure/Queries/SqliteBalanceQueries';
import { GroupsMembership } from '@Contexts/Ledger/Infrastructure/Groups/GroupsMembership';
import { SettlementsSettledAmounts } from '@Contexts/Ledger/Infrastructure/Settlements/SettlementsSettledAmounts';
import { SqliteSettlementQueries } from '@Contexts/Settlements/Infrastructure/Queries/SqliteSettlementQueries';

/**
 * Ledger's balances read model, for the Groups context (ADR 5). Groups asks it a member's balance when it decides
 * whether the member may leave, and what passes to the owner (request 20). The composition root builds it, and not Ledger's
 * wiring: Ledger's wiring already imports Groups' wiring for Groups' read model, and a wiring that imported Ledger's back
 * would close an import cycle. It is the same stateless read over the application's file that Ledger's own wiring builds:
 * it counts the settlements paid as Ledger does (ADR 8), and the balances passed on when members left (ADR 11), so leaving
 * a group counts them too.
 */
export const ledgerBalanceQueries = new SqliteBalanceQueries(
  applicationDatabase(),
  new SettlementsSettledAmounts(new SqliteSettlementQueries(applicationDatabase())),
  new GroupsMembership(new SqliteGroupQueries(applicationDatabase())),
);

/**
 * Settlements' read model, for Groups' port WaitingPayments (request 20, ADR 11): the payments through the provider that
 * have not ended, which keep a member in their group. The same stateless read over the application's file that Settlements'
 * own wiring builds; the composition root passes it, as it does the balances, so Groups' wiring need not import Settlements'.
 */
export const settlementReadModel = new SqliteSettlementQueries(applicationDatabase());

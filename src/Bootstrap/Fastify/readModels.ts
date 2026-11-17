import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/SqliteGroupQueries';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteExpenseQueries';
import { SettledAmountsOfSettlements } from '@Contexts/Ledger/Infrastructure/SettledAmountsOfSettlements';
import { SqliteSettlementQueries } from '@Contexts/Settlements/Infrastructure/SqliteSettlementQueries';

/**
 * The read models one context asks of another while its own transaction is open (docs/adr/0004, docs/adr/0009). Each is
 * a connection of its own to the application's file: the shared connection holds the file's turn for the whole transaction,
 * and a read on it would wait for itself. A connection of its own reads what is committed, which is what a membership and an
 * expense are.
 *
 * They are opened here, by the composition root, and not by the contexts' wiring files: Groups asks Ledger's balances and
 * Ledger asks Groups' members, so each wiring file would import the other, and the two modules would load in a cycle.
 */
export const groupsReadModel = new SqliteGroupQueries(new SqliteDatabase());
/** Settlements' read model, which Ledger reads what was settled through (docs/adr/0013). */
export const settlementsReadModel = new SqliteSettlementQueries(new SqliteDatabase());
/** Ledger's SettledAmounts: the settlements, counted by every balance Ledger reads. */
export const settledAmountsOfSettlements = new SettledAmountsOfSettlements(settlementsReadModel);
export const ledgerReadModel = new SqliteExpenseQueries(new SqliteDatabase(), settledAmountsOfSettlements);

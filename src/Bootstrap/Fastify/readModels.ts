import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/SqliteGroupQueries';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteExpenseQueries';

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
export const ledgerReadModel = new SqliteExpenseQueries(new SqliteDatabase());

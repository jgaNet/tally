import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/SqliteGroupQueries';
import { WaitingPaymentsOfSettlements } from '@Contexts/Groups/Infrastructure/WaitingPaymentsOfSettlements';
import { GroupMembersOfGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersOfGroups';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteExpenseQueries';
import { SettledAmountsOfSettlements } from '@Contexts/Ledger/Infrastructure/SettledAmountsOfSettlements';
import { SettlementAuditOfSettlements } from '@Contexts/Ledger/Infrastructure/SettlementAuditOfSettlements';
import { PassedBalancesOfGroups } from '@Contexts/Ledger/Infrastructure/PassedBalancesOfGroups';
import { SqliteSettlementQueries } from '@Contexts/Settlements/Infrastructure/SqliteSettlementQueries';
import { GroupBalancesOfLedger } from '@Contexts/Settlements/Infrastructure/GroupBalancesOfLedger';
import { OutstandingDebtsOfLedger } from '@Contexts/Settlements/Infrastructure/OutstandingDebtsOfLedger';

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
/** Ledger's SettlementAudit over Settlements' read model: the settlements' changes of money, as the group's audit reads them (request 28). */
export const settlementAuditOfSettlements = new SettlementAuditOfSettlements(settlementsReadModel);
/** Ledger's GroupMembers over Groups' read model: who is a member, and what the leaves passed to the owner (docs/adr/0019). */
export const groupMembersOfGroups = new GroupMembersOfGroups(groupsReadModel);
/** Ledger's PassedBalances over Groups' read model: the balances the leaves passed, as the group's audit reads them (request 28, docs/adr/0027). */
export const passedBalancesOfGroups = new PassedBalancesOfGroups(groupsReadModel);
export const ledgerReadModel = new SqliteExpenseQueries(
  new SqliteDatabase(),
  settledAmountsOfSettlements,
  groupMembersOfGroups,
);
/** Groups' WaitingPayments over Settlements' read model: a leave waits while a payment of the member is pending or refunding (docs/adr/0019). */
export const waitingPaymentsOfSettlements = new WaitingPaymentsOfSettlements(settlementsReadModel);
/**
 * Settlements' what-is-still-owed, read by Notifications' sweep (docs/adr/0018): the balances of every group, less the payments waiting
 * at the provider. It reads Ledger's balances and Settlements' read model, both opened above, so it is opened here as well.
 */
export const outstandingDebtsReadModel = new OutstandingDebtsOfLedger(
  new GroupBalancesOfLedger(ledgerReadModel),
  settlementsReadModel,
);

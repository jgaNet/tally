import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { groupsMembersReadModel } from '@Contexts/Groups/module.local';
import {
  deleteExpense,
  editExpense,
  getExpense,
  getGroupBalances,
  getGroupExpenses,
  getMemberStatement,
  recordExpense,
} from '@Contexts/Ledger/Application/Expenses';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/ExpenseEvents';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { BalancesCountingSettlements } from '@Contexts/Ledger/Infrastructure/BalancesCountingSettlements';
import { GroupMembersOfGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersOfGroups';
import { LedgerDatabase } from '@Contexts/Ledger/Infrastructure/LedgerDatabase';
import { SettledAmountsOfSettlements } from '@Contexts/Ledger/Infrastructure/SettledAmountsOfSettlements';
import { SqliteExpenses } from '@Contexts/Ledger/Infrastructure/SqliteExpenses';
import { settlementsReadModel } from '@Contexts/Settlements/module.local';

/**
 * The Ledger context, as data (ADR 1, ADR 5): its expenses in SQLite at `LEDGER_DATABASE_PATH`, or the application's
 * database file (`DATABASE_PATH`) when that is not set, read when the first request needs it. Ledger asks Groups who the
 * members of a group are through its own `GroupMembers` port, answered over Groups' read model, which Groups' wiring
 * exports and nothing else of Groups is reached through.
 */
const database = new LedgerDatabase(
  () => process.env.LEDGER_DATABASE_PATH || process.env.DATABASE_PATH || 'tally.sqlite',
);
const expenses = new SqliteExpenses(database);
const groupMembers = new GroupMembersOfGroups(() => groupsMembersReadModel);
/** What the group's settlements paid, read from Settlements' read model at a request, never when the modules are built (ADR 7, ADR 11). */
const settledAmounts = new SettledAmountsOfSettlements(() => settlementsReadModel);
/** The balances as every reader sees them: the expenses', plus the settlements (request 12). */
const balancesCountingSettlements = new BalancesCountingSettlements(expenses, settledAmounts, groupMembers);

/**
 * The balances, the read model of the balances, which Groups asks through its own `MemberBalances` port before a member leaves
 * (ADR 7), and Settlements asks for its suggestions (ADR 10): the one thing of Ledger another context reaches through this file. It
 * counts the settlements of the group (ADR 11). Groups' wiring imports this one and this one imports Groups' and Settlements', each for
 * the read model the other asks; all are read at a request (ADR 7).
 */
export const ledgerBalancesReadModel = balancesCountingSettlements;

export const localLedgerModule = new LiteModule({
  name: 'Ledger',
  domainEvents: [{ event: ExpenseRecordedEvent, handlers: [new ExpenseRecordedHandler()] }],
  useCases: [
    recordExpense(expenses, groupMembers, systemClock),
    getExpense(expenses, groupMembers),
    getGroupBalances(balancesCountingSettlements, groupMembers),
    getGroupExpenses(expenses, groupMembers),
    getMemberStatement(expenses, groupMembers),
    editExpense(expenses, groupMembers, systemClock),
    deleteExpense(expenses, groupMembers, systemClock),
  ],
});

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { groupsReadModel, settledAmountsOfSettlements } from '@Bootstrap/Fastify/readModels';
import {
  deleteExpense,
  editExpense,
  getExpense,
  getGroupBalances,
  getGroupExpenses,
  getMemberStatement,
  recordExpense,
} from '@Contexts/Ledger/Application/Expenses';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { GroupMembersOfGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersOfGroups';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteExpenseQueries';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';

/**
 * The Ledger context (conventions/domain.yaml, ADR 0001, ADR 0004): the expenses of each group and their splits. Its
 * adapters are the application's SQLite file; who may be in a split is asked of Groups' read model, which Groups' wiring
 * exports for this purpose; its clock is the system's, given to the use case that records a time.
 */
const expenses = new SqliteExpenseRepository(sharedDatabase);
const groupMembers = new GroupMembersOfGroups(groupsReadModel);
const expenseQueries = new SqliteExpenseQueries(sharedDatabase, settledAmountsOfSettlements, groupMembers);

export const localLedgerModule = new LiteModule({
  name: 'Ledger',
  useCases: [
    recordExpense(expenses, groupMembers, systemClock),
    getExpense(expenseQueries, groupMembers),
    getGroupBalances(expenseQueries, groupMembers),
    editExpense(expenses, groupMembers, systemClock),
    deleteExpense(expenses, groupMembers),
    getGroupExpenses(expenseQueries, groupMembers),
    getMemberStatement(expenseQueries, groupMembers),
  ],
  // An expense recorded is told to the other contexts as the published fact (request 17, docs/adr/0017).
  domainEvents: [{ event: ExpenseRecordedEvent, handlers: [new ExpenseRecordedHandler()] }],
});

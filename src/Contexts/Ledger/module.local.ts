import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { groupsReadModel } from '@Bootstrap/Fastify/readModels';
import {
  deleteExpense,
  editExpense,
  getExpense,
  getGroupBalances,
  getGroupExpenses,
  getMemberStatement,
  recordExpense,
} from '@Contexts/Ledger/Application/Expenses';
import { GroupMembersOfGroups } from '@Contexts/Ledger/Infrastructure/GroupMembersOfGroups';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteExpenseQueries';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';

/**
 * The Ledger context (conventions/domain.yaml, ADR 0001, ADR 0004): the expenses of each group and their splits. Its
 * adapters are the application's SQLite file; who may be in a split is asked of Groups' read model, which Groups' wiring
 * exports for this purpose; its clock is the system's, given to the use case that records a time.
 */
const expenses = new SqliteExpenseRepository(sharedDatabase);
const expenseQueries = new SqliteExpenseQueries(sharedDatabase);
const groupMembers = new GroupMembersOfGroups(groupsReadModel);

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
});

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { getGroupBalances } from '@Contexts/Ledger/Application/Balances';
import { getGroupExpenses, getMemberStatement } from '@Contexts/Ledger/Application/History';
import { deleteExpense, editExpense, getExpense, recordExpense } from '@Contexts/Ledger/Application/Expenses';
import { getOfferedRate } from '@Contexts/Ledger/Application/Rates';
import { ExpenseRecordedHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedHandler';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Expense';
import { ISettledAmounts } from '@Contexts/Ledger/Application/ISettledAmounts';
import { IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { IGroupCurrency } from '@Contexts/Ledger/Application/IGroupCurrency';
import { IOfferedRates } from '@Contexts/Ledger/Application/IOfferedRates';
import { IBalanceRoster } from '@Contexts/Ledger/Domain/Expense/Ports/IBalanceRoster';
import { SqliteBalanceRoster } from '@Contexts/Ledger/Infrastructure/SqliteBalanceRoster';
import { SqliteExpenseStore, ledgerTablesSchema } from '@Contexts/Ledger/Infrastructure/SqliteExpenseStore';

/**
 * The Ledger context (conventions/domain.yaml, ADRs 1, 6 and 10): its wiring, as data. Expenses are kept over the tables the
 * composition root opens with `ledgerSchema`, after the groups' (they name a group). Who may be in a split is Groups' roster,
 * given by the composition root (`roster`, Groups' wiring exports it): Ledger's own port is built over it, so Ledger imports
 * no part of Groups but the roster's type. What the settlements moved in a balance is given the same way (`settled`, ADR 10):
 * every balance Ledger reads counts the settlements recorded so far. The module lists each use case once.
 */
export const ledgerSchema = ledgerTablesSchema;

/**
 * The balances of a group's members, as Ledger's read model gives them to Groups when a member asks to leave (feature 9), and to
 * Settlements when it decides a settlement or suggests one. It is over the database, what the settlements moved (`settled`) and the
 * members Ledger asks (`groupMembers`, which carries what passed when members left, request 20), so the composition root can build it
 * before Ledger's own wiring: each is built over the database alone.
 */
export function ledgerBalanceRoster(
  database: SqliteDatabase,
  settled: ISettledAmounts,
  groupMembers: IGroupMembers,
): IBalanceRoster {
  return new SqliteBalanceRoster(database, settled, groupMembers);
}

/**
 * The Ledger module, over the database, Groups' members (`groupMembers`, built over Groups' roster), the group's currency
 * (`groupCurrency`, the same roster: an expense in another currency is converted to it, request 21), the rates a rates service
 * offers (`rates`, request 22: an expense in another currency takes the rate offered when its own is left out, and is checked
 * against it) and what the settlements moved. The composition root builds `groupMembers` once, so the balance read model and this
 * module share it.
 */
export function ledgerWiring(
  database: SqliteDatabase,
  groupMembers: IGroupMembers,
  groupCurrency: IGroupCurrency,
  rates: IOfferedRates,
  settled: ISettledAmounts,
): LiteModule {
  const expenses = new SqliteExpenseStore(database);

  return new LiteModule({
    name: 'Ledger',
    domainEvents: [{ event: ExpenseRecordedEvent, handlers: [new ExpenseRecordedHandler()] }],
    useCases: [
      recordExpense(expenses, groupMembers, groupCurrency, rates, systemClock),
      editExpense(expenses, groupMembers, groupCurrency, rates, systemClock),
      deleteExpense(expenses, groupMembers, groupCurrency, systemClock),
      getExpense(expenses, groupMembers),
      getOfferedRate(groupMembers, groupCurrency, rates, systemClock),
      getGroupBalances(expenses, groupMembers, settled),
      getGroupExpenses(expenses, groupMembers),
      getMemberStatement(expenses, groupMembers),
    ],
  });
}

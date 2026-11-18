import { Clock, Module } from '@Architecture/Application';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import {
  groupCurrencyForQueries,
  groupCurrencyInCommand,
  groupMembership,
  groupMembershipInCommand,
} from '@Contexts/Groups/module.local';
import { settlementEffects, settlementEffectsInCommand } from '@Contexts/Settlements/module.local';
import { IMemberBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalanceSums';
import { SqliteMemberBalanceSums } from '@Contexts/Ledger/Infrastructure/SqliteMemberBalanceSums';
import {
  DeleteExpenseCommandEvent,
  DeleteExpenseCommandHandler,
  EditExpenseCommandEvent,
  EditExpenseCommandHandler,
  RecordExpenseCommandEvent,
  RecordExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands';
import {
  GetExpenseQueryHandler,
  GetGroupBalancesQueryHandler,
  GetGroupExpensesQueryHandler,
  GetMemberStatementQueryHandler,
  GetOfferedRateQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { SqliteExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteExpenseRepository';
import { SqliteExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteExpenseQueries';
import { SqliteBalanceQueries } from '@Contexts/Ledger/Infrastructure/SqliteBalanceQueries';
import { SqliteGroupBalanceSumsInCommand } from '@Contexts/Ledger/Infrastructure/SqliteGroupBalanceSumsInCommand';
import { SettlementsSettledAmounts } from '@Contexts/Ledger/Infrastructure/SettlementsSettledAmounts';
import { GroupsMembers } from '@Contexts/Ledger/Infrastructure/GroupsMembers';
import { GroupsGroupCurrency } from '@Contexts/Ledger/Infrastructure/GroupsGroupCurrency';
import { SqliteStatementQueries } from '@Contexts/Ledger/Infrastructure/SqliteStatementQueries';
import { IGroupBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupBalanceSums';
import { ExpenseRecordedEventHandler } from '@Contexts/Ledger/Application/Events/ExpenseRecordedEventHandler';
import { ExpenseRecordedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import {
  SetUpRecurringExpenseCommandEvent,
  SetUpRecurringExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands/SetUpRecurringExpense';
import {
  StopRecurringExpenseCommandEvent,
  StopRecurringExpenseCommandHandler,
} from '@Contexts/Ledger/Application/Commands/StopRecurringExpense';
import {
  GetGroupRecurringExpensesQueryHandler,
  GetRecurringExpenseQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { RecurringExpenseDayCameEventHandler } from '@Contexts/Ledger/Application/Events/RecurringExpenseDayCameEventHandler';
import { RecurringExpenseDayCameEvent } from '@Contexts/Ledger/Domain/RecurringExpense/Events/RecurringExpenseEvents';
import { RecordRecurringExpensesJob } from '@Contexts/Ledger/Application/Jobs/RecordRecurringExpensesJob';
import { SqliteRecurringExpenseRepository } from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenseRepository';
import { SqliteRecurringExpenseQueries } from '@Contexts/Ledger/Infrastructure/SqliteRecurringExpenseQueries';
import { ExpenseEditedEvent } from '@Contexts/Ledger/Domain/Expense/Events/ExpenseEvents';
import { BudgetPassedEvent } from '@Contexts/Ledger/Domain/Budget/Events/BudgetEvents';
import { SetBudgetCommandEvent, SetBudgetCommandHandler } from '@Contexts/Ledger/Application/Commands/SetBudget';
import {
  RemoveBudgetCommandEvent,
  RemoveBudgetCommandHandler,
} from '@Contexts/Ledger/Application/Commands/RemoveBudget';
import { GetGroupBudgetsQueryHandler } from '@Contexts/Ledger/Application/Queries/GetGroupBudgets/GetGroupBudgetsQueryHandler';
import { ExpenseMonthBudgetEventHandler } from '@Contexts/Ledger/Application/Events/ExpenseMonthBudgetEventHandler';
import { BudgetPassedEventHandler } from '@Contexts/Ledger/Application/Events/BudgetPassedEventHandler';
import { SqliteBudgetRepository } from '@Contexts/Ledger/Infrastructure/SqliteBudgetRepository';
import { SqliteBudgetQueries } from '@Contexts/Ledger/Infrastructure/SqliteBudgetQueries';
import { SqliteMonthlySpend } from '@Contexts/Ledger/Infrastructure/SqliteMonthlySpend';
import { SqliteSplitTemplateRepository } from '@Contexts/Ledger/Infrastructure/SqliteSplitTemplateRepository';
import { SqliteSplitTemplateQueries } from '@Contexts/Ledger/Infrastructure/SqliteSplitTemplateQueries';
import {
  SaveTemplateCommandEvent,
  SaveTemplateCommandHandler,
} from '@Contexts/Ledger/Application/Commands/SaveTemplate';
import {
  ReplaceTemplateCommandEvent,
  ReplaceTemplateCommandHandler,
} from '@Contexts/Ledger/Application/Commands/ReplaceTemplate';
import {
  RemoveTemplateCommandEvent,
  RemoveTemplateCommandHandler,
} from '@Contexts/Ledger/Application/Commands/RemoveTemplate';
import { GetGroupTemplatesQueryHandler } from '@Contexts/Ledger/Application/Queries/GetGroupTemplates/GetGroupTemplatesQueryHandler';

/**
 * The Ledger context (conventions/domain.yaml, ADR 1, ADR 3, ADR 7): the expenses of each group, recorded with their equal
 * split, the members' balances read from them and from what the settlements paid, and read by the members of the group,
 * kept in the application's SQLite file (ADR 2). Who may be in a split is asked of Groups through the read model Groups'
 * wiring exports, and what was settled of Settlements' read model its wiring exports (ADR 7); neither wiring imports
 * this one.
 */
const database = SqliteDatabase.shared();

/** What the settlements paid, as Ledger reads it: outside a transaction for a query, inside the asking command's for a command. */
const settledForQueries = new SettlementsSettledAmounts(settlementEffects);
const settledInCommand = new SettlementsSettledAmounts(settlementEffectsInCommand);

/** Who passed what when a member left (request 20), as Ledger reads it through GroupMembers: outside a transaction, and inside the asking command's. */
const membersForQueries = new GroupsMembers(groupMembership);
const membersInCommand = new GroupsMembers(groupMembershipInCommand);

/**
 * Ledger's balance of a member as Groups asks it when a member leaves (MemberBalances, ADR 4), exported for a command:
 * it reads inside the asking command's transaction. The composition root hands it to Groups' module.
 */
export const memberBalanceSumsInCommand: IMemberBalanceSums = new SqliteMemberBalanceSums(
  database,
  settledInCommand,
  membersInCommand,
);

/**
 * The balances of each group as Settlements reads them (GroupBalances, ADR 5), exported for a query: outside any
 * transaction. The composition root's Settlements wiring takes it; this wiring does not import Settlements' module.
 */
export const groupBalanceSums: IGroupBalanceSums = new SqliteBalanceQueries(
  database,
  settledForQueries,
  membersForQueries,
);

/**
 * The balances of each group as a settlement is decided on them (GroupBalances, ADR 7), exported for a command: inside
 * the asking command's transaction, so that the second of two settlements decided at once reads the first one's.
 */
export const groupBalanceSumsInCommand: IGroupBalanceSums = new SqliteGroupBalanceSumsInCommand(
  database,
  settledInCommand,
  membersInCommand,
);

/**
 * The background job that records the recurring expenses (request 23, ADR 16), built by the composition root with the clock it
 * is given. It runs as a job of the application, never as a request; its members are asked inside its transactions.
 */
export function recordRecurringExpensesWith(clock: Clock): RecordRecurringExpensesJob {
  return new RecordRecurringExpensesJob(
    new SqliteRecurringExpenseRepository(database),
    new GroupsMembers(groupMembershipInCommand),
    clock,
  );
}

export function ledgerModuleWith(rates: IOfferedRates, clock: Clock): Module {
  return new Module({
    name: 'Ledger',
    commands: [
      {
        event: RecordExpenseCommandEvent,
        handlers: [
          new RecordExpenseCommandHandler(
            new SqliteExpenseRepository(database),
            new SqliteSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            new GroupsGroupCurrency(groupCurrencyInCommand),
            rates,
            clock,
          ),
        ],
      },
      {
        event: EditExpenseCommandEvent,
        handlers: [
          new EditExpenseCommandHandler(
            new SqliteExpenseRepository(database),
            new SqliteSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            new GroupsGroupCurrency(groupCurrencyInCommand),
            rates,
            clock,
          ),
        ],
      },
      {
        event: SetUpRecurringExpenseCommandEvent,
        handlers: [
          new SetUpRecurringExpenseCommandHandler(
            new SqliteRecurringExpenseRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: StopRecurringExpenseCommandEvent,
        handlers: [
          new StopRecurringExpenseCommandHandler(
            new SqliteRecurringExpenseRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: DeleteExpenseCommandEvent,
        handlers: [
          new DeleteExpenseCommandHandler(
            new SqliteExpenseRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: SetBudgetCommandEvent,
        handlers: [
          new SetBudgetCommandHandler(
            new SqliteBudgetRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: RemoveBudgetCommandEvent,
        handlers: [
          new RemoveBudgetCommandHandler(
            new SqliteBudgetRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: SaveTemplateCommandEvent,
        handlers: [
          new SaveTemplateCommandHandler(
            new SqliteSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: ReplaceTemplateCommandEvent,
        handlers: [
          new ReplaceTemplateCommandHandler(
            new SqliteSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: RemoveTemplateCommandEvent,
        handlers: [
          new RemoveTemplateCommandHandler(
            new SqliteSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
    ],
    domainEvents: [
      {
        event: ExpenseRecordedEvent,
        handlers: [
          new ExpenseRecordedEventHandler(),
          new ExpenseMonthBudgetEventHandler(
            new SqliteExpenseRepository(database),
            new SqliteBudgetRepository(database),
            new SqliteMonthlySpend(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: ExpenseEditedEvent,
        handlers: [
          new ExpenseMonthBudgetEventHandler(
            new SqliteExpenseRepository(database),
            new SqliteBudgetRepository(database),
            new SqliteMonthlySpend(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      { event: BudgetPassedEvent, handlers: [new BudgetPassedEventHandler()] },
      {
        event: RecurringExpenseDayCameEvent,
        handlers: [
          new RecurringExpenseDayCameEventHandler(
            new SqliteExpenseRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
    ],
    queries: [
      new GetExpenseQueryHandler(new SqliteExpenseQueries(database), new GroupsMembers(groupMembership)),
      new GetGroupBalancesQueryHandler(
        new SqliteBalanceQueries(database, settledForQueries, membersForQueries),
        membersForQueries,
      ),
      new GetGroupExpensesQueryHandler(new SqliteExpenseQueries(database), new GroupsMembers(groupMembership)),
      new GetMemberStatementQueryHandler(new SqliteStatementQueries(database), new GroupsMembers(groupMembership)),
      new GetRecurringExpenseQueryHandler(
        new SqliteRecurringExpenseQueries(database),
        new GroupsMembers(groupMembership),
      ),
      new GetGroupRecurringExpensesQueryHandler(
        new SqliteRecurringExpenseQueries(database),
        new GroupsMembers(groupMembership),
      ),
      new GetGroupBudgetsQueryHandler(new SqliteBudgetQueries(database), new GroupsMembers(groupMembership), clock),
      new GetGroupTemplatesQueryHandler(new SqliteSplitTemplateQueries(database), new GroupsMembers(groupMembership)),
      new GetOfferedRateQueryHandler(
        rates,
        new GroupsGroupCurrency(groupCurrencyForQueries),
        new GroupsMembers(groupMembership),
        clock,
      ),
    ],
  });
}

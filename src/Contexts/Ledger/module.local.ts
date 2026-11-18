import { Clock, Module } from '@Architecture/Application';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import {
  groupCurrencyForQueries,
  groupCurrencyInCommand,
  groupMembership,
  groupMembershipInCommand,
} from '@Contexts/Groups/module.local';
import {
  countedSettlements,
  countedSettlementsInCommand,
  settlementAuditEntries,
  settlementEffects,
  settlementEffectsInCommand,
} from '@Contexts/Settlements/module.local';
import { passedBalanceEntries } from '@Contexts/Groups/module.local';
import { IMemberBalanceSums } from '@Contexts/Ledger/Domain/Expense/Ports/IMemberBalanceSums';
import { PostgresMemberBalanceSums } from '@Contexts/Ledger/Infrastructure/PostgresMemberBalanceSums';
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
  GetMemberStatementCsvQueryHandler,
  GetMemberStatementQueryHandler,
  GetOfferedRateQueryHandler,
} from '@Contexts/Ledger/Application/Queries';
import { PostgresExpenseRepository } from '@Contexts/Ledger/Infrastructure/PostgresExpenseRepository';
import { PostgresExpenseQueries } from '@Contexts/Ledger/Infrastructure/PostgresExpenseQueries';
import { PostgresBalanceQueries } from '@Contexts/Ledger/Infrastructure/PostgresBalanceQueries';
import { PostgresGroupBalanceSumsInCommand } from '@Contexts/Ledger/Infrastructure/PostgresGroupBalanceSumsInCommand';
import { SettlementsSettledAmounts } from '@Contexts/Ledger/Infrastructure/SettlementsSettledAmounts';
import { GroupsMembers } from '@Contexts/Ledger/Infrastructure/GroupsMembers';
import { GroupsGroupCurrency } from '@Contexts/Ledger/Infrastructure/GroupsGroupCurrency';
import { PostgresStatementQueries } from '@Contexts/Ledger/Infrastructure/PostgresStatementQueries';
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
import { PostgresRecurringExpenseRepository } from '@Contexts/Ledger/Infrastructure/PostgresRecurringExpenseRepository';
import { PostgresRecurringExpenseQueries } from '@Contexts/Ledger/Infrastructure/PostgresRecurringExpenseQueries';
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
import { PostgresBudgetRepository } from '@Contexts/Ledger/Infrastructure/PostgresBudgetRepository';
import { PostgresBudgetQueries } from '@Contexts/Ledger/Infrastructure/PostgresBudgetQueries';
import { PostgresMonthlySpend } from '@Contexts/Ledger/Infrastructure/PostgresMonthlySpend';
import { PostgresSplitTemplateRepository } from '@Contexts/Ledger/Infrastructure/PostgresSplitTemplateRepository';
import { PostgresSplitTemplateQueries } from '@Contexts/Ledger/Infrastructure/PostgresSplitTemplateQueries';
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
import {
  AttachReceiptCommandEvent,
  AttachReceiptCommandHandler,
} from '@Contexts/Ledger/Application/Commands/AttachReceipt';
import { GetReceiptQueryHandler } from '@Contexts/Ledger/Application/Queries/GetReceipt/GetReceiptQueryHandler';
import { IReceiptStore } from '@Contexts/Ledger/Application/Ports/IReceiptStore';
import { PostgresReceiptRepository } from '@Contexts/Ledger/Infrastructure/PostgresReceiptRepository';
import { PostgresReceiptQueries } from '@Contexts/Ledger/Infrastructure/PostgresReceiptQueries';
import { PostgresAuditTrail } from '@Contexts/Ledger/Infrastructure/PostgresAuditTrail';
import { PostgresAuditQueries } from '@Contexts/Ledger/Infrastructure/PostgresAuditQueries';
import { SettlementsSettlementAudit } from '@Contexts/Ledger/Infrastructure/SettlementsSettlementAudit';
import { GroupsPassedBalances } from '@Contexts/Ledger/Infrastructure/GroupsPassedBalances';
import { GetGroupAuditQueryHandler } from '@Contexts/Ledger/Application/Queries/GetGroupAudit/GetGroupAuditQueryHandler';

import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupsIntegrationEvents';
import { GroupsMergedLedgerHandler } from '@Contexts/Ledger/Application/Events/GroupsMergedLedgerHandler';

/**
 * The Ledger context (conventions/domain.yaml, ADR 1, ADR 3, ADR 7): the expenses of each group, recorded with their equal
 * split, the members' balances read from them and from what the settlements paid, and read by the members of the group,
 * kept in the application's PostgreSQL database (ADR 22). Who may be in a split is asked of Groups through the read model Groups'
 * wiring exports, and what was settled of Settlements' read model its wiring exports (ADR 7); neither wiring imports
 * this one.
 */
const database = PostgresDatabase.shared();

/** What the settlements paid, as Ledger reads it: outside a transaction for a query, inside the asking command's for a command. */
const settledForQueries = new SettlementsSettledAmounts(settlementEffects, countedSettlements);
const settledInCommand = new SettlementsSettledAmounts(settlementEffectsInCommand, countedSettlementsInCommand);

/** Who passed what when a member left (request 20), as Ledger reads it through GroupMembers: outside a transaction, and inside the asking command's. */
const membersForQueries = new GroupsMembers(groupMembership);
const membersInCommand = new GroupsMembers(groupMembershipInCommand);

/** An expense as a receipt's command reads it (request 26): inside the command's transaction, so it reads the connection the transaction holds. */
const expensesInCommand = new PostgresExpenseQueries(database, true);

/** The changes of money of the expenses, written in the transaction of each change (request 28). */
const audit = new PostgresAuditTrail(database);

/**
 * Ledger's balance of a member as Groups asks it when a member leaves (MemberBalances, ADR 4), exported for a command:
 * it reads inside the asking command's transaction. The composition root hands it to Groups' module.
 */
export const memberBalanceSumsInCommand: IMemberBalanceSums = new PostgresMemberBalanceSums(
  database,
  settledInCommand,
  membersInCommand,
);

/**
 * The balances of each group as Settlements reads them (GroupBalances, ADR 5), exported for a query: outside any
 * transaction. The composition root's Settlements wiring takes it; this wiring does not import Settlements' module.
 */
export const groupBalanceSums: IGroupBalanceSums = new PostgresBalanceQueries(
  database,
  settledForQueries,
  membersForQueries,
);

/**
 * The balances of each group as a settlement is decided on them (GroupBalances, ADR 7), exported for a command: inside
 * the asking command's transaction, so that the second of two settlements decided at once reads the first one's.
 */
export const groupBalanceSumsInCommand: IGroupBalanceSums = new PostgresGroupBalanceSumsInCommand(
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
    new PostgresRecurringExpenseRepository(database),
    new GroupsMembers(groupMembershipInCommand),
    clock,
  );
}

/**
 * The Ledger module. `receipts` is the outside store a receipt's file is kept in (request 26, ADR 19): the composition root
 * builds it from RECEIPTS_URL, so that this wiring does not read the environment.
 */
export function ledgerModuleWith(rates: IOfferedRates, receipts: IReceiptStore, clock: Clock): Module {
  return new Module({
    name: 'Ledger',
    commands: [
      {
        event: RecordExpenseCommandEvent,
        handlers: [
          new RecordExpenseCommandHandler(
            new PostgresExpenseRepository(database),
            new PostgresSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            new GroupsGroupCurrency(groupCurrencyInCommand),
            rates,
            clock,
            audit,
          ),
        ],
      },
      {
        event: EditExpenseCommandEvent,
        handlers: [
          new EditExpenseCommandHandler(
            new PostgresExpenseRepository(database),
            new PostgresSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            new GroupsGroupCurrency(groupCurrencyInCommand),
            rates,
            clock,
            audit,
          ),
        ],
      },
      {
        event: SetUpRecurringExpenseCommandEvent,
        handlers: [
          new SetUpRecurringExpenseCommandHandler(
            new PostgresRecurringExpenseRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: StopRecurringExpenseCommandEvent,
        handlers: [
          new StopRecurringExpenseCommandHandler(
            new PostgresRecurringExpenseRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: DeleteExpenseCommandEvent,
        handlers: [
          new DeleteExpenseCommandHandler(
            new PostgresExpenseRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
            audit,
          ),
        ],
      },
      {
        event: SetBudgetCommandEvent,
        handlers: [
          new SetBudgetCommandHandler(
            new PostgresBudgetRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: RemoveBudgetCommandEvent,
        handlers: [
          new RemoveBudgetCommandHandler(
            new PostgresBudgetRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: SaveTemplateCommandEvent,
        handlers: [
          new SaveTemplateCommandHandler(
            new PostgresSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: ReplaceTemplateCommandEvent,
        handlers: [
          new ReplaceTemplateCommandHandler(
            new PostgresSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: RemoveTemplateCommandEvent,
        handlers: [
          new RemoveTemplateCommandHandler(
            new PostgresSplitTemplateRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: AttachReceiptCommandEvent,
        handlers: [
          new AttachReceiptCommandHandler(
            new PostgresReceiptRepository(database),
            expensesInCommand,
            new GroupsMembers(groupMembershipInCommand),
            receipts,
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
            new PostgresExpenseRepository(database),
            new PostgresBudgetRepository(database),
            new PostgresMonthlySpend(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
          ),
        ],
      },
      {
        event: ExpenseEditedEvent,
        handlers: [
          new ExpenseMonthBudgetEventHandler(
            new PostgresExpenseRepository(database),
            new PostgresBudgetRepository(database),
            new PostgresMonthlySpend(database),
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
            new PostgresExpenseRepository(database),
            new GroupsMembers(groupMembershipInCommand),
            clock,
            audit,
          ),
        ],
      },
    ],
    integrationEvents: [
      {
        event: GroupsMergedIntegrationEvent,
        handlers: [
          new GroupsMergedLedgerHandler(
            new PostgresExpenseRepository(database),
            new PostgresRecurringExpenseRepository(database),
            audit,
            clock,
          ),
        ],
      },
    ],
    queries: [
      new GetExpenseQueryHandler(new PostgresExpenseQueries(database), new GroupsMembers(groupMembership)),
      new GetGroupBalancesQueryHandler(
        new PostgresBalanceQueries(database, settledForQueries, membersForQueries),
        membersForQueries,
      ),
      new GetGroupExpensesQueryHandler(new PostgresExpenseQueries(database), new GroupsMembers(groupMembership)),
      new GetMemberStatementQueryHandler(
        new PostgresStatementQueries(database),
        new GroupsMembers(groupMembership),
        settledForQueries,
      ),
      new GetMemberStatementCsvQueryHandler(
        new PostgresStatementQueries(database),
        new GroupsMembers(groupMembership),
        settledForQueries,
      ),
      new GetRecurringExpenseQueryHandler(
        new PostgresRecurringExpenseQueries(database),
        new GroupsMembers(groupMembership),
      ),
      new GetGroupRecurringExpensesQueryHandler(
        new PostgresRecurringExpenseQueries(database),
        new GroupsMembers(groupMembership),
      ),
      new GetGroupBudgetsQueryHandler(new PostgresBudgetQueries(database), new GroupsMembers(groupMembership), clock),
      new GetGroupTemplatesQueryHandler(new PostgresSplitTemplateQueries(database), new GroupsMembers(groupMembership)),
      new GetReceiptQueryHandler(
        new PostgresReceiptQueries(database),
        new PostgresExpenseQueries(database),
        new GroupsMembers(groupMembership),
      ),
      new GetGroupAuditQueryHandler(
        new PostgresAuditQueries(database),
        new SettlementsSettlementAudit(settlementAuditEntries),
        new GroupsPassedBalances(passedBalanceEntries),
        new GroupsMembers(groupMembership),
      ),
      new GetOfferedRateQueryHandler(
        rates,
        new GroupsGroupCurrency(groupCurrencyForQueries),
        new GroupsMembers(groupMembership),
        clock,
      ),
    ],
  });
}

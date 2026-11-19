import { Module } from '@Architecture/Application';
import { GroupsMergedIntegrationEvent } from '@SharedKernel/Application/IntegrationEvents/GroupsIntegrationEvents';
import { GroupsMergedSettlementsHandler } from '@Contexts/Settlements/Application/Events/GroupsMergedSettlementsHandler';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { groupCurrencyInCommand, groupMembership, groupMembershipInCommand } from '@Contexts/Groups/module.local';
import { ISettlementEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementEffects';
import { ICountedSettlements } from '@Contexts/Settlements/Domain/Settlement/Ports/ICountedSettlements';
import { PostgresCountedSettlements } from '@Contexts/Settlements/Infrastructure/PostgresCountedSettlements';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { IMemberDebts } from '@Contexts/Settlements/Domain/Settlement/Ports/IMemberDebts';
import {
  GetGroupSettlementsQueryHandler,
  GetNettingQueryHandler,
  GetSettlementQueryHandler,
  GetSuggestedSettlementsQueryHandler,
} from '@Contexts/Settlements/Application/Queries';
import { PostgresNettingRepository } from '@Contexts/Settlements/Infrastructure/PostgresNettingRepository';
import { PostgresNettingQueries } from '@Contexts/Settlements/Infrastructure/PostgresNettingQueries';
import {
  NetDebtsCommandEvent,
  NetDebtsCommandHandler,
  PayThroughProviderCommandEvent,
  PayThroughProviderCommandHandler,
  ReceivePaymentWebhookCommandEvent,
  ReceivePaymentWebhookCommandHandler,
  RecordCashSettlementCommandEvent,
  RecordCashSettlementCommandHandler,
  RefundSettlementCommandEvent,
  RefundSettlementCommandHandler,
  SetPayoutAccountCommandEvent,
  SetPayoutAccountCommandHandler,
} from '@Contexts/Settlements/Application/Commands';
import { GetPayoutAccountQueryHandler } from '@Contexts/Settlements/Application/Queries';
import { GetContestsQueryHandler } from '@Contexts/Settlements/Application/Queries/GetContests/GetContestsQueryHandler';
import { ContestSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/ContestSettlement/ContestSettlementCommandEvent';
import { ContestSettlementCommandHandler } from '@Contexts/Settlements/Application/Commands/ContestSettlement/ContestSettlementCommandHandler';
import { DecideContestCommandEvent } from '@Contexts/Settlements/Application/Commands/DecideContest/DecideContestCommandEvent';
import { DecideContestCommandHandler } from '@Contexts/Settlements/Application/Commands/DecideContest/DecideContestCommandHandler';
import { IAdministratorDecisionEntries } from '@Contexts/Settlements/Domain/Settlement/Ports/IAdministratorDecisionEntries';
import { PostgresAdministratorDecisionEntries } from '@Contexts/Settlements/Infrastructure/PostgresAdministratorDecisionEntries';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { IWaitingEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingEffects';
import { GroupsGroupCurrency } from '@Contexts/Settlements/Infrastructure/GroupsGroupCurrency';
import { GroupsSettlementMembers } from '@Contexts/Settlements/Infrastructure/GroupsSettlementMembers';
import { PostgresSettlementBookRepository } from '@Contexts/Settlements/Infrastructure/PostgresSettlementBookRepository';
import { PostgresSettlementQueries } from '@Contexts/Settlements/Infrastructure/PostgresSettlementQueries';
import { PostgresSettlementEffects } from '@Contexts/Settlements/Infrastructure/PostgresSettlementEffects';
import { PostgresPayoutAccountRepository } from '@Contexts/Settlements/Infrastructure/PostgresPayoutAccountRepository';
import { PostgresPayoutAccountQueries } from '@Contexts/Settlements/Infrastructure/PostgresPayoutAccountQueries';
import { SettlementsMemberDebts } from '@Contexts/Settlements/Infrastructure/SettlementsMemberDebts';
import { PostgresMemberPaymentsWaiting } from '@Contexts/Settlements/Infrastructure/PostgresMemberPaymentsWaiting';
import { IMemberPaymentsWaiting } from '@Contexts/Settlements/Domain/Settlement/Ports/IMemberPaymentsWaiting';
import { ISettlementAuditEntries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementAuditEntries';
import { PostgresSettlementAuditEntries } from '@Contexts/Settlements/Infrastructure/PostgresSettlementAuditEntries';

/**
 * The Settlements context (conventions/domain.yaml, ADR 5, ADR 6, ADR 7, ADR 8), kept in the application's PostgreSQL database (ADR 22). Its
 * balances come from Ledger and its members from Groups; neither is imported here beyond the read it exports. Ledger
 * imports this wiring for what was settled (`settlementEffects`), so this wiring does not import Ledger's: the composition
 * root gives it Ledger's balances (`settlementsModuleWith`), and the two wirings do not import each other.
 */
const database = PostgresDatabase.shared();

/**
 * What the settlements paid, as Ledger reads it (SettledAmounts, ADR 7), exported for a query (outside any transaction)
 * and for a command (inside the asking command's transaction).
 */
export const settlementEffects: ISettlementEffects = new PostgresSettlementEffects(database, false, [
  'paid',
  'refunding',
]);
export const settlementEffectsInCommand: ISettlementEffects = new PostgresSettlementEffects(database, true, [
  'paid',
  'refunding',
]);

/**
 * The settlements each member's balance counts, with when they started to count, as Ledger's statement reads them (SettledAmounts,
 * request 29): exported for a query (outside any transaction) and for a command (inside the asking command's transaction).
 */
export const countedSettlements: ICountedSettlements = new PostgresCountedSettlements(database, false);
export const countedSettlementsInCommand: ICountedSettlements = new PostgresCountedSettlements(database, true);

/**
 * Whether a member has a payment waiting at the provider, exported for Groups' command (WaitingPayments, ADR 13): inside the
 * asking command's transaction. The composition root hands it to Groups' module; this wiring does not import Groups'.
 */
export const memberPaymentsWaitingInCommand: IMemberPaymentsWaiting = new PostgresMemberPaymentsWaiting(database);

/**
 * The changes of money of the settlements, as their history records them, read by Ledger for the group's audit (SettlementAudit,
 * request 28), outside any transaction. Ledger's wiring takes it; this wiring does not import Ledger's.
 */
export const settlementAuditEntries: ISettlementAuditEntries = new PostgresSettlementAuditEntries(database);

/**
 * What the payments waiting at the provider do to each balance, for the suggestions (ADR 8), outside any transaction. A contested
 * settlement waits as a pending one does, for what is still owed (request 33, ADR 24).
 */
const waitingEffects: IWaitingEffects = new PostgresSettlementEffects(database, false, ['pending', 'contested']);

/**
 * The administrators' log's entries, as Groups reads them (AdministratorDecisions, request 33, ADR 24), outside any transaction.
 * Groups' wiring takes it through its adapter; this wiring does not import Groups'.
 */
export const administratorDecisionEntries: IAdministratorDecisionEntries = new PostgresAdministratorDecisionEntries(
  database,
);

/**
 * Who still owes what, as Notifications' sweep asks it (ADR 12), given the balances it reads from Ledger for the sweep
 * (outside any transaction). Exported for the composition root to hand Notifications; this wiring does not import it.
 */
export function memberDebtsWith(balances: IGroupBalances): IMemberDebts {
  return new SettlementsMemberDebts(balances, waitingEffects, new GroupsSettlementMembers(groupMembership));
}

/**
 * The Settlements module, given the balances it decides on: `balances` for its queries (outside a transaction) and
 * `balancesInCommand` for its command (inside the command's transaction, so that two settlements decided at once see each
 * other, ADR 7). The composition root gives both, read from Ledger.
 */
export function settlementsModuleWith(
  balances: IGroupBalances,
  balancesInCommand: IGroupBalances,
  provider: IPaymentProvider,
): Module {
  return new Module({
    name: 'Settlements',
    commands: [
      {
        event: NetDebtsCommandEvent,
        handlers: [
          new NetDebtsCommandHandler(
            new PostgresSettlementBookRepository(database),
            balancesInCommand,
            new GroupsSettlementMembers(groupMembershipInCommand),
            new PostgresNettingRepository(database),
            systemClock,
          ),
        ],
      },
      {
        event: RecordCashSettlementCommandEvent,
        handlers: [
          new RecordCashSettlementCommandHandler(
            new PostgresSettlementBookRepository(database),
            balancesInCommand,
            new GroupsSettlementMembers(groupMembershipInCommand),
            systemClock,
          ),
        ],
      },
      {
        event: PayThroughProviderCommandEvent,
        handlers: [
          new PayThroughProviderCommandHandler(
            new PostgresSettlementBookRepository(database),
            balancesInCommand,
            new GroupsSettlementMembers(groupMembershipInCommand),
            new GroupsGroupCurrency(groupCurrencyInCommand),
            new PostgresPayoutAccountRepository(database),
            provider,
            systemClock,
          ),
        ],
      },
      {
        event: SetPayoutAccountCommandEvent,
        handlers: [new SetPayoutAccountCommandHandler(new PostgresPayoutAccountRepository(database), provider)],
      },
      {
        event: RefundSettlementCommandEvent,
        handlers: [
          new RefundSettlementCommandHandler(
            new PostgresSettlementBookRepository(database),
            new GroupsSettlementMembers(groupMembershipInCommand),
            provider,
            systemClock,
          ),
        ],
      },
      {
        event: ContestSettlementCommandEvent,
        handlers: [
          new ContestSettlementCommandHandler(
            new PostgresSettlementBookRepository(database),
            new GroupsSettlementMembers(groupMembershipInCommand),
            systemClock,
          ),
        ],
      },
      {
        event: DecideContestCommandEvent,
        handlers: [new DecideContestCommandHandler(new PostgresSettlementBookRepository(database), systemClock)],
      },
      {
        event: ReceivePaymentWebhookCommandEvent,
        handlers: [
          new ReceivePaymentWebhookCommandHandler(new PostgresSettlementBookRepository(database), systemClock),
        ],
      },
    ],
    integrationEvents: [
      {
        event: GroupsMergedIntegrationEvent,
        handlers: [new GroupsMergedSettlementsHandler(new PostgresSettlementBookRepository(database), systemClock)],
      },
    ],
    queries: [
      new GetSuggestedSettlementsQueryHandler(balances, waitingEffects, new GroupsSettlementMembers(groupMembership)),
      new GetSettlementQueryHandler(
        new PostgresSettlementQueries(database),
        new GroupsSettlementMembers(groupMembership),
      ),
      new GetGroupSettlementsQueryHandler(
        new PostgresSettlementQueries(database),
        new GroupsSettlementMembers(groupMembership),
      ),
      new GetPayoutAccountQueryHandler(new PostgresPayoutAccountQueries(database)),
      new GetNettingQueryHandler(new PostgresNettingQueries(database)),
      new GetContestsQueryHandler(new PostgresSettlementQueries(database)),
    ],
  });
}

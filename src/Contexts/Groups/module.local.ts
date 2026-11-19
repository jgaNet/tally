import { IPassedBalanceEntries } from '@Contexts/Groups/Domain/Group/Ports/IPassedBalanceEntries';
import { PostgresPassedBalanceEntries } from '@Contexts/Groups/Infrastructure/PostgresPassedBalanceEntries';
import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import {
  AcceptInvitationCommandEvent,
  AcceptInvitationCommandHandler,
  CreateGroupCommandEvent,
  CreateGroupCommandHandler,
  CreateInvitationCommandEvent,
  CreateInvitationCommandHandler,
  SignUpCommandEvent,
  SignUpCommandHandler,
} from '@Contexts/Groups/Application/Commands';
import {
  GetGroupMembersQueryHandler,
  GetGroupQueryHandler,
  GetInvitationQueryHandler,
  GetMyAccountQueryHandler,
  GetMyGroupsQueryHandler,
  LoginQueryHandler,
} from '@Contexts/Groups/Application/Queries';
import { PostgresAccountRepository } from '@Contexts/Groups/Infrastructure/PostgresAccountRepository';
import { PostgresAccountQueries } from '@Contexts/Groups/Infrastructure/PostgresAccountQueries';
import { PostgresGroupRepository } from '@Contexts/Groups/Infrastructure/PostgresGroupRepository';
import { PostgresGroupQueries } from '@Contexts/Groups/Infrastructure/PostgresGroupQueries';
import { PostgresInvitationRepository } from '@Contexts/Groups/Infrastructure/PostgresInvitationRepository';
import { PostgresInvitationQueries } from '@Contexts/Groups/Infrastructure/PostgresInvitationQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { HmacTokens } from '@Contexts/Groups/Infrastructure/HmacTokens';
import { authenticateWith } from '@Contexts/Groups/Presentation/API/REST/authenticate';
import { IGroupMembership } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembership';
import { PostgresGroupMembership } from '@Contexts/Groups/Infrastructure/PostgresGroupMembership';
import { PostgresGroupCurrency } from '@Contexts/Groups/Infrastructure/PostgresGroupCurrency';
import { IGroupCurrency } from '@Contexts/Groups/Domain/Group/Ports/IGroupCurrency';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { LeaveGroupCommandEvent, LeaveGroupCommandHandler } from '@Contexts/Groups/Application/Commands';
import { ArchiveGroupCommandEvent, ArchiveGroupCommandHandler } from '@Contexts/Groups/Application/Commands';
import { MergeGroupsCommandEvent, MergeGroupsCommandHandler } from '@Contexts/Groups/Application/Commands';
import {
  DeleteAccountCommandEvent,
  DeleteAccountCommandHandler,
} from '@Contexts/Groups/Application/Commands/DeleteAccount';
import { GroupsMergedEventHandler } from '@Contexts/Groups/Application/Events/GroupsMergedEventHandler';
import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';
import { IAdministratorDecisions } from '@Contexts/Groups/Application/Ports/IAdministratorDecisions';
import { GetAdministratorsLogQueryHandler } from '@Contexts/Groups/Application/Queries';
import { PostgresAdministratorLog } from '@Contexts/Groups/Infrastructure/PostgresAdministratorLog';
import { IAdministratorLogReads } from '@Contexts/Groups/Application/Ports/IAdministratorLog';
import {
  SuspendAccountCommandEvent,
  SuspendAccountCommandHandler,
} from '@Contexts/Groups/Application/Commands/SuspendAccount';
import {
  ReinstateAccountCommandEvent,
  ReinstateAccountCommandHandler,
} from '@Contexts/Groups/Application/Commands/ReinstateAccount';

/**
 * The Groups context (conventions/domain.yaml, ADR 1): accounts (signing up, signing in, reading one's own account)
 * and groups (creating one, reading one of one's own, listing one's own, the members in their join order, leaving one,
 * archiving one, merging one into another),
 * invitations by a link (creating one, reading one, accepting one), kept in the application's PostgreSQL database (ADR 2, ADR 22).
 */
const database = PostgresDatabase.shared();
const hasher = new ScryptPasswordHasher();
const accountQueries = new PostgresAccountQueries(database);
const groupQueries = new PostgresGroupQueries(database);
const invitationQueries = new PostgresInvitationQueries(database);

export const tokens = new HmacTokens(database);

/**
 * The members of a group as another context reads them (ADR 3), exported as what it needs of Groups and nothing of
 * Groups' application beyond it: `groupMembership` for its queries (outside a transaction), and
 * `groupMembershipInCommand` for its commands (inside the command's transaction, ADR 2).
 */
export const groupMembership: IGroupMembership = groupQueries;
export const groupMembershipInCommand: IGroupMembership = new PostgresGroupMembership(database);

/**
 * The balances that passed to the owner when members left, as Ledger's audit reads them (PassedBalances, request 28),
 * outside any transaction. Ledger's wiring takes it; this wiring does not import Ledger's.
 */
export const passedBalanceEntries: IPassedBalanceEntries = new PostgresPassedBalanceEntries(database);

/** The currency of a group, as another context's command reads it (ADR 8), inside the command's transaction. */
export const groupCurrencyInCommand: IGroupCurrency = new PostgresGroupCurrency(database);

/** The currency of a group, as another context's query reads it (request 22), outside any transaction. */
export const groupCurrencyForQueries: IGroupCurrency = new PostgresGroupCurrency(database, true);

/** Says who is calling, for the transport: the context that owns accounts provides it. */
export const authenticate = authenticateWith(tokens, accountQueries);

/**
 * The Groups module, given the ports it asks when a member leaves: the balance it asks of Ledger (MemberBalances, ADR 4), and
 * whether a payment of the member waits at the provider (WaitingPayments, ADR 13), the administrators' log (AdministratorDecisions,
 * request 33, ADR 24), and the emails the administrators sign in with (ADMIN_EMAILS). The composition root gives it these reads:
 * this wiring does not import Ledger's or Settlements', which import this one (ADR 3).
 */
export function groupsModuleWith(
  memberBalances: IMemberBalances,
  waitingPayments: IWaitingPayments,
  administratorDecisions: IAdministratorDecisions,
  administratorEmails: readonly string[],
): Module {
  // Groups' own entries of the administrators' log (request 34): written with each change, read with Settlements' decisions.
  const administratorLog = new PostgresAdministratorLog(database);
  const administratorLogReads: IAdministratorLogReads = {
    decisions: () => administratorDecisions.decisions(),
    entries: () => administratorLog.entries(),
  };
  return new Module({
    name: 'Groups',
    commands: [
      {
        event: SuspendAccountCommandEvent,
        handlers: [
          new SuspendAccountCommandHandler(new PostgresAccountRepository(database), administratorLog, systemClock),
        ],
      },
      {
        event: ReinstateAccountCommandEvent,
        handlers: [
          new ReinstateAccountCommandHandler(new PostgresAccountRepository(database), administratorLog, systemClock),
        ],
      },
      {
        event: DeleteAccountCommandEvent,
        handlers: [
          new DeleteAccountCommandHandler(
            new PostgresAccountRepository(database),
            new PostgresGroupRepository(database),
            waitingPayments,
            systemClock,
          ),
        ],
      },
      {
        event: SignUpCommandEvent,
        handlers: [new SignUpCommandHandler(new PostgresAccountRepository(database), hasher)],
      },
      {
        event: CreateGroupCommandEvent,
        handlers: [new CreateGroupCommandHandler(new PostgresGroupRepository(database), systemClock)],
      },
      {
        event: CreateInvitationCommandEvent,
        handlers: [
          new CreateInvitationCommandHandler(
            new PostgresGroupRepository(database),
            new PostgresInvitationRepository(database),
            systemClock,
          ),
        ],
      },
      {
        event: AcceptInvitationCommandEvent,
        handlers: [
          new AcceptInvitationCommandHandler(
            new PostgresInvitationRepository(database),
            new PostgresGroupRepository(database),
            systemClock,
          ),
        ],
      },
      {
        event: ArchiveGroupCommandEvent,
        handlers: [
          new ArchiveGroupCommandHandler(
            new PostgresGroupRepository(database),
            memberBalances,
            waitingPayments,
            systemClock,
          ),
        ],
      },
      {
        event: LeaveGroupCommandEvent,
        handlers: [
          new LeaveGroupCommandHandler(
            new PostgresGroupRepository(database),
            memberBalances,
            waitingPayments,
            systemClock,
          ),
        ],
      },
      {
        event: MergeGroupsCommandEvent,
        handlers: [new MergeGroupsCommandHandler(new PostgresGroupRepository(database), waitingPayments, systemClock)],
      },
    ],
    domainEvents: [{ event: GroupsMergedEvent, handlers: [new GroupsMergedEventHandler()] }],
    queries: [
      new GetMyAccountQueryHandler(accountQueries),
      new LoginQueryHandler(accountQueries, hasher, tokens, administratorEmails),
      new GetGroupQueryHandler(groupQueries),
      new GetMyGroupsQueryHandler(groupQueries),
      new GetInvitationQueryHandler(invitationQueries),
      new GetGroupMembersQueryHandler(groupQueries),
      new GetAdministratorsLogQueryHandler(administratorLogReads),
    ],
  });
}

import { IPassedBalanceEntries } from '@Contexts/Groups/Domain/Group/Ports/IPassedBalanceEntries';
import { SqlitePassedBalanceEntries } from '@Contexts/Groups/Infrastructure/SqlitePassedBalanceEntries';
import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
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
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/SqliteAccountRepository';
import { SqliteAccountQueries } from '@Contexts/Groups/Infrastructure/SqliteAccountQueries';
import { SqliteGroupRepository } from '@Contexts/Groups/Infrastructure/SqliteGroupRepository';
import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/SqliteGroupQueries';
import { SqliteInvitationRepository } from '@Contexts/Groups/Infrastructure/SqliteInvitationRepository';
import { SqliteInvitationQueries } from '@Contexts/Groups/Infrastructure/SqliteInvitationQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { HmacTokens } from '@Contexts/Groups/Infrastructure/HmacTokens';
import { authenticateWith } from '@Contexts/Groups/Presentation/API/REST/authenticate';
import { IGroupMembership } from '@Contexts/Groups/Domain/Group/Ports/IGroupMembership';
import { SqliteGroupMembership } from '@Contexts/Groups/Infrastructure/SqliteGroupMembership';
import { SqliteGroupCurrency } from '@Contexts/Groups/Infrastructure/SqliteGroupCurrency';
import { IGroupCurrency } from '@Contexts/Groups/Domain/Group/Ports/IGroupCurrency';
import { IMemberBalances } from '@Contexts/Groups/Domain/Group/Ports/IMemberBalances';
import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { LeaveGroupCommandEvent, LeaveGroupCommandHandler } from '@Contexts/Groups/Application/Commands';
import { ArchiveGroupCommandEvent, ArchiveGroupCommandHandler } from '@Contexts/Groups/Application/Commands';

/**
 * The Groups context (conventions/domain.yaml, ADR 1): accounts (signing up, signing in, reading one's own account)
 * and groups (creating one, reading one of one's own, listing one's own, the members in their join order, leaving one),
 * invitations by a link (creating one, reading one, accepting one), kept in the application's SQLite file (ADR 2).
 */
const database = SqliteDatabase.shared();
const hasher = new ScryptPasswordHasher();
const accountQueries = new SqliteAccountQueries(database);
const groupQueries = new SqliteGroupQueries(database);
const invitationQueries = new SqliteInvitationQueries(database);

export const tokens = new HmacTokens(database);

/**
 * The members of a group as another context reads them (ADR 3), exported as what it needs of Groups and nothing of
 * Groups' application beyond it: `groupMembership` for its queries (outside a transaction), and
 * `groupMembershipInCommand` for its commands (inside the command's transaction, ADR 2).
 */
export const groupMembership: IGroupMembership = groupQueries;
export const groupMembershipInCommand: IGroupMembership = new SqliteGroupMembership(database);

/**
 * The balances that passed to the owner when members left, as Ledger's audit reads them (PassedBalances, request 28),
 * outside any transaction. Ledger's wiring takes it; this wiring does not import Ledger's.
 */
export const passedBalanceEntries: IPassedBalanceEntries = new SqlitePassedBalanceEntries(database);

/** The currency of a group, as another context's command reads it (ADR 8), inside the command's transaction. */
export const groupCurrencyInCommand: IGroupCurrency = new SqliteGroupCurrency(database);

/** The currency of a group, as another context's query reads it (request 22), outside any transaction. */
export const groupCurrencyForQueries: IGroupCurrency = new SqliteGroupCurrency(database);

/** Says who is calling, for the transport: the context that owns accounts provides it. */
export const authenticate = authenticateWith(tokens);

/**
 * The Groups module, given the ports it asks when a member leaves: the balance it asks of Ledger (MemberBalances, ADR 4), and
 * whether a payment of the member waits at the provider (WaitingPayments, ADR 13). The composition root gives it both reads:
 * this wiring does not import Ledger's or Settlements', which import this one (ADR 3).
 */
export function groupsModuleWith(memberBalances: IMemberBalances, waitingPayments: IWaitingPayments): Module {
  return new Module({
    name: 'Groups',
    commands: [
      {
        event: SignUpCommandEvent,
        handlers: [new SignUpCommandHandler(new SqliteAccountRepository(database), hasher)],
      },
      {
        event: CreateGroupCommandEvent,
        handlers: [new CreateGroupCommandHandler(new SqliteGroupRepository(database), systemClock)],
      },
      {
        event: CreateInvitationCommandEvent,
        handlers: [
          new CreateInvitationCommandHandler(
            new SqliteGroupRepository(database),
            new SqliteInvitationRepository(database),
            systemClock,
          ),
        ],
      },
      {
        event: AcceptInvitationCommandEvent,
        handlers: [
          new AcceptInvitationCommandHandler(
            new SqliteInvitationRepository(database),
            new SqliteGroupRepository(database),
            systemClock,
          ),
        ],
      },
      {
        event: ArchiveGroupCommandEvent,
        handlers: [
          new ArchiveGroupCommandHandler(
            new SqliteGroupRepository(database),
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
            new SqliteGroupRepository(database),
            memberBalances,
            waitingPayments,
            systemClock,
          ),
        ],
      },
    ],
    queries: [
      new GetMyAccountQueryHandler(accountQueries),
      new LoginQueryHandler(accountQueries, hasher, tokens),
      new GetGroupQueryHandler(groupQueries),
      new GetMyGroupsQueryHandler(groupQueries),
      new GetInvitationQueryHandler(invitationQueries),
      new GetGroupMembersQueryHandler(groupQueries),
    ],
  });
}

import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Postgres/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { ledgerBalanceQueries, settlementReadModel } from '@Bootstrap/Fastify/readModels';

import {
  AcceptInvitationCommandEvent,
  AcceptInvitationCommandHandler,
  CreateGroupCommandEvent,
  CreateGroupCommandHandler,
  CreateInvitationCommandEvent,
  CreateInvitationCommandHandler,
  LeaveGroupCommandEvent,
  LeaveGroupCommandHandler,
  ArchiveGroupCommandEvent,
  ArchiveGroupCommandHandler,
  MergeGroupsCommandEvent,
  MergeGroupsCommandHandler,
  SignUpCommandEvent,
  SignUpCommandHandler,
} from '@Contexts/Groups/Application/Commands';
import {
  GetGroupMembersQueryHandler,
  GetGroupQueryHandler,
  GetInvitationQueryHandler,
  GetMyAccountQueryHandler,
  GetMyGroupsQueryHandler,
  SignInQueryHandler,
} from '@Contexts/Groups/Application/Queries';
import { PostgresAccountRepository } from '@Contexts/Groups/Infrastructure/Repositories/PostgresAccountRepository';
import { PostgresGroupRepository } from '@Contexts/Groups/Infrastructure/Repositories/PostgresGroupRepository';
import { PostgresInvitationRepository } from '@Contexts/Groups/Infrastructure/Repositories/PostgresInvitationRepository';
import { PostgresAccountQueries } from '@Contexts/Groups/Infrastructure/Queries/PostgresAccountQueries';
import { PostgresGroupQueries } from '@Contexts/Groups/Infrastructure/Queries/PostgresGroupQueries';
import { PostgresInvitationQueries } from '@Contexts/Groups/Infrastructure/Queries/PostgresInvitationQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/Services/ScryptPasswordHasher';
import { HmacAccessTokens } from '@Contexts/Groups/Infrastructure/Services/HmacAccessTokens';
import { LedgerBalances } from '@Contexts/Groups/Infrastructure/Ledger/LedgerBalances';
import { SettlementsWaitingPayments } from '@Contexts/Groups/Infrastructure/Settlements/SettlementsWaitingPayments';
import { bearerAuthentication } from '@Contexts/Groups/Presentation/API/REST/Middlewares/BearerAuthentication';
import { GroupsMergedHandler } from '@Contexts/Groups/Application/Events/GroupsMergedHandler';
import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';

/**
 * The Groups context (conventions/domain.yaml, ADR 1, ADR 2): accounts, groups and their invitations. Its state is in the
 * application's PostgreSQL database; its tokens are signed with a key that database keeps. The application's one clock is
 * passed to what decides a time: a group's creation and a join. A leave asks Ledger a member's balance through
 * its own port (ADR 5).
 */
const database = applicationDatabase();
const accounts = new PostgresAccountRepository(database);
const accountQueries = new PostgresAccountQueries(database);
const groups = new PostgresGroupRepository(database);
export const groupQueries = new PostgresGroupQueries(database);
const invitations = new PostgresInvitationRepository(database);
const invitationQueries = new PostgresInvitationQueries(database);
const hasher = new ScryptPasswordHasher();
/** The key the tokens are signed with, read from the database the first time a token is issued or checked: after it is open. */
const tokens = new HmacAccessTokens(() => database.secret('access-token-key'));
const clock = systemClock;
/** Ledger's balance of a member, asked when a member leaves: the Ledger's read model, passed by the composition root (ADR 5). */
const memberBalances = new LedgerBalances(ledgerBalanceQueries);
/** Whether a payment of a member waits at the provider, asked when a member leaves: Settlements' read model, passed by the composition root (ADR 11). */
const waitingPayments = new SettlementsWaitingPayments(settlementReadModel);

/** Who is calling, from the bearer token: the transport's `authenticate`, given by the composition root. */
export const authenticateAccount = bearerAuthentication(tokens);

export const localGroupsModule = new Module({
  name: 'Groups',
  commands: [
    { event: SignUpCommandEvent, handlers: [new SignUpCommandHandler(accounts, hasher)] },
    { event: CreateGroupCommandEvent, handlers: [new CreateGroupCommandHandler(groups, clock)] },
    { event: CreateInvitationCommandEvent, handlers: [new CreateInvitationCommandHandler(groups, invitations)] },
    {
      event: AcceptInvitationCommandEvent,
      handlers: [new AcceptInvitationCommandHandler(groups, invitations, clock)],
    },
    {
      event: LeaveGroupCommandEvent,
      handlers: [new LeaveGroupCommandHandler(groups, memberBalances, waitingPayments, clock)],
    },
    {
      event: ArchiveGroupCommandEvent,
      handlers: [new ArchiveGroupCommandHandler(groups, memberBalances, waitingPayments, clock)],
    },
    {
      event: MergeGroupsCommandEvent,
      handlers: [new MergeGroupsCommandHandler(groups, waitingPayments, clock)],
    },
  ],
  domainEvents: [{ event: GroupsMergedEvent, handlers: [new GroupsMergedHandler()] }],
  queries: [
    new GetMyAccountQueryHandler(accountQueries),
    new SignInQueryHandler(accountQueries, hasher, tokens),
    new GetGroupQueryHandler(groupQueries),
    new GetMyGroupsQueryHandler(groupQueries),
    new GetGroupMembersQueryHandler(groupQueries),
    new GetInvitationQueryHandler(invitationQueries),
  ],
});

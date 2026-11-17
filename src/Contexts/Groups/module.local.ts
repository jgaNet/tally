import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { ledgerBalanceQueries } from '@Bootstrap/Fastify/readModels';

import {
  AcceptInvitationCommandEvent,
  AcceptInvitationCommandHandler,
  CreateGroupCommandEvent,
  CreateGroupCommandHandler,
  CreateInvitationCommandEvent,
  CreateInvitationCommandHandler,
  LeaveGroupCommandEvent,
  LeaveGroupCommandHandler,
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
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/Repositories/SqliteAccountRepository';
import { SqliteGroupRepository } from '@Contexts/Groups/Infrastructure/Repositories/SqliteGroupRepository';
import { SqliteInvitationRepository } from '@Contexts/Groups/Infrastructure/Repositories/SqliteInvitationRepository';
import { SqliteAccountQueries } from '@Contexts/Groups/Infrastructure/Queries/SqliteAccountQueries';
import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/Queries/SqliteGroupQueries';
import { SqliteInvitationQueries } from '@Contexts/Groups/Infrastructure/Queries/SqliteInvitationQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/Services/ScryptPasswordHasher';
import { HmacAccessTokens } from '@Contexts/Groups/Infrastructure/Services/HmacAccessTokens';
import { LedgerBalances } from '@Contexts/Groups/Infrastructure/Ledger/LedgerBalances';
import { bearerAuthentication } from '@Contexts/Groups/Presentation/API/REST/Middlewares/BearerAuthentication';

/**
 * The Groups context (conventions/domain.yaml, ADR 1, ADR 2): accounts, groups and their invitations. Its state is in the
 * application's SQLite file; its tokens are signed with a key that file keeps. The application's one clock is
 * passed to what decides a time: a group's creation and a join. A leave asks Ledger a member's balance through
 * its own port (ADR 5).
 */
const database = applicationDatabase();
const accounts = new SqliteAccountRepository(database);
const accountQueries = new SqliteAccountQueries(database);
const groups = new SqliteGroupRepository(database);
export const groupQueries = new SqliteGroupQueries(database);
const invitations = new SqliteInvitationRepository(database);
const invitationQueries = new SqliteInvitationQueries(database);
const hasher = new ScryptPasswordHasher();
const tokens = new HmacAccessTokens(database.secret('access-token-key'));
const clock = systemClock;
/** Ledger's balance of a member, asked when a member leaves: the Ledger's read model, passed by the composition root (ADR 5). */
const memberBalances = new LedgerBalances(ledgerBalanceQueries);

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
    { event: LeaveGroupCommandEvent, handlers: [new LeaveGroupCommandHandler(groups, memberBalances)] },
  ],
  queries: [
    new GetMyAccountQueryHandler(accountQueries),
    new SignInQueryHandler(accountQueries, hasher, tokens),
    new GetGroupQueryHandler(groupQueries),
    new GetMyGroupsQueryHandler(groupQueries),
    new GetGroupMembersQueryHandler(groupQueries),
    new GetInvitationQueryHandler(invitationQueries),
  ],
});

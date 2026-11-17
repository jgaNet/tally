import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import {
  CreateGroupCommandEvent,
  CreateGroupCommandHandler,
  SignUpCommandEvent,
  SignUpCommandHandler,
} from '@Contexts/Groups/Application/Commands';
import {
  GetGroupQueryHandler,
  GetMyAccountQueryHandler,
  GetMyGroupsQueryHandler,
  SignInQueryHandler,
} from '@Contexts/Groups/Application/Queries';
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/Repositories/SqliteAccountRepository';
import { SqliteGroupRepository } from '@Contexts/Groups/Infrastructure/Repositories/SqliteGroupRepository';
import { SqliteAccountQueries } from '@Contexts/Groups/Infrastructure/Queries/SqliteAccountQueries';
import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/Queries/SqliteGroupQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/Services/ScryptPasswordHasher';
import { HmacAccessTokens } from '@Contexts/Groups/Infrastructure/Services/HmacAccessTokens';
import { bearerAuthentication } from '@Contexts/Groups/Presentation/API/REST/Middlewares/BearerAuthentication';

/**
 * The Groups context (conventions/domain.yaml, ADR 1, ADR 2): accounts and groups. Its state is in the
 * application's SQLite file; its tokens are signed with a key that file keeps. The application's one clock is
 * passed to what decides a time: a group's creation.
 */
const database = applicationDatabase();
const accounts = new SqliteAccountRepository(database);
const accountQueries = new SqliteAccountQueries(database);
const groups = new SqliteGroupRepository(database);
const groupQueries = new SqliteGroupQueries(database);
const hasher = new ScryptPasswordHasher();
const tokens = new HmacAccessTokens(database.secret('access-token-key'));
const clock = systemClock;

/** Who is calling, from the bearer token: the transport's `authenticate`, given by the composition root. */
export const authenticateAccount = bearerAuthentication(tokens);

export const localGroupsModule = new Module({
  name: 'Groups',
  commands: [
    { event: SignUpCommandEvent, handlers: [new SignUpCommandHandler(accounts, hasher)] },
    { event: CreateGroupCommandEvent, handlers: [new CreateGroupCommandHandler(groups, clock)] },
  ],
  queries: [
    new GetMyAccountQueryHandler(accountQueries),
    new SignInQueryHandler(accountQueries, hasher, tokens),
    new GetGroupQueryHandler(groupQueries),
    new GetMyGroupsQueryHandler(groupQueries),
  ],
});

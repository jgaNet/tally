import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
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
  LoginQueryHandler,
} from '@Contexts/Groups/Application/Queries';
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/SqliteAccountRepository';
import { SqliteAccountQueries } from '@Contexts/Groups/Infrastructure/SqliteAccountQueries';
import { SqliteGroupRepository } from '@Contexts/Groups/Infrastructure/SqliteGroupRepository';
import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/SqliteGroupQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { HmacTokens } from '@Contexts/Groups/Infrastructure/HmacTokens';
import { authenticateWith } from '@Contexts/Groups/Presentation/API/REST/authenticate';

/**
 * The Groups context (conventions/domain.yaml, ADR 1): accounts (signing up, signing in, reading one's own account)
 * and groups (creating one, reading one of one's own, listing one's own), kept in the application's SQLite file (ADR 2).
 */
const database = SqliteDatabase.shared();
const hasher = new ScryptPasswordHasher();
const accountQueries = new SqliteAccountQueries(database);
const groupQueries = new SqliteGroupQueries(database);

export const tokens = new HmacTokens(database);

/** Says who is calling, for the transport: the context that owns accounts provides it. */
export const authenticate = authenticateWith(tokens);

export const localGroupsModule = new Module({
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
  ],
  queries: [
    new GetMyAccountQueryHandler(accountQueries),
    new LoginQueryHandler(accountQueries, hasher, tokens),
    new GetGroupQueryHandler(groupQueries),
    new GetMyGroupsQueryHandler(groupQueries),
  ],
});

import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

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
import { HmacTokenIssuer } from '@Contexts/Groups/Infrastructure/HmacTokenIssuer';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SqliteAccountReadModels } from '@Contexts/Groups/Infrastructure/SqliteAccountReadModels';
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/SqliteAccountRepository';
import { SqliteGroupReadModels } from '@Contexts/Groups/Infrastructure/SqliteGroupReadModels';
import { SqliteGroupRepository } from '@Contexts/Groups/Infrastructure/SqliteGroupRepository';
import { authenticateWithToken } from '@Contexts/Groups/Presentation/API/REST/authenticate';

const database = sharedDatabase();
const accounts = new SqliteAccountRepository(database);
const accountReadModels = new SqliteAccountReadModels(database);
const groups = new SqliteGroupRepository(database);
const groupReadModels = new SqliteGroupReadModels(database);
const passwordHasher = new ScryptPasswordHasher();
const tokens = HmacTokenIssuer.inDatabase(database);

/** Says who is calling, for the transport: the account a bearer token names. */
export const authenticate = authenticateWithToken(tokens, systemClock);

/** The Groups context: who someone is (ADR 1: accounts live here), and the groups they are in. */
export const localGroupsModule = new Module({
  name: 'Groups',
  commands: [
    { event: SignUpCommandEvent, handlers: [new SignUpCommandHandler(accounts, passwordHasher)] },
    { event: CreateGroupCommandEvent, handlers: [new CreateGroupCommandHandler(groups, systemClock)] },
  ],
  queries: [
    new GetMyAccountQueryHandler(accountReadModels),
    new LoginQueryHandler(accountReadModels, passwordHasher, tokens, systemClock),
    new GetGroupQueryHandler(groupReadModels),
    new GetMyGroupsQueryHandler(groupReadModels),
  ],
});

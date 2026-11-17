import { Module } from '@Architecture/Application';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { SignUpCommandEvent, SignUpCommandHandler } from '@Contexts/Groups/Application/Commands';
import { GetMyAccountQueryHandler, LoginQueryHandler } from '@Contexts/Groups/Application/Queries';
import { HmacTokenIssuer } from '@Contexts/Groups/Infrastructure/HmacTokenIssuer';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SqliteAccountReadModels } from '@Contexts/Groups/Infrastructure/SqliteAccountReadModels';
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/SqliteAccountRepository';
import { authenticateWithToken } from '@Contexts/Groups/Presentation/API/REST/authenticate';

const database = sharedDatabase();
const accounts = new SqliteAccountRepository(database);
const accountReadModels = new SqliteAccountReadModels(database);
const passwordHasher = new ScryptPasswordHasher();
const tokens = HmacTokenIssuer.inDatabase(database);

/** Says who is calling, for the transport: the account a bearer token names. */
export const authenticate = authenticateWithToken(tokens, systemClock);

/** The Groups context: who someone is, for now (ADR 1: accounts live here). */
export const localGroupsModule = new Module({
  name: 'Groups',
  commands: [{ event: SignUpCommandEvent, handlers: [new SignUpCommandHandler(accounts, passwordHasher)] }],
  queries: [
    new GetMyAccountQueryHandler(accountReadModels),
    new LoginQueryHandler(accountReadModels, passwordHasher, tokens, systemClock),
  ],
});

import { Module } from '@Architecture/Application';
import { applicationDatabase } from '@Architecture/Infrastructure/Sqlite/ApplicationDatabase';

import { SignUpCommandEvent, SignUpCommandHandler } from '@Contexts/Groups/Application/Commands';
import { GetMyAccountQueryHandler, SignInQueryHandler } from '@Contexts/Groups/Application/Queries';
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/Repositories/SqliteAccountRepository';
import { SqliteAccountQueries } from '@Contexts/Groups/Infrastructure/Queries/SqliteAccountQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/Services/ScryptPasswordHasher';
import { HmacAccessTokens } from '@Contexts/Groups/Infrastructure/Services/HmacAccessTokens';
import { bearerAuthentication } from '@Contexts/Groups/Presentation/API/REST/Middlewares/BearerAuthentication';

/**
 * The Groups context (conventions/domain.yaml, ADR 1, ADR 2): accounts, for now. Its state is in the
 * application's SQLite file; its tokens are signed with a key that file keeps.
 */
const database = applicationDatabase();
const accounts = new SqliteAccountRepository(database);
const accountQueries = new SqliteAccountQueries(database);
const hasher = new ScryptPasswordHasher();
const tokens = new HmacAccessTokens(database.secret('access-token-key'));

/** Who is calling, from the bearer token: the transport's `authenticate`, given by the composition root. */
export const authenticateAccount = bearerAuthentication(tokens);

export const localGroupsModule = new Module({
  name: 'Groups',
  commands: [{ event: SignUpCommandEvent, handlers: [new SignUpCommandHandler(accounts, hasher)] }],
  queries: [new GetMyAccountQueryHandler(accountQueries), new SignInQueryHandler(accountQueries, hasher, tokens)],
});

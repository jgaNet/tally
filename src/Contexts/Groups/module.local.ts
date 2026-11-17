import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/SqliteAccountRepository';
import { SqliteAccountQueries } from '@Contexts/Groups/Infrastructure/SqliteAccountQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SqliteSessionTokens } from '@Contexts/Groups/Infrastructure/SqliteSessionTokens';

/**
 * The Groups context (conventions/domain.yaml, ADR 0001, ADR 0002): accounts for now, groups and their
 * members in the features to come. Its adapters are the application's SQLite file.
 */
const accounts = new SqliteAccountRepository(sharedDatabase);
const accountQueries = new SqliteAccountQueries(sharedDatabase);
const passwords = new ScryptPasswordHasher();
const tokens = new SqliteSessionTokens(sharedDatabase);

export const localGroupsModule = new LiteModule({
  name: 'Groups',
  useCases: [signUp(accounts, passwords), signIn(accounts, passwords, tokens), getMyAccount(accountQueries)],
});

/**
 * Who an `Authorization` header proves, for the transport: the account of a `Bearer` token it accepts, or
 * `undefined` when no token is given or the token proves nothing (docs/adr/0002).
 */
export function authenticatedAccountOf(authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  return match ? tokens.accountOf(match[1]) : undefined;
}

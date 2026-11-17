import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';
import { createGroup, getGroup, getMyGroups } from '@Contexts/Groups/Application/Groups';
import { authenticateWith } from '@Contexts/Groups/Presentation/authentication';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SignedSessionTokens } from '@Contexts/Groups/Infrastructure/SignedSessionTokens';
import { SqliteAccountStore, accountsSchema } from '@Contexts/Groups/Infrastructure/SqliteAccountStore';
import { SqliteGroupStore, groupsTablesSchema } from '@Contexts/Groups/Infrastructure/SqliteGroupStore';

/**
 * The Groups context (conventions/domain.yaml, ADRs 1 and 5): its wiring, as data. Accounts live here (ADR 1): sign-up,
 * sign-in and the signed-in person's own account, over the database the composition root opens with `groupsSchema`
 * (ADR 2). Groups are here too: created by a signed-in person, read by their members (ADR 5). The ports are built here
 * with their adapters and the system clock; the module lists each use case once.
 */
export const groupsSchema = [...accountsSchema, ...groupsTablesSchema];

/** The Groups module, and the authentication the transport gives every request (named exports, ADR 2). */
export async function groupsWiring(database: SqliteDatabase) {
  const accounts = new SqliteAccountStore(database);
  const passwords = new ScryptPasswordHasher();
  const tokens = await SignedSessionTokens.open(database);
  const groups = new SqliteGroupStore(database);

  const module = new LiteModule({
    name: 'Groups',
    useCases: [
      signUp(accounts, passwords, systemClock),
      signIn(accounts, passwords, tokens),
      getMyAccount(accounts),
      createGroup(groups, systemClock),
      getGroup(groups),
      getMyGroups(groups),
    ],
  });
  return { module, authenticate: authenticateWith(tokens) };
}

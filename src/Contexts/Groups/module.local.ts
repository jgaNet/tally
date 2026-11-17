import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { SqliteDatabase, sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';
import { createGroup, getGroup, getGroupMembers, getMyGroups } from '@Contexts/Groups/Application/Groups';
import { acceptInvitation, createInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/SqliteAccountRepository';
import { SqliteAccountQueries } from '@Contexts/Groups/Infrastructure/SqliteAccountQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SqliteSessionTokens } from '@Contexts/Groups/Infrastructure/SqliteSessionTokens';
import { SqliteGroupRepository } from '@Contexts/Groups/Infrastructure/SqliteGroupRepository';
import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/SqliteGroupQueries';
import { SqliteInvitationRepository } from '@Contexts/Groups/Infrastructure/SqliteInvitationRepository';
import { SqliteInvitationQueries } from '@Contexts/Groups/Infrastructure/SqliteInvitationQueries';

/**
 * The Groups context (conventions/domain.yaml, ADR 0001, ADR 0002): accounts, and groups with their members and their
 * invitations. Its adapters are the application's SQLite file; its clock is the system's, given to the use cases that
 * record a time.
 */
const accounts = new SqliteAccountRepository(sharedDatabase);
const accountQueries = new SqliteAccountQueries(sharedDatabase);
const passwords = new ScryptPasswordHasher();
const tokens = new SqliteSessionTokens(sharedDatabase);
const groups = new SqliteGroupRepository(sharedDatabase);
const groupQueries = new SqliteGroupQueries(sharedDatabase);
const invitations = new SqliteInvitationRepository(sharedDatabase);
const invitationQueries = new SqliteInvitationQueries(sharedDatabase);

/**
 * The groups' read model, for Ledger to ask while its own transaction is open (docs/adr/0004). It reads on a connection of
 * its own: the shared one holds the file's turn for the whole transaction, and a read on it would wait for itself. A
 * connection of its own reads what is committed, which is what a membership is.
 */
export const groupsReadModel = new SqliteGroupQueries(new SqliteDatabase());

export const localGroupsModule = new LiteModule({
  name: 'Groups',
  useCases: [
    signUp(accounts, passwords),
    signIn(accounts, passwords, tokens),
    getMyAccount(accountQueries),
    createGroup(groups, systemClock),
    getGroup(groupQueries),
    getMyGroups(groupQueries),
    getGroupMembers(groupQueries),
    createInvitation(invitations, groups, systemClock),
    acceptInvitation(invitations, groups, systemClock),
    getInvitation(invitationQueries),
  ],
});

/**
 * Who an `Authorization` header proves, for the transport: the account of a `Bearer` token it accepts, or
 * `undefined` when no token is given or the token proves nothing (docs/adr/0002).
 */
export function authenticatedAccountOf(authorization: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  return match ? tokens.accountOf(match[1]) : undefined;
}

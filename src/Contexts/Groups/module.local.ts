import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';
import { createGroup, getGroup, getGroupMembers, getMyGroups } from '@Contexts/Groups/Application/Groups';
import { acceptInvitation, createInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';
import { GroupsDatabase } from '@Contexts/Groups/Infrastructure/GroupsDatabase';
import { SqliteAccounts } from '@Contexts/Groups/Infrastructure/SqliteAccounts';
import { SqliteGroups } from '@Contexts/Groups/Infrastructure/SqliteGroups';
import { SqliteInvitations } from '@Contexts/Groups/Infrastructure/SqliteInvitations';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SignedAccessTokens } from '@Contexts/Groups/Infrastructure/SignedAccessTokens';

/**
 * The Groups context, as data (ADR 1, ADR 2, ADR 3, ADR 4): its accounts, groups and invitations in SQLite at `DATABASE_PATH` (read when the first request
 * needs the file, so that a process may set it before then), its password hashing and its tokens, and the use cases
 * it answers. The access tokens are shared with the transport, which says who is calling (`createApplication`).
 */
const database = new GroupsDatabase(() => process.env.DATABASE_PATH || 'tally.sqlite');
const accounts = new SqliteAccounts(database);
const groups = new SqliteGroups(database);
const invitations = new SqliteInvitations(database);
const passwords = new ScryptPasswordHasher();

export const groupsAccessTokens = new SignedAccessTokens(database);

export const localGroupsModule = new LiteModule({
  name: 'Groups',
  useCases: [
    signUp(accounts, passwords, systemClock),
    signIn(accounts, passwords, groupsAccessTokens),
    getMyAccount(accounts),
    createGroup(groups, systemClock),
    getGroup(groups),
    getMyGroups(groups),
    createInvitation(groups, invitations, systemClock),
    acceptInvitation(invitations, groups, systemClock),
    getInvitation(invitations),
    getGroupMembers(groups),
  ],
});

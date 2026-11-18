import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { ledgerBalancesReadModel } from '@Contexts/Ledger/module.local';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';
import {
  archiveGroup,
  createGroup,
  getGroup,
  getGroupMembers,
  getMyGroups,
  leaveGroup,
} from '@Contexts/Groups/Application/Groups';
import { acceptInvitation, createInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';
import { settlementsReadModel } from '@Contexts/Settlements/module.local';
import { BalancesOfLedger } from '@Contexts/Groups/Infrastructure/BalancesOfLedger';
import { WaitingPaymentsOfSettlements } from '@Contexts/Groups/Infrastructure/WaitingPaymentsOfSettlements';
import { GroupsDatabase } from '@Contexts/Groups/Infrastructure/GroupsDatabase';
import { SqliteAccounts } from '@Contexts/Groups/Infrastructure/SqliteAccounts';
import { SqliteGroups } from '@Contexts/Groups/Infrastructure/SqliteGroups';
import { SqliteInvitations } from '@Contexts/Groups/Infrastructure/SqliteInvitations';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SignedAccessTokens } from '@Contexts/Groups/Infrastructure/SignedAccessTokens';

/**
 * The Groups context, as data (ADR 1, ADR 2, ADR 3, ADR 4): its accounts, groups and invitations in PostgreSQL at `DATABASE_URL` (read when the first request
 * needs the database, so that a process may set it before then), its password hashing and its tokens, and the use cases
 * it answers. The access tokens are shared with the transport, which says who is calling (`createApplication`).
 */
export const database = new GroupsDatabase();
const accounts = new SqliteAccounts(database);
const groups = new SqliteGroups(database);
const invitations = new SqliteInvitations(database);
const passwords = new ScryptPasswordHasher();

export const groupsAccessTokens = new SignedAccessTokens(database);

/**
 * The read model of the members, which Ledger asks through its own `GroupMembers` port (ADR 5): the one thing of Groups
 * another context reaches through this file. Ledger's wiring imports this one and this one imports Ledger's, for the two read
 * models each asks the other (ADR 7): each is read when a request comes, never when the modules are built.
 */
export const groupsMembersReadModel = groups;

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
    leaveGroup(
      groups,
      new BalancesOfLedger(() => ledgerBalancesReadModel),
      new WaitingPaymentsOfSettlements(() => settlementsReadModel),
      systemClock,
    ),
    archiveGroup(
      groups,
      new BalancesOfLedger(() => ledgerBalancesReadModel),
      new WaitingPaymentsOfSettlements(() => settlementsReadModel),
      systemClock,
    ),
  ],
});

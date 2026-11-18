import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { sharedDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { ledgerReadModel, waitingPaymentsOfSettlements } from '@Bootstrap/Fastify/readModels';

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
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/SqliteAccountRepository';
import { SqliteAccountQueries } from '@Contexts/Groups/Infrastructure/SqliteAccountQueries';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SqliteSessionTokens } from '@Contexts/Groups/Infrastructure/SqliteSessionTokens';
import { SqliteGroupRepository } from '@Contexts/Groups/Infrastructure/SqliteGroupRepository';
import { SqliteGroupQueries } from '@Contexts/Groups/Infrastructure/SqliteGroupQueries';
import { SqliteInvitationRepository } from '@Contexts/Groups/Infrastructure/SqliteInvitationRepository';
import { SqliteInvitationQueries } from '@Contexts/Groups/Infrastructure/SqliteInvitationQueries';
import { MemberBalancesOfLedger } from '@Contexts/Groups/Infrastructure/MemberBalancesOfLedger';

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
 * The balances, for a leave to be decided while its own transaction is open (docs/adr/0009): Ledger's read model, which the
 * composition root opens on a connection of its own (docs/adr/0004, docs/adr/0009).
 */
const memberBalances = new MemberBalancesOfLedger(ledgerReadModel);

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
    leaveGroup(groups, memberBalances, waitingPaymentsOfSettlements, systemClock),
    archiveGroup(groups, memberBalances, waitingPaymentsOfSettlements, systemClock),
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

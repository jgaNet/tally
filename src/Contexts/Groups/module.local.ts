import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { sharedDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';

import { Role } from '@SharedKernel/Domain';
import {
  administratorDecisionsOfSettlements,
  ledgerReadModel,
  waitingPaymentsOfSettlements,
} from '@Bootstrap/Fastify/readModels';

import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';
import { getAdministratorsLog, reinstateAccount, suspendAccount } from '@Contexts/Groups/Application/Administration';
import {
  archiveGroup,
  createGroup,
  getGroup,
  getGroupMembers,
  getMyGroups,
  leaveGroup,
  mergeGroups,
} from '@Contexts/Groups/Application/Groups';
import { GroupsMergedHandler } from '@Contexts/Groups/Application/Events/GroupsMergedHandler';
import { GroupsMergedEvent } from '@Contexts/Groups/Domain/Group/Events/GroupEvents';
import { acceptInvitation, createInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';
import { PostgresAccountRepository } from '@Contexts/Groups/Infrastructure/PostgresAccountRepository';
import { PostgresAccountQueries } from '@Contexts/Groups/Infrastructure/PostgresAccountQueries';
import { PostgresAdministratorChanges } from '@Contexts/Groups/Infrastructure/PostgresAdministratorChanges';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { PostgresSessionTokens } from '@Contexts/Groups/Infrastructure/PostgresSessionTokens';
import { PostgresGroupRepository } from '@Contexts/Groups/Infrastructure/PostgresGroupRepository';
import { PostgresGroupQueries } from '@Contexts/Groups/Infrastructure/PostgresGroupQueries';
import { PostgresInvitationRepository } from '@Contexts/Groups/Infrastructure/PostgresInvitationRepository';
import { PostgresInvitationQueries } from '@Contexts/Groups/Infrastructure/PostgresInvitationQueries';
import { MemberBalancesOfLedger } from '@Contexts/Groups/Infrastructure/MemberBalancesOfLedger';

/**
 * The Groups context (conventions/domain.yaml, ADR 0001, ADR 0002): accounts, and groups with their members and their
 * invitations. Its adapters are the application's PostgreSQL database; its clock is the system's, given to the use cases that
 * record a time.
 */
const accounts = new PostgresAccountRepository(sharedDatabase);
const accountQueries = new PostgresAccountQueries(sharedDatabase);
/** The administrators' log of the changes to accounts, which Groups writes and reads itself (request 34, docs/adr/0034). */
const administrationChanges = new PostgresAdministratorChanges(sharedDatabase);
const passwords = new ScryptPasswordHasher();
const tokens = new PostgresSessionTokens(sharedDatabase);
const groups = new PostgresGroupRepository(sharedDatabase);
const groupQueries = new PostgresGroupQueries(sharedDatabase);
const invitations = new PostgresInvitationRepository(sharedDatabase);
const invitationQueries = new PostgresInvitationQueries(sharedDatabase);

/**
 * The balances, for a leave to be decided while its own transaction is open (docs/adr/0009): Ledger's read model, which the
 * composition root opens on a connection of its own (docs/adr/0004, docs/adr/0009).
 */
const memberBalances = new MemberBalancesOfLedger(ledgerReadModel);

export const localGroupsModule = new LiteModule({
  name: 'Groups',
  useCases: [
    signUp(accounts, passwords),
    signIn(accounts, passwords, tokens, administratorEmailsOf),
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
    mergeGroups(groups, invitations, waitingPaymentsOfSettlements, systemClock),
    suspendAccount(accounts, systemClock),
    reinstateAccount(accounts, systemClock),
    getAdministratorsLog(administrationChanges, administratorDecisionsOfSettlements),
  ],
  domainEvents: [
    // A merge is told to the other contexts as the published fact (request 31, docs/adr/0031): Ledger and Settlements move what they hold.
    { event: GroupsMergedEvent, handlers: [new GroupsMergedHandler()] },
  ],
});

/**
 * The administrators' emails, read from `ADMIN_EMAILS` (a comma-separated list) each time a sign-in is made: an account with one of them,
 * whatever its case, is an administrator when it signs in (docs/adr/0033).
 */
export function administratorEmailsOf(): string[] {
  return String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(each => each.trim())
    .filter(Boolean);
}

/**
 * Who an `Authorization` header proves, for the transport: the account of a `Bearer` token it accepts and the role it had at sign-in, or
 * `undefined` when no token is given or the token proves nothing (docs/adr/0002, docs/adr/0033).
 */
export function authenticatedCallerOf(
  authorization: string | undefined,
): { subjectId: string; role: Role } | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
  return match ? tokens.accountOf(match[1]) : undefined;
}

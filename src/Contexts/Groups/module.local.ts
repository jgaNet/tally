import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';
import { IMemberBalances, IWaitingPayments } from '@Contexts/Groups/Application/IMemberBalances';
import {
  archiveGroup,
  createGroup,
  getGroup,
  getGroupMembers,
  getMyGroups,
  leaveGroup,
} from '@Contexts/Groups/Application/Groups';
import { acceptInvitation, createInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';
import { authenticateWith } from '@Contexts/Groups/Presentation/authentication';
import { IGroupRoster } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SignedSessionTokens } from '@Contexts/Groups/Infrastructure/SignedSessionTokens';
import { PostgresAccountStore, accountsSchema } from '@Contexts/Groups/Infrastructure/PostgresAccountStore';
import { PostgresGroupStore, groupsTablesSchema } from '@Contexts/Groups/Infrastructure/PostgresGroupStore';
import {
  PostgresInvitationStore,
  invitationsTablesSchema,
} from '@Contexts/Groups/Infrastructure/PostgresInvitationStore';
import { PostgresGroupAuditLog, groupAuditTablesSchema } from '@Contexts/Groups/Infrastructure/PostgresGroupAuditLog';

/**
 * The Groups context (conventions/domain.yaml, ADRs 1 and 5): its wiring, as data. Accounts live here (ADR 1): sign-up,
 * sign-in and the signed-in person's own account, over the database the composition root opens with `groupsSchema`
 * (ADR 2). Groups are here too: created by a signed-in person, read by their members (ADR 5). The ports are built here
 * with their adapters and the system clock; the module lists each use case once. Invitations are an aggregate of their
 * own (feature 3): they join the groups they name, so their table comes after the groups'.
 */
export const groupsSchema = [
  ...accountsSchema,
  ...groupsTablesSchema,
  ...invitationsTablesSchema,
  ...groupAuditTablesSchema,
];

/**
 * The roster of groups, over the database alone: the read model other contexts read (ADR 6), built before the wiring so that
 * the composition root can give it to the other read models (Ledger's balances, which count what passed when members left)
 * without waiting for this module (ADR 15).
 */
export function groupRoster(database: PostgresDatabase): IGroupRoster {
  return new PostgresGroupStore(database);
}

/**
 * The Groups module, the authentication the transport gives every request (named exports, ADR 2), and the roster of
 * groups other contexts read (`roster`, the read-model port of ADR 6, for Ledger's split). Leaving (feature 9, request 20)
 * asks a member's balance through `balances`, the port Groups owns (ADR 1 T5), and whether a payment of theirs waits at
 * the provider through `waiting` (ADR 15): the composition root gives both, over the other contexts' read models, so this
 * file imports no other context.
 */
export async function groupsWiring(database: PostgresDatabase, balances: IMemberBalances, waiting: IWaitingPayments) {
  const accounts = new PostgresAccountStore(database);
  const passwords = new ScryptPasswordHasher();
  const tokens = await SignedSessionTokens.open(database);
  const groups = new PostgresGroupStore(database);
  const invitations = new PostgresInvitationStore(database);
  const audit = new PostgresGroupAuditLog(database);

  const module = new LiteModule({
    name: 'Groups',
    useCases: [
      signUp(accounts, passwords, systemClock),
      signIn(accounts, passwords, tokens),
      getMyAccount(accounts),
      createGroup(groups, systemClock),
      getGroup(groups),
      getMyGroups(groups),
      createInvitation(groups, invitations, systemClock),
      getInvitation(invitations),
      acceptInvitation(groups, invitations, systemClock),
      getGroupMembers(groups, accounts),
      leaveGroup(groups, balances, waiting, audit, systemClock),
      archiveGroup(groups, balances, waiting, systemClock),
    ],
  });
  return { module, authenticate: authenticateWith(tokens), roster: groups };
}

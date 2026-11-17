import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { systemClock } from '@Architecture/Infrastructure/Clock/SystemClock';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { getMyAccount, signIn, signUp } from '@Contexts/Groups/Application/Accounts';
import { IMemberBalances, IWaitingPayments } from '@Contexts/Groups/Application/IMemberBalances';
import { createGroup, getGroup, getGroupMembers, getMyGroups, leaveGroup } from '@Contexts/Groups/Application/Groups';
import { acceptInvitation, createInvitation, getInvitation } from '@Contexts/Groups/Application/Invitations';
import { authenticateWith } from '@Contexts/Groups/Presentation/authentication';
import { IGroupRoster } from '@Contexts/Groups/Domain/Group/Ports/IGroupRoster';
import { ScryptPasswordHasher } from '@Contexts/Groups/Infrastructure/ScryptPasswordHasher';
import { SignedSessionTokens } from '@Contexts/Groups/Infrastructure/SignedSessionTokens';
import { SqliteAccountStore, accountsSchema } from '@Contexts/Groups/Infrastructure/SqliteAccountStore';
import { SqliteGroupStore, groupsTablesSchema } from '@Contexts/Groups/Infrastructure/SqliteGroupStore';
import { SqliteInvitationStore, invitationsTablesSchema } from '@Contexts/Groups/Infrastructure/SqliteInvitationStore';

/**
 * The Groups context (conventions/domain.yaml, ADRs 1 and 5): its wiring, as data. Accounts live here (ADR 1): sign-up,
 * sign-in and the signed-in person's own account, over the database the composition root opens with `groupsSchema`
 * (ADR 2). Groups are here too: created by a signed-in person, read by their members (ADR 5). The ports are built here
 * with their adapters and the system clock; the module lists each use case once. Invitations are an aggregate of their
 * own (feature 3): they join the groups they name, so their table comes after the groups'.
 */
export const groupsSchema = [...accountsSchema, ...groupsTablesSchema, ...invitationsTablesSchema];

/**
 * The roster of groups, over the database alone: the read model other contexts read (ADR 6), built before the wiring so that
 * the composition root can give it to the other read models (Ledger's balances, which count what passed when members left)
 * without waiting for this module (ADR 15).
 */
export function groupRoster(database: SqliteDatabase): IGroupRoster {
  return new SqliteGroupStore(database);
}

/**
 * The Groups module, the authentication the transport gives every request (named exports, ADR 2), and the roster of
 * groups other contexts read (`roster`, the read-model port of ADR 6, for Ledger's split). Leaving (feature 9, request 20)
 * asks a member's balance through `balances`, the port Groups owns (ADR 1 T5), and whether a payment of theirs waits at
 * the provider through `waiting` (ADR 15): the composition root gives both, over the other contexts' read models, so this
 * file imports no other context.
 */
export async function groupsWiring(database: SqliteDatabase, balances: IMemberBalances, waiting: IWaitingPayments) {
  const accounts = new SqliteAccountStore(database);
  const passwords = new ScryptPasswordHasher();
  const tokens = await SignedSessionTokens.open(database);
  const groups = new SqliteGroupStore(database);
  const invitations = new SqliteInvitationStore(database);

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
      leaveGroup(groups, balances, waiting, systemClock),
    ],
  });
  return { module, authenticate: authenticateWith(tokens), roster: groups };
}

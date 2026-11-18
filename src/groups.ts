import { randomUUID } from 'node:crypto';
import { recordAudit } from './audit';
import { balanceOfMembership, balancesOfGroup } from './balances';
import { CURRENCIES, type Currency } from './currencies';
import type { Database, Querier } from './database';
import { inTransaction } from './transactions';
import { Refusal } from './refusal';
import { characters } from './text';

/**
 * Every amount of a group is a whole number of the minor unit of its currency (see `currencies.ts`). A group's currency
 * never changes. The currencies are re-exported for the modules that name a group's.
 */
export { CURRENCIES, type Currency } from './currencies';

const MAX_NAME_LENGTH = 60;

/**
 * What the application knows of a group, as its members see it. `archivedAt` (an ISO 8601 instant) is there once the group
 * is archived, and only then.
 */
export interface Group {
  readonly id: string;
  readonly name: string;
  readonly currency: Currency;
  readonly ownerId: string;
  readonly archivedAt?: string;
}

interface GroupRow {
  id: string;
  name: string;
  currency: Currency;
  owner_id: string;
  archived_at: string | null;
}

const GROUP_COLUMNS = 'g.id, g.name, g.currency, g.owner_id, g.archived_at';

function groupOf(row: GroupRow): Group {
  const group = { id: row.id, name: row.name, currency: row.currency, ownerId: row.owner_id };
  return row.archived_at === null ? group : { ...group, archivedAt: row.archived_at };
}

/**
 * Refuses a change to an archived group, `409` as `GroupIsArchived`, the same for every change. Each write calls it inside
 * its own transaction, once it knows the caller is a member, and before any other rule: a refused change changes nothing.
 */
export function assertNotArchived(group: Group): void {
  if (group.archivedAt !== undefined) {
    throw new Refusal(409, 'GroupIsArchived', 'The group is archived: nothing in it changes.');
  }
}

/**
 * Creates a group owned by `ownerId`, whose first member is its owner, and returns its id. The name
 * has 1 to 60 characters and is not only spaces (it is stored trimmed); the currency is one of
 * {@link CURRENCIES}.
 */
export async function createGroup(
  db: Database,
  input: { ownerId: string; name: string; currency: string },
): Promise<string> {
  const { ownerId, name, currency } = input;
  const trimmedName = name.trim();
  if (characters(name) > MAX_NAME_LENGTH || trimmedName.length === 0) {
    throw new Refusal(
      422,
      'NameIsInvalid',
      `The name must have 1 to ${MAX_NAME_LENGTH} characters and not be only spaces.`,
    );
  }
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    throw new Refusal(422, 'CurrencyIsUnsupported', `The currency must be one of ${CURRENCIES.join(', ')}.`);
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  await inTransaction(db, async tx => {
    await tx
      .prepare('INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, trimmedName, currency, ownerId, now);
    await tx
      .prepare('INSERT INTO group_members (group_id, account_id, joined_at) VALUES (?, ?, ?)')
      .run(id, ownerId, now);
  });
  return id;
}

/** The group with this id, whoever reads it; `undefined` when there is none. Reading never changes it. */
export async function findGroup(db: Querier, groupId: string): Promise<Group | undefined> {
  const row = await db.prepare(`SELECT ${GROUP_COLUMNS} FROM groups g WHERE g.id = ?`).get<GroupRow>(groupId);
  return row && groupOf(row);
}

/** The group with this id, when `accountId` is one of its current members; `undefined` otherwise, as if it did not exist. */
export async function findGroupOfMember(db: Querier, accountId: string, groupId: string): Promise<Group | undefined> {
  const row = await db
    .prepare(
      `SELECT ${GROUP_COLUMNS} FROM groups g
       JOIN group_members m ON m.group_id = g.id
       WHERE g.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get<GroupRow>(groupId, accountId);
  return row && groupOf(row);
}

/** A member of a group, as its members see it: the owner is `owner`, every other member `member`. */
export interface Member {
  readonly memberId: string;
  readonly name: string;
  readonly role: 'owner' | 'member';
  readonly joinedAt: string;
}

interface MemberRow {
  member_id: string;
  name: string;
  role: Member['role'];
  joined_at: string;
}

/**
 * The current members of a group, the earliest to join first; the owner, who created the group, is first.
 * A member who left is not among them.
 */
export async function membersOfGroup(db: Querier, groupId: string): Promise<Member[]> {
  const rows = await db
    .prepare(
      `SELECT m.account_id AS member_id, a.name,
              CASE WHEN g.owner_id = m.account_id THEN 'owner' ELSE 'member' END AS role,
              m.joined_at
       FROM group_members m
       JOIN groups g ON g.id = m.group_id
       JOIN accounts a ON a.id = m.account_id
       WHERE m.group_id = ? AND m.left_at IS NULL
       ORDER BY m.joined_at ASC, m.seq ASC`,
    )
    .all<MemberRow>(groupId);
  return rows.map(row => ({ memberId: row.member_id, name: row.name, role: row.role, joinedAt: row.joined_at }));
}

/** The groups `accountId` is a current member of, the most recently created first. */
export async function groupsOfMember(db: Querier, accountId: string): Promise<Group[]> {
  const rows = await db
    .prepare(
      `SELECT ${GROUP_COLUMNS} FROM groups g
       JOIN group_members m ON m.group_id = g.id
       WHERE m.account_id = ? AND m.left_at IS NULL
       ORDER BY g.created_at DESC, g.seq DESC`,
    )
    .all<GroupRow>(accountId);
  return rows.map(groupOf);
}

/**
 * True when `accountId` is a member of the group now or has been one: a member who left keeps the record
 * of having been one, so that the group's members can still read their statement. Reading changes nothing.
 */
export async function isOrWasMember(db: Querier, accountId: string, groupId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND account_id = ?')
    .get(groupId, accountId);
  return row !== undefined;
}

/**
 * Makes `accountId` leave the group, which they must be a current member of (else `404`, as if the group
 * did not exist). The owner, who created the group, cannot leave it (`403`). Whatever the member's balance,
 * they may leave: it passes to the owner (see {@link balancesOfGroup}), in this same step, so the balances
 * still add up to 0. But not while a settlement through the payment provider that they pay or receive is
 * `pending`, `refunding` or `contested` (`409`): they leave once it has ended. A member who left is no longer among the
 * group's members or balances, and the group is not among their groups; their expenses stay as they were.
 * The check and the leaving are one transaction, so an expense or settlement recorded at the same moment
 * is either counted before the member leaves, or refused because they are no longer a member. An archived group
 * is refused (`409`, see {@link assertNotArchived}).
 */
export async function leaveGroup(db: Database, input: { groupId: string; accountId: string }): Promise<void> {
  const { groupId, accountId } = input;
  await inTransaction(db, async tx => {
    const group = await findGroupOfMember(tx, accountId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    assertNotArchived(group);
    if (group.ownerId === accountId) {
      throw new Refusal(403, 'OwnerCannotLeave', 'The owner created the group and cannot leave it.');
    }
    const waiting = await tx
      .prepare(
        `SELECT 1 FROM settlements
         WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding', 'contested')
           AND (payer_id = ? OR payee_id = ?)`,
      )
      .get(groupId, accountId, accountId);
    if (waiting !== undefined) {
      throw new Refusal(
        409,
        'SettlementIsInProgress',
        'A settlement through the provider that the member pays or receives has not ended yet.',
      );
    }
    const at = new Date().toISOString();
    // What the member holds passes to the owner as it leaves: a change of money, unless the balance is 0.
    const balance = await balanceOfMembership(tx, groupId, accountId);
    await tx
      .prepare('UPDATE group_members SET left_at = ? WHERE group_id = ? AND account_id = ?')
      .run(at, groupId, accountId);
    if (balance !== 0) {
      await recordAudit(tx, {
        groupId,
        at,
        by: accountId,
        action: 'balance-passed',
        subjectId: accountId,
        amount: balance,
      });
    }
  });
}

/**
 * Archives the group, which its owner does, once every member's balance is 0 and no settlement through the provider is
 * `pending`, `refunding` or `contested`. The group stays, for the record, and nothing in it changes any more; `archivedAt` says when it
 * was archived. Refused with `404` when `accountId` is not a current member of the group, with `409` as `GroupIsArchived`
 * when it is archived already, with `403` as `NotOwner` when the caller is another member, with `409` as
 * `BalancesAreNotZero` when a balance is not 0, and with `409` as `SettlementIsInProgress` when a settlement through the
 * provider has not ended. The checks and the archiving are one transaction, so a change recorded at the same moment is
 * either counted before, or refused because the group is archived.
 */
export async function archiveGroup(db: Database, input: { groupId: string; accountId: string }): Promise<void> {
  const { groupId, accountId } = input;
  await inTransaction(db, async tx => {
    const group = await findGroupOfMember(tx, accountId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    assertNotArchived(group);
    if (group.ownerId !== accountId) {
      throw new Refusal(403, 'NotOwner', 'Only the owner of the group may archive it.');
    }
    if ((await balancesOfGroup(tx, groupId)).some(member => member.balance !== 0)) {
      throw new Refusal(409, 'BalancesAreNotZero', 'Every balance must be 0 before the group is archived.');
    }
    const waiting = await tx
      .prepare(
        `SELECT 1 FROM settlements
         WHERE group_id = ? AND method = 'provider' AND status IN ('pending', 'refunding', 'contested')`,
      )
      .get(groupId);
    if (waiting !== undefined) {
      throw new Refusal(409, 'SettlementIsInProgress', 'A settlement through the provider has not ended yet.');
    }
    await tx.prepare('UPDATE groups SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), groupId);
  });
}

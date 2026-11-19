import { randomUUID } from 'node:crypto';
import { recordAudit } from '../audit/audit';
import { balancesOf } from '../balances/balances';
import { type Database, inTransaction } from '../database';
import { Refusal } from '../refusal';
import { type Currency, type GroupInput, validateGroup } from './validation';

export interface Group {
  id: string;
  name: string;
  currency: Currency;
  ownerId: string;
  /** When the group was archived. Present only once it is: an archived group is read only. */
  archivedAt?: string;
}

interface GroupRow {
  id: string;
  name: string;
  currency: Currency;
  owner_id: string;
  archived_at: string | null;
}

const toGroup = (row: GroupRow): Group => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  ownerId: row.owner_id,
  ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
});

/** The columns a `GroupRow` is read from, `groups` being the table they come from. */
const GROUP_COLUMNS = 'groups.id, groups.name, groups.currency, groups.owner_id, groups.archived_at';

/**
 * Refuses a change to `groupId` once it is archived: an archived group is read only, so every request that would
 * change something in it is refused by this one rule, and changes nothing. Called after the group has been found
 * for the caller, and inside the transaction of the change, so an archiving that lands first is seen.
 */
export async function requireNotArchived(db: Database, groupId: string): Promise<void> {
  if (await isArchived(db, groupId)) {
    throw new Refusal(409, 'GroupArchived', 'The group is archived: nothing in it changes any more.');
  }
}

/** Whether `groupId` is archived. Reading it changes nothing. */
export async function isArchived(db: Database, groupId: string): Promise<boolean> {
  const row = await db.row<{ archived_at: string | null }>('SELECT archived_at FROM groups WHERE id = ?', [groupId]);
  return row?.archived_at != null;
}

/**
 * Creates a group owned by `ownerId`, whose first member its owner is. The group and that
 * membership are written together, or not at all.
 */
export async function createGroup(db: Database, ownerId: string, input: GroupInput): Promise<string> {
  const group = validateGroup(input);
  const id = randomUUID();
  const now = new Date().toISOString();
  await inTransaction(db, async () => {
    await db.execute('INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      group.name,
      group.currency,
      ownerId,
      now,
    ]);
    await db.execute('INSERT INTO memberships (group_id, account_id, joined_at) VALUES (?, ?, ?)', [id, ownerId, now]);
  });
  return id;
}

/**
 * The group, when `accountId` is one of its members. For anyone else it is `undefined`, the same
 * as a group that does not exist.
 */
export async function groupForMember(db: Database, groupId: string, accountId: string): Promise<Group | undefined> {
  const row = await db.row<GroupRow>(
    `SELECT ${GROUP_COLUMNS}
       FROM groups JOIN memberships ON memberships.group_id = groups.id
      WHERE groups.id = ? AND memberships.account_id = ?`,
    [groupId, accountId],
  );
  return row === undefined ? undefined : toGroup(row);
}

/** The groups `accountId` is a member of, the most recently created first. */
export async function groupsOfMember(db: Database, accountId: string): Promise<Group[]> {
  const rows = await db.rows<GroupRow>(
    `SELECT ${GROUP_COLUMNS}
       FROM groups JOIN memberships ON memberships.group_id = groups.id
      WHERE memberships.account_id = ?
      ORDER BY groups.created_at DESC, groups.seq DESC`,
    [accountId],
  );
  return rows.map(toGroup);
}

/** The currency `groupId` counts in. It is fixed when the group is created. */
export async function currencyOfGroup(db: Database, groupId: string): Promise<Currency> {
  const row = await db.row<{ currency: Currency }>('SELECT currency FROM groups WHERE id = ?', [groupId]);
  return (row as { currency: Currency }).currency;
}

/**
 * The group, for a member of it. Anyone else is refused with `404`, the same as a group that does
 * not exist: the group is not there for them.
 */
export async function requireMembership(db: Database, groupId: string, accountId: string): Promise<Group> {
  const group = await groupForMember(db, groupId, accountId);
  if (!group) {
    throw new Refusal(404, 'NotFound', 'There is no such group.');
  }
  return group;
}

/**
 * Whether `accountId` has ever been a member of `groupId`, whether or not it still is. Reading it
 * changes nothing.
 */
export async function hasBeenMember(db: Database, groupId: string, accountId: string): Promise<boolean> {
  const row = await db.row(
    `SELECT 1 FROM memberships WHERE group_id = ? AND account_id = ?
     UNION ALL
     SELECT 1 FROM former_members WHERE group_id = ? AND account_id = ?`,
    [groupId, accountId, groupId, accountId],
  );
  return row !== undefined;
}

/**
 * The accounts among `accountIds` that are no longer members of `groupId`, each once. Those who have
 * left cannot be in a new expense, nor pay one, and an expense that names them cannot be changed.
 */
export async function leftMembersAmong(
  db: Database,
  groupId: string,
  accountIds: readonly string[],
): Promise<string[]> {
  const current = new Set(
    (await db.rows<{ account_id: string }>('SELECT account_id FROM memberships WHERE group_id = ?', [groupId])).map(
      row => row.account_id,
    ),
  );
  return [...new Set(accountIds)].filter(accountId => !current.has(accountId));
}

/**
 * Makes `accountId` a member of `groupId`, as a member who joins by an invitation. Someone already
 * a member is refused with `409`. Someone who left joins again as a new member, last in the order.
 * Runs inside `inTransaction`, so the check and the write cannot be split by another join.
 */
export async function joinGroup(db: Database, groupId: string, accountId: string): Promise<void> {
  const existing = await db.row('SELECT 1 FROM memberships WHERE group_id = ? AND account_id = ?', [
    groupId,
    accountId,
  ]);
  if (existing) {
    throw new Refusal(409, 'AlreadyMember', 'You are already a member of this group.');
  }
  await db.execute('INSERT INTO memberships (group_id, account_id, joined_at) VALUES (?, ?, ?)', [
    groupId,
    accountId,
    new Date().toISOString(),
  ]);
}

/**
 * Makes `accountId` leave `groupId`. Whatever its balance, that balance passes to the owner of the group, in
 * the same step: the owner's balance moves by it, and the one who left is at 0. It is refused while a payment
 * through the provider involving it is pending or being refunded. The owner cannot leave the group they
 * created; anyone outside the group is refused with `404`, as for a group that does not exist. The balance
 * is read, the transfer to the owner written and the membership removed in one transaction, so no expense or
 * settlement lands between them.
 */
export async function leaveGroup(db: Database, groupId: string, accountId: string): Promise<void> {
  await inTransaction(db, async () => {
    const group = await requireMembership(db, groupId, accountId);
    await requireNotArchived(db, groupId);
    if (group.ownerId === accountId) {
      throw new Refusal(403, 'OwnerCannotLeave', 'The owner cannot leave the group they created.');
    }
    // A payment waiting at the provider would still move a balance once it succeeds, and a refund waiting
    // at it once it is refunded: either must end first.
    const waiting = await db.row(
      `SELECT 1 FROM settlements
        WHERE group_id = ? AND status IN ('pending', 'refunding', 'contested') AND (payer_id = ? OR payee_id = ?)`,
      [groupId, accountId, accountId],
    );
    if (waiting) {
      throw new Refusal(
        409,
        'PaymentPending',
        'A payment or a refund through the provider is waiting for you, or a payment of yours is contested: it must end first.',
      );
    }
    const balance = (await balancesOf(db, groupId)).find(entry => entry.memberId === accountId)?.balance ?? 0;
    const at = new Date().toISOString();
    if (balance !== 0) {
      await db.execute('INSERT INTO balance_transfers (group_id, from_id, to_id, amount, at) VALUES (?, ?, ?, ?, ?)', [
        groupId,
        accountId,
        group.ownerId,
        balance,
        at,
      ]);
      await recordAudit(
        db,
        groupId,
        { by: accountId, action: 'balance-passed', subjectId: accountId, amount: balance },
        at,
      );
    }
    await db.execute('DELETE FROM memberships WHERE group_id = ? AND account_id = ?', [groupId, accountId]);
    // A debt noted before the member left is not carried over: one who joins again is noted afresh.
    await db.execute('DELETE FROM noted_debts WHERE group_id = ? AND account_id = ?', [groupId, accountId]);
    await db.execute(
      `INSERT INTO former_members (group_id, account_id, left_at) VALUES (?, ?, ?)
       ON CONFLICT (group_id, account_id) DO UPDATE SET left_at = excluded.left_at`,
      [groupId, accountId, new Date().toISOString()],
    );
  });
}

/**
 * Archives `groupId`, by its owner, once the trip is over: every member's balance is 0 and no payment through the
 * provider is pending or being refunded. The owner is the only one who may; a member who is not the owner is refused
 * with `403`, and anyone outside the group with `404`. An archived group is refused with `GroupArchived`, so
 * archiving it again is too. The checks and the write are one transaction, so a settlement cannot land between them.
 */
export async function archiveGroup(db: Database, groupId: string, accountId: string, at: Date): Promise<void> {
  await inTransaction(db, async () => {
    const group = await requireMembership(db, groupId, accountId);
    await requireNotArchived(db, groupId);
    if (group.ownerId !== accountId) {
      throw new Refusal(403, 'NotPermitted', 'Only the owner of the group may archive it.');
    }
    if ((await balancesOf(db, groupId)).some(entry => entry.balance !== 0)) {
      throw new Refusal(
        409,
        'BalancesNotSettled',
        'The balance of every member must be 0 before the group is archived.',
      );
    }
    const waiting = await db.row(
      `SELECT 1 FROM settlements WHERE group_id = ? AND status IN ('pending', 'refunding', 'contested')`,
      [groupId],
    );
    if (waiting) {
      throw new Refusal(
        409,
        'PaymentPending',
        'A payment or a refund through the provider is waiting, or a payment is contested: it must end first.',
      );
    }
    await db.execute('UPDATE groups SET archived_at = ? WHERE id = ?', [at.toISOString(), groupId]);
  });
}

export interface Member {
  memberId: string;
  name: string;
  role: 'owner' | 'member';
  joinedAt: string;
}

interface MemberRow {
  member_id: string;
  name: string;
  owner_id: string;
  joined_at: string;
}

/**
 * The members of a group, the earliest to join first. The owner joined when the group was made,
 * so is first. Two joins at the same instant keep the order they were written in.
 */
export async function membersOf(db: Database, groupId: string): Promise<Member[]> {
  const rows = await db.rows<MemberRow>(
    `SELECT accounts.id AS member_id, accounts.name, groups.owner_id, memberships.joined_at
       FROM memberships
       JOIN accounts ON accounts.id = memberships.account_id
       JOIN groups ON groups.id = memberships.group_id
      WHERE memberships.group_id = ?
      ORDER BY memberships.joined_at, memberships.seq`,
    [groupId],
  );
  return rows.map(row => ({
    memberId: row.member_id,
    name: row.name,
    role: row.member_id === row.owner_id ? 'owner' : 'member',
    joinedAt: row.joined_at,
  }));
}

import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

interface GroupRow {
  id: string;
  name: string;
  currency: string;
  owner_id: string;
  created_at: string;
  version: number;
}

/** The groups' repository over the PostgreSQL database; used inside the command's transaction, which holds the connection. */
export class PostgresGroupRepository implements IGroupRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async ownsAGroupWithOtherMembers(ownerId: Id): Promise<boolean> {
    const row = await this.database.connection.row(
      `SELECT 1 AS found FROM tally_groups g
        WHERE g.owner_id = ?
          AND EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = g.id AND m.account_id <> g.owner_id AND m.left_at IS NULL)
        LIMIT 1`,
      ownerId.value,
    );
    return row !== undefined;
  }

  async findById(id: Id): Promise<Group | null> {
    const { connection } = this.database;
    const row = await connection.row<GroupRow>('SELECT * FROM tally_groups WHERE id = ?', id.value);
    if (!row) return null;
    const members = await connection.rows<{ account_id: string; joined_at: string; left_at: string | null }>(
      'SELECT account_id, joined_at, left_at FROM group_members WHERE group_id = ? ORDER BY position',
      id.value,
    );
    const passed = await connection.rows<{
      from_id: string;
      to_id: string;
      amount: number;
      passed_at: string;
      origin: string | null;
    }>(
      `SELECT p.from_id, p.to_id, p.amount, p.passed_at, o.origin
         FROM group_balances_passed p
         LEFT JOIN group_balances_passed_origins o ON o.group_id = p.group_id AND o.position = p.position
        WHERE p.group_id = ? ORDER BY p.position`,
      id.value,
    );
    const archive = await connection.row<{ archived_at: string }>(
      'SELECT archived_at FROM group_archives WHERE group_id = ?',
      id.value,
    );
    return Group.fromSnapshot({
      id: row.id,
      name: row.name,
      currency: row.currency,
      ownerId: row.owner_id,
      members: members.map(member => ({
        accountId: member.account_id,
        joinedAt: member.joined_at,
        leftAt: member.left_at,
      })),
      passed: passed.map(fact => ({
        fromId: fact.from_id,
        toId: fact.to_id,
        amount: Number(fact.amount),
        passedAt: fact.passed_at,
        origin: fact.origin,
      })),
      createdAt: row.created_at,
      archivedAt: archive?.archived_at ?? null,
      version: row.version,
    });
  }

  async save(group: Group): Promise<IResult> {
    const { id, name, currency, ownerId, members, passed, createdAt, archivedAt, mergedInto, version } =
      group.toSnapshot();
    const { connection } = this.database;
    if (mergedInto) return this.forget(id, version);
    if (version === 0) {
      await connection.run(
        'INSERT INTO tally_groups (id, name, currency, owner_id, created_at, version) VALUES (?, ?, ?, ?, ?, 1)',
        id,
        name,
        currency,
        ownerId,
        createdAt,
      );
    } else {
      const { changes } = await connection.run(
        'UPDATE tally_groups SET version = version + 1 WHERE id = ? AND version = ?',
        id,
        version,
      );
      if (changes === 0) {
        return Result.fail(new ConcurrencyConflictException('Groups', 'The group changed since it was read', { id }));
      }
    }
    await connection.run('DELETE FROM group_members WHERE group_id = ?', id);
    for (const [position, { accountId, joinedAt, leftAt }] of members.entries()) {
      await connection.run(
        'INSERT INTO group_members (group_id, account_id, position, joined_at, left_at) VALUES (?, ?, ?, ?, ?)',
        id,
        accountId,
        position,
        joinedAt,
        leftAt,
      );
    }
    // A balance that passed is a fact: each is written once, at its position, and never changed (ON CONFLICT DO NOTHING).
    for (const [position, fact] of passed.entries()) {
      await connection.run(
        `INSERT INTO group_balances_passed (group_id, position, from_id, to_id, amount, passed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        id,
        position,
        fact.fromId,
        fact.toId,
        fact.amount,
        fact.passedAt,
      );
      if (fact.origin) {
        await connection.run(
          `INSERT INTO group_balances_passed_origins (group_id, position, origin) VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING`,
          id,
          position,
          fact.origin,
        );
      }
    }
    // An archive is a fact: written once, and a group archived by another save is not archived twice (request 27).
    if (archivedAt) {
      await connection.run(
        'INSERT INTO group_archives (group_id, archived_at) VALUES (?, ?) ON CONFLICT DO NOTHING',
        id,
        archivedAt,
      );
    }
    return Result.ok();
  }

  /**
   * Forgets a group merged into another (request 31), in the merge's transaction: from then on it does not exist, and its
   * invitations lead nowhere. Its members and its balances that passed are the group kept's, which the same transaction saves.
   */
  private async forget(id: string, version: number): Promise<IResult> {
    const { connection } = this.database;
    const { changes } = await connection.run('DELETE FROM tally_groups WHERE id = ? AND version = ?', id, version);
    if (changes === 0) {
      return Result.fail(new ConcurrencyConflictException('Groups', 'The group changed since it was read', { id }));
    }
    await connection.run('DELETE FROM group_members WHERE group_id = ?', id);
    await connection.run('DELETE FROM group_balances_passed WHERE group_id = ?', id);
    await connection.run('DELETE FROM group_balances_passed_origins WHERE group_id = ?', id);
    await connection.run('DELETE FROM group_invitations WHERE group_id = ?', id);
    return Result.ok();
  }
}

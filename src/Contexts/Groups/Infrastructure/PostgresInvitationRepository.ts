import { ConcurrencyConflictException, IResult, Result } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { prepareGroupsSchema } from '@Contexts/Groups/Infrastructure/PostgresGroupRepository';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { InvitationSnapshot } from '@Contexts/Groups/Domain/Invitation/DTOs';

/** The invitations' table: an invitation's id is the link, so it is the primary key. */
export const INVITATIONS_SCHEMA =
  'CREATE TABLE IF NOT EXISTS invitations (id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups (id) DEFERRABLE INITIALLY DEFERRED, invited_by TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL)';

/**
 * The invitations' schema step, run once when the database is prepared (docs/adr/0029). The table references the groups,
 * so the groups' tables are made first: the step does not depend on the order the adapters were wired in.
 */
export async function prepareInvitationsSchema(database: PostgresDatabase): Promise<void> {
  await prepareGroupsSchema(database);
  await database.exec(INVITATIONS_SCHEMA);
}

type InvitationRow = { id: string; group_id: string; invited_by: string; created_at: string; version: number };

/** The invitations' store over PostgreSQL (docs/adr/0001). Its methods run inside a transaction: the use case's. */
export class PostgresInvitationRepository implements IInvitationRepository {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareInvitationsSchema);
  }

  async findById(id: string): Promise<Invitation | undefined> {
    const row = await this.database.get<InvitationRow>(
      'SELECT id, group_id, invited_by, created_at, version FROM invitations WHERE id = ?',
      [id],
    );
    if (!row) return undefined;
    const snapshot: InvitationSnapshot = {
      id: String(row.id),
      groupId: String(row.group_id),
      invitedBy: String(row.invited_by),
      createdAt: String(row.created_at),
      version: Number(row.version),
    };
    return Invitation.fromSnapshot(snapshot);
  }

  async save(invitation: Invitation): Promise<IResult<undefined>> {
    this.database.assertInTransaction();
    const snapshot = invitation.toSnapshot();
    if (snapshot.version === 0) {
      await this.database.run(
        'INSERT INTO invitations (id, group_id, invited_by, created_at, version) VALUES (?, ?, ?, ?, ?)',
        [snapshot.id, snapshot.groupId, snapshot.invitedBy, snapshot.createdAt, snapshot.version + 1],
      );
    } else {
      const { changes } = await this.database.run('UPDATE invitations SET version = ? WHERE id = ? AND version = ?', [
        snapshot.version + 1,
        snapshot.id,
        snapshot.version,
      ]);
      if (changes === 0) {
        return Result.fail(new ConcurrencyConflictException('Groups', 'The invitation changed since it was read'));
      }
    }
    return Result.ok(undefined);
  }

  async removeOfGroup(groupId: string): Promise<void> {
    this.database.assertInTransaction();
    await this.database.run('DELETE FROM invitations WHERE group_id = ?', [groupId]);
  }
}

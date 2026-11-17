import { ConcurrencyConflictException, Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

interface InvitationRow {
  id: string;
  group_id: string;
  invited_by: string;
  created_at: string;
  version: number;
}

/** The invitations' repository over the SQLite file; used inside the command's transaction, which holds the connection. */
export class SqliteInvitationRepository implements IInvitationRepository {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async findById(id: Id): Promise<Invitation | null> {
    const row = this.database.connection.prepare('SELECT * FROM group_invitations WHERE id = ?').get(id.value) as
      InvitationRow | undefined;
    if (!row) return null;
    return Invitation.fromSnapshot({
      id: row.id,
      groupId: row.group_id,
      invitedBy: row.invited_by,
      createdAt: row.created_at,
      version: row.version,
    });
  }

  async save(invitation: Invitation): Promise<IResult> {
    const { id, groupId, invitedBy, createdAt, version } = invitation.toSnapshot();
    const { connection } = this.database;
    if (version === 0) {
      connection
        .prepare('INSERT INTO group_invitations (id, group_id, invited_by, created_at, version) VALUES (?, ?, ?, ?, 1)')
        .run(id, groupId, invitedBy, createdAt);
      return Result.ok();
    }
    const { changes } = connection
      .prepare('UPDATE group_invitations SET version = version + 1 WHERE id = ? AND version = ?')
      .run(id, version);
    if (changes === 0) {
      return Result.fail(
        new ConcurrencyConflictException('Groups', 'The invitation changed since it was read', { id }),
      );
    }
    return Result.ok();
  }
}

import { Id, IResult, Result } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';

import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { IInvitationRepository } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationRepository';
import { createGroupsTables } from '@Contexts/Groups/Infrastructure/GroupsTables';

interface Row {
  id: string;
  group_id: string;
  invited_by: string;
  created_at: string;
}

/** The invitations, in the application's file. An invitation is written once and never changed, so no version is kept. */
export class SqliteInvitationRepository implements IInvitationRepository {
  constructor(private database: SqliteDatabase) {
    createGroupsTables(database);
  }

  async findById(id: Id): Promise<Invitation | null> {
    const row = this.database.get<Row>(
      'SELECT id, group_id, invited_by, created_at FROM invitations WHERE id = ?',
      id.value,
    );
    return row
      ? Invitation.fromSnapshot({
          id: row.id,
          groupId: row.group_id,
          invitedBy: row.invited_by,
          createdAt: row.created_at,
        })
      : null;
  }

  async save(invitation: Invitation): Promise<IResult> {
    const { id, groupId, invitedBy, createdAt } = invitation.toSnapshot();
    this.database.run(
      'INSERT INTO invitations (id, group_id, invited_by, created_at) VALUES (?, ?, ?, ?)',
      id,
      groupId,
      invitedBy,
      createdAt,
    );
    return Result.ok();
  }
}

import { Invitation } from '@Contexts/Groups/Domain/Invitation/Invitation';
import { IInvitationRepository } from '@Contexts/Groups/Application/IInvitationRepository';
import { IInvitationQueries, InvitationView } from '@Contexts/Groups/Application/IInvitationQueries';

import { GroupsDatabase } from './GroupsDatabase';

type InvitationRow = { id: string; group_id: string; invited_by: string; created_at: string };

/** The invitations in PostgreSQL: the repository `CreateInvitation` inserts into and `AcceptInvitation` reads, and the read side `GetInvitation` reads. */
export class SqliteInvitations implements IInvitationRepository, IInvitationQueries {
  constructor(private readonly database: GroupsDatabase) {}

  async insert(invitation: Invitation): Promise<void> {
    const { id, groupId, invitedBy, createdAt } = invitation.toSnapshot();
    await this.database.transaction(() =>
      this.database.execute('INSERT INTO invitations (id, group_id, invited_by, created_at) VALUES ($1, $2, $3, $4)', [
        id,
        groupId,
        invitedBy,
        createdAt,
      ]),
    );
  }

  async get(id: string): Promise<Invitation | undefined> {
    const row = await this.database.row<InvitationRow>(
      'SELECT id, group_id, invited_by, created_at FROM invitations WHERE id = $1',
      [id],
    );
    return (
      row &&
      Invitation.fromSnapshot({
        id: row.id,
        groupId: row.group_id,
        invitedBy: row.invited_by,
        createdAt: row.created_at,
      })
    );
  }

  async invitationOf(id: string): Promise<InvitationView | undefined> {
    const row = await this.database.row<{ id: string; group_id: string; group_name: string; invited_by: string }>(
      `SELECT i.id, i.group_id, g.name AS group_name, i.invited_by
         FROM invitations i JOIN expense_groups g ON g.id = i.group_id
        WHERE i.id = $1`,
      [id],
    );
    return row && { id: row.id, groupId: row.group_id, groupName: row.group_name, invitedBy: row.invited_by };
  }
}

import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { prepareInvitationsSchema } from '@Contexts/Groups/Infrastructure/PostgresInvitationRepository';
import { InvitationView, IInvitationQueries } from '@Contexts/Groups/Domain/Invitation/Ports/IInvitationQueries';

type InvitationRow = { id: string; group_id: string; group_name: string; invited_by: string };

/**
 * The read side of the invitations over PostgreSQL: one read, taken alone, outside any transaction. The group's
 * name is read with it, so an invitation reads as the link's page: which group, and who invited.
 */
export class PostgresInvitationQueries implements IInvitationQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.prepare(prepareInvitationsSchema);
  }

  async findInvitation(id: string): Promise<InvitationView | undefined> {
    return this.database.exclusive(async () => {
      const row = await this.database.get<InvitationRow>(
        'SELECT i.id, i.group_id, g.name AS group_name, i.invited_by FROM invitations i JOIN groups g ON g.id = i.group_id WHERE i.id = ?',
        [id],
      );
      return row
        ? {
            id: String(row.id),
            groupId: String(row.group_id),
            groupName: String(row.group_name),
            invitedBy: String(row.invited_by),
          }
        : undefined;
    });
  }
}

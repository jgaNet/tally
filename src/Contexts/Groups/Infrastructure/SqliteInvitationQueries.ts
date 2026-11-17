import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { IInvitationQueries } from '@Contexts/Groups/Application/Ports/IInvitationQueries';
import { InvitationReadModel } from '@Contexts/Groups/Application/ReadModel/InvitationReadModel';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

/** What a signed-in person reads of an invitation, from the SQLite file: the link's group, by its name. */
export class SqliteInvitationQueries implements IInvitationQueries {
  constructor(private readonly database: SqliteDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async findById(id: string): Promise<InvitationReadModel | null> {
    const row = await this.database.exclusive(
      connection =>
        connection
          .prepare(
            `SELECT i.id, i.group_id AS groupId, g.name AS groupName, i.invited_by AS invitedBy
               FROM group_invitations i JOIN tally_groups g ON g.id = i.group_id WHERE i.id = ?`,
          )
          .get(id) as unknown,
    );
    return (row as InvitationReadModel | undefined) ?? null;
  }
}

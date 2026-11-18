import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { IInvitationQueries } from '@Contexts/Groups/Application/Ports/IInvitationQueries';
import { InvitationReadModel } from '@Contexts/Groups/Application/ReadModel/InvitationReadModel';
import { GROUP_STATEMENTS } from '@Contexts/Groups/Infrastructure/groups.schema';

/** What a signed-in person reads of an invitation, from the PostgreSQL database: the link's group, by its name. */
export class PostgresInvitationQueries implements IInvitationQueries {
  constructor(private readonly database: PostgresDatabase) {
    database.migrate(GROUP_STATEMENTS);
  }

  async findById(id: string): Promise<InvitationReadModel | null> {
    const row = await this.database.exclusive(connection =>
      connection.row<InvitationReadModel>(
        `SELECT i.id, i.group_id AS "groupId", g.name AS "groupName", i.invited_by AS "invitedBy"
           FROM group_invitations i JOIN tally_groups g ON g.id = i.group_id WHERE i.id = ?`,
        id,
      ),
    );
    return row ?? null;
  }
}

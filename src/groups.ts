import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './database';
import { addMember, listMembers } from './members';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

const NAME_MAX = 60;

/**
 * The currencies a group can be in. Each counts in hundredths (cents, pence), so every amount of a
 * group is an integer number of hundredths of its currency. A group keeps its currency for good.
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export interface Group {
  id: string;
  name: string;
  currency: Currency;
  ownerId: string;
  /** When the group was archived: present once it is, and only then. */
  archivedAt?: string;
}

export interface NewGroup {
  name: string;
  currency: string;
}

interface GroupRow {
  id: string;
  name: string;
  currency: Currency;
  owner_id: string;
  archived_at: string | null;
}

const groupColumns = 'g.id, g.name, g.currency, g.owner_id, g.archived_at';

function toGroup(row: GroupRow): Group {
  const group: Group = { id: row.id, name: row.name, currency: row.currency, ownerId: row.owner_id };
  if (row.archived_at !== null) group.archivedAt = row.archived_at;
  return group;
}

/**
 * Refuses a change to the group once it is archived: an archived group is read only, so every write that would
 * change something in it is refused with `GroupArchived`, and changes nothing. Called by each such write, after
 * its check that the account is a member, and again inside its write transaction, so an archive that lands
 * meanwhile is not written over.
 */
export async function refuseIfArchived(db: Queryable, groupId: string): Promise<void> {
  const row = await db.get<{ archived_at: string | null }>('SELECT archived_at FROM groups WHERE id = ?', [groupId]);
  if (row?.archived_at) {
    throw new Refusal(409, 'GroupArchived', 'The group is archived: it is read only.');
  }
}

/**
 * Creates a group owned by the account, which is also its first member, and returns its id. A group
 * whose name is not 1 to 60 characters once trimmed, or whose currency is not one of `CURRENCIES`, is
 * a `Refusal`.
 */
export async function createGroup(db: Database, accountId: string, input: NewGroup): Promise<string> {
  const name = input.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > NAME_MAX) {
    throw new Refusal(422, 'InvalidGroupName', `The group needs a name of 1 to ${NAME_MAX} characters.`);
  }
  if (!(CURRENCIES as readonly string[]).includes(input.currency)) {
    throw new Refusal(422, 'InvalidCurrency', `The currency must be one of ${CURRENCIES.join(', ')}.`);
  }
  const id = randomUUID();
  // The group and its owner's membership are written together, or not at all.
  await db.transaction(async tx => {
    await tx.run('INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      name,
      input.currency,
      accountId,
      new Date().toISOString(),
    ]);
    await addMember(tx, id, accountId);
  });
  return id;
}

/** The group, when the account is one of its members. For anyone else it does not exist. */
export async function findGroupOf(db: Queryable, accountId: string, groupId: string): Promise<Group | undefined> {
  const row = await db.get<GroupRow>(
    `SELECT ${groupColumns} FROM groups g JOIN group_members m ON m.group_id = g.id
     WHERE g.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    [groupId, accountId],
  );
  return row && toGroup(row);
}

/** The groups the account is a member of, the most recently created first. */
export async function listGroupsOf(db: Queryable, accountId: string): Promise<Group[]> {
  const rows = await db.all<GroupRow>(
    `SELECT ${groupColumns} FROM groups g JOIN group_members m ON m.group_id = g.id
     WHERE m.account_id = ? AND m.left_at IS NULL ORDER BY g.created_at DESC, g.seq DESC`,
    [accountId],
  );
  return rows.map(toGroup);
}

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

const memberSchema = {
  type: 'object',
  required: ['memberId', 'name', 'role', 'joinedAt'],
  properties: {
    memberId: { type: 'string' },
    name: { type: 'string' },
    role: { type: 'string', enum: ['owner', 'member'] },
    joinedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
  },
};

const groupSchema = {
  type: 'object',
  required: ['id', 'name', 'currency', 'ownerId'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    currency: { type: 'string', enum: [...CURRENCIES] },
    ownerId: { type: 'string' },
    archivedAt: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
  },
};

export function registerGroupRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Body: NewGroup }>(
    '/groups',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'currency'],
          properties: { name: { type: 'string' }, currency: { type: 'string' } },
        },
        response: { 201: idSchema },
      },
    },
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      return reply.code(201).send({ id: await createGroup(db, accountId, request.body) });
    },
  );

  app.get('/groups/mine', { schema: { response: { 200: { type: 'array', items: groupSchema } } } }, async request => {
    const accountId = await requireCaller(db, request);
    return listGroupsOf(db, accountId);
  });

  app.get<{ Params: { id: string } }>('/groups/:id', { schema: { response: { 200: groupSchema } } }, async request => {
    const accountId = await requireCaller(db, request);
    const group = await findGroupOf(db, accountId, request.params.id);
    if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
    return group;
  });

  app.get<{ Params: { id: string } }>(
    '/groups/:id/members',
    { schema: { response: { 200: { type: 'array', items: memberSchema } } } },
    async request => {
      const accountId = await requireCaller(db, request);
      if (!(await findGroupOf(db, accountId, request.params.id))) {
        throw new Refusal(404, 'NotFound', 'There is no such group.');
      }
      return listMembers(db, request.params.id);
    },
  );
}

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './database';
import { addMember, listMembers } from './members';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

const NAME_MAX = 60;

/**
 * The currencies a group can be in. Each has a minor unit, the smallest amount every amount in it is a whole number of: a
 * hundredth (cents, pence) for six of them, a whole unit for the yen and the won, a thousandth for the dinars. A group keeps
 * its currency for good.
 */
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'KRW', 'KWD', 'BHD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** The decimal places of each currency's minor unit: 2 for a hundredth, 0 for a whole unit, 3 for a thousandth. */
const MINOR_UNIT_DIGITS: Record<Currency, number> = {
  EUR: 2,
  USD: 2,
  GBP: 2,
  CHF: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
  KRW: 0,
  KWD: 3,
  BHD: 3,
};

/** Whether the text is one of Tally's currencies. */
export function isCurrency(text: string): text is Currency {
  return (CURRENCIES as readonly string[]).includes(text);
}

/** The decimal places of the minor unit of a currency of Tally: an amount in it is a whole number of 10 to the minus that. */
export function minorUnitDigits(currency: string): number {
  if (!isCurrency(currency)) throw new Error(`${currency} is not a currency of Tally.`);
  return MINOR_UNIT_DIGITS[currency];
}

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
 * change something in it is refused with `GroupArchived`, and changes nothing. A group merged into another no longer
 * exists: a change to it is refused with `NotFound`, as for any group that is not there. Called by each such write,
 * after its check that the account is a member, and again inside its write transaction, so an archive or a merge
 * that lands meanwhile is not written over.
 */
export async function refuseIfArchived(db: Queryable, groupId: string): Promise<void> {
  const row = await db.get<{ archived_at: string | null; merged_into: string | null }>(
    'SELECT archived_at, merged_into FROM groups WHERE id = ?',
    [groupId],
  );
  if (row?.merged_into) throw new Refusal(404, 'NotFound', 'There is no such group.');
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

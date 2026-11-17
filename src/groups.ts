import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { inTransaction } from './database';
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
}

const groupColumns = 'g.id, g.name, g.currency, g.owner_id';

function toGroup(row: GroupRow): Group {
  return { id: row.id, name: row.name, currency: row.currency, ownerId: row.owner_id };
}

/**
 * Creates a group owned by the account, which is also its first member, and returns its id. A group
 * whose name is not 1 to 60 characters once trimmed, or whose currency is not one of `CURRENCIES`, is
 * a `Refusal`.
 */
export function createGroup(db: DatabaseSync, accountId: string, input: NewGroup): string {
  const name = input.name.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > NAME_MAX) {
    throw new Refusal(422, 'InvalidGroupName', `The group needs a name of 1 to ${NAME_MAX} characters.`);
  }
  if (!(CURRENCIES as readonly string[]).includes(input.currency)) {
    throw new Refusal(422, 'InvalidCurrency', `The currency must be one of ${CURRENCIES.join(', ')}.`);
  }
  const id = randomUUID();
  // The group and its owner's membership are written together, or not at all.
  inTransaction(db, () => {
    db.prepare('INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      name,
      input.currency,
      accountId,
      new Date().toISOString(),
    );
    db.prepare('INSERT INTO group_members (group_id, account_id) VALUES (?, ?)').run(id, accountId);
  });
  return id;
}

/** The group, when the account is one of its members. For anyone else it does not exist. */
export function findGroupOf(db: DatabaseSync, accountId: string, groupId: string): Group | undefined {
  const row = db
    .prepare(
      `SELECT ${groupColumns} FROM groups g JOIN group_members m ON m.group_id = g.id
       WHERE g.id = ? AND m.account_id = ?`,
    )
    .get(groupId, accountId) as GroupRow | undefined;
  return row && toGroup(row);
}

/** The groups the account is a member of, the most recently created first. */
export function listGroupsOf(db: DatabaseSync, accountId: string): Group[] {
  const rows = db
    .prepare(
      `SELECT ${groupColumns} FROM groups g JOIN group_members m ON m.group_id = g.id
       WHERE m.account_id = ? ORDER BY g.created_at DESC, g.rowid DESC`,
    )
    .all(accountId) as unknown as GroupRow[];
  return rows.map(toGroup);
}

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

const groupSchema = {
  type: 'object',
  required: ['id', 'name', 'currency', 'ownerId'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    currency: { type: 'string', enum: [...CURRENCIES] },
    ownerId: { type: 'string' },
  },
};

export function registerGroupRoutes(app: FastifyInstance, db: DatabaseSync): void {
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
      const accountId = requireCaller(db, request);
      return reply.code(201).send({ id: createGroup(db, accountId, request.body) });
    },
  );

  app.get('/groups/mine', { schema: { response: { 200: { type: 'array', items: groupSchema } } } }, request => {
    const accountId = requireCaller(db, request);
    return listGroupsOf(db, accountId);
  });

  app.get<{ Params: { id: string } }>('/groups/:id', { schema: { response: { 200: groupSchema } } }, request => {
    const accountId = requireCaller(db, request);
    const group = findGroupOf(db, accountId, request.params.id);
    if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
    return group;
  });
}

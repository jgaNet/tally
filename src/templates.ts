import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { ShareCount, Split } from './expenses';
import { inTransaction } from './database';
import { findGroupOf } from './groups';
import { isMember } from './members';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

const NAME_MAX = 60;

/**
 * A split saved under a name, as it was given: `splitBetween` for an equal split, or `splitByShares` for a split by shares.
 * An expense may be split by it in place of a split of its own.
 */
export interface Template {
  id: string;
  groupId: string;
  name: string;
  splitBetween?: string[];
  splitByShares?: ShareCount[];
}

/** What a member saves: the name, and exactly one of the two splits. */
export interface NewTemplate {
  name: string;
  splitBetween?: string[];
  splitByShares?: ShareCount[];
}

/** The split of a template: an equal one, or one by shares. */
type TemplateSplit = Extract<Split, { kind: 'equal' | 'shares' }>;

interface TemplateRow {
  id: string;
  group_id: string;
  name: string;
  split_kind: 'equal' | 'shares';
  created_by: string;
}

interface TemplateShareRow {
  account_id: string;
  value: number | null;
}

/** The name, trimmed: 1 to 60 characters, counted as characters and not as code units. */
export function checkTemplateName(name: string): string {
  const trimmed = name.trim();
  const length = Array.from(trimmed).length;
  if (length < 1 || length > NAME_MAX) {
    throw new Refusal(422, 'InvalidName', `The name needs 1 to ${NAME_MAX} characters, not only spaces.`);
  }
  return trimmed;
}

/** The split a template is given with: exactly one of `splitBetween` and `splitByShares`; anything else is of the wrong shape. */
function givenSplit(input: NewTemplate): TemplateSplit {
  const given: TemplateSplit[] = [];
  if (input.splitBetween !== undefined) given.push({ kind: 'equal', members: input.splitBetween });
  if (input.splitByShares !== undefined) given.push({ kind: 'shares', shares: input.splitByShares });
  if (given.length !== 1) {
    throw new Refusal(400, 'InvalidRequest', 'The template needs exactly one split: splitBetween or splitByShares.');
  }
  return given[0];
}

/**
 * Checks a split given to a template: it names at least one member, each once, and only members of the group, and each
 * member of a split by shares has at least 1 share. The amounts of an expense are not known here, so they are not checked.
 */
function checkTemplateSplit(db: DatabaseSync, groupId: string, split: TemplateSplit): void {
  const invalid = (message: string) => new Refusal(422, 'InvalidSplit', message);
  const members = split.kind === 'equal' ? split.members : split.shares.map(share => share.memberId);
  if (members.length === 0) throw invalid('The split needs at least one member.');
  if (new Set(members).size !== members.length) throw invalid('Each member can be in the split only once.');
  if (!members.every(memberId => isMember(db, groupId, memberId))) {
    throw invalid('Every member in the split must be a member of the group.');
  }
  if (split.kind === 'shares' && split.shares.some(share => share.shares < 1)) {
    throw invalid('Each member of the split has at least 1 share.');
  }
}

/**
 * Refuses a name that another template of the group already has, whatever its case. `except` is the template being
 * replaced, which may keep its own name.
 */
function checkNameFree(db: DatabaseSync, groupId: string, name: string, except?: string): void {
  const taken = db
    .prepare('SELECT id FROM templates WHERE group_id = ? AND name_key = ? AND id <> ?')
    .get(groupId, name.toLowerCase(), except ?? '');
  if (taken !== undefined) {
    throw new Refusal(409, 'TemplateNameTaken', 'The group already has a template with this name.');
  }
}

function writeTemplateShares(db: DatabaseSync, id: string, split: TemplateSplit): void {
  const insert = db.prepare(
    'INSERT INTO template_shares (template_id, position, account_id, value) VALUES (?, ?, ?, ?)',
  );
  if (split.kind === 'equal') split.members.forEach((member, position) => insert.run(id, position, member, null));
  else split.shares.forEach((share, position) => insert.run(id, position, share.memberId, share.shares));
}

function templateOf(db: DatabaseSync, row: TemplateRow): Template {
  const shares = db
    .prepare('SELECT account_id, value FROM template_shares WHERE template_id = ? ORDER BY position')
    .all(row.id) as unknown as TemplateShareRow[];
  const template: Template = { id: row.id, groupId: row.group_id, name: row.name };
  if (row.split_kind === 'equal') template.splitBetween = shares.map(share => share.account_id);
  else {
    template.splitByShares = shares.map(share => ({ memberId: share.account_id, shares: share.value ?? 0 }));
  }
  return template;
}

const COLUMNS = 't.id, t.group_id, t.name, t.split_kind, t.created_by';

/** The template, when the account is a member of its group. For anyone else it does not exist. */
function findTemplateOf(db: DatabaseSync, accountId: string, id: string): TemplateRow | undefined {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM templates t JOIN group_members m ON m.group_id = t.group_id
       WHERE t.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get(id, accountId) as TemplateRow | undefined;
}

/** Only the member who saved a template and the owner of its group may replace or remove it. */
function checkMayChange(db: DatabaseSync, accountId: string, row: TemplateRow): void {
  if (accountId === row.created_by) return;
  if (findGroupOf(db, accountId, row.group_id)?.ownerId === accountId) return;
  throw new Refusal(
    403,
    'NotAllowed',
    'Only the member who saved the template or the owner of the group may change it.',
  );
}

/** Saves a template of the group under a name, and returns its id. For an account that is not a member, the group does not exist. */
export function createTemplate(db: DatabaseSync, accountId: string, groupId: string, input: NewTemplate): string {
  if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const name = checkTemplateName(input.name);
  const split = givenSplit(input);
  const id = randomUUID();
  inTransaction(db, () => {
    checkTemplateSplit(db, groupId, split);
    checkNameFree(db, groupId, name);
    db.prepare(
      'INSERT INTO templates (id, group_id, name, name_key, split_kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, groupId, name, name.toLowerCase(), split.kind, accountId, new Date().toISOString());
    writeTemplateShares(db, id, split);
  });
  return id;
}

/** The group's templates, the earliest saved first. For an account that is not a member, the group does not exist. */
export function listTemplatesOf(db: DatabaseSync, accountId: string, groupId: string): Template[] {
  if (!findGroupOf(db, accountId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM templates t WHERE t.group_id = ? ORDER BY t.seq`)
    .all(groupId) as unknown as TemplateRow[];
  return rows.map(row => templateOf(db, row));
}

/**
 * Replaces the template whole, with the name and split given, keeping its place in the order of the group's templates.
 * Only the member who saved it and the owner of the group may. The template is changed only, no expense is.
 */
export function replaceTemplate(db: DatabaseSync, accountId: string, id: string, input: NewTemplate): void {
  inTransaction(db, () => {
    const row = findTemplateOf(db, accountId, id);
    if (!row) throw new Refusal(404, 'NotFound', 'There is no such template.');
    checkMayChange(db, accountId, row);
    const name = checkTemplateName(input.name);
    const split = givenSplit(input);
    checkTemplateSplit(db, row.group_id, split);
    checkNameFree(db, row.group_id, name, id);
    db.prepare('UPDATE templates SET name = ?, name_key = ?, split_kind = ? WHERE id = ?').run(
      name,
      name.toLowerCase(),
      split.kind,
      id,
    );
    db.prepare('DELETE FROM template_shares WHERE template_id = ?').run(id);
    writeTemplateShares(db, id, split);
  });
}

/** Removes the template. Only the member who saved it and the owner of the group may. The expenses split by it keep their shares. */
export function removeTemplate(db: DatabaseSync, accountId: string, id: string): void {
  inTransaction(db, () => {
    const row = findTemplateOf(db, accountId, id);
    if (!row) throw new Refusal(404, 'NotFound', 'There is no such template.');
    checkMayChange(db, accountId, row);
    db.prepare('DELETE FROM template_shares WHERE template_id = ?').run(id);
    db.prepare('DELETE FROM templates WHERE id = ?').run(id);
  });
}

/**
 * The split of a template of the group, as an expense of the group is split by it. A template of another group does not
 * exist for it. Whether its members are members of the group now is checked where the expense is written.
 */
export function templateSplitOf(db: DatabaseSync, groupId: string, id: string): Split {
  const row = db.prepare(`SELECT ${COLUMNS} FROM templates t WHERE t.id = ? AND t.group_id = ?`).get(id, groupId) as
    TemplateRow | undefined;
  if (!row) throw new Refusal(404, 'NotFound', 'There is no such template in the group.');
  const template = templateOf(db, row);
  if (template.splitBetween !== undefined) return { kind: 'equal', members: template.splitBetween };
  return { kind: 'shares', shares: template.splitByShares ?? [] };
}

const idSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const templateSchema = {
  type: 'object',
  required: ['id', 'groupId', 'name'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    name: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
    splitByShares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'shares'],
        properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
      },
    },
  },
};

/** The body of a template: its name, and exactly one of the two splits. The shares are checked for their value, not their shape. */
const templateBody = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    splitBetween: { type: 'array', items: { type: 'string' } },
    splitByShares: {
      type: 'array',
      items: {
        type: 'object',
        required: ['memberId', 'shares'],
        properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
      },
    },
  },
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitByShares'] }],
};

export function registerTemplateRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.post<{ Params: { id: string }; Body: NewTemplate }>(
    '/groups/:id/templates',
    { schema: { body: templateBody, response: { 201: idSchema } } },
    (request, reply) => {
      const accountId = requireCaller(db, request);
      return reply.code(201).send({ id: createTemplate(db, accountId, request.params.id, request.body) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id/templates',
    { schema: { response: { 200: { type: 'array', items: templateSchema } } } },
    request => listTemplatesOf(db, requireCaller(db, request), request.params.id),
  );

  app.put<{ Params: { id: string }; Body: NewTemplate }>(
    '/templates/:id',
    { schema: { body: templateBody } },
    (request, reply) => {
      replaceTemplate(db, requireCaller(db, request), request.params.id, request.body);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>('/templates/:id', (request, reply) => {
    removeTemplate(db, requireCaller(db, request), request.params.id);
    return reply.code(204).send();
  });
}

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ShareCount, Split } from './expenses';
import type { Database, Queryable } from './database';
import { findGroupOf, refuseIfArchived } from './groups';
import { isMember } from './members';
import { isDeleted } from './accounts';
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
 * member of a split by shares has at least 1 share. It names no deleted account, unless the template already did (`kept`).
 * The amounts of an expense are not known here, so they are not checked.
 */
async function checkTemplateSplit(
  db: Queryable,
  groupId: string,
  split: TemplateSplit,
  kept: readonly string[] = [],
): Promise<void> {
  const invalid = (message: string) => new Refusal(422, 'InvalidSplit', message);
  const members = split.kind === 'equal' ? split.members : split.shares.map(share => share.memberId);
  if (members.length === 0) throw invalid('The split needs at least one member.');
  if (new Set(members).size !== members.length) throw invalid('Each member can be in the split only once.');
  for (const memberId of members) {
    if (!(await isMember(db, groupId, memberId))) {
      throw invalid('Every member in the split must be a member of the group.');
    }
    if (!kept.includes(memberId) && (await isDeleted(db, memberId))) {
      throw invalid('A deleted account cannot be in the split of a template.');
    }
  }
  if (split.kind === 'shares' && split.shares.some(share => share.shares < 1)) {
    throw invalid('Each member of the split has at least 1 share.');
  }
}

/**
 * Refuses a name that another template of the group already has, whatever its case. `except` is the template being
 * replaced, which may keep its own name.
 */
async function checkNameFree(db: Queryable, groupId: string, name: string, except?: string): Promise<void> {
  const taken = await db.get('SELECT id FROM templates WHERE group_id = ? AND name_key = ? AND id <> ?', [
    groupId,
    name.toLowerCase(),
    except ?? '',
  ]);
  if (taken !== undefined) {
    throw new Refusal(409, 'TemplateNameTaken', 'The group already has a template with this name.');
  }
}

async function writeTemplateShares(db: Queryable, id: string, split: TemplateSplit): Promise<void> {
  if (split.kind === 'equal') {
    for (const [position, member] of split.members.entries()) {
      await db.run('INSERT INTO template_shares (template_id, position, account_id, value) VALUES (?, ?, ?, ?)', [
        id,
        position,
        member,
        null,
      ]);
    }
  } else {
    for (const [position, share] of split.shares.entries()) {
      await db.run('INSERT INTO template_shares (template_id, position, account_id, value) VALUES (?, ?, ?, ?)', [
        id,
        position,
        share.memberId,
        share.shares,
      ]);
    }
  }
}

async function templateOf(db: Queryable, row: TemplateRow): Promise<Template> {
  const shares = await db.all<TemplateShareRow>(
    'SELECT account_id, value FROM template_shares WHERE template_id = ? ORDER BY position',
    [row.id],
  );
  const template: Template = { id: row.id, groupId: row.group_id, name: row.name };
  if (row.split_kind === 'equal') template.splitBetween = shares.map(share => share.account_id);
  else {
    template.splitByShares = shares.map(share => ({ memberId: share.account_id, shares: share.value ?? 0 }));
  }
  return template;
}

const COLUMNS = 't.id, t.group_id, t.name, t.split_kind, t.created_by';

/** The template, when the account is a member of its group. For anyone else it does not exist. */
async function findTemplateOf(db: Queryable, accountId: string, id: string): Promise<TemplateRow | undefined> {
  return db.get<TemplateRow>(
    `SELECT ${COLUMNS} FROM templates t JOIN group_members m ON m.group_id = t.group_id
     WHERE t.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    [id, accountId],
  );
}

/** Only the member who saved a template and the owner of its group may replace or remove it. */
async function checkMayChange(db: Queryable, accountId: string, row: TemplateRow): Promise<void> {
  if (accountId === row.created_by) return;
  if ((await findGroupOf(db, accountId, row.group_id))?.ownerId === accountId) return;
  throw new Refusal(
    403,
    'NotAllowed',
    'Only the member who saved the template or the owner of the group may change it.',
  );
}

/** Saves a template of the group under a name, and returns its id. For an account that is not a member, the group does not exist. */
export async function createTemplate(
  db: Database,
  accountId: string,
  groupId: string,
  input: NewTemplate,
): Promise<string> {
  if (!(await findGroupOf(db, accountId, groupId))) throw new Refusal(404, 'NotFound', 'There is no such group.');
  await refuseIfArchived(db, groupId);
  const name = checkTemplateName(input.name);
  const split = givenSplit(input);
  const id = randomUUID();
  await db.transaction(async tx => {
    await refuseIfArchived(tx, groupId);
    await checkTemplateSplit(tx, groupId, split);
    await checkNameFree(tx, groupId, name);
    await tx.run(
      'INSERT INTO templates (id, group_id, name, name_key, split_kind, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, groupId, name, name.toLowerCase(), split.kind, accountId, new Date().toISOString()],
    );
    await writeTemplateShares(tx, id, split);
  });
  return id;
}

/** The group's templates, the earliest saved first. For an account that is not a member, the group does not exist. */
export async function listTemplatesOf(db: Queryable, accountId: string, groupId: string): Promise<Template[]> {
  if (!(await findGroupOf(db, accountId, groupId))) throw new Refusal(404, 'NotFound', 'There is no such group.');
  const rows = await db.all<TemplateRow>(`SELECT ${COLUMNS} FROM templates t WHERE t.group_id = ? ORDER BY t.seq`, [
    groupId,
  ]);
  const templates: Template[] = [];
  for (const row of rows) templates.push(await templateOf(db, row));
  return templates;
}

/**
 * Replaces the template whole, with the name and split given, keeping its place in the order of the group's templates.
 * Only the member who saved it and the owner of the group may. The template is changed only, no expense is.
 */
export async function replaceTemplate(db: Database, accountId: string, id: string, input: NewTemplate): Promise<void> {
  await db.transaction(async tx => {
    const row = await findTemplateOf(tx, accountId, id);
    if (!row) throw new Refusal(404, 'NotFound', 'There is no such template.');
    await refuseIfArchived(tx, row.group_id);
    await checkMayChange(tx, accountId, row);
    const name = checkTemplateName(input.name);
    const split = givenSplit(input);
    const kept = (
      await tx.all<{ account_id: string }>('SELECT account_id FROM template_shares WHERE template_id = ?', [id])
    ).map(share => share.account_id);
    await checkTemplateSplit(tx, row.group_id, split, kept);
    await checkNameFree(tx, row.group_id, name, id);
    await tx.run('UPDATE templates SET name = ?, name_key = ?, split_kind = ? WHERE id = ?', [
      name,
      name.toLowerCase(),
      split.kind,
      id,
    ]);
    await tx.run('DELETE FROM template_shares WHERE template_id = ?', [id]);
    await writeTemplateShares(tx, id, split);
  });
}

/** Removes the template. Only the member who saved it and the owner of the group may. The expenses split by it keep their shares. */
export async function removeTemplate(db: Database, accountId: string, id: string): Promise<void> {
  await db.transaction(async tx => {
    const row = await findTemplateOf(tx, accountId, id);
    if (!row) throw new Refusal(404, 'NotFound', 'There is no such template.');
    await refuseIfArchived(tx, row.group_id);
    await checkMayChange(tx, accountId, row);
    await tx.run('DELETE FROM template_shares WHERE template_id = ?', [id]);
    await tx.run('DELETE FROM templates WHERE id = ?', [id]);
  });
}

/**
 * The split of a template of the group, as an expense of the group is split by it. A template of another group does not
 * exist for it. Whether its members are members of the group now is checked where the expense is written.
 */
export async function templateSplitOf(db: Queryable, groupId: string, id: string): Promise<Split> {
  const row = await db.get<TemplateRow>(`SELECT ${COLUMNS} FROM templates t WHERE t.id = ? AND t.group_id = ?`, [
    id,
    groupId,
  ]);
  if (!row) throw new Refusal(404, 'NotFound', 'There is no such template in the group.');
  const template = await templateOf(db, row);
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

export function registerTemplateRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Params: { id: string }; Body: NewTemplate }>(
    '/groups/:id/templates',
    { schema: { body: templateBody, response: { 201: idSchema } } },
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      return reply.code(201).send({ id: await createTemplate(db, accountId, request.params.id, request.body) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/groups/:id/templates',
    { schema: { response: { 200: { type: 'array', items: templateSchema } } } },
    async request => listTemplatesOf(db, await requireCaller(db, request), request.params.id),
  );

  app.put<{ Params: { id: string }; Body: NewTemplate }>(
    '/templates/:id',
    { schema: { body: templateBody } },
    async (request, reply) => {
      await replaceTemplate(db, await requireCaller(db, request), request.params.id, request.body);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>('/templates/:id', async (request, reply) => {
    await removeTemplate(db, await requireCaller(db, request), request.params.id);
    return reply.code(204).send();
  });
}

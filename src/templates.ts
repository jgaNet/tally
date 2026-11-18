import { randomUUID } from 'node:crypto';
import type { SplitInput } from './expenses';
import type { Database, Querier } from './database';
import { assertNotArchived, findGroupOfMember, membersOfGroup } from './groups';
import { Refusal } from './refusal';
import { characters } from './text';
import { inReadSnapshot, inTransaction } from './transactions';

/** A template's name has 1 to this many characters. */
const MAX_NAME_LENGTH = 60;

/**
 * The split a template saves: equally between its members, or by shares. An exact split is not saved: its amounts depend
 * on the amount of each expense that is split by it.
 */
export type TemplateSplit = Exclude<SplitInput, { readonly kind: 'exact' }>;

/** A template as a member of its group reads it: its id, group, name, and the split as it was given. */
export interface Template {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly split: TemplateSplit;
}

interface TemplateRow {
  id: string;
  group_id: string;
  saved_by: string;
  name: string;
  split_kind: TemplateSplit['kind'];
}

interface PartRow {
  member_id: string;
  shares: number | null;
}

function splitOf(kind: TemplateSplit['kind'], parts: readonly PartRow[]): TemplateSplit {
  if (kind === 'equal') return { kind, memberIds: parts.map(part => part.member_id) };
  return { kind, parts: parts.map(part => ({ memberId: part.member_id, shares: part.shares as number })) };
}

function templateOf(row: TemplateRow, parts: readonly PartRow[]): Template {
  return { id: row.id, groupId: row.group_id, name: row.name, split: splitOf(row.split_kind, parts) };
}

async function partsOf(db: Querier, templateId: string): Promise<PartRow[]> {
  return db
    .prepare('SELECT member_id, shares FROM template_parts WHERE template_id = ? ORDER BY position ASC')
    .all<PartRow>(templateId);
}

const COLUMNS = 'id, group_id, saved_by, name, split_kind';

/**
 * The key a name is unique by: the name trimmed of surrounding spaces, in NFC, in lower case, so that two names that differ
 * only in case are one name.
 */
function nameKeyOf(trimmedName: string): string {
  return trimmedName.normalize('NFC').toLowerCase();
}

/**
 * Checks a template's name and split as a member of `groupId` gives them: the name has 1 to 60 characters and is not only
 * spaces; the members of the split are members of the group, each listed once; each has at least 1 share. Answers the
 * name trimmed. Refused with `422`, the error naming the rule.
 */
async function checkTemplate(db: Querier, groupId: string, name: string, split: TemplateSplit): Promise<string> {
  const trimmedName = name.trim();
  if (characters(name) > MAX_NAME_LENGTH || trimmedName.length === 0) {
    throw new Refusal(
      422,
      'NameIsInvalid',
      `The name must have 1 to ${MAX_NAME_LENGTH} characters and not be only spaces.`,
    );
  }
  const members = split.kind === 'equal' ? split.memberIds : split.parts.map(part => part.memberId);
  if (members.length === 0) {
    throw new Refusal(422, 'SplitIsEmpty', 'The template must be split between at least one member.');
  }
  if (new Set(members).size !== members.length) {
    throw new Refusal(422, 'SplitRepeatsAMember', 'Each member may be listed once in the split.');
  }
  const groupMembers = new Set((await membersOfGroup(db, groupId)).map(member => member.memberId));
  if (members.some(memberId => !groupMembers.has(memberId))) {
    throw new Refusal(422, 'MemberNotInGroup', 'Every member of the split must be a member of the group.');
  }
  if (split.kind === 'shares' && !split.parts.every(part => Number.isSafeInteger(part.shares) && part.shares >= 1)) {
    throw new Refusal(422, 'SharesAreInvalid', 'Each member must have a whole number of shares, at least 1.');
  }
  return trimmedName;
}

/** Refuses a name another template of the group, other than `exceptId`, already has: `409`. */
async function refuseNameTaken(db: Querier, groupId: string, nameKey: string, exceptId?: string): Promise<void> {
  const taken = await db
    .prepare('SELECT id FROM templates WHERE group_id = ? AND name_key = ?')
    .get<{ id: string }>(groupId, nameKey);
  if (taken && taken.id !== exceptId) {
    throw new Refusal(409, 'TemplateNameIsTaken', 'The group already has a template with this name.');
  }
}

/** Writes the parts of a template's split, in the order of the split: the shares of a split by shares, none for an equal one. */
async function writeParts(db: Querier, templateId: string, split: TemplateSplit): Promise<void> {
  const insert = db.prepare(
    'INSERT INTO template_parts (template_id, position, member_id, shares) VALUES (?, ?, ?, ?)',
  );
  if (split.kind === 'equal') {
    for (const [position, memberId] of split.memberIds.entries())
      await insert.run(templateId, position, memberId, null);
  } else {
    for (const [position, part] of split.parts.entries())
      await insert.run(templateId, position, part.memberId, part.shares);
  }
}

/**
 * Saves a template of the group under a name, by a member of it, and answers its id. Refused with `404` when the caller is
 * not a member of the group, with `409` when the group already has a template of that name (whatever its case), and with
 * `422` when the name or the split breaks a rule (see {@link checkTemplate}).
 */
export async function saveTemplate(
  db: Database,
  input: { groupId: string; callerId: string; name: string; split: TemplateSplit },
): Promise<string> {
  const { groupId, callerId, split } = input;
  const id = randomUUID();
  await inTransaction(db, async tx => {
    const group = await findGroupOfMember(tx, callerId, groupId);
    if (!group) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    assertNotArchived(group);
    const name = await checkTemplate(tx, groupId, input.name, split);
    const nameKey = nameKeyOf(name);
    await refuseNameTaken(tx, groupId, nameKey);
    await tx
      .prepare(
        'INSERT INTO templates (id, group_id, saved_by, name, name_key, split_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, groupId, callerId, name, nameKey, split.kind, new Date().toISOString());
    await writeParts(tx, id, split);
  });
  return id;
}

/**
 * The group's templates, the earliest saved first, each with the split it was given. Refused with `404` when `accountId`
 * is not a member of the group, as if it did not exist. It reads one consistent state of the database and changes nothing.
 */
export async function templatesOfGroup(db: Database, accountId: string, groupId: string): Promise<Template[]> {
  return inReadSnapshot(db, async snapshot => {
    if (!(await findGroupOfMember(snapshot, accountId, groupId))) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    const rows = await snapshot
      .prepare(`SELECT ${COLUMNS} FROM templates WHERE group_id = ? ORDER BY created_at ASC, seq ASC`)
      .all<TemplateRow>(groupId);
    const templates: Template[] = [];
    for (const row of rows) templates.push(templateOf(row, await partsOf(snapshot, row.id)));
    return templates;
  });
}

/**
 * The split of the template with this id, when it is one of the templates of `groupId`; `undefined` otherwise. Used when an
 * expense of the group is split by it: the caller has checked that the expense is the group's.
 */
export async function splitOfTemplate(
  db: Querier,
  groupId: string,
  templateId: string,
): Promise<TemplateSplit | undefined> {
  const row = await db
    .prepare(`SELECT ${COLUMNS} FROM templates WHERE id = ? AND group_id = ?`)
    .get<TemplateRow>(templateId, groupId);
  return row && splitOf(row.split_kind, await partsOf(db, row.id));
}

/**
 * The template a member may change: they must be a member of its group, else `404` as if it did not exist; and the member
 * who saved it or the group's owner, else `403`.
 */
async function templateChangeableBy(db: Querier, editorId: string, templateId: string): Promise<TemplateRow> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM templates WHERE id = ?`).get<TemplateRow>(templateId);
  const group = row && (await findGroupOfMember(db, editorId, row.group_id));
  if (!row || !group) throw new Refusal(404, 'TemplateNotFound', 'No template has this id.');
  assertNotArchived(group);
  if (editorId !== row.saved_by && editorId !== group.ownerId) {
    throw new Refusal(
      403,
      'NotSaverOrOwner',
      'Only the member who saved the template or the owner of its group may change it.',
    );
  }
  return row;
}

/**
 * Replaces the template whole, under the rules of saving one, keeping its id and its place in the order it was saved. Only
 * the member who saved it or the group's owner may (see {@link templateChangeableBy}). Expenses already split by it are not
 * changed.
 */
export async function replaceTemplate(
  db: Database,
  input: { templateId: string; editorId: string; name: string; split: TemplateSplit },
): Promise<void> {
  const { templateId, editorId, split } = input;
  await inTransaction(db, async tx => {
    const row = await templateChangeableBy(tx, editorId, templateId);
    const name = await checkTemplate(tx, row.group_id, input.name, split);
    const nameKey = nameKeyOf(name);
    await refuseNameTaken(tx, row.group_id, nameKey, templateId);
    await tx
      .prepare('UPDATE templates SET name = ?, name_key = ?, split_kind = ? WHERE id = ?')
      .run(name, nameKey, split.kind, templateId);
    await tx.prepare('DELETE FROM template_parts WHERE template_id = ?').run(templateId);
    await writeParts(tx, templateId, split);
  });
}

/**
 * Removes the template, under the same rules as replacing it (see {@link replaceTemplate}). Expenses already split by it are
 * not changed.
 */
export async function removeTemplate(db: Database, input: { templateId: string; editorId: string }): Promise<void> {
  await inTransaction(db, async tx => {
    await templateChangeableBy(tx, input.editorId, input.templateId);
    await tx.prepare('DELETE FROM template_parts WHERE template_id = ?').run(input.templateId);
    await tx.prepare('DELETE FROM templates WHERE id = ?').run(input.templateId);
  });
}

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SplitInput } from './expenses';
import { findGroupOfMember, membersOfGroup } from './groups';
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

function partsOf(db: DatabaseSync, templateId: string): PartRow[] {
  return db
    .prepare('SELECT member_id, shares FROM template_parts WHERE template_id = ? ORDER BY position ASC')
    .all(templateId) as unknown as PartRow[];
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
function checkTemplate(db: DatabaseSync, groupId: string, name: string, split: TemplateSplit): string {
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
  const groupMembers = new Set(membersOfGroup(db, groupId).map(member => member.memberId));
  if (members.some(memberId => !groupMembers.has(memberId))) {
    throw new Refusal(422, 'MemberNotInGroup', 'Every member of the split must be a member of the group.');
  }
  if (split.kind === 'shares' && !split.parts.every(part => Number.isSafeInteger(part.shares) && part.shares >= 1)) {
    throw new Refusal(422, 'SharesAreInvalid', 'Each member must have a whole number of shares, at least 1.');
  }
  return trimmedName;
}

/** Refuses a name another template of the group, other than `exceptId`, already has: `409`. */
function refuseNameTaken(db: DatabaseSync, groupId: string, nameKey: string, exceptId?: string): void {
  const taken = db.prepare('SELECT id FROM templates WHERE group_id = ? AND name_key = ?').get(groupId, nameKey) as
    { id: string } | undefined;
  if (taken && taken.id !== exceptId) {
    throw new Refusal(409, 'TemplateNameIsTaken', 'The group already has a template with this name.');
  }
}

/** Writes the parts of a template's split, in the order of the split: the shares of a split by shares, none for an equal one. */
function writeParts(db: DatabaseSync, templateId: string, split: TemplateSplit): void {
  const insert = db.prepare(
    'INSERT INTO template_parts (template_id, position, member_id, shares) VALUES (?, ?, ?, ?)',
  );
  if (split.kind === 'equal') {
    split.memberIds.forEach((memberId, position) => insert.run(templateId, position, memberId, null));
  } else {
    split.parts.forEach((part, position) => insert.run(templateId, position, part.memberId, part.shares));
  }
}

/**
 * Saves a template of the group under a name, by a member of it, and answers its id. Refused with `404` when the caller is
 * not a member of the group, with `409` when the group already has a template of that name (whatever its case), and with
 * `422` when the name or the split breaks a rule (see {@link checkTemplate}).
 */
export function saveTemplate(
  db: DatabaseSync,
  input: { groupId: string; callerId: string; name: string; split: TemplateSplit },
): string {
  const { groupId, callerId, split } = input;
  const id = randomUUID();
  inTransaction(db, () => {
    if (!findGroupOfMember(db, callerId, groupId)) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    const name = checkTemplate(db, groupId, input.name, split);
    const nameKey = nameKeyOf(name);
    refuseNameTaken(db, groupId, nameKey);
    db.prepare(
      'INSERT INTO templates (id, group_id, saved_by, name, name_key, split_kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, groupId, callerId, name, nameKey, split.kind, new Date().toISOString());
    writeParts(db, id, split);
  });
  return id;
}

/**
 * The group's templates, the earliest saved first, each with the split it was given. Refused with `404` when `accountId`
 * is not a member of the group, as if it did not exist. It reads one consistent state of the file and changes nothing.
 */
export function templatesOfGroup(db: DatabaseSync, accountId: string, groupId: string): Template[] {
  return inReadSnapshot(db, () => {
    if (!findGroupOfMember(db, accountId, groupId)) throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    const rows = db
      .prepare(`SELECT ${COLUMNS} FROM templates WHERE group_id = ? ORDER BY created_at ASC, rowid ASC`)
      .all(groupId) as unknown as TemplateRow[];
    return rows.map(row => templateOf(row, partsOf(db, row.id)));
  });
}

/**
 * The split of the template with this id, when it is one of the templates of `groupId`; `undefined` otherwise. Used when an
 * expense of the group is split by it: the caller has checked that the expense is the group's.
 */
export function splitOfTemplate(db: DatabaseSync, groupId: string, templateId: string): TemplateSplit | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM templates WHERE id = ? AND group_id = ?`).get(templateId, groupId) as
    TemplateRow | undefined;
  return row && splitOf(row.split_kind, partsOf(db, row.id));
}

/**
 * The template a member may change: they must be a member of its group, else `404` as if it did not exist; and the member
 * who saved it or the group's owner, else `403`.
 */
function templateChangeableBy(db: DatabaseSync, editorId: string, templateId: string): TemplateRow {
  const row = db.prepare(`SELECT ${COLUMNS} FROM templates WHERE id = ?`).get(templateId) as TemplateRow | undefined;
  const group = row && findGroupOfMember(db, editorId, row.group_id);
  if (!row || !group) throw new Refusal(404, 'TemplateNotFound', 'No template has this id.');
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
export function replaceTemplate(
  db: DatabaseSync,
  input: { templateId: string; editorId: string; name: string; split: TemplateSplit },
): void {
  const { templateId, editorId, split } = input;
  inTransaction(db, () => {
    const row = templateChangeableBy(db, editorId, templateId);
    const name = checkTemplate(db, row.group_id, input.name, split);
    const nameKey = nameKeyOf(name);
    refuseNameTaken(db, row.group_id, nameKey, templateId);
    db.prepare('UPDATE templates SET name = ?, name_key = ?, split_kind = ? WHERE id = ?').run(
      name,
      nameKey,
      split.kind,
      templateId,
    );
    db.prepare('DELETE FROM template_parts WHERE template_id = ?').run(templateId);
    writeParts(db, templateId, split);
  });
}

/**
 * Removes the template, under the same rules as replacing it (see {@link replaceTemplate}). Expenses already split by it are
 * not changed.
 */
export function removeTemplate(db: DatabaseSync, input: { templateId: string; editorId: string }): void {
  inTransaction(db, () => {
    templateChangeableBy(db, input.editorId, input.templateId);
    db.prepare('DELETE FROM template_parts WHERE template_id = ?').run(input.templateId);
    db.prepare('DELETE FROM templates WHERE id = ?').run(input.templateId);
  });
}

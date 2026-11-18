import { randomUUID } from 'node:crypto';
import type { SplitInput } from '../expenses/validation';
import { type Database, inTransaction } from '../database';
import { type Group, requireMembership, requireNotArchived } from '../groups/groups';
import { Refusal } from '../refusal';
import { charLength } from '../text';

/** A split a template keeps: equally between members, or by shares. A split by exact amounts depends on an expense, so it is none. */
export type TemplateSplit = Extract<SplitInput, { kind: 'equal' } | { kind: 'shares' }>;

export interface SplitTemplate {
  id: string;
  groupId: string;
  /** Trimmed, as given. */
  name: string;
  /** As it was given: the split an expense takes when it is split by this template. */
  split: TemplateSplit;
}

export interface TemplateInput {
  name: string;
  split: TemplateSplit;
}

interface ValidTemplate {
  name: string;
  nameKey: string;
  split: TemplateSplit;
}

/**
 * Checks a template of a group whose members are `groupMembers`. Its name has 1 to 60 characters, not only spaces.
 * Its split names members of the group, each once, and at least one; each by shares has at least 1 share. Refusals
 * are `422`: the body had the right shape, a value is not allowed.
 */
function validateTemplate(input: TemplateInput, groupMembers: ReadonlySet<string>): ValidTemplate {
  const name = input.name.trim();
  if (charLength(name) < 1 || charLength(name) > 60) {
    throw new Refusal(422, 'InvalidName', 'The name must have between 1 and 60 characters, not only spaces.');
  }

  const memberIds =
    input.split.kind === 'equal' ? input.split.splitBetween : input.split.splitByShares.map(share => share.memberId);
  if (memberIds.length === 0 || new Set(memberIds).size !== memberIds.length) {
    throw new Refusal(422, 'InvalidSplit', 'The split must be between at least one member, each listed once.');
  }
  if (!memberIds.every(memberId => groupMembers.has(memberId))) {
    throw new Refusal(422, 'NotAMember', 'Every member of the split must be a member of the group.');
  }

  if (input.split.kind === 'equal') {
    return { name, nameKey: name.toLowerCase(), split: { kind: 'equal', splitBetween: [...input.split.splitBetween] } };
  }
  for (const share of input.split.splitByShares) {
    if (!Number.isInteger(share.shares) || share.shares < 1) {
      throw new Refusal(422, 'InvalidShares', 'Each member must have at least 1 share, a whole number.');
    }
  }
  return {
    name,
    nameKey: name.toLowerCase(),
    split: {
      kind: 'shares',
      splitByShares: input.split.splitByShares.map(({ memberId, shares }) => ({ memberId, shares })),
    },
  };
}

/** The account ids of the members of `groupId`. */
function membersOfGroup(db: Database, groupId: string): Set<string> {
  const rows = db.prepare('SELECT account_id FROM memberships WHERE group_id = ?').all(groupId) as unknown as {
    account_id: string;
  }[];
  return new Set(rows.map(row => row.account_id));
}

/** Refuses a name that another template of the group already has, in any case. `exceptId` is the template being replaced, if any. */
function requireNameFree(db: Database, groupId: string, nameKey: string, exceptId: string): void {
  const taken = db
    .prepare('SELECT 1 FROM split_templates WHERE group_id = ? AND name_key = ? AND id <> ?')
    .get(groupId, nameKey, exceptId);
  if (taken) {
    throw new Refusal(409, 'NameTaken', 'The group already has a template with that name, whatever its case.');
  }
}

/**
 * Saves a template of `groupId`, by `accountId`, who must be a member. The template is written whole, or not at all.
 * Returns its id.
 */
export function createTemplate(db: Database, groupId: string, accountId: string, input: TemplateInput): string {
  return inTransaction(db, () => {
    requireMembership(db, groupId, accountId);
    requireNotArchived(db, groupId);
    const checked = validateTemplate(input, membersOfGroup(db, groupId));
    requireNameFree(db, groupId, checked.nameKey, '');
    const id = randomUUID();
    db.prepare(
      `INSERT INTO split_templates (id, group_id, created_by, name, name_key, split, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      groupId,
      accountId,
      checked.name,
      checked.nameKey,
      JSON.stringify(checked.split),
      new Date().toISOString(),
    );
    return id;
  });
}

interface TemplateRow {
  id: string;
  group_id: string;
  name: string;
  split: string;
}

const toTemplate = (row: TemplateRow): SplitTemplate => ({
  id: row.id,
  groupId: row.group_id,
  name: row.name,
  split: JSON.parse(row.split) as TemplateSplit,
});

/** The templates of `groupId`, the earliest saved first. Reading changes nothing. */
export function templatesOfGroup(db: Database, groupId: string): SplitTemplate[] {
  const rows = db
    .prepare('SELECT id, group_id, name, split FROM split_templates WHERE group_id = ? ORDER BY created_at, rowid')
    .all(groupId) as unknown as TemplateRow[];
  return rows.map(toTemplate);
}

/**
 * The template, for a member of its group, with who saved it. For anyone else it is refused with `404`, the same as a
 * template that does not exist.
 */
function requireTemplate(db: Database, id: string, accountId: string): { template: SplitTemplate; createdBy: string } {
  const row = db
    .prepare(
      `SELECT split_templates.id, split_templates.group_id, split_templates.name, split_templates.split,
              split_templates.created_by
         FROM split_templates JOIN memberships ON memberships.group_id = split_templates.group_id
        WHERE split_templates.id = ? AND memberships.account_id = ?`,
    )
    .get(id, accountId) as (TemplateRow & { created_by: string }) | undefined;
  if (row === undefined) {
    throw new Refusal(404, 'NotFound', 'There is no such template.');
  }
  return { template: toTemplate(row), createdBy: row.created_by };
}

/**
 * The template, for a change by `accountId`: its author, or the owner of its group. Another member is refused with
 * `403`; anyone outside the group is refused with `404`.
 */
function requireTemplateEditor(db: Database, id: string, accountId: string): SplitTemplate {
  const { template, createdBy } = requireTemplate(db, id, accountId);
  requireNotArchived(db, template.groupId);
  if (createdBy !== accountId) {
    const group: Group = requireMembership(db, template.groupId, accountId);
    if (group.ownerId !== accountId) {
      throw new Refusal(403, 'NotPermitted', 'Only the member who saved this template, or the owner, may change it.');
    }
  }
  return template;
}

/**
 * Replaces the template `id` with `input`, by its author or the owner of its group. It keeps its place in the order
 * the templates are listed in. The name may stay the same, but not be another template's name.
 */
export function replaceTemplate(db: Database, id: string, accountId: string, input: TemplateInput): void {
  inTransaction(db, () => {
    const current = requireTemplateEditor(db, id, accountId);
    const checked = validateTemplate(input, membersOfGroup(db, current.groupId));
    requireNameFree(db, current.groupId, checked.nameKey, id);
    db.prepare('UPDATE split_templates SET name = ?, name_key = ?, split = ? WHERE id = ?').run(
      checked.name,
      checked.nameKey,
      JSON.stringify(checked.split),
      id,
    );
  });
}

/** Removes the template `id`, by its author or the owner of its group. Expenses split by it keep their shares. */
export function removeTemplate(db: Database, id: string, accountId: string): void {
  inTransaction(db, () => {
    requireTemplateEditor(db, id, accountId);
    db.prepare('DELETE FROM split_templates WHERE id = ?').run(id);
  });
}

/**
 * The split of the template `templateId`, which must be one of the templates of `groupId`; an expense of the group is
 * split by it, as if that split had been given. Anything else is refused with `422`.
 */
export function splitOfTemplate(db: Database, groupId: string, templateId: string): TemplateSplit {
  const row = db.prepare('SELECT split FROM split_templates WHERE id = ? AND group_id = ?').get(templateId, groupId) as
    { split: string } | undefined;
  if (row === undefined) {
    throw new Refusal(422, 'NoSuchTemplate', 'The template is not one of the templates of this group.');
  }
  return JSON.parse(row.split) as TemplateSplit;
}

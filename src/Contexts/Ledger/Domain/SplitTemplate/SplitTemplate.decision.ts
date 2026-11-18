import { IResult, NotAllowedException, Result } from '@Architecture/Domain';
import { Decision, decided } from '@Architecture/Domain/Lite/Decision';
import { GroupArchivedException } from '@SharedKernel/Domain';

import {
  InvalidSplitSharesException,
  SplitMemberListedTwiceException,
  SplitMemberNotInGroupException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';

import { memberIdsOfTemplate, SplitTemplateSnapshot, TemplateSplit } from './SplitTemplate';
import { TemplateNameTakenException, TemplateWithoutMembersException } from './SplitTemplateExceptions';
import { TemplateName } from './TemplateName';

/** Who may replace or remove a template: the member who saved it, and the group's owner, and no one else (request 25). */
const MAY_CHANGE = 'Only the member who saved the template, or the group’s owner, may replace or remove it';

/** The values a template is saved or replaced with, once they are allowed. */
export interface TemplateValues {
  name: TemplateName;
  split: TemplateSplit;
}

/** What a saving says: the caller, the name as typed, and the split as given. */
export interface SaveTemplateCommand {
  by: string;
  name: string;
  split: TemplateSplit;
}

/**
 * The facts a template is saved against: the members of the group, in the order they joined (the use case asked Groups), and whether a
 * template of the group already has the name, whatever its case (the use case asked the store).
 */
export interface SaveTemplateAccess {
  memberIds: readonly string[];
  nameTaken: boolean;
  /** Whether the group is archived (request 27): then no template is saved, replaced or removed in it. */
  archived: boolean;
}

/**
 * Saving a template (request 25): a name of 1 to 60 characters, not only spaces, unique in the group whatever its case; a split whose
 * members are members of the group, each listed once, at least one of them, each with at least 1 share. Any member of the group may save
 * one. The values are checked in this order: the name, the split, then the name's being taken.
 */
export const decideSaveTemplate: Decision<TemplateValues, SaveTemplateCommand, never, SaveTemplateAccess> = (
  { memberIds, nameTaken, archived },
  { name: rawName, split },
) => {
  if (archived) return Result.fail(new GroupArchivedException());
  const name = TemplateName.create(rawName);
  if (name.isFailure()) return name;
  const checked = checkSplit(split, memberIds);
  if (checked.isFailure()) return checked;
  if (nameTaken) return Result.fail(new TemplateNameTakenException());
  return decided({ name: name.data!, split: checked.data! });
};

/** What a replacement says: the caller, and the name and split it gives the template. */
export interface ReplaceTemplateCommand {
  by: string;
  name: string;
  split: TemplateSplit;
}

/**
 * What a replacement is decided against: the template as it is stored, the group's members and owner, and whether another template of
 * the group has the name (the template itself does not count). The caller is a member: the use case asked Groups before it decided.
 */
export interface ReplaceTemplateAccess {
  template: SplitTemplateSnapshot;
  memberIds: readonly string[];
  ownerId: string;
  nameTaken: boolean;
  /** Whether the group is archived (request 27): then no template is replaced in it. */
  archived: boolean;
}

/**
 * Replacing a template (request 25): the member who saved it, or the group's owner, replaces it under the same rules as a saving; any
 * other member is refused, before the values are looked at.
 */
export const decideReplaceTemplate: Decision<TemplateValues, ReplaceTemplateCommand, never, ReplaceTemplateAccess> = (
  { template, memberIds, ownerId, nameTaken, archived },
  { by, name: rawName, split },
) => {
  if (archived) return Result.fail(new GroupArchivedException());
  if (!mayChange(template.savedBy, ownerId, by)) return Result.fail(new NotAllowedException('Ledger', MAY_CHANGE));
  const name = TemplateName.create(rawName);
  if (name.isFailure()) return name;
  const checked = checkSplit(split, memberIds);
  if (checked.isFailure()) return checked;
  if (nameTaken) return Result.fail(new TemplateNameTakenException());
  return decided({ name: name.data!, split: checked.data! });
};

/** What a removal is decided against: the template as it is stored, and the group's owner. */
export interface RemoveTemplateAccess {
  template: SplitTemplateSnapshot;
  ownerId: string;
  /** Whether the group is archived (request 27): then no template is removed from it. */
  archived: boolean;
}

/** Removing a template (request 25): the member who saved it, or the group's owner, removes it; any other member is refused. */
export const decideRemoveTemplate: Decision<undefined, { by: string }, never, RemoveTemplateAccess> = (
  { template, ownerId, archived },
  { by },
) => {
  if (archived) return Result.fail(new GroupArchivedException());
  if (!mayChange(template.savedBy, ownerId, by)) return Result.fail(new NotAllowedException('Ledger', MAY_CHANGE));
  return decided(undefined);
};

/** The member who saved a template, and the group's owner, may change it; no one else. */
const mayChange = (savedBy: string, ownerId: string, by: string): boolean => by === savedBy || by === ownerId;

/**
 * A split a template is given as (request 25): at least one member, each listed once, each a member of the group, and, by shares, each
 * with a whole number of shares, at least 1. A split by exact amounts is not one a template can be given (the shape refuses it).
 */
const checkSplit = (split: TemplateSplit, memberIds: readonly string[]): IResult<TemplateSplit> => {
  const members = memberIdsOfTemplate(split);
  if (members.length === 0) return Result.fail(new TemplateWithoutMembersException());
  if (new Set(members).size !== members.length) return Result.fail(new SplitMemberListedTwiceException());
  if (members.some(member => !memberIds.includes(member))) return Result.fail(new SplitMemberNotInGroupException());
  if (split.kind === 'shares' && split.shares.some(line => !Number.isSafeInteger(line.shares) || line.shares < 1)) {
    return Result.fail(new InvalidSplitSharesException());
  }
  return Result.ok(split);
};

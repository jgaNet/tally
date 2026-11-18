import { AggregateRoot, DomainEvent, Id, IResult, Result } from '@Architecture/Domain';
import { GroupArchivedException } from '@SharedKernel/Domain';

import { SplitDraft } from '@Contexts/Ledger/Domain/Expense/Split';
import {
  DuplicateTemplateMemberException,
  InvalidTemplateNameException,
  InvalidTemplateSharesException,
  NoTemplateMemberException,
  TemplateMemberNotInGroupException,
  TemplateNameTakenException,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

/**
 * A split as a template keeps it (request 25): equally between members (`splitBetween`) or by their shares (`splitByShares`). Exact
 * amounts make no template: they depend on an expense's amount.
 */
export type TemplateSplit = Exclude<SplitDraft, { readonly kind: 'exact' }>;

/** How a template splits: `equal` (`splitBetween`) or `shares` (`splitByShares`), as it was given. */
export type TemplateKind = 'equal' | 'shares';

/** One member of a template's split, in the order given: its shares (1 each for an equal split). */
export interface TemplateMember {
  readonly memberId: string;
  readonly shares: number;
}

/** A template as the store keeps it: its group, its name, who saved it, its split as given, and the version it is at. */
export interface SplitTemplateSnapshot {
  readonly id: string;
  readonly groupId: string;
  readonly name: string;
  readonly savedBy: string;
  readonly kind: TemplateKind;
  readonly members: readonly TemplateMember[];
  readonly version: number;
}

/** The key two names are compared by: the same name whatever its case (request 25). */
export const templateNameKey = (name: string): string => name.toLowerCase();

/**
 * A split saved under a name, which an expense is split by in place of its own (request 25, ADR 20): one per name in its group, whatever
 * the case. An expense keeps the shares it was decided as, never a reference to the template, so changing or removing a template changes no
 * expense. It is an aggregate root because `SaveTemplate`, `ReplaceTemplate` and `RemoveTemplate` record facts. Its version is the one it
 * was loaded at (AggregateRoot).
 */
export class SplitTemplate extends AggregateRoot {
  static readonly MAX_NAME_LENGTH = 60;

  readonly #groupId: string;
  readonly #savedBy: string;
  #name: string;
  #kind: TemplateKind;
  #members: TemplateMember[];

  private constructor(
    id: Id,
    groupId: string,
    savedBy: string,
    name: string,
    kind: TemplateKind,
    members: readonly TemplateMember[],
    version: number,
  ) {
    super(id, version);
    this.#groupId = groupId;
    this.#savedBy = savedBy;
    this.#name = name;
    this.#kind = kind;
    this.#members = members.map(member => ({ ...member }));
  }

  /**
   * A template saved by `savedBy` in a group: the name is 1 to 60 characters and not only spaces, free in the group (`nameHeldBy`, the id of
   * the template that holds it, if any), and the split's members are members of the group (`members`), each listed once, with at least 1
   * share. The identity is generated here (DOMAIN-IDENTITY), and the save records `TemplateSaved`. Pure: the members and the time are given.
   */
  static create(
    draft: { groupId: string; savedBy: string; name: string; split: TemplateSplit },
    members: readonly string[],
    nameHeldBy: string | undefined,
    archived: boolean,
    now: Date,
  ): IResult<SplitTemplate> {
    if (archived) return Result.fail(new GroupArchivedException());
    const checked = checkTemplate(draft.name, draft.split, members, nameHeldBy !== undefined);
    if (checked.isFailure()) return Result.fail(checked.error);

    const template = new SplitTemplate(
      Id.generate(),
      draft.groupId,
      draft.savedBy,
      draft.name,
      checked.data.kind,
      checked.data.members,
      0,
    );
    template.record(
      TemplateSavedEvent.set({
        templateId: template._id.value,
        groupId: draft.groupId,
        savedBy: draft.savedBy,
        at: now.toISOString(),
      }),
    );
    return Result.ok(template);
  }

  /** A template the store keeps, as it was last saved. Records nothing; throws on a template the domain never keeps. */
  static fromSnapshot(snapshot: SplitTemplateSnapshot): SplitTemplate {
    if (
      !templateNameIsValid(snapshot.name) ||
      !['equal', 'shares'].includes(snapshot.kind) ||
      snapshot.members.length === 0 ||
      new Set(snapshot.members.map(member => member.memberId)).size !== snapshot.members.length
    ) {
      throw new Error(`The template ${snapshot.id} is corrupted`);
    }
    return new SplitTemplate(
      new Id(snapshot.id),
      snapshot.groupId,
      snapshot.savedBy,
      snapshot.name,
      snapshot.kind,
      snapshot.members,
      snapshot.version,
    );
  }

  /**
   * Replaces the template's name and split, under the rules of a save (`nameHeldBy`, the id of the template holding the name, is this
   * one's own id when the name is kept). Records `TemplateReplaced`; the time is `now`. Who may replace it is the use case's to say.
   */
  replace(
    draft: { name: string; split: TemplateSplit },
    members: readonly string[],
    nameHeldBy: string | undefined,
    archived: boolean,
    now: Date,
  ): IResult<void> {
    if (archived) return Result.fail(new GroupArchivedException());
    const takenByOther = nameHeldBy !== undefined && nameHeldBy !== this._id.value;
    const checked = checkTemplate(draft.name, draft.split, members, takenByOther);
    if (checked.isFailure()) return Result.fail(checked.error);

    this.#name = draft.name;
    this.#kind = checked.data.kind;
    this.#members = checked.data.members;
    this.record(
      TemplateReplacedEvent.set({
        templateId: this._id.value,
        groupId: this.#groupId,
        at: now.toISOString(),
      }),
    );
    return Result.ok(undefined);
  }

  /** Removes the template: no expense changes, and no one can split by it from now on. Records `TemplateRemoved`; the time is `now`. */
  remove(archived: boolean, now: Date): IResult<void> {
    if (archived) return Result.fail(new GroupArchivedException());
    this.record(
      TemplateRemovedEvent.set({
        templateId: this._id.value,
        groupId: this.#groupId,
        at: now.toISOString(),
      }),
    );
    return Result.ok(undefined);
  }

  /** The split as it was given, in the words of a recording: the members of an equal split, or each member with their shares. */
  splitDraft(): SplitDraft {
    if (this.#kind === 'equal') return { kind: 'equal', memberIds: this.#members.map(member => member.memberId) };
    return {
      kind: 'shares',
      shares: this.#members.map(member => ({ memberId: member.memberId, shares: member.shares })),
    };
  }

  get groupId(): string {
    return this.#groupId;
  }

  get savedBy(): string {
    return this.#savedBy;
  }

  get name(): string {
    return this.#name;
  }

  toSnapshot(): SplitTemplateSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      name: this.#name,
      savedBy: this.#savedBy,
      kind: this.#kind,
      members: this.#members.map(member => ({ ...member })),
      version: this.version,
    };
  }
}

interface Checked {
  readonly kind: TemplateKind;
  readonly members: TemplateMember[];
}

/**
 * What a save and a replacement both must hold (request 25): the name, free in the group, and the split's members, each a member of the
 * group, listed once, with at least 1 share. Returns the split as it is kept.
 */
const checkTemplate = (
  name: string,
  split: TemplateSplit,
  members: readonly string[],
  nameTaken: boolean,
): IResult<Checked> => {
  if (!templateNameIsValid(name)) return Result.fail(new InvalidTemplateNameException());
  if (nameTaken) return Result.fail(new TemplateNameTakenException());

  const memberIds = split.kind === 'equal' ? [...split.memberIds] : split.shares.map(entry => entry.memberId);
  if (memberIds.length === 0) return Result.fail(new NoTemplateMemberException());
  if (new Set(memberIds).size !== memberIds.length) return Result.fail(new DuplicateTemplateMemberException());
  if (!memberIds.every(memberId => members.includes(memberId))) {
    return Result.fail(new TemplateMemberNotInGroupException());
  }

  if (split.kind === 'equal') {
    return Result.ok({ kind: 'equal', members: memberIds.map(memberId => ({ memberId, shares: 1 })) });
  }
  if (!split.shares.every(entry => isShareCount(entry.shares)))
    return Result.fail(new InvalidTemplateSharesException());
  return Result.ok({
    kind: 'shares',
    members: split.shares.map(entry => ({ memberId: entry.memberId, shares: entry.shares })),
  });
};

/** A name is 1 to 60 characters, and not only spaces. */
const templateNameIsValid = (raw: string): boolean =>
  raw.trim() !== '' && [...raw].length <= SplitTemplate.MAX_NAME_LENGTH;

/** A member's shares are a whole number of 1 or more. */
const isShareCount = (raw: number): boolean => Number.isSafeInteger(raw) && raw >= 1;

export type TemplateSavedPayload = { templateId: string; groupId: string; savedBy: string; at: string };
export type TemplateReplacedPayload = { templateId: string; groupId: string; at: string };
export type TemplateRemovedPayload = { templateId: string; groupId: string; at: string };

/** The fact that a member saved a template: it is a name the group can split by. Made durable with the template and published after the commit. */
export class TemplateSavedEvent extends DomainEvent<TemplateSavedPayload> {}

/** The fact that a template was replaced under the same rules. Published after the commit. */
export class TemplateReplacedEvent extends DomainEvent<TemplateReplacedPayload> {}

/** The fact that a template was removed. Published after the commit. */
export class TemplateRemovedEvent extends DomainEvent<TemplateRemovedPayload> {}

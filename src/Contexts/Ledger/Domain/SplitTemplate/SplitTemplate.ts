import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';
import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/DTOs';
import { NotAGroupMember } from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import {
  NotAllowedToChangeTemplate,
  TemplateNameTaken,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';
import { TemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';
import {
  TemplateMember,
  TemplateSplit,
  requestOfTemplateSplit,
} from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';
import {
  TemplateRemovedEvent,
  TemplateReplacedEvent,
  TemplateSavedEvent,
} from '@Contexts/Ledger/Domain/SplitTemplate/Events/SplitTemplateEvents';

/** A template as it is stored and reconstituted: plain values, its version included. */
export interface SplitTemplateSnapshot {
  id: string;
  groupId: string;
  name: string;
  savedBy: string;
  kind: 'between' | 'shares';
  members: { memberId: string; shares: number }[];
  version: number;
}

/**
 * A split saved under a name in a group (request 25): an aggregate of its own, beside the expenses it may split. Its name is
 * free in the group, whatever its case; its members are members of the group, each listed once, with at least one share.
 * The member who saved it, or the owner of the group, may replace it or remove it. An expense that is split by it takes the
 * split as an expense would be given it, and keeps its shares: nothing of the expense refers back to the template.
 *
 * `draft()` and `revise()` take the id of the template that has the name already (`sameNameAs`), read from the
 * repository, and refuse when it is another template; `retire()` records TemplateRemoved and leaves the removed instance
 * for the repository to delete. Every operation answers a new instance at the version this one was read at.
 */
export class SplitTemplate extends AggregateRoot {
  private constructor(
    id: Id,
    version: number,
    readonly groupId: Id,
    readonly name: TemplateName,
    readonly split: TemplateSplit,
    readonly savedBy: Id,
    private readonly removed: boolean,
  ) {
    super(id, version);
  }

  /** Whether the template was removed: a removed template is gone from every read, and its repository forgets it. */
  get isRemoved(): boolean {
    return this.removed;
  }

  /** Saves a template, as `draft()`: records TemplateSaved. The name must be free in the group; every member must be one of `groupMembers`. */
  static draft({
    groupId,
    name,
    split,
    savedBy,
    groupMembers,
    sameNameAs,
    at,
  }: {
    groupId: Id;
    name: TemplateName;
    split: TemplateSplit;
    savedBy: Id;
    groupMembers: readonly Id[];
    /** The template of the group that has this name already, or null when none has. */
    sameNameAs: Id | null;
    at: Date;
  }): IResult<SplitTemplate> {
    if (sameNameAs !== null) return Result.fail(new TemplateNameTaken());
    if (SplitTemplate.outsiders(split, groupMembers)) return Result.fail(new NotAGroupMember());

    const template = new SplitTemplate(Id.generate(), 0, groupId, name, split, savedBy, false);
    template.record(
      TemplateSavedEvent.set({
        templateId: template._id.value,
        groupId: groupId.value,
        savedBy: savedBy.value,
        savedAt: at.toISOString(),
      }),
    );
    return Result.ok(template);
  }

  /** Replaces the name and the split, under the rules of `draft()`. Only the member who saved it, or the owner, may. Records TemplateReplaced. */
  revise({
    by,
    byOwner,
    name,
    split,
    groupMembers,
    sameNameAs,
    at,
  }: {
    by: Id;
    byOwner: boolean;
    name: TemplateName;
    split: TemplateSplit;
    groupMembers: readonly Id[];
    sameNameAs: Id | null;
    at: Date;
  }): IResult<SplitTemplate> {
    if (!this.mayBeChangedBy(by, byOwner)) return Result.fail(new NotAllowedToChangeTemplate());
    if (sameNameAs !== null && !sameNameAs.equals(this._id)) return Result.fail(new TemplateNameTaken());
    if (SplitTemplate.outsiders(split, groupMembers)) return Result.fail(new NotAGroupMember());

    const replaced = this.moved({ name, split });
    replaced.record(
      TemplateReplacedEvent.set({
        templateId: this._id.value,
        groupId: this.groupId.value,
        replacedBy: by.value,
        replacedAt: at.toISOString(),
      }),
    );
    return Result.ok(replaced);
  }

  /** Removes the template, as `retire()`. Only the member who saved it, or the owner, may. Records TemplateRemoved. */
  retire({ by, byOwner, at }: { by: Id; byOwner: boolean; at: Date }): IResult<SplitTemplate> {
    if (!this.mayBeChangedBy(by, byOwner)) return Result.fail(new NotAllowedToChangeTemplate());

    const removed = new SplitTemplate(this._id, this.version, this.groupId, this.name, this.split, this.savedBy, true);
    removed.record(
      TemplateRemovedEvent.set({
        templateId: this._id.value,
        groupId: this.groupId.value,
        removedBy: by.value,
        removedAt: at.toISOString(),
      }),
    );
    return Result.ok(removed);
  }

  /** The split as a command gives it, for an expense that is split by this template (request 25). */
  asSplitRequest(): SplitRequest {
    return requestOfTemplateSplit(this.split);
  }

  /** The members of the split, in the order it was given. */
  get members(): readonly TemplateMember[] {
    return this.split.members;
  }

  private mayBeChangedBy(by: Id, byOwner: boolean): boolean {
    return byOwner || this.savedBy.equals(by);
  }

  private static outsiders(split: TemplateSplit, groupMembers: readonly Id[]): boolean {
    return split.members.some(member => !groupMembers.some(current => current.equals(member.memberId)));
  }

  private moved({ name, split }: { name: TemplateName; split: TemplateSplit }): SplitTemplate {
    return new SplitTemplate(this._id, this.version, this.groupId, name, split, this.savedBy, this.removed);
  }

  /** Reconstitutes a stored template. It records nothing. */
  static fromSnapshot(snapshot: SplitTemplateSnapshot): SplitTemplate {
    const name = TemplateName.of(snapshot.name);
    if (name.isFailure()) throw new Error(`Corrupted template name of ${snapshot.id}`);
    return new SplitTemplate(
      new Id(snapshot.id),
      snapshot.version,
      new Id(snapshot.groupId),
      name.data,
      {
        kind: snapshot.kind,
        members: snapshot.members.map(member => ({ memberId: new Id(member.memberId), shares: member.shares })),
      },
      new Id(snapshot.savedBy),
      false,
    );
  }

  toSnapshot(): SplitTemplateSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      name: this.name.value,
      savedBy: this.savedBy.value,
      kind: this.split.kind,
      members: this.split.members.map(member => ({ memberId: member.memberId.value, shares: member.shares })),
      version: this.version,
    };
  }
}

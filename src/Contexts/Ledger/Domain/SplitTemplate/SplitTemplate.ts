import { GroupArchived } from '@SharedKernel/Domain';
import { AggregateRoot, Id, IResult, Result } from '@Architecture/Domain';

import {
  DuplicateSplitMember,
  InvalidShareCount,
  NotAMemberOfTheGroup,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { SplitTemplateSnapshot } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';
import {
  TemplateRemovedEvent,
  TemplateReplacedEvent,
  TemplateSavedEvent,
} from '@Contexts/Ledger/Domain/SplitTemplate/Events/SplitTemplateEvents';
import {
  EmptyTemplateSplit,
  NotTheSaverOrTheOwner,
  TemplateNameTaken,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';
import { TemplateName } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateName';
import { TemplateSplit } from '@Contexts/Ledger/Domain/SplitTemplate/TemplateSplit';

/** What a template says once its name and its split have been checked. */
interface Decided {
  name: TemplateName;
  split: TemplateSplit;
}

/**
 * A split a member of a group saves under a name (request 25): either equally between some members, or by shares, the members of the
 * group, each listed once. An expense may be split by it in place of its own split; the expense keeps the shares it was given, so a
 * template changed or removed later changes no expense. The member who saved it, or the group's owner, may replace or remove it.
 * The names of a group are free of one another, whatever their case; the handler reads that fact, as it reads the members.
 */
export class SplitTemplate extends AggregateRoot {
  private constructor(
    id: Id,
    readonly groupId: Id,
    readonly name: TemplateName,
    readonly createdBy: Id,
    readonly split: TemplateSplit,
    version: number,
  ) {
    super(id, version);
  }

  /**
   * Registers a template saved by `createdBy`, a member of the group. `groupMembers` are the group's current members, read by the handler, and
   * `nameTaken` is whether another template of the group has this name, read by the handler. The id is generated here.
   */
  static register({
    groupId,
    createdBy,
    name,
    split,
    groupMembers,
    nameTaken,
    archived,
  }: {
    groupId: Id;
    createdBy: Id;
    name: string;
    split: TemplateSplit;
    groupMembers: Id[];
    nameTaken: boolean;
    /** Whether the group is archived, read by the handler: an archived group saves no template (request 27). */
    archived: boolean;
  }): IResult<SplitTemplate> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    const decided = SplitTemplate.decide({ name, split, groupMembers, nameTaken });
    if (decided.isFailure()) return decided;

    const template = new SplitTemplate(Id.generate(), groupId, decided.data.name, createdBy, decided.data.split, 0);
    template.record(TemplateSavedEvent.set({ templateId: template._id.value, groupId: groupId.value }));
    return Result.ok(template);
  }

  /**
   * Replaces the template, whole, under the same rules as registering it. Only its saver, or the owner of its group (`byOwner`, read by the
   * handler), may. It keeps its saver and its place in the order of the group's templates; the returned template keeps this version.
   */
  replaceWith({
    by,
    byOwner,
    name,
    split,
    groupMembers,
    nameTaken,
    archived,
  }: {
    by: Id;
    byOwner: boolean;
    name: string;
    split: TemplateSplit;
    groupMembers: Id[];
    nameTaken: boolean;
    /** Whether the group is archived, read by the handler (request 27). */
    archived: boolean;
  }): IResult<SplitTemplate> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    if (!this.mayChange(by, byOwner)) return Result.fail(new NotTheSaverOrTheOwner());
    const decided = SplitTemplate.decide({ name, split, groupMembers, nameTaken });
    if (decided.isFailure()) return decided;

    const replaced = new SplitTemplate(
      this._id,
      this.groupId,
      decided.data.name,
      this.createdBy,
      decided.data.split,
      this.version,
    );
    replaced.record(TemplateReplacedEvent.set({ templateId: this._id.value, groupId: this.groupId.value }));
    return Result.ok(replaced);
  }

  /** Removes the template: only its saver or the group's owner may. The repository deletes it. */
  remove({ by, byOwner, archived }: { by: Id; byOwner: boolean; archived: boolean }): IResult<SplitTemplate> {
    if (archived) return Result.fail(new GroupArchived('Ledger'));
    if (!this.mayChange(by, byOwner)) return Result.fail(new NotTheSaverOrTheOwner());

    this.record(TemplateRemovedEvent.set({ templateId: this._id.value, groupId: this.groupId.value }));
    return Result.ok(this);
  }

  static fromSnapshot(snapshot: SplitTemplateSnapshot): SplitTemplate {
    const name = TemplateName.create(snapshot.name);
    const members = snapshot.split.kind === 'equal' ? snapshot.split.members : snapshot.split.shares;
    if (name.isFailure() || members.length === 0) throw new Error(`The template ${snapshot.id} is corrupted`);
    return new SplitTemplate(
      new Id(snapshot.id),
      new Id(snapshot.groupId),
      name.data,
      new Id(snapshot.createdBy),
      snapshot.split,
      snapshot.version,
    );
  }

  toSnapshot(): SplitTemplateSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      name: this.name.value,
      createdBy: this.createdBy.value,
      split:
        this.split.kind === 'equal'
          ? { kind: 'equal', members: [...this.split.members] }
          : { kind: 'shares', shares: this.split.shares.map(share => ({ ...share })) },
      version: this.version,
    };
  }

  /** The saver, or the owner of the group, may change a template; no one else. */
  private mayChange(by: Id, byOwner: boolean): boolean {
    return byOwner || by.value === this.createdBy.value;
  }

  /**
   * The rules a template's content follows, shared by saving and replacing: a name free in the group, a split of at least one member,
   * each member listed once, each a member of the group, and each with a whole number of shares, at least 1, when split by shares.
   */
  private static decide({
    name,
    split,
    groupMembers,
    nameTaken,
  }: {
    name: string;
    split: TemplateSplit;
    groupMembers: Id[];
    nameTaken: boolean;
  }): IResult<Decided> {
    const text = TemplateName.create(name);
    if (text.isFailure()) return text;
    if (nameTaken) return Result.fail(new TemplateNameTaken());

    const members = split.kind === 'equal' ? split.members : split.shares.map(share => share.memberId);
    if (members.length === 0) return Result.fail(new EmptyTemplateSplit());
    if (new Set(members).size !== members.length) return Result.fail(new DuplicateSplitMember());
    if (members.some(member => !groupMembers.some(current => current.value === member))) {
      return Result.fail(new NotAMemberOfTheGroup());
    }
    if (
      split.kind === 'shares' &&
      split.shares.some(share => !Number.isSafeInteger(share.shares) || share.shares < 1)
    ) {
      return Result.fail(new InvalidShareCount());
    }
    return Result.ok({ name: text.data, split });
  }
}

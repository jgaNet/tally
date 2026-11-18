import { AggregateRoot, Id, IResult, NotAllowedException, Result } from '@Architecture/Domain';

import { ISplitTemplateSnapshot } from '@Contexts/Ledger/Domain/SplitTemplate/DTOs';
import {
  TemplateRemovedEvent,
  TemplateReplacedEvent,
  TemplateSavedEvent,
} from '@Contexts/Ledger/Domain/SplitTemplate/Events/SplitTemplateEvents';
import {
  DuplicateTemplateNameException,
  InvalidTemplateNameException,
  InvalidTemplateSplitException,
} from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';
import {
  InvalidSharesException,
  SplitListsTwiceException,
  SplitWithStrangerException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { GroupMember } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';

/** The longest name of a template, in characters (request 25). */
export const LONGEST_TEMPLATE_NAME = 60;

/**
 * A split as a template keeps it, as it was given: equally between members, or by whole shares. A template never splits by
 * exact amounts, which depend on an expense's amount (request 25). An expense split by a template is given this split, under
 * the same rules as its own.
 */
export type TemplateSplit =
  { kind: 'equal'; memberIds: string[] } | { kind: 'shares'; shares: { memberId: string; shares: number }[] };

/**
 * SplitTemplate is the aggregate root of a split saved under a name in a group (request 25): a member saves it, the member who
 * saved it or the group's owner replaces or removes it, and an expense recorded or edited may be split by it. Its name is free
 * in the group, whatever its case: `nameTaken` says whether another template of the group has it, a fact the repository
 * answers. Its members are the group's members when it is saved or replaced, each listed once, each with at least one share.
 *
 * A template is not part of an expense: an expense keeps the shares it was given, never a reference to the template.
 */
export class SplitTemplate extends AggregateRoot {
  readonly #groupId: string;
  readonly #name: string;
  readonly #split: TemplateSplit;
  readonly #savedBy: string;

  private constructor(id: Id, groupId: string, name: string, split: TemplateSplit, savedBy: string, version: number) {
    super(id, version);
    this.#groupId = groupId;
    this.#name = name;
    this.#split = split;
    this.#savedBy = savedBy;
  }

  /**
   * Creates a template under `name` in a group, as `savedBy` asks, a member of it. The store saves it. Records TemplateSaved. A name not from 1 to 60
   * characters, or only spaces, is refused; so is a name another template of the group has, or a split that is not the group's
   * members, each once, with at least one share.
   */
  static draft({
    groupId,
    name,
    split,
    savedBy,
    members,
    nameTaken,
  }: {
    groupId: string;
    name: string;
    split: TemplateSplit;
    savedBy: string;
    members: GroupMember[];
    nameTaken: boolean;
  }): IResult<SplitTemplate> {
    const checked = checkValues({ name, split, members, nameTaken });
    if (checked.isFailure()) return Result.fail(checked.error);

    const saved = new SplitTemplate(Id.generate(), groupId, name, split, savedBy, 0);
    saved.record(TemplateSavedEvent.set({ templateId: saved._id.value, groupId, name, savedBy }));
    return Result.ok(saved);
  }

  /**
   * Replaces the template under the same rules, as `replacedBy` asks: the member who saved it or the group's owner, and no other
   * member. It keeps its id, its group and who saved it. Records TemplateReplaced.
   */
  replace({
    replacedBy,
    members,
    name,
    split,
    nameTaken,
  }: {
    replacedBy: string;
    members: GroupMember[];
    name: string;
    split: TemplateSplit;
    nameTaken: boolean;
  }): IResult<SplitTemplate> {
    if (!this.mayChange(replacedBy, members)) return Result.fail(notAllowed());
    const checked = checkValues({ name, split, members, nameTaken });
    if (checked.isFailure()) return Result.fail(checked.error);

    const replaced = new SplitTemplate(this._id, this.#groupId, name, split, this.#savedBy, this.version);
    replaced.record(TemplateReplacedEvent.set({ templateId: this._id.value, groupId: this.#groupId, name }));
    return Result.ok(replaced);
  }

  /**
   * Removes the template, as `removedBy` asks: the member who saved it or the group's owner, and no other member. Records
   * TemplateRemoved; the store then deletes it. The expenses split by it keep their shares.
   */
  remove({ removedBy, members }: { removedBy: string; members: GroupMember[] }): IResult<SplitTemplate> {
    if (!this.mayChange(removedBy, members)) return Result.fail(notAllowed());

    const removed = new SplitTemplate(this._id, this.#groupId, this.#name, this.#split, this.#savedBy, this.version);
    removed.record(TemplateRemovedEvent.set({ templateId: this._id.value, groupId: this.#groupId }));
    return Result.ok(removed);
  }

  /** Rebuilds a template from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: ISplitTemplateSnapshot): SplitTemplate {
    if (!snapshot.groupId || !snapshot.name || !snapshot.split || !snapshot.savedBy) {
      throw new Error(`Corrupted split template ${snapshot._id}`);
    }
    return new SplitTemplate(
      new Id(snapshot._id),
      snapshot.groupId,
      snapshot.name,
      snapshot.split,
      snapshot.savedBy,
      snapshot.version,
    );
  }

  toSnapshot(): ISplitTemplateSnapshot {
    return {
      _id: this._id.value,
      groupId: this.#groupId,
      name: this.#name,
      split: this.#split,
      savedBy: this.#savedBy,
      version: this.version,
    };
  }

  get groupId(): string {
    return this.#groupId;
  }

  get name(): string {
    return this.#name;
  }

  get split(): TemplateSplit {
    return this.#split;
  }

  /** Whether `who` may change the template: the member who saved it, or the group's owner. */
  private mayChange(who: string, members: GroupMember[]): boolean {
    return who === this.#savedBy || members.some(member => member.memberId === who && member.role === 'owner');
  }
}

/** Any other member is refused: a template is the saver's, and the owner's (request 25). */
const notAllowed = () =>
  new NotAllowedException('Ledger', 'Only the member who saved this template, or the group’s owner, may change it');

/** The values of a template: its name, whether another has it, and its split. A refusal is a failed Result, by name. */
const checkValues = ({
  name,
  split,
  members,
  nameTaken,
}: {
  name: string;
  split: TemplateSplit;
  members: GroupMember[];
  nameTaken: boolean;
}): IResult<void> => {
  if (name.trim() === '' || Array.from(name).length > LONGEST_TEMPLATE_NAME) {
    return Result.fail(new InvalidTemplateNameException());
  }
  if (nameTaken) return Result.fail(new DuplicateTemplateNameException());

  const listed = split.kind === 'equal' ? split.memberIds : split.shares.map(share => share.memberId);
  if (listed.length === 0) return Result.fail(new InvalidTemplateSplitException());
  const memberIds = members.map(member => member.memberId);
  if (listed.some(memberId => !memberIds.includes(memberId))) return Result.fail(new SplitWithStrangerException());
  if (new Set(listed).size !== listed.length) return Result.fail(new SplitListsTwiceException());
  if (split.kind === 'shares' && split.shares.some(share => !Number.isSafeInteger(share.shares) || share.shares < 1)) {
    return Result.fail(new InvalidSharesException());
  }
  return Result.ok();
};

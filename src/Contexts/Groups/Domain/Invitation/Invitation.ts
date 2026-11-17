import { AggregateRoot, Id, IResult, NotFoundException, Result } from '@Architecture/Domain';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { InvitationSnapshot } from '@Contexts/Groups/Domain/Invitation/DTOs';
import { InvitationCreatedEvent } from '@Contexts/Groups/Domain/Invitation/Events/InvitationEvents';

/**
 * An invitation to a group, by a link: its id is the link, and whoever has it may join (the storm, hot spots 1 and 2).
 * It is an aggregate of its own, not a part of the group: it is read by people who are not members yet, it is used any
 * number of times, and making it changes nothing of the group. Accepting it changes the group (`Group.join()`).
 *
 * `issue()` is the invitation, made by a member of the group: the rule that only a member invites is decided here, from
 * the group it is given, and a caller who is not a member is refused as if the group did not exist. Its id is generated
 * here, long and random, and it records InvitationCreated for the store to make durable with it. `fromSnapshot()` reads
 * what the store kept, records nothing, and throws on corrupted data.
 */
export class Invitation extends AggregateRoot {
  readonly #groupId: string;
  readonly #invitedBy: string;
  readonly #createdAt: Date;

  private constructor(id: Id, groupId: string, invitedBy: string, createdAt: Date, version: number) {
    super(id, version);
    this.#groupId = groupId;
    this.#invitedBy = invitedBy;
    this.#createdAt = createdAt;
  }

  /** Makes an invitation to `group`, by `invitedBy`, who must be one of its members; `at` is the one clock's now. */
  static issue({ group, invitedBy, at }: { group: Group; invitedBy: string; at: Date }): IResult<Invitation> {
    if (!group.isMember(invitedBy)) {
      return Result.fail(new NotFoundException('Groups', 'There is no such group'));
    }
    const id = Id.generate();
    const invitation = new Invitation(id, group.id, invitedBy, at, 0);
    invitation.record(InvitationCreatedEvent.set({ invitationId: id.value, groupId: group.id, invitedBy }));
    return Result.ok(invitation);
  }

  static fromSnapshot(snapshot: InvitationSnapshot): Invitation {
    const createdAt = new Date(snapshot.createdAt);
    if (!snapshot.groupId || !snapshot.invitedBy || Number.isNaN(createdAt.getTime())) {
      throw new Error(`The invitation ${snapshot.id} is corrupted in the store`);
    }
    return new Invitation(new Id(snapshot.id), snapshot.groupId, snapshot.invitedBy, createdAt, snapshot.version);
  }

  toSnapshot(): InvitationSnapshot {
    return {
      id: this._id.value,
      groupId: this.#groupId,
      invitedBy: this.#invitedBy,
      createdAt: this.#createdAt.toISOString(),
      version: this.version,
    };
  }

  get id(): string {
    return this._id.value;
  }

  get groupId(): string {
    return this.#groupId;
  }

  get invitedBy(): string {
    return this.#invitedBy;
  }
}

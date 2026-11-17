import { AggregateRoot, Id } from '@Architecture/Domain';

import { IInvitationSnapshot } from '@Contexts/Groups/Domain/Invitation/DTOs';
import { InvitationCreatedEvent } from '@Contexts/Groups/Domain/Invitation/Events/InvitationEvents';

/**
 * Invitation is the aggregate root of an invitation to a group (the storm's decision: its own aggregate, not part of
 * the group). Its id is the link: whoever holds it may read the invitation and join, so the id is generated here,
 * long and random. It is used any number of times and changes nothing when it is used, so the only behaviour is its
 * creation, which records InvitationCreated.
 *
 * Whether the creator may invite to the group is the group's to say (a member only); the handler asks it first.
 */
export class Invitation extends AggregateRoot {
  readonly #groupId: string;
  readonly #invitedBy: string;

  private constructor(id: Id, groupId: string, invitedBy: string, version: number) {
    super(id, version);
    this.#groupId = groupId;
    this.#invitedBy = invitedBy;
  }

  /** Issues an invitation to a group by one of its members: its id is generated here, and the creation is recorded. */
  static issue({ groupId, invitedBy }: { groupId: string; invitedBy: string }): Invitation {
    const invitation = new Invitation(Id.generate(), groupId, invitedBy, 0);
    invitation.record(InvitationCreatedEvent.set({ invitationId: invitation._id.value, groupId, invitedBy }));
    return invitation;
  }

  /** Rebuilds an invitation from what was persisted. Nothing is recorded: nothing new happened. */
  static fromSnapshot(snapshot: IInvitationSnapshot): Invitation {
    if (!snapshot.groupId || !snapshot.invitedBy) {
      throw new Error(`Corrupted invitation ${snapshot._id}`);
    }
    return new Invitation(new Id(snapshot._id), snapshot.groupId, snapshot.invitedBy, snapshot.version);
  }

  toSnapshot(): IInvitationSnapshot {
    return {
      _id: this._id.value,
      groupId: this.#groupId,
      invitedBy: this.#invitedBy,
      version: this.version,
    };
  }

  get groupId(): string {
    return this.#groupId;
  }

  get invitedBy(): string {
    return this.#invitedBy;
  }
}

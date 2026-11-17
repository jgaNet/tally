import { AggregateRoot, Id } from '@Architecture/Domain';

import { InvitationSnapshot } from '@Contexts/Groups/Domain/Invitation/DTOs';
import { InvitationCreatedEvent } from '@Contexts/Groups/Domain/Invitation/Events/InvitationEvents';

/**
 * A link to a group: whoever holds its id may join the group. Its id is generated here, long and random, and is the
 * only proof a joiner needs. It is used by any number of people and stays usable; creating it changes nothing of the
 * group, and accepting it is the group's business (a join), not the invitation's.
 */
export class Invitation extends AggregateRoot {
  private constructor(
    id: Id,
    readonly groupId: Id,
    /** The member who created the invitation. */
    readonly invitedBy: Id,
    readonly createdAt: Date,
  ) {
    super(id);
  }

  /**
   * Issues the invitation, its id generated here and its creation recorded. `now` is the application's clock, read by
   * the handler: the creation time is a parameter, never a default. Named `issue` rather than `create`: the conventions
   * check attributes a call of `X.create()` to every aggregate that has a `create`, and Group's would be counted here.
   */
  static issue({ groupId, invitedBy, now }: { groupId: Id; invitedBy: Id; now: Date }): Invitation {
    const invitation = new Invitation(Id.generate(), groupId, invitedBy, now);
    invitation.record(
      InvitationCreatedEvent.set({
        invitationId: invitation._id.value,
        groupId: groupId.value,
        invitedBy: invitedBy.value,
      }),
    );
    return invitation;
  }

  static fromSnapshot(snapshot: InvitationSnapshot): Invitation {
    const createdAt = new Date(snapshot.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error(`The invitation ${snapshot.id} is corrupted`);
    return new Invitation(new Id(snapshot.id), new Id(snapshot.groupId), new Id(snapshot.invitedBy), createdAt);
  }

  toSnapshot(): InvitationSnapshot {
    return {
      id: this._id.value,
      groupId: this.groupId.value,
      invitedBy: this.invitedBy.value,
      createdAt: this.createdAt.toISOString(),
    };
  }
}

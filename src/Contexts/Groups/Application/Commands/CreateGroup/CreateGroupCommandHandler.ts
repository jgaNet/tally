import { IResult, Result } from '@Architecture/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { CreateGroupCommandEvent } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandEvent';

/**
 * Creating a group: a signed-in person asks for it, and becomes its owner and its first member. The name and the
 * currency are decided by their value objects; the group is saved and what it recorded is published with the
 * save, in one transaction. Its answer is the new group's id. The clock is the application's, passed by the wiring.
 */
export class CreateGroupCommandHandler extends CommandHandler<CreateGroupCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: CreateGroupCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return Result.fail(caller.error);

    const founded = Group.found({
      name: event.payload.name,
      currency: event.payload.currency,
      ownerId: caller.data.value,
      createdAt: this.clock(),
    });
    if (founded.isFailure()) return Result.fail(founded.error);
    const group = founded.data;

    const saved = await this.groups.save(group);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(group, context);
    return Result.ok(group._id.value);
  }
}

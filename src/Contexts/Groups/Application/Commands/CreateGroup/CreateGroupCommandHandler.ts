import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';

import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { CreateGroupCommandEvent } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandEvent';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

/**
 * A signed-in person creates a group: they own it and are its first member. The operation answers the id of the group,
 * born with it. Nobody else may ask: a group is made by one of its own.
 */
export class CreateGroupCommandHandler extends CommandHandler<CreateGroupCommandEvent> {
  constructor(
    private groups: IGroupRepository,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: CreateGroupCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Groups');
    if (caller.isFailure()) return caller;
    const name = GroupName.create(payload.name);
    if (name.isFailure()) return name;
    const currency = Currency.create(payload.currency);
    if (currency.isFailure()) return currency;

    const group = Group.create({ name: name.data, currency: currency.data, ownerId: caller.data, now: this.clock() });
    const saved = await this.groups.save(group);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(group, context);
    return Result.ok(group._id.value);
  }
}

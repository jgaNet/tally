import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { Group } from '@Contexts/Groups/Domain/Group/Group';
import { Currency } from '@Contexts/Groups/Domain/Group/Currency';
import { GroupName } from '@Contexts/Groups/Domain/Group/GroupName';
import { IGroupRepository } from '@Contexts/Groups/Domain/Group/Ports/IGroupRepository';
import { CreateGroupCommandEvent } from '@Contexts/Groups/Application/Commands/CreateGroup/CreateGroupCommandEvent';

/**
 * A signed-in person creates a group in a currency fixed for good; they own it and are its first member. The result
 * is the new group's id.
 */
export class CreateGroupCommandHandler extends CommandHandler<CreateGroupCommandEvent> {
  constructor(
    private readonly groups: IGroupRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: CreateGroupCommandEvent, context: ExecutionContext): Promise<IResult<{ id: string }>> {
    const owner = requireSignedIn(context, 'Groups');
    if (owner.isFailure()) return owner;
    const name = GroupName.create(payload.name);
    if (name.isFailure()) return name;
    const currency = Currency.create(payload.currency);
    if (currency.isFailure()) return currency;

    const group = Group.create({ name: name.data, currency: currency.data, ownerId: owner.data, at: this.clock() });
    const saved = await this.groups.save(group);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(group, context);
    return Result.ok({ id: group._id.value });
  }
}

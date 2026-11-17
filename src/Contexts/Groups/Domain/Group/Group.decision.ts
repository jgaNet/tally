import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { Currency } from './Currency';
import { Group } from './Group';
import { GroupName } from './GroupName';

/** What a creation says: the name and the currency as typed, and the account creating the group, its owner. */
export interface CreateGroupCommand {
  name: string;
  currency: string;
  ownerId: string;
}

/**
 * Group creation, as the storm decided it: a name of 1 to 60 characters that is not only spaces, and one of the six
 * currencies, fixed here for good. Nothing is given: the group is new, so it has no state to read yet.
 */
export const decideCreateGroup: Decision<Group, CreateGroupCommand, never, undefined> = (_given, command, now) => {
  const name = GroupName.create(command.name);
  if (name.isFailure()) return name;
  const currency = Currency.create(command.currency);
  if (currency.isFailure()) return currency;
  return decided(Group.create({ name: name.data, currency: currency.data, ownerId: command.ownerId, at: now }));
};

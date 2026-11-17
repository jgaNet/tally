import { Decision, decided } from '@Architecture/Domain/Lite/Decision';

import { Currency } from './Currency';
import { GroupName } from './GroupName';

/** What a creation says: the name and the currency as typed. */
export interface CreateGroupCommand {
  name: string;
  currency: string;
}

/** The values a new group is made of, once they are allowed. */
export interface NewGroupValues {
  name: GroupName;
  currency: Currency;
}

/**
 * Group creation, as the storm decided it: a name of 1 to 60 characters that is not only spaces, and one of the six
 * currencies, fixed for good. It answers the validated values; the use case makes the group from them with
 * `Group.register`, which records `GroupCreated` (ADR 3 says why the group is not made here).
 */
export const decideCreateGroup: Decision<NewGroupValues, CreateGroupCommand, never, undefined> = (_given, command) => {
  const name = GroupName.create(command.name);
  if (name.isFailure()) return name;
  const currency = Currency.create(command.currency);
  if (currency.isFailure()) return currency;
  return decided({ name: name.data, currency: currency.data });
};

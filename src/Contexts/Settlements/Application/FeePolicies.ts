import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';

/** What the owner gives to decide who bears the provider's fee in a group: the group, and the bearer, `payer`, `payee` or `shared` (request 38). */
export interface SetFeePolicyInput {
  groupId: string;
  borneBy: string;
}

/**
 * Decides who bears the provider's fee in the group (request 38, docs/adr/0037): the owner alone may, and any other member is refused
 * (`403`); an archived group changes nothing. Only settlements asked for from now on take the decision: each one keeps the fee it was
 * asked with. A group the caller is not a member of does not exist for it (`404`). Answers `204`: there is nothing to say back.
 */
export const setFeePolicy = command(
  'SetFeePolicy',
  (books: ISettlementBooks, members: ISettlementMembers) =>
    async ({ groupId, borneBy }: SetFeePolicyInput, context) => {
      const by = callerOf(context);
      const group = await members.groupOf(by, groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such group'));

      const book = await books.get(groupId);
      const decided = book.setFeePolicy({ by, ownerId: group.ownerId, borneBy, archived: group.archived });
      if (decided.isFailure()) return decided;

      const saved = await books.save(book);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
);

/**
 * Reads who bears the provider's fee in the group (request 38): any current member of the group reads it, and anyone else does not see the
 * group (`404`). The payee bears it until the owner decides.
 */
export const getFeePolicy = query(
  'GetFeePolicy',
  (settlements: ISettlementQueries, members: ISettlementMembers) =>
    async ({ groupId }: { groupId: string }, context) => {
      const group = await members.groupOf(callerOf(context), groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such group'));
      return Result.ok({ borneBy: await settlements.feePolicyOf(groupId) });
    },
);

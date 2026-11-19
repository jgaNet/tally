import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { NettingView } from '@Contexts/Settlements/Domain/Netting/DTOs';
import { NetDebts, SharedGroupDebts } from '@Contexts/Settlements/Domain/Netting/NetDebts';
import { INettings } from '@Contexts/Settlements/Domain/Netting/Ports/INettings';
import { INettingQueries } from '@Contexts/Settlements/Domain/Netting/Ports/INettingQueries';
import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Suggestion/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';

/** What a member gives to net with another: the other member (`with`, an account id) and the currency (request 32). */
export interface NetDebtsInput {
  with: string;
  currency: string;
}

/**
 * Nets what the caller and `with` owe each other across the groups both are members of now, in the currency, that are not archived
 * (request 32, docs/adr/0032). The domain service decides the amount and the settlements from the books and the balances read here;
 * the books are read before the balances, as the cash settlement's are, and every shared book is stored at the version it was read at:
 * a settlement recorded in between makes the save refuse, and the command decides again on what the other left (CONC-OPTIMISTIC,
 * three attempts). Stored together, the books and the netting make all its settlements or none. Its id is the answer.
 */
export const netDebts = command(
  'NetDebts',
  (books: ISettlementBooks, balances: IGroupBalances, members: ISettlementMembers, nettings: INettings, clock: Clock) =>
    async ({ with: other, currency }: NetDebtsInput, context) => {
      const by = callerOf(context);
      const groups: SharedGroupDebts[] = [];
      for (const group of await members.sharedGroupsOf(by, other, currency)) {
        groups.push({
          groupId: group.groupId,
          book: await books.get(group.groupId),
          currency: group.currency,
          archived: group.archived,
          members: group.members.map(member => member.memberId),
          balances: await balances.balancesOf(group.groupId),
        });
      }

      const suspended = await members.isSuspended(by);
      const withDeleted = await members.isDeleted(other);
      const decided = NetDebts.decide({ by, with: other, currency, groups, suspended, withDeleted, at: clock() });
      if (decided.isFailure()) return decided;

      for (const group of groups) {
        const saved = await books.save(group.book);
        if (saved.isFailure()) return saved;
      }
      await nettings.save(decided.data);
      for (const group of groups) await publishDomainEvents(group.book, context);
      await publishDomainEvents(decided.data, context);
      return Result.ok(decided.data.id);
    },
);

/**
 * Reads a netting for the two members it is between, who read it: for anyone else it does not exist (request 32). Its settlements are
 * listed in the order they were made.
 */
export const getNetting = query(
  'GetNetting',
  (nettings: INettingQueries) =>
    async ({ id }: { id: string }, context) => {
      const netting: NettingView | undefined = await nettings.findNetting(id);
      const caller = callerOf(context);
      if (!netting || (netting.by !== caller && netting.with !== caller)) {
        return Result.fail(new NotFoundException('Settlements', 'There is no such netting'));
      }
      return Result.ok(netting);
    },
);

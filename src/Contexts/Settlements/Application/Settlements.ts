import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { SettlementView } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Suggestion/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';

/** What a member gives to record a cash settlement: the group, the payer (`from`, an account id) and the amount (request 12). */
export interface RecordCashSettlementInput {
  groupId: string;
  from: string;
  amount: number;
}

/**
 * Records a settlement paid in cash by the caller to the member who is `from` (request 12, docs/adr/0013). The caller is its
 * payee and must be a member of the group: for anyone else the group does not exist. The book is read before the balances, as
 * the Ledger's balances are: a settlement recorded in between moves the book's version, so the save refuses this one and the
 * command decides again on the balances the other left (CONC-OPTIMISTIC). Its id is the answer.
 */
export const recordCashSettlement = command(
  'RecordCashSettlement',
  (books: ISettlementBooks, balances: IGroupBalances, members: ISettlementMembers, clock: Clock) =>
    async ({ groupId, from, amount }: RecordCashSettlementInput, context) => {
      const by = callerOf(context);
      const group = await members.groupOf(by, groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such group'));

      const book = await books.get(groupId);
      const owed = await balances.balancesOf(groupId);
      const balanceOf = (memberId: string) => owed.find(balance => balance.memberId === memberId)?.balance ?? 0;

      const recorded = book.recordCash({
        by,
        from,
        amount,
        members: group.members.map(member => member.memberId),
        balances: { payer: balanceOf(from), payee: balanceOf(by) },
        at: clock(),
      });
      if (recorded.isFailure()) return recorded;

      const saved = await books.save(book);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(book, context);
      return Result.ok(recorded.data.id);
    },
);

/** Reads a settlement, for the members of its group only: for anyone else it does not exist (requests 12, 13). */
export const getSettlement = query(
  'GetSettlement',
  (settlements: ISettlementQueries, members: ISettlementMembers) =>
    async ({ id }: { id: string }, context) => {
      const settlement: SettlementView | undefined = await settlements.findSettlement(id);
      if (!settlement) return Result.fail(new NotFoundException('Settlements', 'There is no such settlement'));
      const group = await members.groupOf(callerOf(context), settlement.groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such settlement'));
      return Result.ok(settlement);
    },
);

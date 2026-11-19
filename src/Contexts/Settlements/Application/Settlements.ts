import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotFoundException, Result } from '@Architecture/Domain';

import { SettlementWithHistory } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { OriginalPaymentInput } from '@Contexts/Settlements/Domain/Settlement/OriginalPayment';
import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Suggestion/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';
import { ISettlementRates } from '@Contexts/Settlements/Application/Ports/ISettlementRates';
import { offeredRateOf } from '@Contexts/Settlements/Application/OfferedRateOf';

/**
 * What a member gives to record a cash settlement: the group, the payer (`from`, an account id) and either its `amount` in the group's currency
 * (request 12) or its `original`, what is paid in another currency (request 39): exactly one of the two.
 */
export interface RecordCashSettlementInput {
  groupId: string;
  from: string;
  amount?: number;
  original?: OriginalPaymentInput;
}

/**
 * Records a settlement paid in cash by the caller to the member who is `from` (request 12, docs/adr/0013). The caller is its
 * payee and must be a member of the group: for anyone else the group does not exist. The book is read before the balances, as
 * the Ledger's balances are: a settlement recorded in between moves the book's version, so the save refuses this one and the
 * command decides again on the balances the other left (CONC-OPTIMISTIC). A settlement in another currency takes the rate the rates
 * service offers on the day it is decided, in UTC, and keeps it; with none it is refused and nothing is kept (request 39). Its id is the answer.
 */
export const recordCashSettlement = command(
  'RecordCashSettlement',
  (
    books: ISettlementBooks,
    balances: IGroupBalances,
    members: ISettlementMembers,
    rates: ISettlementRates,
    clock: Clock,
  ) =>
    async ({ groupId, from, amount, original }: RecordCashSettlementInput, context) => {
      const by = callerOf(context);
      const group = await members.groupOf(by, groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such group'));
      const suspended = await members.isSuspended(by);

      const book = await books.get(groupId);
      const owed = await balances.balancesOf(groupId);
      const balanceOf = (memberId: string) => owed.find(balance => balance.memberId === memberId)?.balance ?? 0;

      const at = clock();
      const recorded = book.recordCash({
        by,
        from,
        amount,
        original,
        groupCurrency: group.currency,
        offered: await offeredRateOf({ rates, original, groupCurrency: group.currency, at }),
        members: group.members.map(member => member.memberId),
        balances: { payer: balanceOf(from), payee: balanceOf(by) },
        archived: group.archived,
        suspended,
        at,
      });
      if (recorded.isFailure()) return recorded;

      const saved = await books.save(book);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(book, context);
      return Result.ok(recorded.data.id);
    },
);

/** Reads a settlement, with every status it has had, for the members of its group only: for anyone else it does not exist (requests 12, 13, 19). */
export const getSettlement = query(
  'GetSettlement',
  (settlements: ISettlementQueries, members: ISettlementMembers) =>
    async ({ id }: { id: string }, context) => {
      const settlement: SettlementWithHistory | undefined = await settlements.findSettlement(id);
      if (!settlement) return Result.fail(new NotFoundException('Settlements', 'There is no such settlement'));
      const group = await members.groupOf(callerOf(context), settlement.groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such settlement'));
      return Result.ok(settlement);
    },
);

/**
 * Lists the settlements of a group, the most recently recorded first, each as `GetSettlement` reads it (request 19). Only the group's
 * current members see them; for anyone else, a member who has left included, the group does not exist. The settlements of a member who
 * has left stay the group's, and stay listed for the members who remain.
 */
export const getGroupSettlements = query(
  'GetGroupSettlements',
  (settlements: ISettlementQueries, members: ISettlementMembers) =>
    async ({ groupId }: { groupId: string }, context) => {
      const group = await members.groupOf(callerOf(context), groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such group'));
      return Result.ok(await settlements.listSettlementsOf(groupId));
    },
);

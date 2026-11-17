import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { suggestTransfers, SuggestedTransfer } from '@Contexts/Settlements/Domain/Suggestion/SuggestedTransfers';
import { ISettlementQueries, SettlementView } from '@Contexts/Settlements/Domain/ISettlementQueries';
import { decideRecordCashSettlement } from '@Contexts/Settlements/Domain/SettlementBook/SettlementBook.decision';

import { IGroupBalances } from './IGroupBalances';
import { ISettlementBooks } from './ISettlementBooks';
import { ISettlementMembers } from './ISettlementMembers';

/**
 * A member of a group reads the transfers that would bring every balance of the group to 0 (request 11), made by the stated
 * algorithm, in the order they are made. Reading them changes nothing and records nothing: the balances are what the
 * expenses and the settlements make them. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const getSuggestedSettlements = query(
  'GetSuggestedSettlements',
  (groupBalances: IGroupBalances, members: ISettlementMembers) =>
    async ({ id }: { id: string }, context) => {
      const memberIds = await members.membersOf(id, callerOf(context));
      if (!memberIds) return Result.fail(new NotFoundException('Settlements', 'No group is found'));
      const balances = await groupBalances.balancesOf(id);
      const transfers: SuggestedTransfer[] = suggestTransfers(
        memberIds.map(memberId => ({ memberId, balance: balances.get(memberId) ?? 0 })),
      );
      return Result.ok(transfers);
    },
);

/** What a member records: the group, the payer (its account id), and the amount paid in cash to the caller. */
export interface RecordCashSettlementInput {
  groupId: string;
  from: string;
  amount: number;
}

/**
 * A member of a group records a payment in cash they received from another member of the group (request 12): the caller is the
 * payee, the payer is `from`. It is decided in the group's settlement book on the balances as they are now, which count every
 * settlement already recorded, and refused if it is more than the payer owes or the payee is owed (ADR 11). Two recorded at once
 * are decided one after the other: the second is re-read and decided again by the book's version check. Answers the new
 * settlement's id. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const recordCashSettlement = command(
  'RecordCashSettlement',
  (books: ISettlementBooks, groupBalances: IGroupBalances, members: ISettlementMembers, clock: Clock) =>
    async ({ groupId, from, amount }: RecordCashSettlementInput, context) => {
      const payee = callerOf(context);
      const memberIds = await members.membersOf(groupId, payee);
      if (!memberIds) return Result.fail(new NotFoundException('Settlements', 'No group is found'));

      // The book is read before the balances: a settlement recorded after this read moves the version, so the save refuses this
      // decision and the retry reads the balances again; a settlement recorded before it is in the balances read below.
      const book = await books.bookOf(groupId);
      const balances = await groupBalances.balancesOf(groupId);
      const now = clock();
      const decision = decideRecordCashSettlement({ memberIds, balances }, { payee, from, amount }, now);
      if (decision.isFailure()) return decision;

      const settlementId = book.recordCash({ ...decision.data.state, at: now });
      await books.save(book);
      await publishDomainEvents(book, context);
      return Result.ok(settlementId);
    },
);

/** A member of the settlement's group reads it; anyone else, or nobody, gets the answer for a settlement that does not exist. */
export const getSettlement = query(
  'GetSettlement',
  (settlements: ISettlementQueries, members: ISettlementMembers) =>
    async ({ id }: { id: string }, context) => {
      const settlement: SettlementView | undefined = await settlements.settlementOf(id);
      if (!settlement) return Result.fail(new NotFoundException('Settlements', 'No settlement is found'));
      if (!(await members.membersOf(settlement.groupId, callerOf(context)))) {
        return Result.fail(new NotFoundException('Settlements', 'No settlement is found'));
      }
      return Result.ok(settlement);
    },
);

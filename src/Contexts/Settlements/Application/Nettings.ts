import { NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/ISettlementQueries';
import { SettlementBook } from '@Contexts/Settlements/Domain/SettlementBook/SettlementBook';
import { decideNetDebts } from '@Contexts/Settlements/Domain/Netting/Netting.decision';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';

import { IGroupBalances } from './IGroupBalances';
import { INettings } from './INettings';
import { ISettlementBooks } from './ISettlementBooks';
import { ISettlementMembers } from './ISettlementMembers';

/** What a netting asks: the other member's account id, and the currency it is netted in (request 32). */
export interface NetDebtsInput {
  with: string;
  currency: string;
}

/**
 * A signed-in person nets what they and another member owe each other in one currency, across every group they both are members of now, in
 * that currency, that is not archived (request 32, ADR 30). Every group's book is read first, with the balances it counts, and every book read
 * is saved after the settlements are recorded: each is checked at the version it was read at, so a settlement recorded in any of those groups
 * since moves a version and the netting is decided again on what is left, all or nothing (CONC-OPTIMISTIC). The settlements are recorded in the
 * books, paid at once and counted at once, and the netting is saved in the same transaction. A netting that nets nothing is refused and nothing
 * changes. Answers the netting's id.
 */
export const netDebts = command(
  'NetDebts',
  (
    books: ISettlementBooks,
    groupBalances: IGroupBalances,
    members: ISettlementMembers,
    nettings: INettings,
    clock: Clock,
  ) =>
    async ({ with: other, currency }: NetDebtsInput, context) => {
      return books.inTransaction(async () => {
        const by = callerOf(context);
        const read: {
          groupId: string;
          book: SettlementBook;
          currency: string;
          archived: boolean;
          balances: ReadonlyMap<string, number>;
        }[] = [];
        for (const group of await members.sharedGroupsOf(by, other)) {
          // The book is read before the balances, as every settlement is decided: a settlement recorded after this read moves the version.
          const book = await books.bookOf(group.groupId);
          const balances = book.stillOwed(await groupBalances.balancesOf(group.groupId));
          read.push({ groupId: group.groupId, book, currency: group.currency, archived: group.archived, balances });
        }

        const now = clock();
        const decision = decideNetDebts(
          {
            groups: read.map(({ groupId, currency: groupCurrency, archived, balances }) => ({
              groupId,
              currency: groupCurrency,
              archived,
              balances,
            })),
          },
          { by, with: other, currency },
          now,
        );
        if (decision.isFailure()) return decision;

        const booksByGroup = new Map(read.map(({ groupId, book }) => [groupId, book]));
        const settlements: string[] = [];
        for (const transfer of decision.data.state.transfers) {
          const book = booksByGroup.get(transfer.groupId);
          if (!book) throw new Error(`The netting made a settlement in ${transfer.groupId}, which it did not read`);
          settlements.push(book.recordNet({ from: transfer.from, to: transfer.to, amount: transfer.amount, at: now }));
        }

        for (const { book } of read) {
          await books.save(book);
          await publishDomainEvents(book, context);
        }
        const { amount } = decision.data.state;
        const netting = Netting.register({ by, with: other, currency, amount, settlements });
        await nettings.save(netting);
        await publishDomainEvents(netting, context);
        return Result.ok(netting.nettingId);
      });
    },
);

/**
 * A netting is read by the two people it is between, who asked and with whom: who asked, with whom, its currency, the amount netted, and its
 * settlements in the order they were made (request 32). Anyone else, or nobody, gets the answer for a netting that does not exist.
 */
export const getNetting = query(
  'GetNetting',
  (queries: ISettlementQueries) =>
    async ({ id }: { id: string }, context) => {
      const netting = await queries.nettingOf(id);
      const reader = callerOf(context);
      if (!netting || (netting.by !== reader && netting.with !== reader)) {
        return Result.fail(new NotFoundException('Settlements', 'No netting is found'));
      }
      return Result.ok(netting);
    },
);

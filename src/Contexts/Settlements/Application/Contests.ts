import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { NotAllowedException, NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';

import { SettlementWithHistory } from '@Contexts/Settlements/Domain/Settlement/DTOs';
import { ISettlementBooks } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBooks';
import { ISettlementQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementQueries';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Suggestion/Ports/ISettlementMembers';

/**
 * The payee contests a paid settlement through the provider: the money did not reach them (request 33, docs/adr/0033). The caller must be
 * a member of the group (for anyone else it does not exist); the book decides the rest: only its payee, once, while it is paid and both its
 * members are in the group, and the group not archived. Nothing is paid or refunded at the provider: the settlement waits for an
 * administrator.
 */
export const contestSettlement = command(
  'ContestSettlement',
  (books: ISettlementBooks, members: ISettlementMembers, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      const by = callerOf(context);
      const book = await books.ofSettlement(id);
      if (!book) return Result.fail(new NotFoundException('Settlements', 'There is no such settlement'));
      const group = await members.groupOf(by, book.groupId);
      if (!group) return Result.fail(new NotFoundException('Settlements', 'There is no such settlement'));

      const contested = book.contest({
        by,
        settlementId: id,
        members: group.members.map(member => member.memberId),
        archived: group.archived,
        at: clock(),
      });
      if (contested.isFailure()) return contested;

      const saved = await books.save(book);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
);

/** What an administrator decides about a contested settlement: its id, and whether the money arrived (`paid`). */
export interface DecideContestInput {
  id: string;
  paid: boolean;
}

/**
 * An administrator decides a contested settlement (request 33, docs/adr/0033): paid, if the money arrived, or annulled, if it did not. Only
 * an administrator may (`NotAllowed` for anyone else, signed in); it is decided once, and the decision is in the administrators' log. The
 * book reads the settlement inside the transaction, so a decision made twice at once is refused by the second.
 */
export const decideContest = command(
  'DecideContest',
  (books: ISettlementBooks, clock: Clock) =>
    async ({ id, paid }: DecideContestInput, context) => {
      // Only an administrator decides: the role the sign-in gave the caller (docs/adr/0033). Anyone else is refused, signed in or not.
      if (context.auth.role !== Role.ADMIN) {
        return Result.fail(
          new NotAllowedException('Settlements', 'Only an administrator decides a contested settlement'),
        );
      }
      const book = await books.ofSettlement(id);
      if (!book) return Result.fail(new NotFoundException('Settlements', 'There is no such settlement'));

      const decided = book.decideContest({ by: callerOf(context), settlementId: id, paid, at: clock() });
      if (decided.isFailure()) return decided;

      const saved = await books.save(book);
      if (saved.isFailure()) return saved;
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
);

/**
 * Lists the settlements contested now, the earliest contested first, each as `GetSettlement` reads it (request 33). Only an administrator
 * lists them: for anyone else the list does not exist.
 */
export const getContests = query('GetContests', (settlements: ISettlementQueries) => async (_input: void, context) => {
  // For anyone who is not an administrator the list does not exist (docs/adr/0033).
  if (context.auth.role !== Role.ADMIN)
    return Result.fail(new NotFoundException('Settlements', 'There is no such list'));
  const contested: SettlementWithHistory[] = await settlements.contestedSettlements();
  return Result.ok(contested);
});

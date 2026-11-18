import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';
import { INettingStore, NettingView } from '@Contexts/Settlements/Application/INettingStore';
import { ISettlementAuditLog } from '@Contexts/Settlements/Application/ISettlementAuditLog';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';
import { ISettlementStore } from '@Contexts/Settlements/Application/ISettlementStore';
import { openBook } from '@Contexts/Settlements/Application/OpenBook';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';
import { NettingGroup, planNetting } from '@Contexts/Settlements/Domain/Netting/NetDebts';
import {
  NettingNotFoundException,
  NettingWithOneselfException,
  NothingToNetException,
} from '@Contexts/Settlements/Domain/Netting/NettingExceptions';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { Settlement } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import { settlementAuditId } from '@Contexts/Settlements/Domain/Settlement/SettlementAudit';

/** A netting as the request carries it: the other member, and the currency the debts are netted in; the caller is the other side. */
export interface NetDebtsInput {
  readonly with: string;
  readonly currency: string;
}

/**
 * Nets what the caller and another member owe each other in one currency, across every group they are both members of now, that is in
 * that currency and not archived (feature 32, request 32, the storm's `NetDebts`). The groups are read in the order they were made, each
 * with its book as it stands; the planner decides the amount and the settlements (`planNetting`); each settlement is recorded in its
 * group's book, which refuses anything more than is still owed, and each book is saved at its version in this command's transaction. The
 * settlements count at once: each is paid, by `net`, and audited as paid by the caller. The netting is kept with them. Nothing to net is
 * refused (`NothingToNet`) and nothing changes; a second netting decided at the same moment meets the books the first one wrote, and is
 * decided again on them (CONC-OPTIMISTIC), so it finds nothing left to net. Answers the netting's id.
 */
export const netDebts = command(
  'NetDebts',
  (
    store: ISettlementStore,
    nettings: INettingStore,
    members: ISettlementMembers,
    balances: IGroupBalances,
    audit: ISettlementAuditLog,
    clock: Clock,
  ) =>
    async ({ with: otherId, currency }: NetDebtsInput, context): Promise<IResult<string>> => {
      const by = callerOf(context);
      if (otherId === by) return Result.fail(new NettingWithOneselfException());

      const groups: NettingGroup[] = [];
      for (const shared of await members.groupsShared(by, otherId)) {
        if (shared.currency !== currency) continue;
        const book = await openBook(store, members, balances, shared.groupId);
        if (book) groups.push({ groupId: shared.groupId, book, archived: shared.archived });
      }
      const plan = planNetting(by, otherId, groups);
      if (!plan) return Result.fail(new NothingToNetException());

      const now = clock();
      const bookOf = new Map<string, SettlementBook>(groups.map(group => [group.groupId, group.book]));
      const settled: { book: SettlementBook; settlement: Settlement }[] = [];
      for (const payment of plan.payments) {
        const book = bookOf.get(payment.groupId);
        if (!book) return Result.fail(new NothingToNetException());
        const recorded = book.recordNet(payment, now);
        if (recorded.isFailure()) return Result.fail(recorded.error);
        settled.push({ book, settlement: recorded.data });
      }

      const netting = Netting.make({
        by,
        with: otherId,
        currency,
        amount: plan.amount,
        settlementIds: settled.map(({ settlement }) => settlement.id),
        at: now,
      });
      if (netting.isFailure()) return Result.fail(netting.error);

      for (const { book, settlement } of settled) {
        await store.save(book, settlement, settlement.at);
        // A net settlement counts from the moment it is recorded, and the caller made it (request 28).
        await audit.record({
          id: settlementAuditId.paid(settlement.id),
          groupId: settlement.groupId,
          at: settlement.at,
          by,
          action: 'settlement-paid',
          subjectId: settlement.id,
          amount: settlement.amount,
        });
      }
      await nettings.save(netting.data);
      for (const book of new Set(settled.map(({ book }) => book))) await publishDomainEvents(book, context);
      await publishDomainEvents(netting.data, context);
      return Result.ok(netting.data.id);
    },
);

/**
 * A netting as one of the two people reads it (request 32, the storm's `GetNetting`): who asked, with whom, its currency, the amount netted
 * and its settlements, in the order they were made. To anyone else it does not exist: the same `404` for one that does not exist and one
 * between two other members.
 */
export const getNetting = query(
  'GetNetting',
  (nettings: INettingStore) =>
    async (nettingId: string, context): Promise<IResult<NettingView>> => {
      const view = await nettings.viewOf(nettingId);
      const me = callerOf(context);
      if (!view || (view.by !== me && view.with !== me)) return Result.fail(new NettingNotFoundException());
      return Result.ok(view);
    },
);

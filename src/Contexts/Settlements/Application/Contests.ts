import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { IAdministratorLog } from '@Contexts/Settlements/Application/IAdministratorLog';
import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';
import { ISettlementAuditLog } from '@Contexts/Settlements/Application/ISettlementAuditLog';
import { ISettlementStore, SettlementView } from '@Contexts/Settlements/Application/ISettlementStore';
import { openBook } from '@Contexts/Settlements/Application/OpenBook';
import { administratorDecisionId } from '@Contexts/Settlements/Domain/Settlement/AdministratorLog';
import { settlementAuditId } from '@Contexts/Settlements/Domain/Settlement/SettlementAudit';
import { settledAmountOf } from '@Contexts/Settlements/Domain/Settlement/Settlement';
import {
  ContestsNotFoundException,
  NotAnAdministratorException,
  SettlementNotFoundException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { Role } from '@SharedKernel/Domain';

/** An administrator's decision as the request carries it: the settlement, and whether the money arrived (`paid`). */
export interface DecideContestInput {
  readonly settlementId: string;
  readonly paid: boolean;
}

/**
 * The payee of a settlement paid through the provider contests it (request 33, the storm's `ContestSettlement`): the caller is the payee,
 * and must be a member of the group, else the settlement's `404`; the payee only (`403` to any other member). The book decides it (the
 * settlement is `contested`, held until an administrator decides), in the transaction that saves it with its history line, and its audit
 * entry `settlement-contested`, by the payee, with its amount. A refusal changes nothing.
 */
export const contestSettlement = command(
  'ContestSettlement',
  (
    store: ISettlementStore,
    members: ISettlementMembers,
    balances: IGroupBalances,
    audit: ISettlementAuditLog,
    clock: Clock,
  ) =>
    async (settlementId: string, context): Promise<IResult<void>> => {
      const payeeId = callerOf(context);
      const settlement = await store.settlementOf(settlementId);
      if (!settlement) return Result.fail(new SettlementNotFoundException());
      const book = await openBook(store, members, balances, settlement.groupId);
      if (!book || !book.hasMember(payeeId)) return Result.fail(new SettlementNotFoundException());

      const archived = await members.isArchived(settlement.groupId);
      const now = clock();
      const contested = book.contest(settlement, payeeId, archived, now);
      if (contested.isFailure()) return Result.fail(contested.error);

      await store.save(book, contested.data, now.toISOString());
      await audit.record({
        id: settlementAuditId.contested(settlement.id),
        groupId: settlement.groupId,
        at: now.toISOString(),
        by: payeeId,
        action: 'settlement-contested',
        subjectId: settlement.id,
        amount: settledAmountOf(settlement),
      });
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
);

/**
 * An administrator decides a contested settlement (request 33, the storm's `DecideContest`): the money arrived (`paid`: the settlement is paid
 * again, and the balances count it as before, with its audit entry `settlement-paid` by the administrator) or it did not (`annulled`: nothing
 * counts it, and what was owed is owed again). Only an administrator decides (`403` to anyone else), and only a contested settlement, once
 * (`422`). The decision is written in the administrators' log in the same transaction, so every decision has its entry, oldest first.
 */
export const decideContest = command(
  'DecideContest',
  (
    store: ISettlementStore,
    members: ISettlementMembers,
    balances: IGroupBalances,
    log: IAdministratorLog,
    audit: ISettlementAuditLog,
    clock: Clock,
  ) =>
    async ({ settlementId, paid }: DecideContestInput, context): Promise<IResult<void>> => {
      if (context.auth.role !== Role.ADMIN) return Result.fail(new NotAnAdministratorException());
      const settlement = await store.settlementOf(settlementId);
      if (!settlement) return Result.fail(new SettlementNotFoundException());
      const book = await openBook(store, members, balances, settlement.groupId);
      if (!book) return Result.fail(new SettlementNotFoundException());

      const decided = book.decideContest(settlement, paid);
      if (decided.isFailure()) return Result.fail(decided.error);

      const now = clock().toISOString();
      const by = callerOf(context);
      await store.save(book, decided.data, now);
      await log.record({
        id: administratorDecisionId.of(settlement.id),
        at: now,
        by,
        action: paid ? 'decided-paid' : 'decided-annulled',
        subjectId: settlement.id,
      });
      if (paid) {
        await audit.record({
          id: settlementAuditId.decidedPaid(settlement.id),
          groupId: settlement.groupId,
          at: now,
          by,
          action: 'settlement-paid',
          subjectId: settlement.id,
          amount: settledAmountOf(settlement),
        });
      }
      await publishDomainEvents(book, context);
      return Result.ok(undefined);
    },
);

/**
 * The settlements contested now, the earliest contested first (request 33, the storm's `GetContests`), each as `GetSettlement` reads it. Only an
 * administrator reads them: to anyone else they do not exist, the `404`.
 */
export const getContests = query(
  'GetContests',
  (store: ISettlementStore) =>
    async (_input: undefined, context): Promise<IResult<SettlementView[]>> => {
      if (context.auth.role !== Role.ADMIN) return Result.fail(new ContestsNotFoundException());
      return Result.ok(await store.viewsContested());
    },
);

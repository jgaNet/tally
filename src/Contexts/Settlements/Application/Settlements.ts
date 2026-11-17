import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';

import { IGroupBalances } from '@Contexts/Settlements/Application/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Application/ISettlementMembers';
import { ISettlementStore, SettlementView } from '@Contexts/Settlements/Application/ISettlementStore';
import {
  GroupNotFoundException,
  SettlementNotFoundException,
} from '@Contexts/Settlements/Domain/Settlement/SettlementExceptions';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/** A cash settlement as the request carries it: the group it is in, the payer's account, and the amount; the payee is the caller. */
export interface RecordCashSettlementInput {
  readonly groupId: string;
  readonly from: string;
  readonly amount: number;
}

/**
 * Records a settlement in cash, decided by its payee (request 12, the storm's `RecordCashSettlement`). The caller is the payee,
 * and must be a member of the group, else the group's `404`. The book of the group is opened as it stands: its version, the members
 * in the order they joined, and the balances the ledger counts, settlements included. The book decides and records it; the store
 * saves the settlement and the book's next version in the transaction, and a second settlement decided at the same moment meets
 * the version check and is decided again on the first one's balances (ADR 10). Answers the new settlement's id.
 */
export const recordCashSettlement = command(
  'RecordCashSettlement',
  (store: ISettlementStore, members: ISettlementMembers, balances: IGroupBalances, clock: Clock) =>
    async ({ groupId, from, amount }: RecordCashSettlementInput, context): Promise<IResult<string>> => {
      const payeeId = callerOf(context);
      const memberIds = await members.membersOf(groupId);
      if (!memberIds || !memberIds.includes(payeeId)) return Result.fail(new GroupNotFoundException());

      const version = await store.versionOf(groupId);
      const counted = new Map((await balances.balancesOf(groupId)).map(row => [row.memberId, row.balance]));
      const book = SettlementBook.open({
        groupId,
        version,
        members: memberIds,
        balances: memberIds.map(memberId => ({ memberId, balance: counted.get(memberId) ?? 0 })),
      });

      const recorded = book.recordCash({ from, to: payeeId, amount }, clock());
      if (recorded.isFailure()) return Result.fail(recorded.error);

      await store.save(book, recorded.data);
      await publishDomainEvents(book, context);
      return Result.ok(recorded.data.id);
    },
);

/**
 * A settlement as a member of its group reads it: its group, payer, payee, amount, how it was paid, its status and when it was
 * recorded. To anyone else it does not exist: the same `404` for a settlement that does not exist and one of a group the caller
 * is not in.
 */
export const getSettlement = query(
  'GetSettlement',
  (store: ISettlementStore, members: ISettlementMembers) =>
    async (settlementId: string, context): Promise<IResult<SettlementView>> => {
      const view = await store.viewOf(settlementId);
      if (!view) return Result.fail(new SettlementNotFoundException());

      const memberIds = await members.membersOf(view.groupId);
      if (!memberIds || !memberIds.includes(callerOf(context))) return Result.fail(new SettlementNotFoundException());
      return Result.ok(view);
    },
);

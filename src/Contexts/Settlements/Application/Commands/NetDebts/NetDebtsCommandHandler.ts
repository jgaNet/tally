import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { NetDebtsCommandEvent } from '@Contexts/Settlements/Application/Commands/NetDebts/NetDebtsCommandEvent';
import { IGroupBalances } from '@Contexts/Settlements/Application/Ports/IGroupBalances';
import { ISettlementAuditLog } from '@Contexts/Settlements/Application/Ports/ISettlementAuditLog';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { INettingRepository } from '@Contexts/Settlements/Domain/Netting/Ports/INettingRepository';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';
import { NetDebts, SharedGroup } from '@Contexts/Settlements/Domain/Netting/NetDebts';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * A signed-in member nets what they and `with` owe each other, across the groups they share now, in the currency, not archived
 * (request 32). The groups are read in the order they were created; each book's balances are read in this transaction, and the
 * netting is decided on them (NetDebts). Then every book records its settlements, each paid at once and audited as paid by the caller,
 * and every book is saved at its version, with the netting, in this one transaction: all of the nettings' settlements are stored, or
 * none. A conflict on any book re-reads and re-decides the whole netting (CONC-OPTIMISTIC), so no settlement pays more than is still
 * owed. The operation answers the netting's id.
 */
export class NetDebtsCommandHandler extends CommandHandler<NetDebtsCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private members: ISettlementMembers,
    private balances: IGroupBalances,
    private nettings: INettingRepository,
    private clock: Clock,
    private audit: ISettlementAuditLog,
  ) {
    super();
  }

  async execute({ payload }: NetDebtsCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const by = caller.data;
    const withAccount = new Id(payload.with);
    const request = Netting.checkRequest({ by, withAccount, currency: payload.currency });
    if (request.isFailure()) return request;

    const now = this.clock();
    const groupIds = await this.members.sharedGroupsOf(by.value, payload.with, payload.currency);
    const books = new Map<string, SettlementBook>();
    const balances = new Map<string, { caller: number; other: number }>();
    const groups: SharedGroup[] = [];
    for (const groupId of groupIds) {
      const book = (await this.books.findByGroupId(new Id(groupId))) ?? SettlementBook.open(new Id(groupId));
      const ownBalance = await this.balances.balanceOf(groupId, by.value);
      const theirBalance = await this.balances.balanceOf(groupId, payload.with);
      books.set(groupId, book);
      balances.set(groupId, { caller: ownBalance, other: theirBalance });
      groups.push({
        groupId: new Id(groupId),
        callerBalance: book.effectiveBalance(by, ownBalance),
        otherBalance: book.effectiveBalance(withAccount, theirBalance),
      });
    }

    const plan = NetDebts.plan({ by, withAccount, groups });
    if (plan.isFailure()) return plan;

    const touched = new Set<string>();
    const settlementIds: Id[] = [];
    for (const planned of plan.data.settlements) {
      const groupId = planned.groupId.value;
      const book = books.get(groupId) as SettlementBook;
      const { caller: callerBalance, other: otherBalance } = balances.get(groupId) as { caller: number; other: number };
      const payerIsCaller = planned.payer.value === by.value;
      const recorded = book.recordNet({
        by,
        payer: planned.payer,
        payee: planned.payee,
        amount: planned.amount,
        payerIsMember: true,
        payeeIsMember: true,
        payerBalance: payerIsCaller ? callerBalance : otherBalance,
        payeeBalance: payerIsCaller ? otherBalance : callerBalance,
        archived: await this.members.archivedOf(groupId),
        now,
      });
      if (recorded.isFailure()) return recorded;
      settlementIds.push(recorded.data.id);
      touched.add(groupId);
    }

    const netting = Netting.create({
      by,
      withAccount,
      currency: payload.currency,
      amount: plan.data.amount,
      settlementIds,
    });
    if (netting.isFailure()) return netting;

    for (const groupId of touched) {
      const book = books.get(groupId) as SettlementBook;
      const saved = await this.books.save(book);
      if (saved.isFailure()) return saved;
      for (const move of book.moneyMovedSinceRead) {
        await this.audit.record(groupId, {
          id: `${move.action}:${move.settlement.id.value}`,
          at: now.toISOString(),
          by: move.by.value,
          action: move.action,
          subjectId: move.settlement.id.value,
          amount: move.settlement.amount,
        });
      }
    }
    const storedNetting = await this.nettings.save(netting.data);
    if (storedNetting.isFailure()) return storedNetting;

    for (const groupId of touched) await this.publishDomainEvents(books.get(groupId) as SettlementBook, context);
    await this.publishDomainEvents(netting.data, context);
    return Result.ok(netting.data._id.value);
  }
}

import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { AccountSuspendedException, GroupArchivedException } from '@SharedKernel/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementRates, offerForSettlement } from '@Contexts/Settlements/Application/Ports/ISettlementRates';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { AnotherCurrency, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { RecordCashSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RecordCashSettlement/RecordCashSettlementCommandEvent';

/**
 * Recording a cash settlement (request 12): the signed-in member who received the money records who paid them and how much.
 * The members and the balances are asked when this decides: the book of the group decides the settlement against them,
 * in the same transaction as the book's version, so a second settlement recorded at the same moment is decided on the first
 * one's balances, or refused at the save and decided again (CONC-OPTIMISTIC, ADR 8). To anyone who is not a member the group
 * does not exist. The book is saved and what it recorded is published with the save, in one transaction. Its answer is the
 * settlement's id.
 */
export class RecordCashSettlementCommandHandler extends CommandHandler<RecordCashSettlementCommandEvent> {
  constructor(
    private settlementMembers: ISettlementMembers,
    private balances: IGroupBalances,
    private books: ISettlementBookRepository,
    private rates: ISettlementRates,
    private clock: Clock,
  ) {
    super();
  }

  async execute(event: RecordCashSettlementCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return Result.fail(caller.error);
    const payee = caller.data.value;

    const { groupId, from, amount, original } = event.payload;
    const members = await this.settlementMembers.membersOf(groupId, payee);
    if (!members) return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    if (await this.settlementMembers.isArchived(groupId)) return Result.fail(new GroupArchivedException());
    // A suspended payee records no cash settlement, in any group (request 34).
    if (await this.settlementMembers.isSuspended(payee)) return Result.fail(new AccountSuspendedException());

    const at = this.clock();
    // Paid in another currency: the rate is asked for the day it is decided, and the book takes it (request 39). Nothing is kept
    // when no rate is offered, and the book refuses it by name.
    const paid = await this.paid(groupId, payee, amount, original, at);
    if (paid === null) return Result.fail(new NotFoundException('Settlements', 'Group not found'));

    const balances = await this.balances.balancesOf(groupId);
    const book = (await this.books.findByGroupId(groupId)) ?? SettlementBook.open(groupId);

    const recorded = book.recordCash({
      payer: from,
      payee,
      amount: paid,
      at,
      members: members.map(member => member.memberId),
      balances,
    });
    if (recorded.isFailure()) return Result.fail(recorded.error);

    const saved = await this.books.save(book);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(book, context);
    return Result.ok(recorded.data._id);
  }

  /** What is paid: the amount in the group's currency, or what is paid in another currency with the rate offered for the day (request 39). */
  private async paid(
    groupId: string,
    asker: string,
    amount: number | null,
    original: { currency: string; amount: number } | null,
    at: Date,
  ): Promise<number | AnotherCurrency | null> {
    if (!original) return amount ?? 0;
    const groupCurrency = await this.settlementMembers.currencyOf(groupId, asker);
    if (!groupCurrency) return null;
    return { original, groupCurrency, offer: await offerForSettlement(this.rates, original, groupCurrency, at) };
  }
}

import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { PayThroughProviderCommandEvent } from '@Contexts/Settlements/Application/Commands/PayThroughProvider/PayThroughProviderCommandEvent';
import { IGroupBalances } from '@Contexts/Settlements/Application/Ports/IGroupBalances';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { Decision, SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { IPayoutAccountRepository } from '@Contexts/Settlements/Domain/PayoutAccount/Ports/IPayoutAccountRepository';

/**
 * A signed-in member of a group asks to pay another member through the provider: the caller is the payer, and the operation answers
 * the settlement's id. The book decides the rules first, and the payee must have a payout account (request 16), so that a payment the
 * rules refuse never reaches the provider; then the provider is asked for a link, with the settlement's id as its reference and the
 * payee's payout account as the payee; then the book decides again, on the balances read after the provider answered, and keeps the
 * payment pending with the link. A provider that does not answer with a link refuses the request, and nothing is kept. For anyone who
 * is not a member the group does not exist.
 */
export class PayThroughProviderCommandHandler extends CommandHandler<PayThroughProviderCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private payoutAccounts: IPayoutAccountRepository,
    private members: ISettlementMembers,
    private balances: IGroupBalances,
    private provider: IPaymentProvider,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: PayThroughProviderCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const groupId = new Id(payload.groupId);
    const members = await this.members.membersOf(payload.groupId);
    if (!members.includes(caller.data.value)) return Result.fail(notFound(payload.groupId));
    const currency = await this.members.currencyOf(payload.groupId);
    if (currency === null) return Result.fail(notFound(payload.groupId));
    const archived = await this.members.archivedOf(payload.groupId);
    const suspended = await this.members.suspendedOf(caller.data.value);
    const payeeDeleted = await this.members.deletedOf(payload.to);

    const book = (await this.books.findByGroupId(groupId)) ?? SettlementBook.open(groupId);
    const decision = await this.decide(
      payload.groupId,
      caller.data.value,
      payload.to,
      payload.amount,
      members,
      archived,
      suspended,
      payeeDeleted,
    );
    const payee = await this.payoutAccounts.findByOwner(new Id(payload.to));

    const planned = book.planPayment({ ...decision, now: this.clock(), payeeAccount: payee?.accountId ?? null });
    if (planned.isFailure()) return planned;

    const link = await this.provider.requestPaymentLink({
      reference: planned.data.id.value,
      amount: payload.amount,
      currency,
      payee: planned.data.payeeAccount,
    });

    const recorded = book.recordPayment(
      planned.data,
      link,
      await this.decide(
        payload.groupId,
        caller.data.value,
        payload.to,
        payload.amount,
        members,
        archived,
        suspended,
        payeeDeleted,
      ),
    );
    if (recorded.isFailure()) return recorded;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(book, context);
    return Result.ok(recorded.data.id.value);
  }

  /** The facts a settlement is decided on, read now: the two balances, and who is a member. */
  private async decide(
    groupId: string,
    payer: string,
    payee: string,
    amount: number,
    members: string[],
    archived: boolean,
    suspended: boolean,
    payeeDeleted: boolean,
  ): Promise<Decision> {
    return {
      payer: new Id(payer),
      payee: new Id(payee),
      amount,
      payerIsMember: members.includes(payer),
      payeeIsMember: members.includes(payee),
      payerBalance: await this.balances.balanceOf(groupId, payer),
      payeeBalance: await this.balances.balanceOf(groupId, payee),
      archived,
      suspended,
      counterpartyDeleted: payeeDeleted,
    };
  }
}

const notFound = (id: string) => new NotFoundException('Settlements', 'Group not found', { id });

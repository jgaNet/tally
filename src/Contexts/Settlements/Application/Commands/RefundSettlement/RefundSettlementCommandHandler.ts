import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { RefundSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RefundSettlement/RefundSettlementCommandEvent';
import { IPaymentProvider } from '@Contexts/Settlements/Application/Ports/IPaymentProvider';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';

/**
 * A signed-in member asks to refund a settlement paid through the provider: the caller must be its payee, and the settlement must
 * still be paid, with both members still in the group. The book decides the rules first, so that a refusal never reaches the
 * provider; then the provider is asked to refund the payment, with the settlement's id as its reference; then the book decides again
 * on the members read after the provider answered, and the settlement is refunding. A provider that does not accept the refund
 * refuses the request, and nothing changes. For anyone who is not a member the settlement does not exist.
 */
export class RefundSettlementCommandHandler extends CommandHandler<RefundSettlementCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private members: ISettlementMembers,
    private provider: IPaymentProvider,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: RefundSettlementCommandEvent, context: ExecutionContext): Promise<IResult> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const settlementId = new Id(payload.settlementId);
    const book = await this.books.findBySettlementId(settlementId);
    if (!book) return Result.fail(notFound(payload.settlementId));
    const members = await this.members.membersOf(book.groupId.value);
    if (!members.includes(caller.data.value)) return Result.fail(notFound(payload.settlementId));
    const archived = await this.members.archivedOf(book.groupId.value);

    const planned = book.decideRefund(settlementId, caller.data, members, archived);
    if (planned.isFailure()) return planned;

    const accepted = await this.provider.requestRefund({
      paymentId: planned.data.paymentId,
      reference: planned.data.settlementId,
    });

    const recorded = book.recordRefund(
      settlementId,
      caller.data,
      await this.members.membersOf(book.groupId.value),
      accepted,
      this.clock(),
      archived,
    );
    if (recorded.isFailure()) return recorded;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(book, context);
    return Result.ok();
  }
}

const notFound = (id: string) => new NotFoundException('Settlements', 'Settlement not found', { id });

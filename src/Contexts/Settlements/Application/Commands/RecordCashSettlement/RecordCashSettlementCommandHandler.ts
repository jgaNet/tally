import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { RecordCashSettlementCommandEvent } from '@Contexts/Settlements/Application/Commands/RecordCashSettlement/RecordCashSettlementCommandEvent';
import { IGroupBalances } from '@Contexts/Settlements/Application/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Application/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { SettlementBook } from '@Contexts/Settlements/Domain/Settlement/SettlementBook';

/**
 * A signed-in member of a group records a payment in cash they received from another member: the caller is the payee, and the
 * operation answers the settlement's id. For anyone who is not a member the group does not exist. The book decides the rule, on
 * the payer's and the payee's balances as they are read inside this transaction (which holds the file, so a settlement recorded
 * at the same moment is read as the other left it). The settlement is stored with the book's new version, in the same transaction,
 * and its event is published after the commit.
 */
export class RecordCashSettlementCommandHandler extends CommandHandler<RecordCashSettlementCommandEvent> {
  constructor(
    private books: ISettlementBookRepository,
    private members: ISettlementMembers,
    private balances: IGroupBalances,
    private clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: RecordCashSettlementCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    const groupId = new Id(payload.groupId);
    const members = await this.members.membersOf(payload.groupId);
    if (!members.includes(caller.data.value)) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found', { id: payload.groupId }));
    }

    const book = (await this.books.findByGroupId(groupId)) ?? SettlementBook.open(groupId);
    const recorded = book.recordCash({
      payer: new Id(payload.from),
      payee: caller.data,
      amount: payload.amount,
      payerIsMember: members.includes(payload.from),
      payerBalance: await this.balances.balanceOf(payload.groupId, payload.from),
      payeeBalance: await this.balances.balanceOf(payload.groupId, caller.data.value),
      now: this.clock(),
    });
    if (recorded.isFailure()) return recorded;

    const saved = await this.books.save(book);
    if (saved.isFailure()) return saved;

    await this.publishDomainEvents(book, context);
    return Result.ok(recorded.data.id.value);
  }
}

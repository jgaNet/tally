import { ExecutionContext, QueryHandler } from '@Architecture/Application';
import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { IWaitingEffects } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingEffects';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { suggestSettlements } from '@Contexts/Settlements/Domain/Settlement/SettlementSuggestion';
import { TransferReadModel } from '@Contexts/Settlements/Application/ReadModel/TransferReadModel';

/**
 * A member of the group reads the transfers that would bring every balance to 0, made by the stated algorithm
 * (`suggestSettlements`). What is still owed counts a payment waiting at the provider as paid (ADR 8), so the balance of each
 * member is the balance read, plus what is waiting. Nothing is recorded: the suggestion is computed at the read. For anyone
 * else the group does not exist, the same answer as for a group that was never created.
 */
export class GetSuggestedSettlementsQueryHandler extends QueryHandler<
  IGroupBalances,
  { id: string },
  IResult<TransferReadModel[]>
> {
  constructor(
    balances: IGroupBalances,
    private readonly waiting: IWaitingEffects,
    private readonly members: ISettlementMembers,
  ) {
    super(balances);
  }

  async execute({ id }: { id: string }, context: ExecutionContext): Promise<IResult<TransferReadModel[]>> {
    const caller = requireSignedIn(context, 'Settlements');
    if (caller.isFailure()) return caller;

    // The balances are read before the members, as Ledger's balances are: a member who left had a balance of 0 (a member
    // leaves only with 0), so the members listed now cover every balance that is not 0, and those add up to 0.
    const balances = await this.queries.balancesOf(id);
    const waiting = await this.waiting.effectsOf(id);
    const members = await this.members.currentMembers(id);
    if (!members.includes(caller.data.value)) {
      return Result.fail(new NotFoundException('Settlements', 'Group not found'));
    }
    const transfers = suggestSettlements(
      members.map(memberId => ({
        memberId,
        balance: (balances.get(memberId) ?? 0) + (waiting.get(memberId) ?? 0),
      })),
    );
    return Result.ok(transfers.map(transfer => ({ from: transfer.from, to: transfer.to, amount: transfer.amount })));
  }
}

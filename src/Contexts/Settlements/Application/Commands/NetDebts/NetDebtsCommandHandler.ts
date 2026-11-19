import { Clock, CommandHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';
import { IGroupBalances } from '@Contexts/Settlements/Domain/Settlement/Ports/IGroupBalances';
import { ISettlementMembers } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementMembers';
import { ISettlementBookRepository } from '@Contexts/Settlements/Domain/Settlement/Ports/ISettlementBookRepository';
import { INettingRepository } from '@Contexts/Settlements/Domain/Netting/Ports/INettingRepository';
import { Netting } from '@Contexts/Settlements/Domain/Netting/Netting';
import { NetDebts, NettingGroup, refusalOfNetting } from '@Contexts/Settlements/Domain/Netting/NetDebts';
import { NetDebtsCommandEvent } from '@Contexts/Settlements/Application/Commands/NetDebts/NetDebtsCommandEvent';

/**
 * A member nets what they and another member owe each other across the groups they share now, in one currency, that are not
 * archived (request 32). The groups are read in this transaction, in the order they were created, with their books and their
 * balances; NetDebts decides the amount and the settlements; every book considered is saved at its version, so that a netting
 * decided on what another one left is decided again, and nothing is written unless all of it is (CONC-OPTIMISTIC). The
 * result is the netting's id. A netting with oneself, in a currency that is not Tally's, or with nothing to net, is refused.
 */
export class NetDebtsCommandHandler extends CommandHandler<NetDebtsCommandEvent> {
  constructor(
    private readonly books: ISettlementBookRepository,
    private readonly balances: IGroupBalances,
    private readonly members: ISettlementMembers,
    private readonly nettings: INettingRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async execute({ payload }: NetDebtsCommandEvent, context: ExecutionContext): Promise<IResult<{ id: string }>> {
    const by = requireSignedIn(context, 'Settlements');
    if (by.isFailure()) return by;

    const other = new Id(payload.with);
    const callerSuspended = await this.members.isSuspended(by.data.value);
    const otherDeleted = await this.members.isDeleted(payload.with);
    const refusal = refusalOfNetting({
      by: by.data,
      with: other,
      currency: payload.currency,
      callerSuspended,
      otherDeleted,
    });
    if (refusal) return Result.fail(refusal);

    const groups: NettingGroup[] = [];
    for (const shared of await this.members.sharedGroups(by.data.value, payload.with)) {
      if (shared.archived || shared.currency !== payload.currency) continue;
      const groupId = new Id(shared.groupId);
      groups.push({
        groupId,
        book: await this.books.findByGroup(groupId),
        balances: await this.balances.balancesOf(shared.groupId),
        members: await this.members.currentMembers(shared.groupId),
      });
    }

    const at = this.clock();
    const plan = NetDebts.net({ by: by.data, with: other, currency: payload.currency, groups, at });
    if (plan.isFailure()) return Result.fail(plan.error);

    for (const group of groups) {
      const saved = await this.books.save(group.book);
      if (saved.isFailure()) return Result.fail(saved.error);
    }
    const netting = Netting.make({
      by: by.data,
      with: other,
      currency: payload.currency,
      amount: plan.data.amount,
      settlements: plan.data.settlements.map(settlement => settlement.id),
      at,
    });
    if (netting.isFailure()) return Result.fail(netting.error);
    await this.nettings.save(netting.data);

    for (const group of groups) await publishDomainEvents(group.book, context);
    await publishDomainEvents(netting.data, context);
    return Result.ok({ id: netting.data._id.value });
  }
}

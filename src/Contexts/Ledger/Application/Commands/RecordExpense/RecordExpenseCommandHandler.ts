import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { AccountDeletedException, AccountSuspendedException, GroupArchivedException } from '@SharedKernel/Domain';
import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IOfferedRates, offerForExpense } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { splitOfExpense } from '@Contexts/Ledger/Application/Ports/SplitOfExpense';
import { membersListedBy } from '@Contexts/Ledger/Domain/Expense/Split';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';
import { RecordExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/RecordExpense/RecordExpenseCommandEvent';

/**
 * Recording an expense: a signed-in member of a group records what they paid, split equally between members of the
 * group in the order given. The members who may be in the split are asked of Groups when this decides, and the group's
 * currency, which an expense paid in another currency is converted into; an expense in another currency is given the rate
 * offered for its currency and day, when the payer leaves its rate out (request 22). To anyone who is not a member the group
 * does not exist. The payer is the caller. The expense is saved and what it recorded is published with the save, in one
 * transaction. Its answer is the expense's id.
 */
export class RecordExpenseCommandHandler extends CommandHandler<RecordExpenseCommandEvent> {
  constructor(
    private groupMembers: IGroupMembers,
    private groupCurrency: IGroupCurrency,
    private offeredRates: IOfferedRates,
    private expenses: IExpenseRepository,
    private clock: Clock,
    private templates: ISplitTemplateRepository,
  ) {
    super();
  }

  async execute(event: RecordExpenseCommandEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return Result.fail(caller.error);
    const payer = caller.data.value;

    const { groupId, description, money, date, category } = event.payload;
    const members = await this.groupMembers.membersOf(groupId, payer);
    if (!members) return Result.fail(new NotFoundException('Ledger', 'Group not found'));
    if (await this.groupMembers.isArchived(groupId)) return Result.fail(new GroupArchivedException());
    // A suspended account records nothing, in any group (request 34).
    if (await this.groupMembers.isSuspended(payer)) return Result.fail(new AccountSuspendedException());
    const currency = await this.groupCurrency.currencyOf(groupId, payer);
    if (!currency) return Result.fail(new NotFoundException('Ledger', 'Group not found'));

    const requested = await splitOfExpense(this.templates, groupId, event.payload);
    if (requested.isFailure()) return Result.fail(requested.error);
    // A deleted account is in no new split, in any group (request 35).
    for (const memberId of membersListedBy(requested.data)) {
      if (await this.groupMembers.isDeleted(memberId)) return Result.fail(new AccountDeletedException());
    }

    const today = this.clock();
    const offer = await offerForExpense(this.offeredRates, money, currency, date, today);
    const recorded = Expense.create({
      groupId,
      description,
      money,
      groupCurrency: currency,
      date,
      paidBy: payer,
      split: requested.data,
      members: members.map(member => member.memberId),
      today,
      offer,
      category,
    });
    if (recorded.isFailure()) return Result.fail(recorded.error);
    const expense = recorded.data;

    const saved = await this.expenses.save(expense);
    if (saved.isFailure()) return Result.fail(saved.error);

    await this.publishDomainEvents(expense, context);
    return Result.ok(expense._id.value);
  }
}

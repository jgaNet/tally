import { Clock, CommandHandler, ExecutionContext } from '@Architecture/Application';
import { Id, IResult, NotFoundException, Result } from '@Architecture/Domain';
import { requireSignedIn } from '@SharedKernel/Application/Guards';

import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { IBalanceCounts } from '@Contexts/Ledger/Application/Ports/IBalanceCounts';
import { IAuditLog } from '@Contexts/Ledger/Application/Ports/IAuditLog';
import { IExpenseRepository } from '@Contexts/Ledger/Domain/Expense/Ports/IExpenseRepository';
import { IGroupCurrency } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupCurrency';
import { IGroupMembers } from '@Contexts/Ledger/Domain/Expense/Ports/IGroupMembers';
import { IOfferedRates } from '@Contexts/Ledger/Application/Ports/IOfferedRates';
import { RecordExpenseCommandEvent } from '@Contexts/Ledger/Application/Commands/RecordExpense/RecordExpenseCommandEvent';
import { resolveSplit } from '@Contexts/Ledger/Application/Commands/SplitSource';
import { ISplitTemplateRepository } from '@Contexts/Ledger/Domain/SplitTemplate/Ports/ISplitTemplateRepository';

/**
 * A signed-in member of a group records an expense they paid: the payer is the caller, and the operation answers the
 * expense's id. For anyone who is not a member the group does not exist, the same refusal as one that is not there.
 * The split is decided by the expense; its members are read from Groups through the port Ledger owns (ADR 3). The
 * expense is counted into the balances in this same transaction, so the balances and the expense are stored together.
 * An expense paid in another currency is converted into the group's currency, which is read through the port Ledger owns (ADR 12).
 * Its rate is settled against the rate the rates service offers for that day, asked through the port Ledger owns (ADR 13). Its split may
 * be the split of a template of the group (request 25), which the expense is decided by as if it had been given. Its entry in the
 * group's audit is written in the same transaction (request 28).
 */
export class RecordExpenseCommandHandler extends CommandHandler<RecordExpenseCommandEvent> {
  constructor(
    private expenses: IExpenseRepository,
    private groupMembers: IGroupMembers,
    private groupCurrency: IGroupCurrency,
    private offeredRates: IOfferedRates,
    private clock: Clock,
    private balances: IBalanceCounts,
    private templates: ISplitTemplateRepository,
    private audit: IAuditLog,
  ) {
    super();
  }

  async execute({ payload }: RecordExpenseCommandEvent, context: ExecutionContext): Promise<IResult<string>> {
    const caller = requireSignedIn(context, 'Ledger');
    if (caller.isFailure()) return caller;

    const members = await this.groupMembers.membersOf(payload.groupId);
    if (!members.some(member => member.value === caller.data.value)) {
      return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: payload.groupId }));
    }

    const currency = await this.groupCurrency.currencyOf(payload.groupId);
    if (!currency) return Result.fail(new NotFoundException('Ledger', 'Group not found', { id: payload.groupId }));

    const split = await resolveSplit(this.templates, payload.groupId, payload.split);
    if (split.isFailure()) return split;

    const offer =
      'original' in payload.money
        ? await this.offeredRates.rateOn({ from: payload.money.original.currency, to: currency, date: payload.date })
        : null;

    const now = this.clock();
    const expense = Expense.create({
      groupId: new Id(payload.groupId),
      paidBy: caller.data,
      description: payload.description,
      money: payload.money,
      date: payload.date,
      split: split.data,
      category: payload.category,
      groupMembers: members,
      groupCurrency: currency,
      offer,
      archived: await this.groupMembers.archivedOf(payload.groupId),
      now,
    });
    if (expense.isFailure()) return expense;

    const saved = await this.expenses.save(expense.data);
    if (saved.isFailure()) return saved;
    await this.balances.count(expense.data);
    await this.audit.record(payload.groupId, {
      id: `expense-recorded:${expense.data._id.value}`,
      at: now.toISOString(),
      by: caller.data.value,
      action: 'expense-recorded',
      subjectId: expense.data._id.value,
      amount: expense.data.amount.value,
    });

    await this.publishDomainEvents(expense.data, context);
    return Result.ok(expense.data._id.value);
  }
}

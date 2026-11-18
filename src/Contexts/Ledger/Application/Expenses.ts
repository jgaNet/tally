import { IResult, Result } from '@Architecture/Domain';
import { Clock, publishDomainEvents } from '@Architecture/Application';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';

import { IExpenseStore, ExpenseView } from '@Contexts/Ledger/Application/IExpenseStore';
import { IGroupCurrency } from '@Contexts/Ledger/Application/IGroupCurrency';
import { GroupMemberRole, IGroupMembers } from '@Contexts/Ledger/Application/IGroupMembers';
import { IOfferedRates } from '@Contexts/Ledger/Application/IOfferedRates';
import { ISplitTemplateStore } from '@Contexts/Ledger/Application/ISplitTemplateStore';
import { Expense } from '@Contexts/Ledger/Domain/Expense/Expense';
import { OfferedRate, OriginalDraft } from '@Contexts/Ledger/Domain/Expense/OriginalAmount';
import {
  ExpenseNotFoundException,
  GroupNotFoundException,
  NotThePayerOrOwnerException,
} from '@Contexts/Ledger/Domain/Expense/ExpenseExceptions';
import { SplitDraft } from '@Contexts/Ledger/Domain/Expense/Split';
import { TemplateNotFoundException } from '@Contexts/Ledger/Domain/SplitTemplate/SplitTemplateExceptions';

/**
 * How an expense is split as the request gives it (request 25): by a split of its own, or by the split of one of its group's templates, which
 * it is split as if its split had been given (the template's shares are not kept, the expense's are).
 */
export type SplitGiven = SplitDraft | { readonly template: string };

/** Whether a split is given by a template (request 25) rather than as a split of its own. */
const isTemplateRef = (given: SplitGiven): given is { readonly template: string } => 'template' in given;

/**
 * An expense as the request carries it: the group it is in, and the rest of the draft; the payer is the caller. Its amount is
 * either `amount`, in the group's currency, or `original`, in another currency at its rate (request 21): the transport gives
 * exactly one of them. The rate of an original may be left out, and is then the one offered (request 22). Its split is given
 * either as a split of its own or as a template of its group (request 25): exactly one of the two.
 */
export type RecordExpenseInput = {
  readonly groupId: string;
  readonly description: string;
  readonly amount?: number;
  readonly original?: OriginalDraft;
  readonly date: string;
  readonly split: SplitGiven;
  /** What it is spent on (request 24): one of the eight, `other` when left out. */
  readonly category?: string;
};

/**
 * An edit as the request carries it: the expense it changes, the expense given again whole, and the version its author read.
 * The payer is not in it: an edit never changes who paid.
 */
export interface EditExpenseInput {
  readonly expenseId: string;
  readonly description: string;
  readonly amount?: number;
  readonly original?: OriginalDraft;
  readonly date: string;
  readonly split: SplitGiven;
  readonly version: number;
  /** What it is spent on (request 24), as a recording gives it. */
  readonly category?: string;
}

/**
 * Records an expense the signed-in person paid, split between the members the request names. The group is read through the
 * owned port: a caller who is not one of its members gets the group's `404`, since the group is not there for them. The group's
 * currency is read through its own port, the one an expense in another currency is converted to (request 21). An expense in
 * another currency is decided with the rate the rates service offers for its currency on its day (request 22, asked before the
 * expense decides). The expense is saved with its shares, and what it recorded (ExpenseRecorded) goes out with the commit, through
 * the outbox. Answers the new expense's id.
 */
export const recordExpense = command(
  'RecordExpense',
  (
    expenses: IExpenseStore,
    templates: ISplitTemplateStore,
    groupMembers: IGroupMembers,
    groupCurrency: IGroupCurrency,
    rates: IOfferedRates,
    clock: Clock,
  ) =>
    async ({ groupId, ...draft }: RecordExpenseInput, context): Promise<IResult<string>> => {
      const payerId = callerOf(context);
      const members = await groupMembers.membersOf(groupId);
      if (!members || !isMember(members, payerId)) return Result.fail(new GroupNotFoundException());
      const currency = await groupCurrency.currencyOf(groupId);
      if (currency === undefined) return Result.fail(new GroupNotFoundException());
      const split = await splitOf(templates, groupId, draft.split);
      if (split.isFailure()) return Result.fail(split.error);
      const offered = await offeredRateFor(rates, draft.original, currency, draft.date);

      const recorded = Expense.register(
        { groupId, payerId, groupCurrency: currency, offered, ...draft, split: split.data },
        members.map(member => member.memberId),
        clock(),
      );
      if (recorded.isFailure()) return recorded;

      await expenses.add(recorded.data);
      await publishDomainEvents(recorded.data, context);
      return Result.ok(recorded.data.toSnapshot().id);
    },
);

/**
 * Edits an expense: given again whole, from the version its author read (request 6). Only its payer or the group's owner may
 * (`403` to any other member); to someone outside the group the expense does not exist (`404`). The payer stays the one who
 * paid. An edit from another version is refused with `ExpenseChanged` (`409`), and the author reads it again and decides. The
 * expense is saved at the version it was read at, so of two edits from one version, one is kept, and the other is refused by
 * that same rule once it has read the expense again. An edit in another currency is decided with the rate offered on its day
 * (request 22), as a recording is. What it recorded (ExpenseEdited) goes out with the commit.
 */
export const editExpense = command(
  'EditExpense',
  (
    expenses: IExpenseStore,
    templates: ISplitTemplateStore,
    groupMembers: IGroupMembers,
    groupCurrency: IGroupCurrency,
    rates: IOfferedRates,
    clock: Clock,
  ) =>
    async ({ expenseId, version, ...draft }: EditExpenseInput, context): Promise<IResult<void>> => {
      const found = await changeable(expenses, groupMembers, groupCurrency, expenseId, context);
      if (found.isFailure()) return Result.fail(found.error);
      const { expense, members, currency } = found.data;
      const split = await splitOf(templates, expense.toSnapshot().groupId, draft.split);
      if (split.isFailure()) return Result.fail(split.error);
      const offered = await offeredRateFor(rates, draft.original, currency, draft.date);

      const edited = expense.edit(
        { groupCurrency: currency, offered, ...draft, split: split.data },
        members.map(member => member.memberId),
        version,
        clock(),
      );
      if (edited.isFailure()) return Result.fail(edited.error);

      await expenses.save(expense);
      await publishDomainEvents(expense, context);
      return Result.ok(undefined);
    },
);

/**
 * Deletes an expense: it is no longer there for anyone, and counts in no balance (request 6). Only its payer or the group's
 * owner may (`403` to any other member); to someone outside the group the expense does not exist (`404`). What it recorded
 * (ExpenseDeleted) goes out with the commit.
 */
export const deleteExpense = command(
  'DeleteExpense',
  (expenses: IExpenseStore, groupMembers: IGroupMembers, groupCurrency: IGroupCurrency, clock: Clock) =>
    async (expenseId: string, context): Promise<IResult<void>> => {
      const found = await changeable(expenses, groupMembers, groupCurrency, expenseId, context);
      if (found.isFailure()) return Result.fail(found.error);
      const { expense, members } = found.data;

      const deleted = expense.delete(
        members.map(member => member.memberId),
        clock(),
      );
      if (deleted.isFailure()) return Result.fail(deleted.error);
      await expenses.remove(expense);
      await publishDomainEvents(expense, context);
      return Result.ok(undefined);
    },
);

/**
 * An expense as a member of its group reads it: its description, amount, date, payer, each member's share in the order the
 * split was given, and the version it is at. To anyone else it does not exist: the same `404` for an expense that is not there
 * and one of a group the caller is not in.
 */
export const getExpense = query(
  'GetExpense',
  (expenses: IExpenseStore, groupMembers: IGroupMembers) =>
    async (expenseId: string, context): Promise<IResult<ExpenseView>> => {
      const view = await expenses.viewOf(expenseId);
      if (!view) return Result.fail(new ExpenseNotFoundException());

      const members = await groupMembers.membersOf(view.groupId);
      if (!members || !isMember(members, callerOf(context))) return Result.fail(new ExpenseNotFoundException());
      return Result.ok(view);
    },
);

/**
 * The expense a caller may change, as the caller may see it: it is there for them (an expense of a group they are a member of,
 * else the same `404` as one that does not exist), and they are its payer or the group's owner (else `403`). Answers the
 * expense, the group's members, the ones the split may be in, and the group's currency (request 21).
 */
async function changeable(
  expenses: IExpenseStore,
  groupMembers: IGroupMembers,
  groupCurrency: IGroupCurrency,
  expenseId: string,
  context: ExecutionContext,
): Promise<IResult<{ expense: Expense; members: GroupMemberRole[]; currency: string }>> {
  const expense = await expenses.findById(expenseId);
  if (!expense) return Result.fail(new ExpenseNotFoundException());

  const { groupId, paidBy } = expense.toSnapshot();
  const members = await groupMembers.membersOf(groupId);
  const caller = callerOf(context);
  const me = members?.find(member => member.memberId === caller);
  if (!members || !me) return Result.fail(new ExpenseNotFoundException());
  if (paidBy !== caller && me.role !== 'owner') return Result.fail(new NotThePayerOrOwnerException());
  const currency = await groupCurrency.currencyOf(groupId);
  if (currency === undefined) return Result.fail(new ExpenseNotFoundException());

  return Result.ok({ expense, members, currency });
}

/**
 * The split an expense is decided by (request 25): the one given, or the split of the template of the group it names, as if it had been
 * given. A template that is not there, or is of another group, is `404`; whether its members are the group's is the expense's to decide, as
 * for any split.
 */
const splitOf = async (
  templates: ISplitTemplateStore,
  groupId: string,
  given: SplitGiven,
): Promise<IResult<SplitDraft>> => {
  if (!isTemplateRef(given)) return Result.ok(given);
  const template = await templates.findById(given.template);
  if (!template || template.groupId !== groupId) return Result.fail(new TemplateNotFoundException());
  return Result.ok(template.splitDraft());
};

/**
 * The rate the rates service offers for an original's currency to the group's on the expense's day (request 22), asked when the
 * expense has an original, whether or not its rate is left out: a stated rate is checked against it. Nothing is asked for an
 * expense in the group's currency.
 */
const offeredRateFor = async (
  rates: IOfferedRates,
  original: OriginalDraft | undefined,
  groupCurrency: string,
  date: string,
): Promise<OfferedRate | undefined> =>
  original === undefined ? undefined : rates.rateOf(original.currency, groupCurrency, date);

const isMember = (members: readonly GroupMemberRole[], memberId: string): boolean =>
  members.some(member => member.memberId === memberId);

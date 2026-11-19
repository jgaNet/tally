import { IResult, NotFoundException, Result } from '@Architecture/Domain';
import { Clock } from '@Architecture/Application';
import { publishDomainEvents } from '@Architecture/Application/DomainEvents';
import { callerOf, command, query } from '@Architecture/Application/Lite/UseCase';
import { ExecutionContext } from '@Architecture/Application/ExecutionContext';
import { isCurrencyCode } from '@SharedKernel/Domain';
import { Expense, ExpenseSnapshot } from '@Contexts/Ledger/Domain/Expense/Expense';
import { memberIdsOfSplit, SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';
import { GivenAmount } from '@Contexts/Ledger/Domain/Expense/Expense.decision';
import { IBalanceQueries } from '@Contexts/Ledger/Domain/IBalanceQueries';
import { auditEntryOf } from '@Contexts/Ledger/Domain/Audit/AuditEntry';
import { InvalidRateDateException } from '@Contexts/Ledger/Domain/Expense/RateExceptions';
import { NOT_ASKED, RateOffer } from '@Contexts/Ledger/Domain/Expense/Rate';
import {
  decideRecordExpense,
  decideEditExpense,
  decideDeleteExpense,
} from '@Contexts/Ledger/Domain/Expense/Expense.decision';

import { IGroupCurrency } from './IGroupCurrency';
import { IGroupMembers, MemberOfGroup } from './IGroupMembers';
import { IOfferedRates, OfferedRateView } from './IOfferedRates';
import { BalanceView, ExpenseView, IExpenseQueries } from './IExpenseQueries';
import { IStatementQueries, StatementView } from './IStatementQueries';
import { IAuditEntries } from './IAuditEntries';
import { IExpenseRepository } from './IExpenseRepository';
import { ISplitTemplateRepository } from './ISplitTemplateRepository';
import { anyDeletedOf } from './anyDeletedOf';

/**
 * How an expense is split as it is asked: either by a split given (request 7), between members equally, by exact amounts, or by shares,
 * the members in the order chosen; or by `template`, the id of one of its group's templates, split as if that template's split had been
 * given (request 25). Exactly one of the two.
 */
export type SplitChoice = { split: SplitRequest; template?: undefined } | { split?: undefined; template: string };

/**
 * What a member records: the group, the expense as typed, and how it is split (a split or a template, request 7 and request 25). Its amount
 * is in the group's currency, or paid in another currency at a rate (request 21).
 */
export type RecordExpenseInput = {
  groupId: string;
  description: string;
  date: string;
  /** What it was for (request 24); `other` when none is given. */
  category?: string;
} & SplitChoice &
  GivenAmount;

/**
 * What a change to an expense says: which expense, the expense as typed, how it is split (a split or a template), the version its author
 * read it at, and its amount (in the group's currency, or paid in another, request 21).
 */
export type EditExpenseInput = {
  id: string;
  description: string;
  date: string;
  version: number;
  category?: string;
} & SplitChoice &
  GivenAmount;

/**
 * A member of a group records an expense they paid, split between members of the group, the payer among them, one of the
 * three ways (equally, by exact amounts, or by shares). The payer is the caller. Anyone who is not a member gets the answer for a group that does not exist. Answers the new
 * expense's id.
 */
export const recordExpense = command(
  'RecordExpense',
  (
    expenses: IExpenseRepository,
    groupMembers: IGroupMembers,
    groupCurrency: IGroupCurrency,
    offeredRates: IOfferedRates,
    templates: ISplitTemplateRepository,
    audit: IAuditEntries,
    clock: Clock,
  ) =>
    async ({ groupId, description, date, category, ...rest }: RecordExpenseInput, context) => {
      const { split, template, ...given } = rest as SplitChoice & GivenAmount;
      return expenses.inTransaction(async () => {
        const payer = callerOf(context);
        const members = await groupMembers.membersOf(groupId, payer);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No group is found'));
        const currency = await groupCurrency.currencyOf(groupId, payer);
        if (currency === undefined) return Result.fail(new NotFoundException('Ledger', 'No group is found'));
        const offered = await offerFor(offeredRates, given as GivenAmount, date, currency);
        const asked = await splitAsked({ split, template } as SplitChoice, groupId, templates);
        if (asked === undefined) return Result.fail(new NotFoundException('Ledger', 'No template is found'));

        const decision = decideRecordExpense(
          {
            memberIds: memberIdsOf(members),
            groupCurrency: currency,
            offered,
            archived: await groupMembers.archivedOf(groupId),
            suspended: await groupMembers.suspendedOf(payer),
            deleted: await anyDeletedOf(groupMembers, [payer, ...memberIdsOfSplit(asked)]),
          },
          { description, date, split: asked, payer, category, ...(given as GivenAmount) },
          clock(),
        );
        if (decision.isFailure()) return decision;

        const recordedAt = clock();
        const expense = Expense.register({ groupId, ...decision.data.state, recordedAt });
        await expenses.insert(expense, recordedAt.toISOString());
        await audit.add(
          groupId,
          auditEntryOf(
            {
              by: payer,
              action: 'expense-recorded',
              subjectId: expense._id.value,
              amount: expense.toSnapshot().amount,
            },
            clock(),
          ),
        );
        await publishDomainEvents(expense, context);
        return Result.ok(expense._id.value);
      });
    },
);

/**
 * The payer of an expense, or the group's owner, gives it again, whole, from the version they read (feature 6). Any other
 * member is refused; anyone who is not a member gets the answer for an expense that does not exist. An edit made from a
 * version the expense has left is refused by name; two edits at once from one version keep one, and the other is re-read
 * and refused the same way (CONC-OPTIMISTIC).
 */
export const editExpense = command(
  'EditExpense',
  (
    expenses: IExpenseRepository,
    groupMembers: IGroupMembers,
    groupCurrency: IGroupCurrency,
    offeredRates: IOfferedRates,
    templates: ISplitTemplateRepository,
    audit: IAuditEntries,
    clock: Clock,
  ) =>
    async ({ id, description, date, version, category, ...rest }: EditExpenseInput, context) => {
      const { split, template, ...given } = rest as SplitChoice & GivenAmount;
      return expenses.inTransaction(async () => {
        const by = callerOf(context);
        const expense = await expenses.get(id);
        if (!expense) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
        const stored = expense.toSnapshot();
        const members = await groupMembers.membersOf(stored.groupId, by);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
        const currency = await groupCurrency.currencyOf(stored.groupId, by);
        if (currency === undefined) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
        const offered = await offerFor(offeredRates, given as GivenAmount, date, currency);
        const asked = await splitAsked({ split, template } as SplitChoice, stored.groupId, templates);
        if (asked === undefined) return Result.fail(new NotFoundException('Ledger', 'No template is found'));

        const decision = decideEditExpense(
          {
            expense: stored,
            memberIds: memberIdsOf(members),
            ownerId: ownerIdOf(members),
            groupCurrency: currency,
            offered,
            archived: await groupMembers.archivedOf(stored.groupId),
          },
          { by, description, date, split: asked, version, category, ...(given as GivenAmount) },
          clock(),
        );
        if (decision.isFailure()) return decision;

        expense.revise(decision.data.state);
        await expenses.save(expense);
        await audit.add(
          stored.groupId,
          auditEntryOf({ by, action: 'expense-edited', subjectId: id, amount: expense.toSnapshot().amount }, clock()),
        );
        await publishDomainEvents(expense, context);
        return Result.ok(undefined);
      });
    },
);

/**
 * The payer of an expense, or the group's owner, deletes it (feature 6): it is no longer read, and counts in no balance.
 * Any other member is refused; anyone who is not a member gets the answer for an expense that does not exist.
 */
export const deleteExpense = command(
  'DeleteExpense',
  (expenses: IExpenseRepository, groupMembers: IGroupMembers, audit: IAuditEntries, clock: Clock) =>
    async ({ id }: { id: string }, context) => {
      return expenses.inTransaction(async () => {
        const by = callerOf(context);
        const expense = await expenses.get(id);
        if (!expense) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
        const stored: ExpenseSnapshot = expense.toSnapshot();
        const members = await groupMembers.membersOf(stored.groupId, by);
        if (!members) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));

        const decision = decideDeleteExpense(
          {
            expense: stored,
            memberIds: memberIdsOf(members),
            ownerId: ownerIdOf(members),
            archived: await groupMembers.archivedOf(stored.groupId),
          },
          { by },
          clock(),
        );
        if (decision.isFailure()) return decision;

        expense.delete();
        await expenses.remove(expense);
        await audit.add(
          stored.groupId,
          auditEntryOf({ by, action: 'expense-deleted', subjectId: id, amount: stored.amount }, clock()),
        );
        await publishDomainEvents(expense, context);
        return Result.ok(undefined);
      });
    },
);

/** A member of the expense's group reads it; anyone else, or nobody, gets the answer for an expense that does not exist. */
export const getExpense = query(
  'GetExpense',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const expense: ExpenseView | undefined = await expenses.expenseOf(id);
      if (!expense) return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
      if (!(await groupMembers.membersOf(expense.groupId, callerOf(context)))) {
        return Result.fail(new NotFoundException('Ledger', 'No expense is found'));
      }
      return Result.ok(expense);
    },
);

/**
 * A member of a group reads every member's balance, in the order they joined (the order Groups gives them): what the
 * member paid for the group's expenses less their shares in them, and what the group's settlements have paid since
 * (request 12), so the balances add up to 0. Anyone who is not a member gets the answer for a group that does not exist.
 */
export const getGroupBalances = query(
  'GetGroupBalances',
  (balances: IBalanceQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      const members = await groupMembers.membersOf(id, callerOf(context));
      if (!members) return Result.fail(new NotFoundException('Ledger', 'No group is found'));
      const counted = await balances.balancesOf(id);
      const answer: BalanceView[] = memberIdsOf(members).map(memberId => ({
        memberId,
        balance: counted.get(memberId) ?? 0,
      }));
      return Result.ok(answer);
    },
);

/**
 * A member of a group reads its expenses that are not deleted, each as `GetExpense` reads it, the latest date first and, on
 * the same date, the most recently recorded first (request 8). Anyone who is not a member gets the answer for a group that
 * does not exist.
 */
export const getGroupExpenses = query(
  'GetGroupExpenses',
  (expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    async ({ id }: { id: string }, context) => {
      if (!(await groupMembers.membersOf(id, callerOf(context)))) {
        return Result.fail(new NotFoundException('Ledger', 'No group is found'));
      }
      return Result.ok(await expenses.expensesOf(id));
    },
);

/**
 * A member of a group reads the statement of any member of the group, themselves included (request 8): every expense that
 * member paid or is in the split of, the earliest date first, with the balance after each entry. Anyone who is not a
 * member gets the answer for a group that does not exist. A member who left the group keeps their statement readable while
 * an expense of theirs is recorded (request 9); one who never was in an expense of the group does not exist, so the answer
 * for them is the same as for a member who is not there.
 */
/**
 * A member of a group reads the statement of a member (request 8, request 29): the expenses they paid or are in the split of, and the
 * settlements the balances count in which they are a party, in the order of a bank statement. Anyone who is not a member of the group
 * gets the answer for a member that does not exist, unless that member has an expense of the group.
 */
const statementOfMember =
  (statements: IStatementQueries, expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
  async (
    { id, memberId }: { id: string; memberId: string },
    context: ExecutionContext,
  ): Promise<IResult<StatementView>> => {
    const members = await groupMembers.membersOf(id, callerOf(context));
    if (!members) return Result.fail(new NotFoundException('Ledger', 'No group is found'));
    const isMember = memberIdsOf(members).includes(memberId);
    if (!isMember && !(await expenses.isInvolved(id, memberId))) {
      return Result.fail(new NotFoundException('Ledger', 'No member is found'));
    }
    return Result.ok(await statements.statementOf(id, memberId));
  };

/** The statement of a member, as the JSON route answers it (request 8, request 29). */
export const getMemberStatement = query(
  'GetMemberStatement',
  (statements: IStatementQueries, expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    statementOfMember(statements, expenses, groupMembers),
);

/**
 * The same statement, as the CSV route answers it (request 29): the same read model, the same access, and the transport renders its
 * entries as CSV. A separate query so that each route is answered by the use case that names it.
 */
export const getMemberStatementCsv = query(
  'GetMemberStatementCsv',
  (statements: IStatementQueries, expenses: IExpenseQueries, groupMembers: IGroupMembers) =>
    statementOfMember(statements, expenses, groupMembers),
);

/**
 * The rate offered for an amount paid in another currency (request 22), asked before the decision, for the expense's currency to the
 * group's on its day. Nothing is asked for an amount in the group's own currency, nor for a currency that is not Tally's, nor for a day
 * that is not written as one: the decision refuses those before it reads an offer.
 */
const offerFor = async (
  offeredRates: IOfferedRates,
  given: GivenAmount,
  date: string,
  groupCurrency: string,
): Promise<RateOffer> => {
  const original = given.original;
  if (original === undefined || !isCurrencyCode(original.currency) || original.currency === groupCurrency)
    return NOT_ASKED;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NOT_ASKED;
  return offeredRates.rateFor({ from: original.currency, to: groupCurrency, date });
};

/**
 * A member of a group reads the rate Tally offers from a currency to the group's on a day (request 22): the day given, or today (UTC) when
 * none is. It is the rate the rates service gives, as it gives it. Anyone who is not a member gets the answer for a group that does not
 * exist; a currency that is the group's or not one of Tally's, and a day with no rate offered, both answer as a rate that is not there.
 */
export const getOfferedRate = query(
  'GetOfferedRate',
  (groupCurrency: IGroupCurrency, groupMembers: IGroupMembers, offeredRates: IOfferedRates, clock: Clock) =>
    async ({ id, currency, date }: { id: string; currency: string; date?: string }, context) => {
      const by = callerOf(context);
      if (!(await groupMembers.membersOf(id, by)))
        return Result.fail(new NotFoundException('Ledger', 'No group is found'));
      const groupCode = await groupCurrency.currencyOf(id, by);
      if (groupCode === undefined) return Result.fail(new NotFoundException('Ledger', 'No group is found'));

      const day = date ?? clock().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isRealDay(day)) return Result.fail(new InvalidRateDateException());
      if (!isCurrencyCode(currency) || currency === groupCode) {
        return Result.fail(new NotFoundException('Ledger', 'No rate is offered'));
      }
      const offer = await offeredRates.rateFor({ from: currency, to: groupCode, date: day });
      if (offer.kind !== 'rate') return Result.fail(new NotFoundException('Ledger', 'No rate is offered'));
      const answer: OfferedRateView = { currency, date: day, rate: offer.rate };
      return Result.ok(answer);
    },
);

/** Whether `day` (already written YYYY-MM-DD) is a day of the calendar: 2026-02-30 is not, and reads back as another day. */
const isRealDay = (day: string): boolean => new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;

/**
 * The split an expense is decided by (request 25): the split as given, or, for a template, the template's split as it was saved, when the
 * template is one of the group's. Answers `undefined` when the template is not there, or is another group's: to the caller it does not exist.
 * The split is a value the expense keeps; the template is not referred to once the expense is decided.
 */
const splitAsked = async (
  choice: SplitChoice,
  groupId: string,
  templates: ISplitTemplateRepository,
): Promise<SplitRequest | undefined> => {
  if (choice.template === undefined) return choice.split;
  const template = await templates.get(choice.template);
  const stored = template?.toSnapshot();
  if (!stored || stored.groupId !== groupId) return undefined;
  return stored.split;
};

const memberIdsOf = (members: MemberOfGroup[]): string[] => members.map(member => member.memberId);

/** The group's owner, the member whose role is owner; no one, if none is (a group always has one). */
const ownerIdOf = (members: MemberOfGroup[]): string => members.find(member => member.role === 'owner')?.memberId ?? '';

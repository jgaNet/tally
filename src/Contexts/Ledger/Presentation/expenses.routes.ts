import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  SplitGiven,
  deleteExpense,
  editExpense,
  getExpense,
  recordExpense,
} from '@Contexts/Ledger/Application/Expenses';
import { SplitDraft } from '@Contexts/Ledger/Domain/Expense/Split';

/** The three ways a body may split an expense (request 7): exactly one of them, its shape only. */
export type SplitBody =
  | { readonly splitBetween: string[] }
  | { readonly splitExactly: { memberId: string; amount: number }[] }
  | { readonly splitByShares: { memberId: string; shares: number }[] };

/** A split as a body gives it (request 25): one of the three, or `template`, the id of a template of the group, in its place. Exactly one. */
export type SplitOrTemplateBody = SplitBody | { readonly template: string };

/** An expense paid in another currency, as a body gives it (request 21): its shape only. */
type OriginalBody = { readonly currency: string; readonly amount: number; readonly rate?: string };

/** The amount of a body (request 21): exactly one of `amount`, in the group's currency, and `original`, in another currency. */
type AmountBody = { readonly amount: number } | { readonly original: OriginalBody };

/**
 * The body of a recording: its shape only; the payer is the caller, and the group is the URL's. Its category is a string the domain
 * checks (request 24); left out, it is `other`.
 */
type RecordExpenseBody = {
  readonly description: string;
  readonly date: string;
  readonly category?: string;
} & AmountBody &
  SplitOrTemplateBody;

/** The body of an edit: the expense given again whole, and the version its author read (request 6). */
type EditExpenseBody = RecordExpenseBody & { readonly version: number };

/** The schema of an amount in a body (request 21): exactly one of `amount` and `original`, each of the shape it names. */
const amountProperties = {
  amount: { type: 'integer' },
  original: {
    type: 'object',
    required: ['currency', 'amount'],
    properties: { currency: { type: 'string' }, amount: { type: 'integer' }, rate: { type: 'string' } },
  },
};
const exactlyOneAmount = {
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
};

/** The amount a body gives, in the domain's words: `amount`, or the original it is paid in. The schema has let through exactly one. */
const amountOf = (body: AmountBody): { amount?: number; original?: OriginalBody } =>
  'amount' in body ? { amount: body.amount } : { original: body.original };

/**
 * The schema of a split in a body (request 4's `splitBetween`, request 7's `splitExactly` and `splitByShares`): exactly one of
 * the three keys, each of the shape it names. Whether an amount is 0 or more, or the shares are at least 1, is the domain's.
 */
export const splitProperties = {
  splitBetween: { type: 'array', items: { type: 'string' } },
  splitExactly: {
    type: 'array',
    items: {
      type: 'object',
      required: ['memberId', 'amount'],
      properties: { memberId: { type: 'string' }, amount: { type: 'integer' } },
    },
  },
  splitByShares: {
    type: 'array',
    items: {
      type: 'object',
      required: ['memberId', 'shares'],
      properties: { memberId: { type: 'string' }, shares: { type: 'integer' } },
    },
  },
};
export const exactlyOneSplit = {
  oneOf: [{ required: ['splitBetween'] }, { required: ['splitExactly'] }, { required: ['splitByShares'] }],
};

/** The schema of a template in a body (request 25): the id of one of the group's templates, which the domain looks up. */
const templateProperties = { template: { type: 'string' } };

/** Exactly one of the three splits, or `template` (request 25): the schema has let through exactly one of the four keys. */
const exactlyOneSplitOrTemplate = {
  oneOf: [...exactlyOneSplit.oneOf, { required: ['template'] }],
};

/** The split a body gives, in the domain's words. The schema has let through exactly one of the three keys. */
export const splitOf = (body: SplitBody): SplitDraft => {
  if ('splitBetween' in body) return { kind: 'equal', memberIds: body.splitBetween };
  if ('splitExactly' in body) return { kind: 'exact', amounts: body.splitExactly };
  return { kind: 'shares', shares: body.splitByShares };
};

/** The split a body gives, as the use case takes it (request 25): a split of its own, or the template it names. Exactly one of the four keys. */
const splitGivenBy = (body: SplitOrTemplateBody): SplitGiven =>
  'template' in body ? { template: body.template } : splitOf(body);

/**
 * The expenses' routes (feature 4, the API's fragment 5, feature 6's fragment 7, feature 7's fragment 8, and request 21's fragment
 * 21): a member records an expense they paid, split equally, by exact amounts or by shares, in the group's currency or in another
 * one at its rate; a member of its group reads it, with how it was split; its payer or the group's owner edits it from the version
 * they read, the same ways, or deletes it. Each answers its use case at once. The paths are whole, mounted at the root beside the
 * groups' (ADR 5: a context has one mount). The body's schema says its shape only: a missing field, one of the wrong type, neither
 * or both of `amount` and `original`, or not exactly one of the three splits is `400` before any use case runs; whether the
 * description fits, the amount is in range, the currency is Tally's and not the group's, the rate is a positive decimal with at most
 * six digits after the point, the date is a real day, the split is the group's members, the amounts add up and the shares are at
 * least 1 is the domain's to say (`422`). The rate of an original may be left out (request 22): it is then the one offered on the day,
 * and a rate given is checked against that offer by the domain.
 */
export const expenseRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.post<{ Params: { id: string }; Body: RecordExpenseBody }>(
    '/groups/:id/expenses',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'date'],
          properties: {
            description: { type: 'string' },
            date: { type: 'string' },
            category: { type: 'string' },
            ...amountProperties,
            ...splitProperties,
            ...templateProperties,
          },
          allOf: [exactlyOneAmount, exactlyOneSplitOrTemplate],
        },
      },
    },
    (req, reply) =>
      answerAtOnce(
        req,
        reply,
        module.useCase(recordExpense),
        {
          groupId: req.params.id,
          description: req.body.description,
          ...amountOf(req.body),
          date: req.body.date,
          split: splitGivenBy(req.body),
          category: req.body.category,
        },
        { created: true },
      ),
  );

  fastify.get<{ Params: { id: string } }>('/expenses/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getExpense), req.params.id),
  );

  fastify.put<{ Params: { id: string }; Body: EditExpenseBody }>(
    '/expenses/:id',
    {
      schema: {
        body: {
          type: 'object',
          required: ['description', 'date', 'version'],
          properties: {
            description: { type: 'string' },
            date: { type: 'string' },
            version: { type: 'integer' },
            category: { type: 'string' },
            ...amountProperties,
            ...splitProperties,
            ...templateProperties,
          },
          allOf: [exactlyOneAmount, exactlyOneSplitOrTemplate],
        },
      },
    },
    (req, reply) =>
      answerAtOnce(req, reply, module.useCase(editExpense), {
        expenseId: req.params.id,
        description: req.body.description,
        ...amountOf(req.body),
        date: req.body.date,
        split: splitGivenBy(req.body),
        version: req.body.version,
        category: req.body.category,
      }),
  );

  fastify.delete<{ Params: { id: string } }>('/expenses/:id', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(deleteExpense), req.params.id),
  );

  done();
};

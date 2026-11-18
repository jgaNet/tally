import { SplitRequest } from '@Contexts/Ledger/Domain/Expense/Split';

/** A body's object, as a shape check reads it. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** The three fields a body may split an expense by (request 7): exactly one of them is given. */
export const SPLIT_FIELDS = ['splitBetween', 'splitExactly', 'splitByShares'] as const;

/** Whether the one split field given is of its shape: a list of member ids, of { memberId, amount }, or of { memberId, shares }. */
export const hasSplitShape = (body: Record<string, unknown>): boolean => {
  const given = SPLIT_FIELDS.filter(field => body[field] !== undefined);
  if (given.length !== 1) return false;
  const value = body[given[0]];
  if (!Array.isArray(value)) return false;
  if (given[0] === 'splitBetween') return value.every(member => typeof member === 'string');
  if (given[0] === 'splitExactly') {
    return value.every(line => isObject(line) && typeof line.memberId === 'string' && Number.isInteger(line.amount));
  }
  return value.every(line => isObject(line) && typeof line.memberId === 'string' && Number.isInteger(line.shares));
};

/** The split a body asks for, as the domain takes it. Only called on a body `hasSplitShape` has accepted. */
export const splitOf = (body: Record<string, unknown>): SplitRequest => {
  if (body.splitExactly !== undefined) {
    const lines = body.splitExactly as { memberId: string; amount: number }[];
    return { kind: 'exact', amounts: lines.map(({ memberId, amount }) => ({ memberId, amount })) };
  }
  if (body.splitByShares !== undefined) {
    const lines = body.splitByShares as { memberId: string; shares: number }[];
    return { kind: 'shares', shares: lines.map(({ memberId, shares }) => ({ memberId, shares })) };
  }
  return { kind: 'equal', memberIds: body.splitBetween as string[] };
};

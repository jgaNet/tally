/**
 * A notice as a person reads it: which group it is about, the amount, and when it was made. An expense's notice names its expense,
 * and their share of it; a reminder (ADR 10) names no expense, and the amount is what they still owe in the group.
 */
export type NoticeReadModel =
  | { id: string; kind: 'expense'; groupId: string; expenseId: string; amount: number; at: string }
  | { id: string; kind: 'reminder'; groupId: string; amount: number; at: string };

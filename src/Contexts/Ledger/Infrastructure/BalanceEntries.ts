import type { DatabaseSync } from 'node:sqlite';

/**
 * The expenses' part of each member's balance in a group, from the balance entries, on the connection given: a member
 * with no entry is absent (0). Shared by the queries outside a transaction and the reads inside a command's.
 */
export function entrySumsOf(connection: DatabaseSync, groupId: string): Map<string, number> {
  const rows = connection
    .prepare(
      'SELECT member_id AS memberId, SUM(amount) AS balance FROM ledger_balance_entries WHERE group_id = ? GROUP BY member_id',
    )
    .all(groupId) as { memberId: string; balance: number }[];
  return new Map(rows.map(row => [row.memberId, Number(row.balance)]));
}

/** The groups with a balance entry, on the connection given: every group that has an expense recorded. */
export function groupIdsOf(connection: DatabaseSync): string[] {
  const rows = connection
    .prepare('SELECT DISTINCT group_id AS groupId FROM ledger_balance_entries ORDER BY group_id')
    .all() as { groupId: string }[];
  return rows.map(row => row.groupId);
}

/** A balance is the expenses' part plus what the settlements paid to it (ADR 7): a member's balance, read by Ledger, counts both. */
export function withSettled(entries: Map<string, number>, settled: Map<string, number>): Map<string, number> {
  return addSums(entries, settled);
}

/** A balance also counts what passed to it, or from it, when a member left (request 20): a member's balance, read by Ledger, counts it. */
export function withPassed(entries: Map<string, number>, passed: Map<string, number>): Map<string, number> {
  return addSums(entries, passed);
}

function addSums(base: Map<string, number>, extra: Map<string, number>): Map<string, number> {
  const sums = new Map(base);
  for (const [memberId, amount] of extra) sums.set(memberId, (sums.get(memberId) ?? 0) + amount);
  return sums;
}

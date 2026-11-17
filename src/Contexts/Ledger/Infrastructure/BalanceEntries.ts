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

/** A balance is the expenses' part plus what the settlements paid to it (ADR 7): a member's balance, read by Ledger, counts both. */
export function withSettled(entries: Map<string, number>, settled: Map<string, number>): Map<string, number> {
  const sums = new Map(entries);
  for (const [memberId, amount] of settled) sums.set(memberId, (sums.get(memberId) ?? 0) + amount);
  return sums;
}

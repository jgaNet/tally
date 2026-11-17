import type { DatabaseSync } from 'node:sqlite';
import { findGroupOfMember, isOrWasMember } from './groups';
import { Refusal } from './refusal';
import { inReadSnapshot } from './transactions';

/**
 * One expense in a member's statement: what the member paid for it, their share of it (0 when they are
 * not in its split), and their balance once it is counted, starting from 0.
 */
export interface StatementEntry {
  readonly expenseId: string;
  readonly date: string;
  readonly description: string;
  readonly paid: number;
  readonly share: number;
  readonly balance: number;
}

/**
 * A member's statement: every expense of the group, not deleted, that the member paid or is in the split
 * of, in the order of a bank statement (the earliest date first, then the earliest recorded). `balance`
 * is the last entry's, or 0 with no entry, which is the member's balance in the group.
 */
export interface Statement {
  readonly memberId: string;
  readonly balance: number;
  readonly entries: readonly StatementEntry[];
}

interface StatementRow {
  id: string;
  spent_on: string;
  description: string;
  amount: number;
  paid_by: string;
  share: number | null;
}

/**
 * The statement of `memberId` in the group, read by `readerId`, who must be a current member of the group
 * (else `404`, as if the group did not exist). `memberId` must be a member of the group, or have left it (else `404`).
 * It reads one consistent state of the file and changes nothing.
 */
export function statementOfMember(db: DatabaseSync, readerId: string, groupId: string, memberId: string): Statement {
  return inReadSnapshot(db, () => {
    if (!findGroupOfMember(db, readerId, groupId)) {
      throw new Refusal(404, 'GroupNotFound', 'No group has this id.');
    }
    // A member who left keeps a statement, read by the group's current members.
    if (!isOrWasMember(db, memberId, groupId)) {
      throw new Refusal(404, 'MemberNotFound', 'No member of the group has this id.');
    }
    // The share is joined on the member alone, so each expense appears once: a member is listed once in a split.
    const rows = db
      .prepare(
        `SELECT e.id, e.spent_on, e.description, e.amount, e.paid_by, s.amount AS share
         FROM expenses e
         LEFT JOIN expense_shares s ON s.expense_id = e.id AND s.member_id = ?
         WHERE e.group_id = ? AND (e.paid_by = ? OR s.member_id IS NOT NULL)
         ORDER BY e.spent_on ASC, e.created_at ASC, e.rowid ASC`,
      )
      .all(memberId, groupId, memberId) as unknown as StatementRow[];
    let balance = 0;
    const entries = rows.map(row => {
      const paid = row.paid_by === memberId ? Number(row.amount) : 0;
      const share = row.share === null ? 0 : Number(row.share);
      balance += paid - share;
      return {
        expenseId: row.id,
        date: row.spent_on,
        description: row.description,
        paid,
        share,
        balance,
      };
    });
    return { memberId, balance, entries };
  });
}

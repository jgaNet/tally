import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database, Queryable } from './database';
import { type Expense, type ExpenseRow, expenseOf, expenseSchema } from './expenses';
import { findGroupOf } from './groups';
import { hasBeenMember } from './members';
import { Refusal } from './refusal';
import type { SettlementMethod } from './settlements';
import { requireCaller } from './sessions';

/** One row per share of an expense, with the expense's own fields repeated on each of its rows. */
interface GroupExpenseRow extends ExpenseRow {
  share_member: string;
  share_amount: number;
}

/** What an entry of a statement says of an expense: its id, its date and description, what the member paid and their share. */
interface ExpenseEntryBody {
  kind: 'expense';
  expenseId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
}

/** What an entry of a statement says of a settlement the balances count, the same way as an expense's. */
interface SettlementEntryBody {
  kind: 'settlement';
  settlementId: string;
  date: string;
  description: string;
  paid: number;
  share: number;
}

/** One entry of a statement, with the member's balance once it is counted. */
export type StatementEntry = (ExpenseEntryBody | SettlementEntryBody) & { balance: number };

export interface Statement {
  memberId: string;
  balance: number;
  entries: StatementEntry[];
}

interface StatementRow {
  expense_id: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  recorded_at: string;
}

interface SettlementStatementRow {
  settlement_id: string;
  method: SettlementMethod;
  payer_id: string;
  settled: number;
  counted_at: string;
}

/** An entry as the statement orders it: by its date, then by the moment it was recorded or the balances counted it. */
interface Ordered {
  date: string;
  moment: string;
  body: ExpenseEntryBody | SettlementEntryBody;
}

/**
 * The expenses of the group that are not deleted, the latest date first; on the same date, the most
 * recently recorded first. An edit keeps the moment an expense was recorded, so it keeps its place.
 * Each expense is read as `findExpenseOf` reads it. The rows come from one statement, so the list is of
 * one snapshot of the database.
 */
export async function listExpenses(db: Queryable, groupId: string): Promise<Expense[]> {
  // Every expense has a share: its payer is in its split. Its shares come in the order of their split.
  const rows = await db.all<GroupExpenseRow>(
    `SELECT e.id, e.group_id, e.description, e.amount, e.date, e.paid_by, e.split_kind, e.category, e.version,
       e.original_currency, e.original_amount, e.original_rate,
       s.account_id AS share_member, s.amount AS share_amount
     FROM expenses e JOIN expense_shares s ON s.expense_id = e.id
     WHERE e.group_id = ?
     ORDER BY e.date DESC, e.created_at DESC, e.seq DESC, s.position`,
    [groupId],
  );
  const expenses: Expense[] = [];
  let current: Expense | undefined;
  for (const row of rows) {
    if (current?.id !== row.id) {
      current = expenseOf(row, []);
      expenses.push(current);
    }
    current.shares.push({ memberId: row.share_member, amount: row.share_amount });
  }
  return expenses;
}

const SETTLEMENT_DESCRIPTIONS: Record<SettlementMethod, string> = {
  cash: 'Settlement in cash',
  provider: 'Settlement through the provider',
  net: 'Settlement by netting',
};

/**
 * The statement of a member of the group: every expense of the group that is not deleted and that the member
 * paid or is in the split of, and every settlement the member paid or received that the balances count, the
 * earliest date first; on the same date, the earliest first, an expense by when it was recorded and a settlement
 * by when the balances started to count it. A settlement is dated by the day, in UTC, the balances started to
 * count it. Each entry's balance is the one before it plus what the member paid minus their share, starting from
 * 0. The statement's balance is the last entry's, or 0 when it has none. One statement reads the entries, so
 * they are of one snapshot of the database. A read changes nothing.
 */
export async function statementOf(db: Queryable, groupId: string, memberId: string): Promise<Statement> {
  const expenseRows = await db.all<StatementRow>(
    `SELECT e.id AS expense_id, e.date, e.description, e.created_at AS recorded_at,
       CASE WHEN e.paid_by = ? THEN e.amount ELSE 0 END AS paid,
       COALESCE((SELECT s.amount FROM expense_shares s
                 WHERE s.expense_id = e.id AND s.account_id = ?), 0) AS share
     FROM expenses e
     WHERE e.group_id = ?
       AND (e.paid_by = ? OR EXISTS (SELECT 1 FROM expense_shares s
                                     WHERE s.expense_id = e.id AND s.account_id = ?))
     ORDER BY e.date ASC, e.created_at ASC, e.seq ASC`,
    [memberId, memberId, groupId, memberId, memberId],
  );
  // The settlements the balances count: paid, or being refunded. The moment they started to count is the first
  // history entry that counts them, which a cash settlement has from when it is recorded.
  const settlementRows = await db.all<SettlementStatementRow>(
    `SELECT t.id AS settlement_id, t.method, t.payer_id, t.settled,
       COALESCE((SELECT h.at FROM settlement_history h
                 WHERE h.settlement_id = t.id AND h.status IN ('paid', 'refunding')
                 ORDER BY h.seq LIMIT 1), t.created_at) AS counted_at
     FROM settlements t
     WHERE t.group_id = ? AND t.status IN ('paid', 'refunding') AND (t.payer_id = ? OR t.payee_id = ?)`,
    [groupId, memberId, memberId],
  );
  const ordered: Ordered[] = [
    ...expenseRows.map(row => ({
      date: row.date,
      moment: row.recorded_at,
      body: {
        kind: 'expense' as const,
        expenseId: row.expense_id,
        date: row.date,
        description: row.description,
        paid: row.paid,
        share: row.share,
      },
    })),
    ...settlementRows.map(row => {
      const paid = row.payer_id === memberId;
      return {
        date: row.counted_at.slice(0, 10),
        moment: row.counted_at,
        body: {
          kind: 'settlement' as const,
          settlementId: row.settlement_id,
          date: row.counted_at.slice(0, 10),
          description: SETTLEMENT_DESCRIPTIONS[row.method],
          paid: paid ? row.settled : 0,
          share: paid ? 0 : row.settled,
        },
      };
    }),
  ];
  // The sort is stable: on a tie, the expenses come first, in the order the query gave them.
  ordered.sort((a, b) => compareText(a.date, b.date) || compareText(a.moment, b.moment));
  let balance = 0;
  const entries = ordered.map(({ body }): StatementEntry => {
    balance += body.paid - body.share;
    return { ...body, balance };
  });
  return { memberId, balance: entries.at(-1)?.balance ?? 0, entries };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The header line of the statement as CSV: its columns, in the order they are written. */
const CSV_HEADER = 'date,kind,id,description,paid,share,balance';

/** A CSV field: written between double quotes, each double quote doubled, when it holds a comma, a quote or a line break. */
function csvField(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The statement as CSV: a header line, then a line for each entry, in the order of the statement, each ending in CRLF. */
export function statementCsv(statement: Statement): string {
  const lines = statement.entries.map(entry =>
    [
      entry.date,
      entry.kind,
      entry.kind === 'expense' ? entry.expenseId : entry.settlementId,
      entry.description,
      entry.paid,
      entry.share,
      entry.balance,
    ]
      .map(csvField)
      .join(','),
  );
  return [CSV_HEADER, ...lines].map(line => `${line}\r\n`).join('');
}

const entrySchema = {
  type: 'object',
  required: ['kind', 'date', 'description', 'paid', 'share', 'balance'],
  properties: {
    kind: { type: 'string', enum: ['expense', 'settlement'] },
    expenseId: { type: 'string' },
    settlementId: { type: 'string' },
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    description: { type: 'string' },
    paid: { type: 'integer' },
    share: { type: 'integer' },
    balance: { type: 'integer' },
  },
};

const statementSchema = {
  type: 'object',
  required: ['memberId', 'balance', 'entries'],
  properties: {
    memberId: { type: 'string' },
    balance: { type: 'integer' },
    entries: { type: 'array', items: entrySchema },
  },
};

/**
 * The expenses of a group and the statements of its members are read by the members of the group. For
 * anyone else the group does not exist; a member who has never been in the group does not exist either.
 * A member who has left the group keeps their statement, which the members of the group can still read.
 */
export function registerHistoryRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/expenses',
    { schema: { response: { 200: { type: 'array', items: expenseSchema } } } },
    async request => {
      const accountId = await requireCaller(db, request);
      if (!(await findGroupOf(db, accountId, request.params.id))) {
        throw new Refusal(404, 'NotFound', 'There is no such group.');
      }
      return listExpenses(db, request.params.id);
    },
  );

  const statementRoute = async (
    db: Database,
    request: FastifyRequest<{ Params: { id: string; memberId: string } }>,
  ) => {
    const accountId = await requireCaller(db, request);
    const groupId = request.params.id;
    if (!(await findGroupOf(db, accountId, groupId))) throw new Refusal(404, 'NotFound', 'There is no such group.');
    if (!(await hasBeenMember(db, groupId, request.params.memberId))) {
      throw new Refusal(404, 'NotFound', 'There is no such member of the group.');
    }
    return statementOf(db, groupId, request.params.memberId);
  };

  app.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement',
    { schema: { response: { 200: statementSchema } } },
    request => statementRoute(db, request),
  );

  app.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement.csv',
    async (request, reply) => reply.type('text/csv').send(statementCsv(await statementRoute(db, request))),
  );
}

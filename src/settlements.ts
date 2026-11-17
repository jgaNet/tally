import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { type Balance, listBalances } from './balances';
import { inTransaction } from './database';
import { findGroupOf } from './groups';
import { isMember } from './members';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/** One transfer that brings a balance to 0: `from` pays `to` the `amount`. Both are members' account ids. */
export interface Transfer {
  from: string;
  to: string;
  amount: number;
}

/**
 * The transfers that bring every balance to 0, made by this algorithm, so that every member reads the same
 * transfers:
 *  1. Start from the balances, given in the order the members joined, the earliest first.
 *  2. Take the member who owes the most (the lowest balance) and the member who is owed the most (the
 *     highest balance). Among members who owe, or are owed, the same, the one who joined first is taken.
 *  3. The first pays the second the smaller of what the first owes and what the second is owed: one
 *     transfer. Both balances move by its amount.
 *  4. Repeat from 2 until every balance is 0.
 *
 * The transfers are listed in the order they were made. Each one leaves a balance at 0, so there are never
 * more transfers than the members whose balance is not 0, less one. It only computes: the balances are not
 * changed.
 */
export function suggestSettlements(balances: Balance[]): Transfer[] {
  // The working balances, by position in the order of joining; the positions keep the tie-breaks.
  const owing = balances.map(row => ({ memberId: row.memberId, balance: row.balance }));
  const transfers: Transfer[] = [];
  for (;;) {
    // The earliest position wins a tie, because the comparison is strict.
    let debtor = -1;
    let creditor = -1;
    owing.forEach((row, position) => {
      if (row.balance < 0 && (debtor === -1 || row.balance < owing[debtor].balance)) debtor = position;
      if (row.balance > 0 && (creditor === -1 || row.balance > owing[creditor].balance)) creditor = position;
    });
    if (debtor === -1 || creditor === -1) return transfers;

    const amount = Math.min(-owing[debtor].balance, owing[creditor].balance);
    owing[debtor].balance += amount;
    owing[creditor].balance -= amount;
    transfers.push({ from: owing[debtor].memberId, to: owing[creditor].memberId, amount });
  }
}

/** A settlement as it is read: the payer `from` paid the payee `to` the `amount`, in cash, when it was recorded at `at`. */
export interface Settlement {
  id: string;
  groupId: string;
  from: string;
  to: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  at: string;
}

/** What the payee records: the payer's account id, and the amount in hundredths of the group's currency. */
export interface NewCashSettlement {
  from: string;
  amount: number;
}

interface SettlementRow {
  id: string;
  group_id: string;
  payer_id: string;
  payee_id: string;
  amount: number;
  method: 'cash';
  status: 'paid';
  created_at: string;
}

/** A refusal of a rule that is about the settlement, not about the shape of the request. */
function refuse(statusCode: number, type: string, message: string): never {
  throw new Refusal(statusCode, type, message);
}

/**
 * Records that the payer `from` paid the account, the payee, the amount in cash, and returns its id. The
 * payee is the account that records it, and must be a member of the group; for anyone else the group does
 * not exist. The payer must be another member of the group.
 *
 * The amount is at least 1, and never more than the payer owes the group (the opposite of their balance)
 * nor more than the payee is owed (their balance), on the balances as they are at the moment. Otherwise it
 * is refused and nothing is written. The balances are read and the settlement written in one write
 * transaction, which waits for the write lock, so two settlements recorded at once are decided one after
 * the other, each on the balances the other left.
 */
export function recordCashSettlement(
  db: DatabaseSync,
  payeeId: string,
  groupId: string,
  input: NewCashSettlement,
): string {
  const id = randomUUID();
  inTransaction(db, () => {
    if (!findGroupOf(db, payeeId, groupId)) throw new Refusal(404, 'NotFound', 'There is no such group.');
    if (!Number.isInteger(input.amount) || input.amount < 1) {
      refuse(422, 'InvalidAmount', 'The amount of a settlement is a whole number, at least 1.');
    }
    if (input.from === payeeId || !isMember(db, groupId, input.from)) {
      refuse(422, 'InvalidPayer', 'The payer must be another member of the group.');
    }
    const balances = listBalances(db, groupId);
    const payerBalance = balances.find(row => row.memberId === input.from)?.balance ?? 0;
    const payeeBalance = balances.find(row => row.memberId === payeeId)?.balance ?? 0;
    if (input.amount > -payerBalance) {
      refuse(409, 'AmountTooLarge', 'The payer does not owe the group that much.');
    }
    if (input.amount > payeeBalance) {
      refuse(409, 'AmountTooLarge', 'The payee is not owed that much by the group.');
    }
    db.prepare(
      `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'cash', 'paid', ?)`,
    ).run(id, groupId, input.from, payeeId, input.amount, new Date().toISOString());
  });
  return id;
}

/** The settlement, when the account is a member of its group. For anyone else it does not exist. */
export function findSettlementOf(db: DatabaseSync, accountId: string, settlementId: string): Settlement | undefined {
  const row = db
    .prepare(
      `SELECT t.id, t.group_id, t.payer_id, t.payee_id, t.amount, t.method, t.status, t.created_at
       FROM settlements t JOIN group_members m ON m.group_id = t.group_id
       WHERE t.id = ? AND m.account_id = ? AND m.left_at IS NULL`,
    )
    .get(settlementId, accountId) as SettlementRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    groupId: row.group_id,
    from: row.payer_id,
    to: row.payee_id,
    amount: row.amount,
    method: row.method,
    status: row.status,
    at: row.created_at,
  };
}

const transferSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'integer' } },
};

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

const settlementSchema = {
  type: 'object',
  required: ['id', 'groupId', 'from', 'to', 'amount', 'method', 'status', 'at'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer', minimum: 1 },
    method: { enum: ['cash'] },
    status: { enum: ['paid'] },
    at: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]00:?00)$' },
  },
};

/**
 * The suggested settlements are read by the members of the group. For anyone else the group does not exist.
 * A read changes nothing: the transfers are computed from the balances as the expenses and settlements make
 * them now.
 *
 * A cash settlement is recorded by its payee, a member of the group. A settlement is read by the members of
 * its group; for anyone else it does not exist.
 */
export function registerSettlementRoutes(app: FastifyInstance, db: DatabaseSync): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    { schema: { response: { 200: { type: 'array', items: transferSchema } } } },
    request => {
      const accountId = requireCaller(db, request);
      if (!findGroupOf(db, accountId, request.params.id)) throw new Refusal(404, 'NotFound', 'There is no such group.');
      return suggestSettlements(listBalances(db, request.params.id));
    },
  );

  app.post<{ Params: { id: string }; Body: NewCashSettlement }>(
    '/groups/:id/settlements/cash',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'amount'],
          properties: { from: { type: 'string' }, amount: { type: 'integer' } },
        },
        response: { 201: idSchema },
      },
    },
    (request, reply) => {
      const accountId = requireCaller(db, request);
      return reply.code(201).send({ id: recordCashSettlement(db, accountId, request.params.id, request.body) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/settlements/:id',
    { schema: { response: { 200: settlementSchema } } },
    request => {
      const accountId = requireCaller(db, request);
      const settlement = findSettlementOf(db, accountId, request.params.id);
      if (!settlement) throw new Refusal(404, 'NotFound', 'There is no such settlement.');
      return settlement;
    },
  );
}

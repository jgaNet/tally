import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { type Balance, listBalances } from './balances';
import { findGroupOf } from './groups';
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

const transferSchema = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'integer' } },
};

/**
 * The suggested settlements are read by the members of the group. For anyone else the group does not exist.
 * A read changes nothing: the transfers are computed from the balances as the expenses make them now.
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
}

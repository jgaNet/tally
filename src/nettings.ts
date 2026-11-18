import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { writeAudit } from './audit';
import { listBalancesIncludingWaiting } from './balances';
import type { Database, Queryable } from './database';
import { isDeleted } from './accounts';
import { CURRENCIES } from './groups';
import { Refusal } from './refusal';
import { addHistory } from './settlement-history';
import { requireCaller } from './sessions';
import { refuseIfSuspended } from './suspensions';

/** What the caller asks: netting what they and `with`, an account id, owe each other in `currency`. */
export interface NewNetting {
  with: string;
  currency: string;
}

/** A netting as it is read: who asked, with whom, in what currency, how much was netted, and its settlements, in the order made. */
export interface Netting {
  id: string;
  by: string;
  with: string;
  currency: string;
  amount: number;
  settlements: string[];
}

/** What the two can pay each other in one group of the currency: the caller to the other, and the other to the caller. */
interface GroupPlan {
  groupId: string;
  payCaller: number;
  payOther: number;
}

/**
 * What the two can pay each other in each group they are both members of now, in the currency, not archived, the earliest
 * created first. In a group the caller owes and the other is owed, the caller can pay the other the smaller of what the caller
 * still owes and what the other is still owed; the same, the other way round, for what the other can pay the caller. The
 * balances count the payments waiting at the provider as paid. A read changes nothing.
 */
async function groupPlansOf(db: Queryable, accountId: string, withId: string, currency: string): Promise<GroupPlan[]> {
  const groups = await db.all<{ id: string }>(
    `SELECT g.id FROM groups g
     JOIN group_members mine ON mine.group_id = g.id AND mine.account_id = ? AND mine.left_at IS NULL
     JOIN group_members theirs ON theirs.group_id = g.id AND theirs.account_id = ? AND theirs.left_at IS NULL
     WHERE g.currency = ? AND g.archived_at IS NULL AND g.merged_into IS NULL
     ORDER BY g.created_at ASC, g.seq ASC`,
    [accountId, withId, currency],
  );
  const plans: GroupPlan[] = [];
  for (const group of groups) {
    const balances = await listBalancesIncludingWaiting(db, group.id);
    const mine = balances.find(row => row.memberId === accountId)?.balance ?? 0;
    const theirs = balances.find(row => row.memberId === withId)?.balance ?? 0;
    plans.push({
      groupId: group.id,
      payCaller: mine < 0 && theirs > 0 ? Math.min(-mine, theirs) : 0,
      payOther: theirs < 0 && mine > 0 ? Math.min(-theirs, mine) : 0,
    });
  }
  return plans;
}

/**
 * Nets what the caller `accountId` and `input.with` owe each other in `input.currency`, across the groups they share now, and
 * returns the id of the netting. The amount netted is the smaller of what the caller can pay the other across the groups and
 * what the other can pay the caller. It is paid as settlements of their groups, one per group and direction, in the order the
 * groups were created: the caller pays the other the amount, group by group, in each the smaller of what is left to net and what
 * the caller can pay there; the other pays the caller the same, the same way. Each settlement is `paid` at once, with method
 * `net`, and is audited as `settlement-paid` by the caller. Nothing moves in money, and a netting is never refunded.
 *
 * Refused, and nothing changes, when the caller nets with themself (`SameAccount`), in a currency that is not Tally's
 * (`InvalidCurrency`), or when the two have nothing to net (`NothingToNet`). The groups are read and the settlements
 * written in one write transaction, so a netting or a settlement recorded meanwhile is seen, and no settlement pays more than
 * is still owed.
 */
export async function netAcrossGroups(db: Database, accountId: string, input: NewNetting): Promise<string> {
  await refuseIfSuspended(db, accountId);
  if (input.with === accountId) throw new Refusal(422, 'SameAccount', 'A netting is between two different people.');
  if (!(CURRENCIES as readonly string[]).includes(input.currency)) {
    throw new Refusal(422, 'InvalidCurrency', `The currency must be one of ${CURRENCIES.join(', ')}.`);
  }
  const id = randomUUID();
  await db.transaction(async tx => {
    await refuseIfSuspended(tx, accountId);
    // A deleted account is still a member of its groups, but nothing is netted with it.
    if (await isDeleted(tx, input.with)) {
      throw new Refusal(409, 'AccountDeleted', 'The other account has been deleted, so cannot be netted with.');
    }
    const plans = await groupPlansOf(tx, accountId, input.with, input.currency);
    const callerTotal = plans.reduce((sum, plan) => sum + plan.payCaller, 0);
    const otherTotal = plans.reduce((sum, plan) => sum + plan.payOther, 0);
    const amount = Math.min(callerTotal, otherTotal);
    if (amount === 0) throw new Refusal(409, 'NothingToNet', 'The two of them have nothing to net in that currency.');
    const at = new Date().toISOString();
    await tx.run('INSERT INTO nettings (id, by_id, with_id, currency, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      id,
      accountId,
      input.with,
      input.currency,
      amount,
      at,
    ]);
    // The caller's payments are made first, then the other's: each direction is netted up to the amount, group by group.
    const directions = [
      { payer: accountId, payee: input.with, capacity: (plan: GroupPlan) => plan.payCaller },
      { payer: input.with, payee: accountId, capacity: (plan: GroupPlan) => plan.payOther },
    ];
    for (const { payer, payee, capacity } of directions) {
      let left = amount;
      for (const plan of plans) {
        const pay = Math.min(left, capacity(plan));
        if (pay === 0) continue;
        left -= pay;
        const settlementId = randomUUID();
        await tx.run(
          `INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at, netting_id)
           VALUES (?, ?, ?, ?, ?, 'net', 'paid', ?, ?)`,
          [settlementId, plan.groupId, payer, payee, pay, at, id],
        );
        await addHistory(tx, settlementId, 'paid', at);
        await writeAudit(tx, plan.groupId, {
          by: accountId,
          action: 'settlement-paid',
          subjectId: settlementId,
          amount: pay,
          at,
        });
      }
    }
  });
  return id;
}

interface NettingRow {
  id: string;
  by_id: string;
  with_id: string;
  currency: string;
  amount: number;
}

/**
 * The netting, as one of the two people reads it, with its settlements in the order they were made. For anyone else it does
 * not exist. A read changes nothing.
 */
export async function findNettingOf(db: Queryable, accountId: string, nettingId: string): Promise<Netting | undefined> {
  const row = await db.get<NettingRow>(
    'SELECT id, by_id, with_id, currency, amount FROM nettings WHERE id = ? AND (by_id = ? OR with_id = ?)',
    [nettingId, accountId, accountId],
  );
  if (!row) return undefined;
  const settlements = await db.all<{ id: string }>('SELECT id FROM settlements WHERE netting_id = ? ORDER BY seq', [
    nettingId,
  ]);
  return {
    id: row.id,
    by: row.by_id,
    with: row.with_id,
    currency: row.currency,
    amount: row.amount,
    settlements: settlements.map(settlement => settlement.id),
  };
}

const idSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
};

const nettingSchema = {
  type: 'object',
  required: ['id', 'by', 'with', 'currency', 'amount', 'settlements'],
  properties: {
    id: { type: 'string' },
    by: { type: 'string' },
    with: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    amount: { type: 'integer', minimum: 1 },
    settlements: { type: 'array', minItems: 2, items: { type: 'string' } },
  },
};

export function registerNettingRoutes(app: FastifyInstance, db: Database): void {
  app.post<{ Body: NewNetting }>(
    '/nettings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['with', 'currency'],
          properties: { with: { type: 'string' }, currency: { type: 'string' } },
        },
        response: { 201: idSchema },
      },
    },
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      return reply.code(201).send({ id: await netAcrossGroups(db, accountId, request.body) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/nettings/:id',
    { schema: { response: { 200: nettingSchema } } },
    async request => {
      const accountId = await requireCaller(db, request);
      const netting = await findNettingOf(db, accountId, request.params.id);
      if (!netting) throw new Refusal(404, 'NotFound', 'There is no such netting.');
      return netting;
    },
  );
}

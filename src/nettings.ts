import { randomUUID } from 'node:crypto';
import { recordAudit } from './audit';
import { balancesOfGroup } from './balances';
import type { Database, Querier } from './database';
import { CURRENCIES } from './groups';
import { Refusal } from './refusal';
import { recordStatus } from './settlements';
import { inReadSnapshot, inTransaction } from './transactions';

/**
 * A netting as the two members read it: who asked, with whom, its currency, the amount netted, and its settlements,
 * in the order they were made.
 */
export interface Netting {
  readonly id: string;
  readonly by: string;
  readonly with: string;
  readonly currency: string;
  readonly amount: number;
  readonly settlements: readonly string[];
}

/**
 * What `payerBalance`'s member can pay `payeeBalance`'s member in one group: the smaller of what the payer owes and what
 * the payee is owed, when the payer owes and the payee is owed; 0 otherwise. Balances are as `balancesOfGroup` counts
 * them, a settlement waiting at the provider counted as paid.
 */
function payable(payerBalance: number, payeeBalance: number): number {
  return payerBalance < 0 && payeeBalance > 0 ? Math.min(-payerBalance, payeeBalance) : 0;
}

/**
 * The settlements that net `amount`, group by group in the order given: each pays the smaller of what is left to net
 * and what its payer can pay there. A group that pays nothing is left out.
 */
function planPayments(
  groups: readonly { groupId: string; payable: number }[],
  amount: number,
): { groupId: string; amount: number }[] {
  const plan: { groupId: string; amount: number }[] = [];
  let left = amount;
  for (const group of groups) {
    if (left === 0) break;
    const pay = Math.min(left, group.payable);
    if (pay > 0) {
      plan.push({ groupId: group.groupId, amount: pay });
      left -= pay;
    }
  }
  return plan;
}

/**
 * The groups both members are current members of, in the currency, not archived, the earliest created first.
 */
async function sharedGroupsOf(db: Querier, by: string, other: string, currency: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT g.id FROM groups g
       JOIN group_members mb ON mb.group_id = g.id AND mb.account_id = ? AND mb.left_at IS NULL
       JOIN group_members mo ON mo.group_id = g.id AND mo.account_id = ? AND mo.left_at IS NULL
       WHERE g.currency = ? AND g.archived_at IS NULL
       ORDER BY g.created_at ASC, g.seq ASC`,
    )
    .all<{ id: string }>(by, other, currency);
  return rows.map(row => row.id);
}

/**
 * Nets what `by` and `with` owe each other in `currency`, across every group they are both current members of, in that
 * currency and not archived, and answers the netting's id.
 *
 * What `by` can pay `with` is the sum over those groups of what `payable` gives; what `with` can pay `by` likewise. The
 * amount netted is the smaller of the two totals. It is refused with `409` as `NothingToNet` when it is 0, and nothing
 * changes. Otherwise a settlement is made for each group that pays, `by` paying `with` first, then `with` paying `by`, each
 * group by group, the earliest created first, every settlement `paid` at once with method `net` (no money moves), and
 * recorded in the audit as `settlement-paid` by `by`. Refused with `422` as `NettingWithSelf` when `with` is `by`, and as
 * `CurrencyIsUnsupported` when the currency is not one of Tally's.
 *
 * The balances are read and the settlements written in one transaction, so two nettings, or a netting and another
 * settlement, asked at the same moment are each decided on what the other left: no settlement pays more than is owed.
 */
export async function netBetween(db: Database, input: { by: string; with: string; currency: string }): Promise<string> {
  const { by, with: other, currency } = input;
  if (by === other) throw new Refusal(422, 'NettingWithSelf', 'A netting is between two different members.');
  if (!(CURRENCIES as readonly string[]).includes(currency)) {
    throw new Refusal(422, 'CurrencyIsUnsupported', `The currency must be one of ${CURRENCIES.join(', ')}.`);
  }
  const id = randomUUID();
  await inTransaction(db, async tx => {
    const byPays: { groupId: string; payable: number }[] = [];
    const otherPays: { groupId: string; payable: number }[] = [];
    for (const groupId of await sharedGroupsOf(tx, by, other, currency)) {
      const balances = await balancesOfGroup(tx, groupId, { includePending: true });
      const byBalance = balances.find(member => member.memberId === by)?.balance ?? 0;
      const otherBalance = balances.find(member => member.memberId === other)?.balance ?? 0;
      byPays.push({ groupId, payable: payable(byBalance, otherBalance) });
      otherPays.push({ groupId, payable: payable(otherBalance, byBalance) });
    }
    const total = (groups: { payable: number }[]) => groups.reduce((sum, group) => sum + group.payable, 0);
    const amount = Math.min(total(byPays), total(otherPays));
    if (amount === 0) {
      throw new Refusal(409, 'NothingToNet', 'The two members owe each other nothing to net in this currency.');
    }

    const at = new Date().toISOString();
    const settlements: string[] = [];
    const settle = async (payerId: string, payeeId: string, plan: { groupId: string; amount: number }[]) => {
      for (const step of plan) {
        const settlementId = randomUUID();
        await tx
          .prepare(
            'INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(settlementId, step.groupId, payerId, payeeId, step.amount, 'net', 'paid', at);
        await recordStatus(tx, settlementId, 'paid', at);
        await recordAudit(tx, {
          groupId: step.groupId,
          at,
          by,
          action: 'settlement-paid',
          subjectId: settlementId,
          amount: step.amount,
        });
        settlements.push(settlementId);
      }
    };
    await settle(by, other, planPayments(byPays, amount));
    await settle(other, by, planPayments(otherPays, amount));

    await tx
      .prepare('INSERT INTO nettings (id, by_id, with_id, currency, amount, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, by, other, currency, amount, at);
    for (const [position, settlementId] of settlements.entries()) {
      await tx
        .prepare('INSERT INTO netting_settlements (netting_id, position, settlement_id) VALUES (?, ?, ?)')
        .run(id, position, settlementId);
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
 * The netting with this id, when `readerId` is one of the two members it nets; `404` otherwise, as if it did not exist.
 * Reading one consistent state of the database, it changes nothing.
 */
export async function nettingOfMember(db: Database, readerId: string, nettingId: string): Promise<Netting> {
  return inReadSnapshot(db, async snapshot => {
    const row = await snapshot
      .prepare('SELECT id, by_id, with_id, currency, amount FROM nettings WHERE id = ? AND (by_id = ? OR with_id = ?)')
      .get<NettingRow>(nettingId, readerId, readerId);
    if (!row) throw new Refusal(404, 'NettingNotFound', 'No netting has this id.');
    const settlements = await snapshot
      .prepare('SELECT settlement_id FROM netting_settlements WHERE netting_id = ? ORDER BY position ASC')
      .all<{ settlement_id: string }>(nettingId);
    return {
      id: row.id,
      by: row.by_id,
      with: row.with_id,
      currency: row.currency,
      amount: Number(row.amount),
      settlements: settlements.map(settlement => settlement.settlement_id),
    };
  });
}

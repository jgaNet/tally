import type { FastifyInstance } from 'fastify';
import type { Database, Queryable } from './database';
import { findGroupOf, refuseIfArchived } from './groups';
import { Refusal } from './refusal';
import { requireCaller } from './sessions';

/**
 * Who bears the provider's fee of a group's settlements: `payer` (the fee is taken from what the payer's settlement
 * settles, so the payer still owes it), `payee` (the whole amount settles, so the payee loses the fee), or `shared`
 * (each bears half of it; when the fee is odd, the payee bears the extra hundredth).
 */
export const FEE_BEARERS = ['payer', 'payee', 'shared'] as const;
export type FeeBearer = (typeof FEE_BEARERS)[number];

/** The fee a settlement through the provider has, and who bore it, as it is read. A settlement asked for earlier has none. */
export interface SettlementFee {
  amount: number;
  borneBy: FeeBearer;
}

export function isFeeBearer(value: unknown): value is FeeBearer {
  return typeof value === 'string' && (FEE_BEARERS as readonly string[]).includes(value);
}

/** Who bears the provider's fee in the group: the payee, until its owner decides otherwise. */
export async function feeBorneByOf(db: Queryable, groupId: string): Promise<FeeBearer> {
  const row = await db.get<{ fee_borne_by: FeeBearer }>('SELECT fee_borne_by FROM groups WHERE id = ?', [groupId]);
  return row?.fee_borne_by ?? 'payee';
}

/**
 * Sets who bears the provider's fee of the group's settlements, asked for from now on: a settlement already asked for keeps
 * who bore its fee when its payment was asked. Only the owner of the group may set it; a member who is not the owner is
 * refused with `NotAllowed`, and for anyone else the group does not exist. An archived group is read only, and a merged one
 * does not exist any more, as for any other change.
 */
export async function setFeePolicy(db: Database, accountId: string, groupId: string, borneBy: string): Promise<void> {
  await db.transaction(async tx => {
    const group = await findGroupOf(tx, accountId, groupId);
    if (!group) throw new Refusal(404, 'NotFound', 'There is no such group.');
    await refuseIfArchived(tx, groupId);
    if (group.ownerId !== accountId) {
      throw new Refusal(403, 'NotAllowed', "Only the owner of the group may set who bears the provider's fee.");
    }
    if (!isFeeBearer(borneBy)) {
      throw new Refusal(422, 'InvalidFeeBearer', `The fee is borne by ${FEE_BEARERS.join(', ')}.`);
    }
    await tx.run('UPDATE groups SET fee_borne_by = ? WHERE id = ?', [borneBy, groupId]);
  });
}

/** The fee policy is read by the members of the group. For anyone else the group does not exist. */
export function registerFeePolicyRoutes(app: FastifyInstance, db: Database): void {
  app.get<{ Params: { id: string } }>(
    '/groups/:id/fee-policy',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['borneBy'],
            properties: { borneBy: { enum: [...FEE_BEARERS] } },
          },
        },
      },
    },
    async request => {
      const accountId = await requireCaller(db, request);
      if (!(await findGroupOf(db, accountId, request.params.id))) {
        throw new Refusal(404, 'NotFound', 'There is no such group.');
      }
      return { borneBy: await feeBorneByOf(db, request.params.id) };
    },
  );

  app.put<{ Params: { id: string }; Body: { borneBy: string } }>(
    '/groups/:id/fee-policy',
    {
      schema: {
        body: {
          type: 'object',
          required: ['borneBy'],
          properties: { borneBy: { type: 'string' } },
        },
      },
    },
    async (request, reply) => {
      const accountId = await requireCaller(db, request);
      await setFeePolicy(db, accountId, request.params.id, request.body.borneBy);
      return reply.code(204).send();
    },
  );
}

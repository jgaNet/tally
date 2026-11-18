import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { requireCaller } from '../http';
import { Refusal } from '../refusal';
import type { ProviderConfig } from '../provider';
import {
  findSettlementOfMember,
  recordCashSettlement,
  refundSettlement,
  requestProviderSettlement,
  settlementsOfGroup,
  suggestedSettlement,
} from '../settlements';

interface RecordCashSettlementBody {
  from: string;
  amount: number;
}

interface RequestProviderSettlementBody {
  to: string;
  amount: number;
}

/** Only the shape is checked here (a missing or wrongly typed field is `400`); the values are checked by the rules. */
const RECORD_CASH_SETTLEMENT_BODY = {
  type: 'object',
  required: ['from', 'amount'],
  properties: { from: { type: 'string' }, amount: { type: 'number' } },
};

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

/** Only the shape is checked here (a missing or wrongly typed field is `400`); the values are checked by the rules. */
const REQUEST_PROVIDER_SETTLEMENT_BODY = {
  type: 'object',
  required: ['to', 'amount'],
  properties: { to: { type: 'string' }, amount: { type: 'number' } },
};

const SETTLEMENT = {
  type: 'object',
  required: ['id', 'groupId', 'from', 'to', 'amount', 'method', 'status', 'at', 'history'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer' },
    method: { enum: ['cash', 'provider', 'net'] },
    status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded'] },
    at: { type: 'string' },
    payUrl: { type: 'string' },
    history: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['status', 'at'],
        properties: {
          status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded'] },
          at: { type: 'string' },
        },
      },
    },
  },
};

const TRANSFER = {
  type: 'object',
  required: ['from', 'to', 'amount'],
  properties: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'integer' } },
};

export function registerSettlementRoutes(server: FastifyInstance, db: Database, provider: ProviderConfig): void {
  // Only a current member of the group lists its settlements; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/settlements',
    { schema: { response: { 200: { type: 'array', items: SETTLEMENT } } } },
    async request => {
      const caller = await requireCaller(db, request);
      return await settlementsOfGroup(db, caller.id, request.params.id);
    },
  );

  // Only a member of the group reads its suggested settlement; to anyone else the group does not exist.
  server.get<{ Params: { id: string } }>(
    '/groups/:id/settlements/suggested',
    { schema: { response: { 200: { type: 'array', items: TRANSFER } } } },
    async request => {
      const caller = await requireCaller(db, request);
      return await suggestedSettlement(db, caller.id, request.params.id);
    },
  );

  // The payee is the caller, who records the cash it was paid; a caller who is not a member sees no group.
  server.post<{ Params: { id: string }; Body: RecordCashSettlementBody }>(
    '/groups/:id/settlements/cash',
    { schema: { body: RECORD_CASH_SETTLEMENT_BODY, response: { 201: ID } } },
    async (request, reply) => {
      const caller = await requireCaller(db, request);
      const id = await recordCashSettlement(db, {
        groupId: request.params.id,
        payeeId: caller.id,
        payerId: request.body.from,
        amount: request.body.amount,
      });
      return reply.code(201).send({ id });
    },
  );

  // The payer is the caller, who asks the provider for a payment link to the payee; a caller who is not a member sees no group.
  server.post<{ Params: { id: string }; Body: RequestProviderSettlementBody }>(
    '/groups/:id/settlements/provider',
    { schema: { body: REQUEST_PROVIDER_SETTLEMENT_BODY, response: { 201: ID } } },
    async (request, reply) => {
      const caller = await requireCaller(db, request);
      const id = await requestProviderSettlement(db, provider, {
        groupId: request.params.id,
        payerId: caller.id,
        payeeId: request.body.to,
        amount: request.body.amount,
      });
      return reply.code(201).send({ id });
    },
  );

  // The payee is the caller, who asks the provider to refund the settlement; a caller who is not a member sees no settlement.
  server.post<{ Params: { id: string } }>('/settlements/:id/refund', async (request, reply) => {
    const caller = await requireCaller(db, request);
    await refundSettlement(db, provider, { settlementId: request.params.id, accountId: caller.id });
    return reply.code(204).send();
  });

  // Only a current member of the settlement's group reads it; to anyone else it does not exist.
  server.get<{ Params: { id: string } }>(
    '/settlements/:id',
    { schema: { response: { 200: SETTLEMENT } } },
    async request => {
      const caller = await requireCaller(db, request);
      const settlement = await findSettlementOfMember(db, caller.id, request.params.id);
      if (!settlement) throw new Refusal(404, 'SettlementNotFound', 'No settlement has this id.');
      return settlement;
    },
  );
}

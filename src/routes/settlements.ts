import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { CURRENCIES } from '../groups';
import { requireCaller } from '../http';
import { Refusal } from '../refusal';
import type { ProviderConfig } from '../provider';
import type { RatesConfig } from '../rates';
import {
  contestSettlement,
  findSettlementOfMember,
  recordCashSettlement,
  refundSettlement,
  requestProviderSettlement,
  type SettlementAmount,
  settlementsOfGroup,
  suggestedSettlement,
} from '../settlements';

/** A settlement paid in another currency: its currency, and the amount in it, in hundredths. */
interface OriginalBody {
  currency: string;
  amount: number;
}

/** The amount a body gives: `amount` in the group's currency, or `original`, in another currency: exactly one of them. */
interface AmountBody {
  amount?: number;
  original?: OriginalBody;
}

interface RecordCashSettlementBody extends AmountBody {
  from: string;
}

interface RequestProviderSettlementBody extends AmountBody {
  to: string;
}

const ID = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };

const ORIGINAL = {
  type: 'object',
  required: ['currency', 'amount'],
  properties: { currency: { type: 'string' }, amount: { type: 'number' } },
};

/**
 * Only the shape is checked here (a missing or wrongly typed field is `400`, and so is a body that names neither `amount`
 * nor `original`, or both); the values are checked by the rules. A rate in the body is not read: the rate is the rates service's.
 */
const RECORD_CASH_SETTLEMENT_BODY = {
  type: 'object',
  required: ['from'],
  properties: { from: { type: 'string' }, amount: { type: 'number' }, original: ORIGINAL },
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
};

/** Only the shape is checked here, as {@link RECORD_CASH_SETTLEMENT_BODY} does; the values are checked by the rules. */
const REQUEST_PROVIDER_SETTLEMENT_BODY = {
  type: 'object',
  required: ['to'],
  properties: { to: { type: 'string' }, amount: { type: 'number' }, original: ORIGINAL },
  oneOf: [{ required: ['amount'] }, { required: ['original'] }],
};

/** What a body asks for: `original` when it names one, else `amount` (the schema has checked that it names exactly one). */
function amountOf(body: AmountBody): SettlementAmount {
  if (body.original) return { kind: 'original', currency: body.original.currency, amount: body.original.amount };
  return { kind: 'group', amount: body.amount as number };
}

/** A settlement, as a member of its group reads it, and as an administrator reads a contested one. */
export const SETTLEMENT = {
  type: 'object',
  required: ['id', 'groupId', 'from', 'to', 'amount', 'method', 'status', 'at', 'history'],
  properties: {
    id: { type: 'string' },
    groupId: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    amount: { type: 'integer' },
    method: { enum: ['cash', 'provider', 'net'] },
    status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'] },
    at: { type: 'string' },
    payUrl: { type: 'string' },
    // Only a settlement through the provider asked for from request 38 on has it.
    fee: {
      type: 'object',
      required: ['amount', 'borneBy'],
      properties: { amount: { type: 'integer', minimum: 0 }, borneBy: { enum: ['payer', 'payee', 'shared'] } },
    },
    // Only a settlement paid in another currency (request 39) has it: what it was paid in, at the rate decided then.
    original: {
      type: 'object',
      required: ['currency', 'amount', 'rate'],
      properties: {
        currency: { enum: [...CURRENCIES] },
        amount: { type: 'integer', minimum: 1 },
        rate: { type: 'string', pattern: '^\\d+(\\.\\d{1,6})?$' },
      },
    },
    history: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['status', 'at'],
        properties: {
          status: { enum: ['pending', 'paid', 'failed', 'refunding', 'refunded', 'contested', 'annulled'] },
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

export function registerSettlementRoutes(
  server: FastifyInstance,
  db: Database,
  provider: ProviderConfig,
  rates: RatesConfig,
): void {
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
      const id = await recordCashSettlement(db, rates, {
        groupId: request.params.id,
        payeeId: caller.id,
        payerId: request.body.from,
        amount: amountOf(request.body),
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
      const id = await requestProviderSettlement(db, provider, rates, {
        groupId: request.params.id,
        payerId: caller.id,
        payeeId: request.body.to,
        amount: amountOf(request.body),
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

  // The payee is the caller, who says the money did not reach them; a caller who is not a member sees no settlement.
  server.post<{ Params: { id: string } }>('/settlements/:id/contest', async (request, reply) => {
    const caller = await requireCaller(db, request);
    await contestSettlement(db, { settlementId: request.params.id, accountId: caller.id });
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

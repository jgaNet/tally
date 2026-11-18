import type { FastifyInstance } from 'fastify';
import type { Database } from '../database';
import { CURRENCIES } from '../groups';
import { requireCaller } from '../http';
import { ratesOfferedToGroup, type RatesConfig } from '../rates';

/** Only the shape is checked here (a `date` that is not a string is `400`); the day is checked by the rules. */
const QUERY = {
  type: 'object',
  properties: { date: { type: 'string' } },
};

/** The rate offered from a currency to the group's on a day: the currency, the day, and what one of it is worth. */
const RATE = {
  type: 'object',
  required: ['currency', 'date', 'rate'],
  properties: {
    currency: { enum: [...CURRENCIES] },
    date: { type: 'string' },
    rate: { type: 'string' },
  },
};

export function registerRateRoutes(server: FastifyInstance, db: Database, rates: RatesConfig): void {
  // Only a member of the group reads the rate offered to it; to anyone else the group does not exist. A read: the
  // rate is asked of the rates service and nothing is kept.
  server.get<{ Params: { id: string; currency: string }; Querystring: { date?: string } }>(
    '/groups/:id/rates/:currency',
    { schema: { querystring: QUERY, response: { 200: RATE } } },
    async request => {
      const caller = await requireCaller(db, request);
      return await ratesOfferedToGroup(db, rates, {
        accountId: caller.id,
        groupId: request.params.id,
        currency: request.params.currency,
        date: request.query.date,
      });
    },
  );
}

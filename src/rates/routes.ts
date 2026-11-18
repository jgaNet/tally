import type { FastifyInstance } from 'fastify';
import { requireAccount } from '../auth';
import type { Database } from '../database';
import { requireMembership } from '../groups/groups';
import { CURRENCIES } from '../groups/validation';
import { isAcceptableDate, isOtherCurrency, todayInUtc } from '../expenses/validation';
import { Refusal } from '../refusal';
import { type RatesConfig, offeredRate } from './rates';

const rateSchema = {
  type: 'object',
  required: ['currency', 'date', 'rate'],
  properties: {
    currency: { type: 'string', enum: [...CURRENCIES] },
    date: { type: 'string' },
    rate: { type: 'string' },
  },
};

export function registerRateRoutes(app: FastifyInstance, db: Database, rates: RatesConfig): void {
  app.get<{ Params: { id: string; currency: string }; Querystring: { date?: string } }>(
    '/groups/:id/rates/:currency',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'currency'],
          properties: { id: { type: 'string' }, currency: { type: 'string' } },
        },
        querystring: { type: 'object', properties: { date: { type: 'string' } } },
        response: { 200: rateSchema },
      },
    },
    async request => {
      const account = await requireAccount(db, request);
      // Only the members of a group see its rates; anyone else is told it does not exist.
      const group = await requireMembership(db, request.params.id, account.id);
      const { currency } = request.params;
      const date = request.query.date ?? todayInUtc();
      if (!isOtherCurrency(currency, group.currency)) {
        throw new Refusal(404, 'NoRateOffered', "No rate is offered from that currency to the group's currency.");
      }
      if (!isAcceptableDate(date)) {
        throw new Refusal(
          422,
          'InvalidDate',
          'The date must be a day of the calendar, written YYYY-MM-DD, and not after today (UTC).',
        );
      }
      const rate = await offeredRate(rates, currency, group.currency, date);
      if (rate === undefined) {
        throw new Refusal(404, 'NoRateOffered', 'No rate is offered for that currency on that day.');
      }
      return { currency, date, rate };
    },
  );
}

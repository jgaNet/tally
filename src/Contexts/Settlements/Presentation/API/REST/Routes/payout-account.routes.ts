import { FastifyInstance } from 'fastify';

import { Module } from '@Architecture/Application';

import { FastifyPayoutAccountController } from '@Contexts/Settlements/Presentation/API/REST/Controllers/FastifyPayoutAccountController';
import {
  GetPayoutAccountResSchema,
  SetPayoutAccountBodySchema,
} from '@Contexts/Settlements/Presentation/API/REST/Routes/payout-account.routes.schema';
import { LaterCommandResSchema } from '@Contexts/Settlements/Presentation/API/REST/Routes/settlement.routes.schema';

export const payoutAccountRoutes = function (
  fastify: FastifyInstance,
  { settlementsModule }: { settlementsModule: Module },
  done: () => void,
) {
  const controller = new FastifyPayoutAccountController({ module: settlementsModule });

  // The whole paths, registered at the API's root beside the accounts' (the client reads a person's payout account under them).
  // Answered 202 and read at the operation: the provider is asked whether it knows the account (request 16).
  fastify.put(
    '/accounts/me/payout-account',
    { schema: { tags: ['accounts'], body: SetPayoutAccountBodySchema, response: LaterCommandResSchema } },
    controller.setPayoutAccount.bind(controller),
  );

  fastify.get(
    '/accounts/me/payout-account',
    { schema: { tags: ['accounts'], response: GetPayoutAccountResSchema } },
    controller.getPayoutAccount.bind(controller),
  );

  done();
};

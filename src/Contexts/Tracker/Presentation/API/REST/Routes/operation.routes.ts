import { FastifyInstance } from 'fastify';

import { FastifyOperationController } from '@Contexts/Tracker/Presentation/API/REST/Controllers/FastifyOperationController';
import { Module } from '@Architecture/Application';
import { GetOperationResSchema } from '@Contexts/Tracker/Presentation/API/REST/Routes/operation.routes.schema';

/** `GET /v1/operations/{operationId}`: the one route the API gives an operation (api/1-accounts.yaml). */
export const operationRoutes = function (
  fastify: FastifyInstance,
  { operationsModule }: { operationsModule: Module },
  done: () => void,
) {
  const operationController = new FastifyOperationController({ module: operationsModule });

  fastify.get(
    '/:id',
    {
      schema: {
        tags: ['tracker'],
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        response: GetOperationResSchema,
      },
    },
    operationController.getOperation.bind(operationController),
  );

  done();
};

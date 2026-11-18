import { FastifyPluginCallback } from 'fastify';

import { LiteModule } from '@Architecture/Application/Lite/LiteModule';
import { answerAtOnce } from '@Architecture/Presentation/Lite/AnswerAtOnce';

import {
  getGroupExpenses,
  getMemberStatement,
  getMemberStatementCsv,
  MemberStatementView,
} from '@Contexts/Ledger/Application/History';
import { statementAsCsv } from '@Contexts/Ledger/Presentation/statement-csv';

/**
 * The history's routes (request 8, the API's fragment 9; request 29 adds the statement as CSV): a member of a group lists its expenses,
 * the latest first, and reads any member's statement, the earliest first. Each answers its use case at once; a caller who is not a member
 * of the group gets the group's `404`, and a statement of someone who was never a member of it gets `404` too. The CSV is the same statement
 * rendered as `text/csv` in UTF-8; a refusal of it answers as the JSON route does.
 */
export const historyRoutes: FastifyPluginCallback<{ module: LiteModule }> = (fastify, { module }, done) => {
  fastify.get<{ Params: { id: string } }>('/groups/:id/expenses', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getGroupExpenses), req.params.id),
  );

  fastify.get<{ Params: { id: string; memberId: string } }>('/groups/:id/members/:memberId/statement', (req, reply) =>
    answerAtOnce(req, reply, module.useCase(getMemberStatement), {
      groupId: req.params.id,
      memberId: req.params.memberId,
    }),
  );

  fastify.get<{ Params: { id: string; memberId: string } }>(
    '/groups/:id/members/:memberId/statement.csv',
    async (req, reply) => {
      const answer = await answerAtOnce(req, reply, module.useCase(getMemberStatementCsv), {
        groupId: req.params.id,
        memberId: req.params.memberId,
      });
      if (reply.statusCode !== 200) return answer;
      reply.header('content-type', 'text/csv; charset=utf-8');
      return statementAsCsv(answer as MemberStatementView);
    },
  );

  done();
};

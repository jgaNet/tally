import { IResult, Result } from '@Architecture/Domain';
import { query } from '@Architecture/Application/Lite/UseCase';

import {
  AdministratorDecisionView,
  IAdministratorDecisions,
} from '@Contexts/Groups/Application/IAdministratorDecisions';
import { AdministratorLogNotFoundException } from '@Contexts/Groups/Domain/Account/AdministratorExceptions';
import { Role } from '@SharedKernel/Domain';

/**
 * The administrators' log, the oldest first (request 33, the storm's `GetAdministratorsLog`): every decision an administrator made about a
 * contested settlement, read through the port Groups owns. Only an administrator reads it: to anyone else it does not exist, the `404`.
 */
export const getAdministratorsLog = query(
  'GetAdministratorsLog',
  (decisions: IAdministratorDecisions) =>
    async (_input: undefined, context): Promise<IResult<AdministratorDecisionView[]>> => {
      if (context.auth.role !== Role.ADMIN) return Result.fail(new AdministratorLogNotFoundException());
      return Result.ok(await decisions.decisions());
    },
);

import { query } from '@Architecture/Application/Lite/UseCase';
import { NotFoundException, Result } from '@Architecture/Domain';
import { Role } from '@SharedKernel/Domain';

import { IAdministratorDecisions } from '@Contexts/Groups/Domain/Account/Ports/IAdministratorDecisions';

/**
 * Reads the administrators' log, the oldest first (request 33, docs/adr/0033). Only an administrator reads it: for anyone else, signed in
 * or not, the log does not exist. Anonymous callers are refused by the transport before this runs (`401`).
 */
export const getAdministratorsLog = query(
  'GetAdministratorsLog',
  (decisions: IAdministratorDecisions) => async (_input: void, context) => {
    // For anyone who is not an administrator the log does not exist (docs/adr/0033).
    if (context.auth.role !== Role.ADMIN) return Result.fail(new NotFoundException('Groups', 'There is no such log'));
    return Result.ok(await decisions.decisionsOf());
  },
);

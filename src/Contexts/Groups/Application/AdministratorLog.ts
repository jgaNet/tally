import { IResult, Result } from '@Architecture/Domain';
import { query } from '@Architecture/Application/Lite/UseCase';

import { AccountActionEntry, IAdministratorActionLog } from '@Contexts/Groups/Application/IAdministratorActionLog';
import {
  AdministratorDecisionView,
  IAdministratorDecisions,
} from '@Contexts/Groups/Application/IAdministratorDecisions';
import { AdministratorLogNotFoundException } from '@Contexts/Groups/Domain/Account/AdministratorExceptions';
import { Role } from '@SharedKernel/Domain';

/** One line of the administrators' log as Groups answers it: a decision about a contested settlement (request 33), or an account suspended or reinstated (request 34). */
export type AdministratorLogLine = AdministratorDecisionView | AccountActionEntry;

/**
 * The administrators' log, the oldest first (request 33, the storm's `GetAdministratorsLog`): every decision an administrator made about a
 * contested settlement, read through the port Groups owns, and every suspension or reinstatement Groups wrote (request 34), in the order they
 * were made. Only an administrator reads it: to anyone else it does not exist, the `404`.
 */
export const getAdministratorsLog = query(
  'GetAdministratorsLog',
  (decisions: IAdministratorDecisions, actions: IAdministratorActionLog) =>
    async (_input: undefined, context): Promise<IResult<AdministratorLogLine[]>> => {
      if (context.auth.role !== Role.ADMIN) return Result.fail(new AdministratorLogNotFoundException());
      const lines: AdministratorLogLine[] = [...(await decisions.decisions()), ...(await actions.actions())];
      // Each line's time is written by the change it records, in one format, so the times sort as time does; the sort is stable.
      return Result.ok(lines.sort((earlier, later) => (earlier.at < later.at ? -1 : earlier.at > later.at ? 1 : 0)));
    },
);

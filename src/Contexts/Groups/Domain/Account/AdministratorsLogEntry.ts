import { Id } from '@Architecture/Domain';

import { AdministratorDecision } from '@Contexts/Groups/Domain/Account/Ports/IAdministratorDecisions';

/**
 * An entry of the administrators' log that Groups writes (request 34): an account suspended or reinstated, by the administrator who
 * decided it, at the time given. Its id is generated here, with the time the change is made in, so the entry is the change's own
 * (DOMAIN-IDENTITY); the handler that makes the change stores it in the same transaction.
 */
export function administratorsLogEntry({
  at,
  by,
  action,
  subjectId,
}: {
  at: Date;
  by: string;
  action: 'suspended' | 'reinstated';
  subjectId: string;
}): AdministratorDecision {
  return { id: Id.generate().value, at: at.toISOString(), by, action, subjectId };
}

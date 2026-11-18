import { Id } from '@Architecture/Domain';

import { IWaitingPayments } from '@Contexts/Groups/Domain/Group/Ports/IWaitingPayments';
import { IWaitingPaymentsQueries } from '@Contexts/Settlements/Domain/Settlement/Ports/IWaitingPaymentsQueries';

/**
 * Groups' port to Settlements, answered over Settlements' read model (request 20): whether a payment the member pays or receives
 * is waiting at the provider. The read model is a function, the one Settlements' wiring exports, because the two wiring files
 * import each other (ADR 4): it is read when the answer is asked, not while the files are evaluated.
 */
export class WaitingPaymentsFromSettlements implements IWaitingPayments {
  constructor(private settlements: () => IWaitingPaymentsQueries) {}

  async waitingOf(groupId: string, accountId: Id): Promise<boolean> {
    return this.settlements().isWaitingFor(groupId, accountId.value);
  }

  async waitingIn(groupId: string): Promise<boolean> {
    return this.settlements().isWaitingIn(groupId);
  }
}

import { EventHandler, ExecutionContext, publishDomainEvents } from '@Architecture/Application';
import { Id, IResult, Result } from '@Architecture/Domain';

import { INoticeRepository } from '@Contexts/Notifications/Domain/Notice/Ports/INoticeRepository';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { ReminderIssuedEvent } from '@Contexts/Notifications/Domain/DebtWatch/Events/DebtWatchEvents';

/**
 * Makes the reminder the sweep decided on (ADR 10): a notice of kind `reminder` to the member, with what they still owe in the group,
 * made at the instant the sweep carries. It runs in the reaction's own transaction, so the notice and what it publishes commit together.
 */
export class ReminderIssuedHandler extends EventHandler<ReminderIssuedEvent> {
  constructor(private notices: INoticeRepository) {
    super();
  }

  async execute({ payload }: ReminderIssuedEvent, context: ExecutionContext): Promise<IResult<unknown>> {
    const made = Notice.remind({
      recipient: new Id(payload.memberId),
      groupId: new Id(payload.groupId),
      amount: payload.amount,
      now: new Date(payload.at),
    });
    if (made.isFailure()) return made;

    const saved = await this.notices.save(made.data);
    if (saved.isFailure()) return saved;
    await publishDomainEvents(made.data, context);
    return Result.ok();
  }
}

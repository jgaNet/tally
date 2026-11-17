import { Id } from '@Architecture/Domain';

import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';
import { NoticeIssuedEvent } from '@Contexts/Notifications/Domain/Notice/Events/NoticeEvents';

const now = new Date('2026-03-10T09:00:00.000Z');
const made = (amount: number) =>
  Notice.create({
    recipient: new Id('cy'),
    groupId: new Id('flat'),
    expenseId: new Id('groceries'),
    amount,
    now,
  });

describe('Notice', () => {
  it('is made for a member, about an expense, with their share, at the time it is made', () => {
    const notice = made(333);

    expect(notice.isSuccess()).toBe(true);
    const issued = notice.data as Notice;
    expect(issued.recipient.value).toBe('cy');
    expect(issued.groupId.value).toBe('flat');
    expect(issued.expenseId.value).toBe('groceries');
    expect(issued.amount).toBe(333);
    expect(issued.at).toEqual(now);
  });

  it('generates its own id, and records that it was issued, once', () => {
    const issued = made(333).data as Notice;

    expect(issued._id.value).toEqual(expect.any(String));
    expect(issued.pullDomainEvents()).toEqual([
      NoticeIssuedEvent.set({ noticeId: issued._id.value, recipientId: 'cy', expenseId: 'groceries' }),
    ]);
    expect(issued.pullDomainEvents()).toEqual([]);
  });

  it('is made for a share of 0, and refuses an amount that is not a whole number, or below 0', () => {
    expect(made(0).isSuccess()).toBe(true);
    expect(made(-1).isFailure()).toBe(true);
    expect(made(1.5).isFailure()).toBe(true);
    expect((made(-1).error as { type: string }).type).toBe('InvalidNoticeAmount');
  });
});

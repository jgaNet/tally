import { Notice } from './Notice';
import { NoticeIssuedEvent } from './NoticeEvents';

const at = new Date('2026-03-02T10:00:00.000Z');

describe('Notice.issueFor', () => {
  it('makes one notice for each member of the split but the payer, with that member’s share', () => {
    const notices = Notice.issueFor({
      groupId: 'group-1',
      expenseId: 'expense-1',
      payer: 'ada',
      shares: [
        { memberId: 'ada', amount: 100 },
        { memberId: 'grace', amount: 100 },
        { memberId: 'linus', amount: 100 },
      ],
      at,
    });

    expect(notices.map(notice => notice.toSnapshot())).toEqual([
      expect.objectContaining({
        memberId: 'grace',
        groupId: 'group-1',
        expenseId: 'expense-1',
        amount: 100,
        at: at.toISOString(),
      }),
      expect.objectContaining({
        memberId: 'linus',
        groupId: 'group-1',
        expenseId: 'expense-1',
        amount: 100,
        at: at.toISOString(),
      }),
    ]);
  });

  it('makes no notice for an expense its payer alone is split for', () => {
    expect(
      Notice.issueFor({
        groupId: 'group-1',
        expenseId: 'expense-1',
        payer: 'ada',
        shares: [{ memberId: 'ada', amount: 40 }],
        at,
      }),
    ).toEqual([]);
  });

  it('gives each notice an id of its own, and records the issue of each', () => {
    const notices = Notice.issueFor({
      groupId: 'group-1',
      expenseId: 'expense-1',
      payer: 'ada',
      shares: [
        { memberId: 'grace', amount: 50 },
        { memberId: 'linus', amount: 50 },
      ],
      at,
    });

    const [first, second] = notices.map(notice => notice.toSnapshot().id);
    expect(first).not.toEqual(second);
    for (const notice of notices) {
      const events = notice.pullDomainEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(NoticeIssuedEvent);
      expect(events[0].payload).toEqual({
        noticeId: notice.toSnapshot().id,
        memberId: notice.toSnapshot().memberId,
        kind: 'expense',
        groupId: 'group-1',
        expenseId: 'expense-1',
        amount: 50,
        at: at.toISOString(),
      });
    }
  });
});

describe('Notice.remind', () => {
  it('makes a reminder of what is owed, with no expense, and records its issue', () => {
    const notice = Notice.remind({ memberId: 'grace', groupId: 'group-1', owed: 2500, at });

    const snapshot = notice.toSnapshot();
    expect(snapshot).toEqual({
      id: expect.any(String),
      memberId: 'grace',
      kind: 'reminder',
      groupId: 'group-1',
      amount: 2500,
      at: at.toISOString(),
    });
    expect('expenseId' in snapshot).toBe(false);
    const [event] = notice.pullDomainEvents();
    expect(event).toBeInstanceOf(NoticeIssuedEvent);
  });
});

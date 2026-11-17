import { Id } from '@Architecture/Domain';

import { DEBT_THRESHOLD, DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import {
  DebtClearedEvent,
  DebtNotedEvent,
  ReminderIssuedEvent,
} from '@Contexts/Notifications/Domain/DebtWatch/Events/DebtWatchEvents';

const WEEK = 604_800_000;
const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000);

const opened = () => DebtWatch.open({ groupId: new Id('flat'), memberId: new Id('cy') });

describe('DebtWatch', () => {
  it('notes a debt above the threshold from the sweep that first sees it, and nothing at the threshold', () => {
    const watch = opened();
    watch.see({ owed: DEBT_THRESHOLD, now: day(0) });
    expect(watch.notedSince).toBeNull();
    expect(watch.pullDomainEvents()).toEqual([]);

    watch.see({ owed: DEBT_THRESHOLD + 1, now: day(1) });
    expect(watch.notedSince).toEqual(day(1));
    expect(watch.pullDomainEvents()).toEqual([
      DebtNotedEvent.set({
        watchId: watch._id.value,
        groupId: 'flat',
        memberId: 'cy',
        at: day(1).toISOString(),
      }),
    ]);
  });

  it('clears the noted debt when a sweep sees it at or below the threshold, and keeps the last reminder', () => {
    const watch = opened();
    watch.see({ owed: 2500, now: day(0) });
    watch.remindIfDue({ owed: 2500, now: day(0.5), period: WEEK });
    expect(watch.lastReminded).toBeNull();
    watch.pullDomainEvents();

    watch.see({ owed: 0, now: day(1) });
    expect(watch.notedSince).toBeNull();
    expect(watch.pullDomainEvents()).toEqual([
      DebtClearedEvent.set({ watchId: watch._id.value, groupId: 'flat', memberId: 'cy', at: day(1).toISOString() }),
    ]);
  });

  it('reminds a member noted for a period, and again each period while the debt lasts, not twice in one', () => {
    const watch = opened();
    watch.see({ owed: 2500, now: day(0) });
    watch.pullDomainEvents();

    expect(watch.remindIfDue({ owed: 2500, now: day(6), period: WEEK })).toBe(false);
    expect(watch.remindIfDue({ owed: 2500, now: day(7), period: WEEK })).toBe(true);
    expect(watch.pullDomainEvents()).toEqual([
      ReminderIssuedEvent.set({
        watchId: watch._id.value,
        groupId: 'flat',
        memberId: 'cy',
        amount: 2500,
        at: day(7).toISOString(),
      }),
    ]);

    expect(watch.remindIfDue({ owed: 2500, now: day(8), period: WEEK })).toBe(false);
    expect(watch.remindIfDue({ owed: 2500, now: day(13), period: WEEK })).toBe(false);
    expect(watch.remindIfDue({ owed: 2500, now: day(14), period: WEEK })).toBe(true);
  });

  it('waits a period from the sweep that sees a debt come back, after its last reminder', () => {
    const watch = opened();
    watch.see({ owed: 2500, now: day(0) });
    watch.remindIfDue({ owed: 2500, now: day(7), period: WEEK });
    watch.see({ owed: 0, now: day(9) });
    watch.see({ owed: 2500, now: day(10) });

    expect(watch.notedSince).toEqual(day(10));
    expect(watch.remindIfDue({ owed: 2500, now: day(16), period: WEEK })).toBe(false);
    expect(watch.remindIfDue({ owed: 2500, now: day(17), period: WEEK })).toBe(true);
  });

  it('is kept as it was read, and records nothing when it is read', () => {
    const watch = DebtWatch.fromSnapshot({
      id: 'w1',
      groupId: 'flat',
      memberId: 'cy',
      notedSince: day(0).toISOString(),
      remindedAt: null,
      version: 3,
    });

    expect(watch.version).toBe(3);
    expect(watch.notedSince).toEqual(day(0));
    expect(watch.pullDomainEvents()).toEqual([]);
  });
});

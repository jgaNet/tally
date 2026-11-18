import { describe, expect, it } from '@jest/globals';

import { ExecutionContext } from '@Architecture/Application';
import { EventBus } from '@Architecture/Application/EventBus';
import { IDebtWatchStore } from '@Contexts/Notifications/Application/IDebtWatchStore';
import { INoticeStore } from '@Contexts/Notifications/Application/INoticeStore';
import { IOutstandingDebts, OutstandingDebt } from '@Contexts/Notifications/Application/IOutstandingDebts';
import { sweepDebts } from '@Contexts/Notifications/Application/DebtSweep';
import { DebtWatch } from '@Contexts/Notifications/Domain/DebtWatch/DebtWatch';
import { MemoryNoticePreferences } from '@Contexts/Notifications/Application/NoticePreferences.spec-helper';
import { Notice } from '@Contexts/Notifications/Domain/Notice/Notice';

const WEEK = 604_800_000;
const noBus = { connect() {}, publish() {}, subscribe() {} } as unknown as EventBus;

class MemoryWatches implements IDebtWatchStore {
  watches = new Map<string, DebtWatch>();
  async all(): Promise<DebtWatch[]> {
    return [...this.watches.values()].map(watch => DebtWatch.fromSnapshot(watch.toSnapshot()));
  }
  async save(watch: DebtWatch): Promise<void> {
    this.watches.set(
      `${watch.groupId}/${watch.memberId}`,
      DebtWatch.fromSnapshot({ ...watch.toSnapshot(), version: watch.version + 1 }),
    );
  }
}

class MemoryNotices implements INoticeStore {
  added: Notice[] = [];
  async add(notice: Notice): Promise<void> {
    this.added.push(notice);
  }
}

class Debts implements IOutstandingDebts {
  owing: OutstandingDebt[] = [];
  async debtsOf(): Promise<OutstandingDebt[]> {
    return this.owing.map(debt => ({ ...debt }));
  }
}

const at = (ms: number) => new Date(Date.UTC(2026, 10, 17) + ms);

describe('SweepDebts', () => {
  it('notes a debt over the threshold, reminds it after a period, reminds again each period while it lasts, and clears it when it is paid down', async () => {
    const watches = new MemoryWatches();
    const notices = new MemoryNotices();
    const debts = new Debts();
    let now = at(0);
    const sweep = sweepDebts(watches, debts, notices, new MemoryNoticePreferences(), () => now, WEEK);
    const context = new ExecutionContext({ traceId: 'sweep', eventBus: noBus, auth: {} });
    const run = () => sweep.run(undefined, context);

    debts.owing = [
      { groupId: 'g', memberId: 'bob', owes: 2500 },
      { groupId: 'g', memberId: 'ann', owes: 0 },
    ];
    expect((await run()).isSuccess()).toBe(true);
    expect(notices.added).toEqual([]);
    expect(watches.watches.get('g/bob')?.toSnapshot().notedAt).toBe(at(0).toISOString());

    now = at(WEEK);
    await run();
    expect(notices.added.map(notice => notice.toSnapshot())).toEqual([
      {
        id: expect.any(String),
        recipientId: 'bob',
        kind: 'reminder',
        groupId: 'g',
        amount: 2500,
        at: at(WEEK).toISOString(),
      },
    ]);

    now = at(WEEK + 1000);
    await run();
    expect(notices.added).toHaveLength(1);

    now = at(2 * WEEK);
    await run();
    expect(notices.added).toHaveLength(2);

    debts.owing = [{ groupId: 'g', memberId: 'bob', owes: 1000 }];
    now = at(3 * WEEK);
    await run();
    expect(notices.added).toHaveLength(2);
    expect(watches.watches.get('g/bob')?.toSnapshot().notedAt).toBeUndefined();
  });

  it('clears the watch of a member no longer in the group, since no debt of theirs is seen', async () => {
    const watches = new MemoryWatches();
    const debts = new Debts();
    let now = at(0);
    const sweep = sweepDebts(watches, debts, new MemoryNotices(), new MemoryNoticePreferences(), () => now, WEEK);
    const context = new ExecutionContext({ traceId: 'sweep', eventBus: noBus, auth: {} });

    debts.owing = [{ groupId: 'g', memberId: 'cy', owes: 3000 }];
    await sweep.run(undefined, context);
    debts.owing = [];
    now = at(1);
    await sweep.run(undefined, context);

    expect(watches.watches.get('g/cy')?.toSnapshot().notedAt).toBeUndefined();
  });

  it('keeps a debt noted but makes no reminder while reminders are off, and reminds at the first run after they are on again', async () => {
    const watches = new MemoryWatches();
    const notices = new MemoryNotices();
    const debts = new Debts();
    const preferences = new MemoryNoticePreferences();
    preferences.turnOff('bob', 'reminder');
    let now = at(0);
    const sweep = sweepDebts(watches, debts, notices, preferences, () => now, WEEK);
    const context = new ExecutionContext({ traceId: 'sweep', eventBus: noBus, auth: {} });
    debts.owing = [{ groupId: 'g', memberId: 'bob', owes: 2500 }];

    await sweep.run(undefined, context);
    now = at(WEEK);
    await sweep.run(undefined, context);
    now = at(2 * WEEK);
    await sweep.run(undefined, context);
    expect(notices.added).toEqual([]);
    expect(watches.watches.get('g/bob')?.toSnapshot().lastReminderAt).toBeUndefined();

    preferences.turnOn('bob', 'reminder');
    now = at(2 * WEEK + 1000);
    await sweep.run(undefined, context);
    expect(notices.added.map(notice => notice.toSnapshot().kind)).toEqual(['reminder']);
  });
});

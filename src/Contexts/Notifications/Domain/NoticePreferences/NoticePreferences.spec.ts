import { Id } from '@Architecture/Domain';

import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreferences/NoticePreferences';
import { NoticePreferenceChangedEvent } from '@Contexts/Notifications/Domain/NoticePreferences/Events/NoticePreferenceEvents';
import { InvalidNoticeKind } from '@Contexts/Notifications/Domain/Notice/NoticeExceptions';

const now = new Date('2026-11-18T09:00:00.000Z');

describe('NoticePreferences (request 36)', () => {
  it('has every kind on until it is turned off, and records nothing when it is made', () => {
    const preferences = NoticePreferences.open({ ownerId: new Id('ann') });

    expect(preferences.enables('expense')).toBe(true);
    expect(preferences.enables('reminder')).toBe(true);
    expect(preferences.enables('budget')).toBe(true);
    expect(preferences.pullDomainEvents()).toEqual([]);
  });

  it('turns a kind off and records the change, once, from the time it is made', () => {
    const preferences = NoticePreferences.open({ ownerId: new Id('ann') });

    expect(preferences.set({ kind: 'budget', enabled: false, now }).isSuccess()).toBe(true);
    expect(preferences.enables('budget')).toBe(false);
    expect(preferences.enables('expense')).toBe(true);
    expect(preferences.pullDomainEvents()).toEqual([expect.any(NoticePreferenceChangedEvent)]);
  });

  it('changes nothing and records nothing when a kind is set to what it already is', () => {
    const preferences = NoticePreferences.open({ ownerId: new Id('ann') });

    preferences.set({ kind: 'reminder', enabled: true, now });

    expect(preferences.pullDomainEvents()).toEqual([]);
  });

  it('turns a kind on again', () => {
    const preferences = NoticePreferences.fromSnapshot({
      id: 'prefs',
      ownerId: 'ann',
      flags: { expense: false, reminder: true, budget: true },
      version: 1,
    });

    preferences.set({ kind: 'expense', enabled: true, now });

    expect(preferences.enables('expense')).toBe(true);
    expect(preferences.version).toBe(1);
  });

  it('refuses a kind that is not one of the three, and changes nothing', () => {
    const preferences = NoticePreferences.open({ ownerId: new Id('ann') });

    const refused = preferences.set({ kind: 'pets', enabled: false, now });

    expect(refused.isFailure()).toBe(true);
    expect(refused.isFailure() && refused.error).toBeInstanceOf(InvalidNoticeKind);
    expect(preferences.flags).toEqual({ expense: true, reminder: true, budget: true });
    expect(preferences.pullDomainEvents()).toEqual([]);
  });
});

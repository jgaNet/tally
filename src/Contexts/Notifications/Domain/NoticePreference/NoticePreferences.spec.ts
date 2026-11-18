import { describe, expect, it } from '@jest/globals';

import { NoticePreferences, NOTICE_KINDS } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';

const NOW = new Date('2026-11-18T09:00:00.000Z');

describe('NoticePreferences', () => {
  it('has every kind of notice on until it is turned off, and on again when turned back on', () => {
    const preferences = NoticePreferences.create({ ownerId: 'ann' });
    expect(NOTICE_KINDS.every(kind => preferences.isOn(kind))).toBe(true);

    expect(preferences.set('budget', false, NOW).isSuccess()).toBe(true);
    expect(preferences.isOn('budget')).toBe(false);
    expect(preferences.isOn('expense')).toBe(true);

    expect(preferences.set('budget', true, NOW).isSuccess()).toBe(true);
    expect(preferences.isOn('budget')).toBe(true);
  });

  it('records one NoticePreferenceChanged for each change, and none for a kind already in the state asked for', () => {
    const preferences = NoticePreferences.create({ ownerId: 'ann' });

    preferences.set('reminder', true, NOW);
    expect(preferences.changed).toBe(false);

    preferences.set('reminder', false, NOW);
    preferences.set('reminder', false, NOW);
    expect(preferences.changed).toBe(true);
    expect(preferences.pullDomainEvents().map(event => event.payload)).toEqual([
      {
        preferencesId: expect.any(String),
        ownerId: 'ann',
        kind: 'reminder',
        enabled: false,
        at: NOW.toISOString(),
      },
    ]);
  });

  it('refuses a kind that is not one of the kinds of notice, and changes nothing', () => {
    const preferences = NoticePreferences.create({ ownerId: 'ann' });

    const refused = preferences.set('weekly', false, NOW);

    expect(refused.isFailure()).toBe(true);
    expect(refused.isFailure() && refused.error).toMatchObject({ type: 'UnknownNoticeKind' });
    expect(preferences.changed).toBe(false);
    expect(preferences.pullDomainEvents()).toEqual([]);
  });

  it('is read as it was kept, recording nothing, and keeps the kinds off in the order the API lists them', () => {
    const kept = NoticePreferences.fromSnapshot({
      id: 'prefs-1',
      ownerId: 'ann',
      off: ['budget', 'expense'],
      version: 4,
    });

    expect(kept.pullDomainEvents()).toEqual([]);
    expect(kept.version).toBe(4);
    expect(kept.isOn('reminder')).toBe(true);
    expect(kept.toSnapshot()).toEqual({ id: 'prefs-1', ownerId: 'ann', off: ['expense', 'budget'], version: 4 });
  });
});

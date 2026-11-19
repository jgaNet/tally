import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';

describe('notice preferences', () => {
  it('has every kind on for a person who never set one, and records nothing', () => {
    const preferences = NoticePreferences.open({ accountId: 'ann' });
    expect(preferences.isOn('expense')).toBe(true);
    expect(preferences.isOn('reminder')).toBe(true);
    expect(preferences.isOn('budget')).toBe(true);
    expect(preferences.version).toBe(0);
    expect(preferences.pullDomainEvents()).toEqual([]);
  });

  it('turns a kind off and on again, and says whether it changed', () => {
    const preferences = NoticePreferences.open({ accountId: 'ann' });
    expect(preferences.set('budget', false)).toBe(true);
    expect(preferences.isOn('budget')).toBe(false);
    expect(preferences.isOn('expense')).toBe(true);
    expect(preferences.set('budget', false)).toBe(false);
    expect(preferences.set('budget', true)).toBe(true);
    expect(preferences.isOn('budget')).toBe(true);
    // Only the two changes were recorded, not the no-op between them.
    expect(preferences.pullDomainEvents()).toHaveLength(2);
  });

  it('answers the same state from a snapshot as it was saved, and refuses a corrupted one', () => {
    const preferences = NoticePreferences.open({ accountId: 'ann' });
    preferences.set('reminder', false);
    const restored = NoticePreferences.fromSnapshot({ ...preferences.toSnapshot(), version: 2 });
    expect(restored.isOn('reminder')).toBe(false);
    expect(restored.isOn('expense')).toBe(true);
    expect(() =>
      NoticePreferences.fromSnapshot({
        id: 'x',
        version: 1,
        accountId: 'ann',
        expense: 'no' as unknown as boolean,
        reminder: true,
        budget: true,
      }),
    ).toThrow();
  });
});

import { NoticePreferences } from '@Contexts/Notifications/Domain/NoticePreference/NoticePreferences';

describe('NoticePreferences (request 36)', () => {
  it('has every kind of notice on until a person turns it off', () => {
    const preferences = NoticePreferences.open('dan');
    expect(preferences.wants('expense')).toBe(true);
    expect(preferences.wants('reminder')).toBe(true);
    expect(preferences.wants('budget')).toBe(true);
    expect(preferences.toSnapshot()).toEqual({ _id: expect.any(String), person: 'dan', off: [], version: 0 });
  });

  it('turns a kind off and on again, recording each change, and only a change', () => {
    const preferences = NoticePreferences.open('dan');

    expect(preferences.set({ kind: 'reminder', enabled: true }).isSuccess()).toBe(true);
    expect(preferences.pullDomainEvents()).toEqual([]); // already on: nothing changed, nothing recorded

    expect(preferences.set({ kind: 'reminder', enabled: false }).isSuccess()).toBe(true);
    expect(preferences.wants('reminder')).toBe(false);
    expect(preferences.wants('expense')).toBe(true);
    expect(preferences.pullDomainEvents()).toHaveLength(1);

    expect(preferences.set({ kind: 'reminder', enabled: false }).isSuccess()).toBe(true);
    expect(preferences.pullDomainEvents()).toEqual([]); // off again: no change

    expect(preferences.set({ kind: 'reminder', enabled: true }).isSuccess()).toBe(true);
    expect(preferences.wants('reminder')).toBe(true);
    expect(preferences.pullDomainEvents()).toHaveLength(1);
  });

  it('refuses a kind it does not make, and a value that is not on or off, and changes nothing', () => {
    const preferences = NoticePreferences.open('dan');

    const unknown = preferences.set({ kind: 'weekly', enabled: false });
    expect(unknown.isFailure()).toBe(true);
    expect(preferences.set({ kind: 'expense', enabled: 'no' as unknown as boolean }).isFailure()).toBe(true);

    expect(preferences.toSnapshot().off).toEqual([]);
    expect(preferences.pullDomainEvents()).toEqual([]);
  });

  it('keeps the kinds turned off in the order they are declared, and reads them back as they were kept', () => {
    const preferences = NoticePreferences.open('dan');
    preferences.set({ kind: 'budget', enabled: false });
    preferences.set({ kind: 'expense', enabled: false });

    const snapshot = preferences.toSnapshot();
    expect(snapshot.off).toEqual(['expense', 'budget']);

    const read = NoticePreferences.fromSnapshot({ ...snapshot, version: 3 });
    expect(read.wants('expense')).toBe(false);
    expect(read.wants('reminder')).toBe(true);
    expect(read.wants('budget')).toBe(false);
    expect(read.toSnapshot().version).toBe(3);
  });

  it('throws on preferences no rule could have made', () => {
    const snapshot = NoticePreferences.open('dan').toSnapshot();
    expect(() => NoticePreferences.fromSnapshot({ ...snapshot, off: ['weekly'] as never })).toThrow();
    expect(() => NoticePreferences.fromSnapshot({ ...snapshot, off: ['expense', 'expense'] })).toThrow();
    expect(() => NoticePreferences.fromSnapshot({ ...snapshot, person: '' })).toThrow();
  });
});

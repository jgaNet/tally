import { Id } from '@Architecture/Domain';
import { NoticePreferences } from '@Contexts/Notifications/Domain/Preference/NoticePreferences';

const memberId = new Id('member');
const at = new Date('2030-01-01T00:00:00Z');

describe('NoticePreferences: each kind of notice on or off for a person; every kind on until turned off (request 36)', () => {
  it('is all on for a person with none stored, and reads so through wants()', () => {
    expect(NoticePreferences.wants(null, 'expense')).toBe(true);
    expect(NoticePreferences.wants(null, 'reminder')).toBe(true);
    expect(NoticePreferences.wants(null, 'budget')).toBe(true);
  });

  it('is made by its first change, which records NoticePreferenceChanged, and leaves the other kinds on', () => {
    const made = NoticePreferences.register({ memberId, kind: 'reminder', enabled: false, at });
    if (made.isFailure()) throw new Error('refused');
    expect(made.data.version).toBe(0);
    expect(made.data.pullDomainEvents().map(event => event.name)).toEqual(['NoticePreferenceChangedEvent']);
    expect(made.data.toSnapshot()).toMatchObject({ memberId: 'member', expense: true, reminder: false, budget: true });
    expect(NoticePreferences.wants(made.data, 'reminder')).toBe(false);
    expect(NoticePreferences.wants(made.data, 'expense')).toBe(true);
  });

  it('records a change only when the choice of a kind moves, and turns it back on', () => {
    const made = NoticePreferences.register({ memberId, kind: 'budget', enabled: false, at });
    if (made.isFailure()) throw new Error('refused');
    made.data.pullDomainEvents();
    expect(made.data.change({ kind: 'budget', enabled: false, at }).isFailure()).toBe(false);
    expect(made.data.pullDomainEvents()).toEqual([]);

    expect(made.data.change({ kind: 'budget', enabled: true, at }).isFailure()).toBe(false);
    expect(made.data.isOn('budget')).toBe(true);
    expect(made.data.pullDomainEvents().map(event => event.name)).toEqual(['NoticePreferenceChangedEvent']);
  });

  it('refuses a kind that is not one of the three, and records nothing', () => {
    const made = NoticePreferences.register({ memberId, kind: 'weekly', enabled: false, at });
    expect(made.isFailure()).toBe(true);
    if (made.isFailure()) expect(made.error.type).toBe('UnknownNoticeKind');
  });

  it('restores as it was stored, and records nothing', () => {
    const restored = NoticePreferences.fromSnapshot(
      { id: 'p', memberId: 'member', expense: false, reminder: true, budget: false },
      4,
    );
    expect(restored.version).toBe(4);
    expect(restored.pullDomainEvents()).toEqual([]);
    expect(NoticePreferences.wants(restored, 'budget')).toBe(false);
  });
});

import { NoticePreferences } from './NoticePreferences';

const at = new Date('2026-03-02T10:00:00.000Z');

describe('NoticePreferences', () => {
  it('has every kind on until it is turned off, and records nothing when it is made', () => {
    const prefs = NoticePreferences.defaults('ada');
    expect(prefs.isOn('expense')).toBe(true);
    expect(prefs.isOn('reminder')).toBe(true);
    expect(prefs.isOn('budget')).toBe(true);
    expect(prefs.pullDomainEvents()).toEqual([]);
  });

  it('records a change once, and changes nothing when a kind is set to the value it has', () => {
    const prefs = NoticePreferences.defaults('ada');
    prefs.set('reminder', false, at);
    prefs.set('reminder', false, at);
    expect(prefs.isOn('reminder')).toBe(false);
    expect(prefs.isOn('expense')).toBe(true);
    expect(prefs.toSnapshot().enabled).toEqual({ expense: true, reminder: false, budget: true });
    const events = prefs.pullDomainEvents();
    expect(events.map(event => event.name)).toEqual(['NoticePreferenceChangedEvent']);
    expect(events[0].payload).toEqual({ memberId: 'ada', kind: 'reminder', enabled: false, at: at.toISOString() });
  });

  it('is rebuilt as it was stored, and refuses data no change could have stored', () => {
    const stored = NoticePreferences.fromSnapshot({
      id: '11111111-1111-4111-8111-111111111111',
      memberId: 'ada',
      enabled: { expense: false, reminder: true, budget: true },
      version: 2,
    });
    expect(stored.isOn('expense')).toBe(false);
    expect(stored.toSnapshot().version).toBe(2);
    expect(() =>
      NoticePreferences.fromSnapshot({
        id: 'x',
        memberId: 'ada',
        enabled: { expense: true, reminder: true, budget: true },
        version: 0,
      }),
    ).toThrow();
  });
});

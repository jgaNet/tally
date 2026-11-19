import { decideSetNoticePreference } from './NoticePreferences.decision';

describe('decideSetNoticePreference', () => {
  it('allows turning any of the three kinds on or off', () => {
    for (const kind of ['expense', 'reminder', 'budget']) {
      const decision = decideSetNoticePreference(undefined, { kind, enabled: false }, new Date());
      expect(decision.isFailure()).toBe(false);
      if (decision.isFailure()) throw decision.error;
      expect(decision.data.state).toEqual({ kind, enabled: false });
    }
  });

  it('refuses a kind that is none of the three, and says which ones are allowed', () => {
    const decision = decideSetNoticePreference(undefined, { kind: 'newsletter', enabled: true }, new Date());
    expect(decision.isFailure()).toBe(true);
    if (!decision.isFailure()) throw new Error('expected a refusal');
    expect(decision.error).toMatchObject({ type: 'InvalidNoticeKind' });
  });
});

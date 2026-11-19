import { Id } from '@Architecture/Domain';
import { DebtWatch } from '@Contexts/Notifications/Domain/Debt/DebtWatch';
import { debtThresholdOf } from '@Contexts/Notifications/Domain/Debt/Threshold';

const groupId = new Id('group');
const memberId = new Id('member');
const at = new Date(Date.UTC(2030, 0, 1));

describe('the reminders’ threshold in each currency (request 40)', () => {
  it('is more than 20 of the group’s currency, in its minor unit', () => {
    expect(debtThresholdOf('EUR')).toBe(2000);
    expect(debtThresholdOf('USD')).toBe(2000);
    expect(debtThresholdOf('JPY')).toBe(20);
    expect(debtThresholdOf('KRW')).toBe(20);
    expect(debtThresholdOf('KWD')).toBe(20000);
    expect(debtThresholdOf('BHD')).toBe(20000);
  });

  it('refuses a debt of exactly 20 yen as not over the threshold, and notes one of 21 yen', () => {
    const threshold = debtThresholdOf('JPY');
    expect(DebtWatch.create({ groupId, memberId, owed: 20, at, threshold }).isFailure()).toBe(true);
    expect(DebtWatch.create({ groupId, memberId, owed: 21, at, threshold }).isFailure()).toBe(false);
  });

  it('refuses a debt of exactly 20.000 dinars as not over the threshold, and notes one of 20.001', () => {
    const threshold = debtThresholdOf('KWD');
    expect(DebtWatch.create({ groupId, memberId, owed: 20000, at, threshold }).isFailure()).toBe(true);
    expect(DebtWatch.create({ groupId, memberId, owed: 20001, at, threshold }).isFailure()).toBe(false);
  });

  it('refuses a currency that is not Tally’s by throwing', () => {
    expect(() => debtThresholdOf('XXX')).toThrow();
  });
});

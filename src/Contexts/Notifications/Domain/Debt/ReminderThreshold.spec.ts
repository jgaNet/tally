import { reminderAbove } from '@Contexts/Notifications/Domain/Debt/DebtWatch';

describe('the amount a debt is reminded above, in its group currency (request 18, request 40)', () => {
  it('is 20 of the currency, in its minor unit: 2000 in euros, 20 in yen, 20 000 in dinars', () => {
    expect(reminderAbove('EUR')).toBe(2000);
    expect(reminderAbove('JPY')).toBe(20);
    expect(reminderAbove('KRW')).toBe(20);
    expect(reminderAbove('KWD')).toBe(20_000);
    expect(reminderAbove('BHD')).toBe(20_000);
  });
});

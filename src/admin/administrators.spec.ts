import { administratorsOf, isAdministrator } from './administrators';

describe('the administrators, from ADMIN_EMAILS', () => {
  it('are the emails listed, separated by commas: their case and the spaces around them do not matter', () => {
    expect([...administratorsOf('Boss@Example.com, ,ops@example.com ')]).toEqual([
      'boss@example.com',
      'ops@example.com',
    ]);
  });

  it('are none when the list is empty', () => {
    expect(administratorsOf('').size).toBe(0);
  });

  it('are the accounts whose email is listed, whatever its case, and no other', () => {
    const administrators = administratorsOf('Boss@Example.com');
    const account = (email: string) => ({ id: 'a', email, name: 'A' });
    expect(isAdministrator(administrators, account('boss@EXAMPLE.com'))).toBe(true);
    expect(isAdministrator(administrators, account('bossy@example.com'))).toBe(false);
    expect(isAdministrator(administrators, account('ada@example.com'))).toBe(false);
  });
});

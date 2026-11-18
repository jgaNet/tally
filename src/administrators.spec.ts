import { administratorEmailsOf, isAdministrator } from './administrators';

describe('the administrators', () => {
  it('are the emails of ADMIN_EMAILS, separated by commas, with blanks ignored and whatever their case', () => {
    expect(administratorEmailsOf(' Admin@Example.org , ,second@example.ORG,')).toEqual(
      new Set(['admin@example.org', 'second@example.org']),
    );
  });

  it('are none when ADMIN_EMAILS is not set, or empty', () => {
    expect(administratorEmailsOf(undefined).size).toBe(0);
    expect(administratorEmailsOf('  ').size).toBe(0);
  });

  it('are the accounts with one of those emails, whatever the case of the email they signed up with, and no other', () => {
    const administrators = administratorEmailsOf('Admin@Example.org');
    expect(isAdministrator(administrators, { email: 'admin@example.org' })).toBe(true);
    expect(isAdministrator(administrators, { email: 'ADMIN@EXAMPLE.ORG' })).toBe(true);
    expect(isAdministrator(administrators, { email: 'admin@example.com' })).toBe(false);
  });
});

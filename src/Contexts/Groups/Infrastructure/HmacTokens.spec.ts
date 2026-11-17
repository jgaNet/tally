import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { HmacTokens } from '@Contexts/Groups/Infrastructure/HmacTokens';

describe('HmacTokens', () => {
  it('verifies what it issued, and nothing else', () => {
    const tokens = new HmacTokens(new SqliteDatabase(':memory:'));
    const token = tokens.issue('account-1');
    expect(tokens.verify(token)).toBe('account-1');
    expect(tokens.verify(token.replace('account-1', 'account-2'))).toBeNull();
    expect(tokens.verify('account-1.')).toBeNull();
    expect(tokens.verify('')).toBeNull();
    expect(new HmacTokens(new SqliteDatabase(':memory:')).verify(token)).toBeNull();
  });
});

import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { freshDatabase } from '@Architecture/Infrastructure/Postgres/database.spec-helper';
import { HmacTokens } from '@Contexts/Groups/Infrastructure/HmacTokens';

describe('HmacTokens', () => {
  it('verifies what it issued, and nothing else', async () => {
    const database = freshDatabase();
    const other = freshDatabase();
    const tokens = new HmacTokens(database);
    await tokens.load();
    const token = tokens.issue('account-1');
    expect(tokens.verify(token)).toBe('account-1');
    expect(tokens.verify(token.replace('account-1', 'account-2'))).toBeNull();
    expect(tokens.verify('account-1.')).toBeNull();
    expect(tokens.verify('')).toBeNull();
    const another = new HmacTokens(other);
    await another.load();
    expect(another.verify(token)).toBeNull();
    // Another server on the same database verifies it.
    const same = new HmacTokens(new PostgresDatabase(database.url));
    await same.load();
    expect(same.verify(token)).toBe('account-1');
    await Promise.all([database.close(), other.close()]);
  });
});

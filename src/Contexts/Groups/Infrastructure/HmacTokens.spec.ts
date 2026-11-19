import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { freshDatabase } from '@Architecture/Infrastructure/Postgres/database.spec-helper';
import { Role } from '@SharedKernel/Domain';
import { HmacTokens } from '@Contexts/Groups/Infrastructure/HmacTokens';

describe('HmacTokens', () => {
  it('verifies what it issued, and nothing else', async () => {
    const database = freshDatabase();
    const other = freshDatabase();
    const tokens = new HmacTokens(database);
    await tokens.load();
    const token = tokens.issue('account-1', Role.USER);
    expect(tokens.verify(token)).toEqual({ accountId: 'account-1', role: Role.USER });
    expect(tokens.verify(token.replace('account-1', 'account-2'))).toBeNull();
    expect(tokens.verify(token.replace('.USER.', '.ADMIN.'))).toBeNull();
    expect(tokens.verify('account-1.')).toBeNull();
    expect(tokens.verify('')).toBeNull();
    const another = new HmacTokens(other);
    await another.load();
    expect(another.verify(token)).toBeNull();
    // Another server on the same database verifies it.
    const same = new HmacTokens(new PostgresDatabase(database.url));
    await same.load();
    expect(same.verify(token)).toEqual({ accountId: 'account-1', role: Role.USER });
    await Promise.all([database.close(), other.close()]);
  });

  it('carries the role a token was issued in, and a token of the earlier shape proves a user', async () => {
    const database = freshDatabase();
    const tokens = new HmacTokens(database);
    await tokens.load();
    const admin = tokens.issue('account-1', Role.ADMIN);
    expect(tokens.verify(admin)).toEqual({ accountId: 'account-1', role: Role.ADMIN });
    // The shape before roles: `<account id>.<signature>`, signed over the account id alone.
    const earlier = `account-1.${(tokens as unknown as { sign(body: string): string }).sign('account-1')}`;
    expect(tokens.verify(earlier)).toEqual({ accountId: 'account-1', role: Role.USER });
    await database.close();
  });
});

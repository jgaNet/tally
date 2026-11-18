import { Role } from '@SharedKernel/Domain';
import { randomUUID } from 'node:crypto';

import pg from 'pg';

import { sharedDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';

import { PostgresSessionTokens } from '@Contexts/Groups/Infrastructure/PostgresSessionTokens';

// A database of its own for this suite: named in DATABASE_URL now, created on the server before the first test. The
// suite's tokens are made here, before the database is prepared: their key is a seed of the database.
const base = new URL(process.env.DATABASE_URL ?? '');
const admin = new URL(base.toString());
admin.pathname = '/postgres';
base.pathname = `/tally_groups_tokens_${randomUUID().replace(/-/g, '')}`;
process.env.DATABASE_URL = base.toString();
const created = createDatabase(admin.toString(), base.pathname.slice(1));
const tokens = new PostgresSessionTokens(sharedDatabase);

async function createDatabase(server: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: server });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await created;
  // What prepareDatabase does on a fresh database, without its file move: every schema step, then every seed.
  await sharedDatabase.transaction(async () => {
    for (const step of sharedDatabase.setups) await step(sharedDatabase);
    for (const step of sharedDatabase.seeds) await step(sharedDatabase);
  });
});

afterAll(async () => {
  await sharedDatabase.close();
});

describe('session tokens', () => {
  it('proves the account it was issued for, and the role it had', () => {
    expect(tokens.accountOf(tokens.issue('account-1', Role.USER))).toEqual({ subjectId: 'account-1', role: Role.USER });
    expect(tokens.accountOf(tokens.issue('account-2', Role.ADMIN))).toEqual({
      subjectId: 'account-2',
      role: Role.ADMIN,
    });
  });

  it('refuses a token whose payload was changed to name another account or role', () => {
    const [, signature] = tokens.issue('account-1', Role.USER).split('.');
    const forged = `${Buffer.from(JSON.stringify({ sub: 'account-2', role: 'ADMIN' })).toString('base64url')}.${signature}`;

    expect(tokens.accountOf(forged)).toBeUndefined();
  });

  it('refuses a value that is not a token of its own', () => {
    expect(tokens.accountOf('not-a-token')).toBeUndefined();
    expect(tokens.accountOf('')).toBeUndefined();
  });
});

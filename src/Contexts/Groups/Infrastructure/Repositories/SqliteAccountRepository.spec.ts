import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConcurrencyConflictException, IResult } from '@Architecture/Domain';
import { SqliteDatabase } from '@Architecture/Infrastructure/Sqlite/SqliteDatabase';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { SqliteAccountRepository } from '@Contexts/Groups/Infrastructure/Repositories/SqliteAccountRepository';

const valueOf = <T>(result: IResult<T>): T => {
  if (result.isFailure()) throw result.error;
  return result.data as T;
};

function newAccount(email = 'ana@example.com'): Account {
  return Account.create({
    email: valueOf(Email.create(email)),
    name: valueOf(AccountName.create('Ana')),
    passwordHash: 'scrypt$salt$key',
  });
}

describe('the accounts in the application file', () => {
  let directory: string;
  let path: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'tally-accounts-'));
    path = join(directory, 'state.db');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('finds an account saved before the file was opened again, by its id and by its email', async () => {
    const database = new SqliteDatabase(path);
    const account = newAccount();
    expect((await new SqliteAccountRepository(database).save(account)).isSuccess()).toBe(true);
    database.connection.close();

    const reopened = new SqliteAccountRepository(new SqliteDatabase(path));
    const byEmail = await reopened.findByEmail(valueOf(Email.create('ANA@example.com')));

    expect(byEmail?._id.value).toBe(account._id.value);
    expect(byEmail?.toSnapshot()).toEqual({ ...account.toSnapshot(), version: 1 });
    expect((await reopened.findById(account._id.value))?.name.value).toBe('Ana');
  });

  it('refuses a save of an account read before another writer saved it (ADR 8)', async () => {
    const repository = new SqliteAccountRepository(new SqliteDatabase(path));
    const account = newAccount();
    await repository.save(account);

    const firstReader = (await repository.findById(account._id.value)) as Account;
    const secondReader = (await repository.findById(account._id.value)) as Account;
    expect((await repository.save(firstReader)).isSuccess()).toBe(true);

    const stale = await repository.save(secondReader);
    expect(stale.isFailure()).toBe(true);
    expect(stale.isFailure() && stale.error).toBeInstanceOf(ConcurrencyConflictException);
  });
});

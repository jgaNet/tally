import { ConcurrencyConflictException, IResult } from '@Architecture/Domain';
import { PostgresDatabase } from '@Architecture/Infrastructure/Postgres/PostgresDatabase';
import { Email } from '@SharedKernel/Domain';

import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { PostgresAccountRepository } from '@Contexts/Groups/Infrastructure/Repositories/PostgresAccountRepository';

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

describe('the accounts in the application database', () => {
  let database: PostgresDatabase;
  let repository: PostgresAccountRepository;

  beforeAll(async () => {
    // The adapter declares its table when it is constructed, so it is built before the database is opened.
    database = new PostgresDatabase(process.env.DATABASE_URL!);
    repository = new PostgresAccountRepository(database);
    await database.open();
  });

  afterAll(() => database.close());

  it('finds an account saved before the database was opened again, by its id and by its email', async () => {
    const account = newAccount();
    expect((await repository.save(account)).isSuccess()).toBe(true);

    const restarted = new PostgresDatabase(process.env.DATABASE_URL!);
    const reopened = new PostgresAccountRepository(restarted);
    await restarted.open();
    try {
      const byEmail = await reopened.findByEmail(valueOf(Email.create('ANA@example.com')));

      expect(byEmail?._id.value).toBe(account._id.value);
      expect(byEmail?.toSnapshot()).toEqual({ ...account.toSnapshot(), version: 1 });
      expect((await reopened.findById(account._id.value))?.name.value).toBe('Ana');
    } finally {
      await restarted.close();
    }
  });

  it('refuses a save of an account read before another writer saved it (ADR 8)', async () => {
    const account = newAccount('bea@example.com');
    await repository.save(account);

    const firstReader = (await repository.findById(account._id.value)) as Account;
    const secondReader = (await repository.findById(account._id.value)) as Account;
    expect((await repository.save(firstReader)).isSuccess()).toBe(true);

    const stale = await repository.save(secondReader);
    expect(stale.isFailure()).toBe(true);
    expect(stale.isFailure() && stale.error).toBeInstanceOf(ConcurrencyConflictException);
  });
});

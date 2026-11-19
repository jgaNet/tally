import { Id } from '@Architecture/Domain';
import { PostgresOutbox } from '@Architecture/Infrastructure/Postgres/PostgresOutbox';
import { PostgresUnitOfWork } from '@Architecture/Infrastructure/Postgres/PostgresUnitOfWork';
import { freshDatabase } from '@Architecture/Infrastructure/Postgres/database.spec-helper';
import { Email } from '@SharedKernel/Domain';
import { Account } from '@Contexts/Groups/Domain/Account/Account';
import { AccountName } from '@Contexts/Groups/Domain/Account/AccountName';
import { PostgresAccountRepository } from '@Contexts/Groups/Infrastructure/PostgresAccountRepository';

describe('PostgresAccountRepository, deleting an account (request 35)', () => {
  it('erases the email, the name and the password, in every table, and frees the email', async () => {
    const database = freshDatabase();
    const repository = new PostgresAccountRepository(database);
    const unit = new PostgresUnitOfWork(database);
    await unit.beginTransaction();

    const cy = Account.register({
      email: Email.create('cy-secret@example.com').data as Email,
      name: AccountName.create('Cy Secret').data as AccountName,
      passwordHash: 'hash-of-cy',
    });
    expect((await repository.save(cy)).isSuccess()).toBe(true);
    // The fact of the sign-up, still waiting in the outbox, carries the email and the name.
    await new PostgresOutbox(database).append(cy.pullDomainEvents());

    const read = (await repository.findById(cy._id)) as Account;
    expect(
      read
        .delete({ at: new Date('2026-05-01T10:00:00.000Z'), ownsAGroupWithMembers: false, paymentWaiting: false })
        .isSuccess(),
    ).toBe(true);
    expect((await repository.save(read)).isSuccess()).toBe(true);

    const tables = await database.connection.rows<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
    );
    expect(tables.map(({ table_name }) => table_name)).toEqual(expect.arrayContaining(['accounts', 'outbox']));
    for (const { table_name: table } of tables) {
      const rows = await database.connection.rows(
        `SELECT t::text AS found FROM "${table}" t WHERE t::text ILIKE '%cy-secret%' OR t::text ILIKE '%Cy Secret%' OR t::text LIKE '%hash-of-cy%'`,
      );
      expect({ table, rows }).toEqual({ table, rows: [] });
    }

    const stored = (await repository.findById(cy._id)) as Account;
    expect(stored.isDeleted).toBe(true);
    expect(stored.name.value).toBe('Deleted account');
    expect(await repository.findByEmail(Email.create('cy-secret@example.com').data as Email)).toBeNull();
    expect(await repository.findById(new Id('nobody'))).toBeNull();

    // The email is free for a new account, which is someone else.
    const again = Account.register({
      email: Email.create('cy-secret@example.com').data as Email,
      name: AccountName.create('Someone Else').data as AccountName,
      passwordHash: 'hash',
    });
    expect((await repository.save(again)).isSuccess()).toBe(true);
    await unit.rollbackTransaction();
    await database.close();
  });
});

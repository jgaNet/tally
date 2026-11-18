import { writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../app';
import { emailKey } from '../accounts/validation';
import { hashPassword } from '../accounts/passwords';
import { openDatabase } from '../database';
import { send, temporaryDatabaseUrl, temporaryLegacyFilePath } from '../test-support';
import { legacyMigrations } from './sqlite-schema';

const SECRET = 'the-provider-secret';
const CREATED = '2026-01-01T10:00:00.000Z';
const PASSWORD = 'correct horse';

/**
 * A file Tally kept as SQLite, brought to `version` steps of its schema, with `rows` written in it. The file is what an
 * earlier version of Tally left behind, so its schema is the one of that version, and nothing of it is changed here.
 */
function legacyFileAt(version: number, rows: string): string {
  const path = temporaryLegacyFilePath();
  const file = new DatabaseSync(path);
  try {
    file.exec(legacyMigrations.slice(0, version).join('\n'));
    file.exec(`PRAGMA user_version = ${version}`);
    file.exec(rows);
  } finally {
    file.close();
  }
  return path;
}

/** The rows of a Tally file of the current schema: two members of a group, an expense, a cash settlement. */
async function currentFile(extra = ''): Promise<string> {
  const ada = await hashPassword(PASSWORD);
  const grace = await hashPassword('another password');
  return legacyFileAt(
    legacyMigrations.length,
    `
    INSERT INTO accounts (id, email, email_key, name, password_salt, password_hash, created_at) VALUES
      ('ada', 'ada@example.com', '${emailKey('ada@example.com')}', 'Ada', '${ada.salt}', '${ada.hash}', '${CREATED}'),
      ('grace', 'grace@example.com', '${emailKey('grace@example.com')}', 'Grace', '${grace.salt}', '${grace.hash}', '${CREATED}');
    INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES ('g1', 'Trip', 'EUR', 'ada', '${CREATED}');
    INSERT INTO memberships (group_id, account_id, joined_at) VALUES
      ('g1', 'ada', '${CREATED}'), ('g1', 'grace', '2026-01-02T10:00:00.000Z');
    INSERT INTO expenses (id, group_id, description, amount, date, paid_by, created_at)
      VALUES ('e1', 'g1', 'Dinner', 3000, '2026-01-03', 'ada', '2026-01-03T10:00:00.000Z');
    INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES ('e1', 0, 'ada', 1500), ('e1', 1, 'grace', 1500);
    INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
      VALUES ('s1', 'g1', 'grace', 'ada', 1000, 'cash', 'paid', '2026-01-04T10:00:00.000Z');
    INSERT INTO settlement_statuses (settlement_id, status, at) VALUES ('s1', 'paid', '2026-01-04T10:00:00.000Z');
    INSERT INTO audit_entries (id, group_id, at, by_id, action, subject_id, amount)
      VALUES ('a1', 'g1', '2026-01-03T10:00:00.000Z', 'ada', 'expense-recorded', 'e1', 3000);
    ${extra}
    `,
  );
}

const signed = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');

describe('moving a SQLite file into PostgreSQL', () => {
  it('moves everything the file holds into an empty database, and serves it', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const app = await createApplication({ databaseUrl, databasePath: await currentFile() });
    try {
      const login = await send(app, 'POST', '/accounts/login', {
        payload: { email: 'ada@example.com', password: PASSWORD },
      });
      expect(login.statusCode).toBe(200);
      const token = login.json<{ token: string }>().token;
      expect((await send(app, 'GET', '/accounts/me', { token })).json()).toEqual({
        id: 'ada',
        email: 'ada@example.com',
        name: 'Ada',
      });

      const balances = await send(app, 'GET', '/groups/g1/balances', { token });
      expect(balances.json()).toEqual([
        { memberId: 'ada', balance: 500 },
        { memberId: 'grace', balance: -500 },
      ]);
      const expenses = await send(app, 'GET', '/groups/g1/expenses', { token });
      expect(expenses.json()).toEqual([
        expect.objectContaining({ id: 'e1', description: 'Dinner', amount: 3000, paidBy: 'ada', version: 1 }),
      ]);
      const settlement = await send(app, 'GET', '/settlements/s1', { token });
      expect(settlement.json()).toEqual(
        expect.objectContaining({
          id: 's1',
          status: 'paid',
          history: [{ status: 'paid', at: '2026-01-04T10:00:00.000Z' }],
        }),
      );
      const audit = await send(app, 'GET', '/groups/g1/audit', { token });
      expect(audit.json()).toEqual([
        {
          id: 'a1',
          at: '2026-01-03T10:00:00.000Z',
          by: 'ada',
          action: 'expense-recorded',
          subjectId: 'e1',
          amount: 3000,
        },
      ]);
    } finally {
      await app.stop();
    }
  });

  it('keeps the order of rows: the groups and expenses are listed as they were made', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const app = await createApplication({
      databaseUrl,
      databasePath: await currentFile(`
        INSERT INTO expenses (id, group_id, description, amount, date, paid_by, created_at)
          VALUES ('e2', 'g1', 'Taxi', 800, '2026-01-03', 'grace', '2026-01-03T10:00:00.000Z');
        INSERT INTO expense_shares (expense_id, position, member_id, amount) VALUES ('e2', 0, 'ada', 400), ('e2', 1, 'grace', 400);
      `),
    });
    try {
      const token = (
        await send(app, 'POST', '/accounts/login', { payload: { email: 'ada@example.com', password: PASSWORD } })
      ).json<{ token: string }>().token;
      // Same date and same creation time: the one recorded later is listed first, as before the move.
      const expenses = await send(app, 'GET', '/groups/g1/expenses', { token });
      expect(expenses.json().map((expense: { id: string }) => expense.id)).toEqual(['e2', 'e1']);
    } finally {
      await app.stop();
    }
  });

  it('moves a payment waiting at the provider, and it lands when its webhook comes, counted once', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const pending = `
      INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, pay_url, provider_payment_id, created_at)
        VALUES ('p1', 'g1', 'grace', 'ada', 500, 'provider', 'pending', 'https://pay.example.test/pay-1', 'pay-1', '2026-01-05T10:00:00.000Z');
      INSERT INTO settlement_statuses (settlement_id, status, at) VALUES ('p1', 'pending', '2026-01-05T10:00:00.000Z');
    `;
    const app = await createApplication({
      databaseUrl,
      databasePath: await currentFile(pending),
      providerWebhookSecret: SECRET,
    });
    try {
      const token = (
        await send(app, 'POST', '/accounts/login', { payload: { email: 'ada@example.com', password: PASSWORD } })
      ).json<{ token: string }>().token;
      // Waiting at the provider, the payment is not counted yet.
      expect((await send(app, 'GET', '/groups/g1/balances', { token })).json()).toEqual([
        { memberId: 'ada', balance: 500 },
        { memberId: 'grace', balance: -500 },
      ]);

      const body = JSON.stringify({ paymentId: 'pay-1', status: 'succeeded' });
      const first = await app.server.inject({
        method: 'POST',
        url: '/v1/provider/webhooks',
        headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
        payload: body,
      });
      expect(first.statusCode).toBe(204);
      // Once more, as a provider redelivers it: nothing is counted again.
      const again = await app.server.inject({
        method: 'POST',
        url: '/v1/provider/webhooks',
        headers: { 'content-type': 'application/json', 'provider-signature': signed(body) },
        payload: body,
      });
      expect(again.statusCode).toBe(204);

      expect((await send(app, 'GET', '/groups/g1/balances', { token })).json()).toEqual([
        { memberId: 'ada', balance: 0 },
        { memberId: 'grace', balance: 0 },
      ]);
      const settlement = (await send(app, 'GET', '/settlements/p1', { token })).json();
      expect(settlement.status).toBe('paid');
      expect(settlement.history.map((entry: { status: string }) => entry.status)).toEqual(['pending', 'paid']);
      const audit = (await send(app, 'GET', '/groups/g1/audit', { token })).json() as {
        subjectId: string;
        action: string;
      }[];
      expect(audit.filter(entry => entry.subjectId === 'p1')).toEqual([
        expect.objectContaining({ action: 'settlement-paid' }),
      ]);
    } finally {
      await app.stop();
    }
  });

  it('reads the file once: a file changed after it was moved is not read again, and nothing it adds is kept', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const path = await currentFile();
    const first = await createApplication({ databaseUrl, databasePath: path });
    await first.stop();
    const changed = new DatabaseSync(path);
    changed.exec(`UPDATE accounts SET name = 'Changed' WHERE id = 'ada';
      INSERT INTO accounts (id, email, email_key, name, password_salt, password_hash, created_at)
        VALUES ('zoe', 'zoe@example.com', 'zoe@example.com', 'Zoe', 's', 'h', '${CREATED}');`);
    changed.close();

    const again = await createApplication({ databaseUrl, databasePath: path });
    try {
      const token = (
        await send(again, 'POST', '/accounts/login', { payload: { email: 'ada@example.com', password: PASSWORD } })
      ).json<{ token: string }>().token;
      expect((await send(again, 'GET', '/accounts/me', { token })).json().name).toBe('Ada');
      const zoe = await send(again, 'POST', '/accounts/login', {
        payload: { email: 'zoe@example.com', password: 'h' },
      });
      expect(zoe.statusCode).toBe(401);
    } finally {
      await again.stop();
    }
  });

  it('moves nothing into a database that already holds Tally’s data', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const first = await createApplication({ databaseUrl });
    await send(first, 'POST', '/accounts', {
      payload: { email: 'zoe@example.com', password: 'a password', name: 'Zoe' },
    });
    await first.stop();

    const second = await createApplication({ databaseUrl, databasePath: await currentFile() });
    try {
      const zoe = await send(second, 'POST', '/accounts/login', {
        payload: { email: 'zoe@example.com', password: 'a password' },
      });
      expect(zoe.statusCode).toBe(200);
      const ada = await send(second, 'POST', '/accounts/login', {
        payload: { email: 'ada@example.com', password: PASSWORD },
      });
      expect(ada.statusCode).toBe(401);
    } finally {
      await second.stop();
    }
  });

  it('is moved once when several servers start on an empty database together', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const path = await currentFile();
    const [a, b] = await Promise.all([
      createApplication({ databaseUrl, databasePath: path }),
      createApplication({ databaseUrl, databasePath: path }),
    ]);
    try {
      const db = await openDatabase(databaseUrl);
      try {
        expect(await db.row('SELECT COUNT(*) AS count FROM accounts')).toEqual({ count: 2 });
        expect(await db.row('SELECT COUNT(*) AS count FROM expenses')).toEqual({ count: 1 });
      } finally {
        await db.close();
      }
      const login = await send(b, 'POST', '/accounts/login', {
        payload: { email: 'ada@example.com', password: PASSWORD },
      });
      expect(login.statusCode).toBe(200);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it('serves an empty database at once when there is no file to move', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const app = await createApplication({ databaseUrl, databasePath: '/no/such/directory/tally.db' });
    try {
      const created = await send(app, 'POST', '/accounts', {
        payload: { email: 'ada@example.com', password: PASSWORD, name: 'Ada' },
      });
      expect(created.statusCode).toBe(201);
    } finally {
      await app.stop();
    }
  });

  it('moves a file of an earlier version, and brings the history of its settlements up to date', async () => {
    // Version 14 is the schema before settlements kept their history: a cash settlement and a provider one, paid.
    const ada = await hashPassword(PASSWORD);
    const path = legacyFileAt(
      14,
      `
      INSERT INTO accounts (id, email, email_key, name, password_salt, password_hash, created_at) VALUES
        ('ada', 'ada@example.com', 'ada@example.com', 'Ada', '${ada.salt}', '${ada.hash}', '${CREATED}'),
        ('grace', 'grace@example.com', 'grace@example.com', 'Grace', 's', 'h', '${CREATED}');
      INSERT INTO groups (id, name, currency, owner_id, created_at) VALUES ('g1', 'Trip', 'EUR', 'ada', '${CREATED}');
      INSERT INTO memberships (group_id, account_id, joined_at) VALUES ('g1', 'ada', '${CREATED}'), ('g1', 'grace', '${CREATED}');
      INSERT INTO settlements (id, group_id, payer_id, payee_id, amount, method, status, created_at)
        VALUES ('c1', 'g1', 'grace', 'ada', 100, 'cash', 'paid', '2026-01-04T10:00:00.000Z'),
               ('p1', 'g1', 'grace', 'ada', 200, 'provider', 'paid', '2026-01-05T10:00:00.000Z');
      UPDATE settlements SET pay_url = 'https://pay.example.test/pay-1', provider_payment_id = 'pay-1' WHERE id = 'p1';
      `,
    );
    const databaseUrl = await temporaryDatabaseUrl();
    const app = await createApplication({ databaseUrl, databasePath: path });
    try {
      const token = (
        await send(app, 'POST', '/accounts/login', { payload: { email: 'ada@example.com', password: PASSWORD } })
      ).json<{ token: string }>().token;
      expect((await send(app, 'GET', '/settlements/c1', { token })).json().history).toEqual([
        { status: 'paid', at: '2026-01-04T10:00:00.000Z' },
      ]);
      expect((await send(app, 'GET', '/settlements/p1', { token })).json().history).toEqual([
        { status: 'pending', at: '2026-01-05T10:00:00.000Z' },
        { status: 'paid', at: '2026-01-05T10:00:00.000Z' },
      ]);
    } finally {
      await app.stop();
    }
  });

  it('leaves the database as it was when the file cannot be moved, and moves it on the next start', async () => {
    const databaseUrl = await temporaryDatabaseUrl();
    const broken = temporaryLegacyFilePath();
    writeFileSync(broken, 'this is not a SQLite file');
    await expect(createApplication({ databaseUrl, databasePath: broken })).rejects.toThrow();

    const app = await createApplication({ databaseUrl, databasePath: await currentFile() });
    try {
      const login = await send(app, 'POST', '/accounts/login', {
        payload: { email: 'ada@example.com', password: PASSWORD },
      });
      expect(login.statusCode).toBe(200);
    } finally {
      await app.stop();
    }
  });
});

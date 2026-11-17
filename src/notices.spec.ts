import { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

describe('notices', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: DatabaseSync;

  beforeEach(async () => {
    directory = testDirectory();
    app = await startApplication(directory.databasePath);
    // A second connection to the same file, to count what was stored.
    db = openDatabase(directory.databasePath);
  });

  afterEach(async () => {
    db.close();
    await app.stop();
    directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Flat', currency: 'EUR' } });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Makes the account of `joinerToken` a member of `groupId`, through an invitation its owner creates. */
  async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
    const id = (invitation.body as { id: string }).id;
    const accepted = await send(app, 'POST', `/invitations/${id}/accept`, { token: joinerToken });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
  }

  /** Records an expense as `token`'s account, with `fields` naming its split; answers its status and id. */
  async function record(token: string, groupId: string, fields: Record<string, unknown>, amount = 900) {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Pizzas', amount, date: utcDay(0), ...fields },
    });
    return { status: reply.status, id: (reply.body as { id?: string } | undefined)?.id };
  }

  /** The notices of the account of `token`, as the API answers them. */
  async function noticesAs(token: string) {
    return send(app, 'GET', '/notices', { token });
  }

  /** How many notices the file holds, read on the second connection. */
  function storedNotices(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM notices').get() as { n: number }).n;
  }

  it('makes a notice to each member of the split but the payer, of their share', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const di = await signedUpAccount(app, { email: 'di@example.com', name: 'Di' });
    const groupId = await createGroup(bob.token);
    await join(bob.token, groupId, cy.token);
    await join(bob.token, groupId, di.token);

    const expense = await record(bob.token, groupId, { splitBetween: [bob.id, cy.id, di.id] }, 1000);
    expect(expense.status).toBe(201);

    const cyNotices = await noticesAs(cy.token);
    expect(cyNotices.status).toBe(200);
    expect(cyNotices.body).toEqual([
      {
        id: expect.any(String),
        kind: 'expense',
        groupId,
        expenseId: expense.id,
        amount: 333,
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      },
    ]);
    // Di's share of 1000 between three is 333 too: the remainder went to Bob, the first member listed.
    expect(await noticesAs(di.token)).toMatchObject({ status: 200, body: [{ expenseId: expense.id, amount: 333 }] });
  });

  it('answers the member’s share of an exact split and of a split by shares', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const groupId = await createGroup(bob.token);
    await join(bob.token, groupId, cy.token);

    await record(
      bob.token,
      groupId,
      {
        splitExactly: [
          { memberId: bob.id, amount: 400 },
          { memberId: cy.id, amount: 500 },
        ],
      },
      900,
    );
    await record(
      bob.token,
      groupId,
      {
        splitByShares: [
          { memberId: bob.id, shares: 1 },
          { memberId: cy.id, shares: 2 },
        ],
      },
      900,
    );

    const amounts = (await noticesAs(cy.token)).body as { amount: number }[];
    // Exact: Cy's 500. By shares (1 to 2 of 900): Cy's 600.
    expect(amounts.map(notice => notice.amount).sort((a, b) => a - b)).toEqual([500, 600]);
  });

  it('makes no notice to the payer, and none when the payer is the only member split', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const groupId = await createGroup(bob.token);

    expect((await record(bob.token, groupId, { splitBetween: [bob.id] })).status).toBe(201);
    expect(await noticesAs(bob.token)).toEqual({ status: 200, body: [] });
    expect(storedNotices()).toBe(0);
  });

  it('makes no notice when an expense is refused, nor when it is edited or deleted', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const groupId = await createGroup(bob.token);
    await join(bob.token, groupId, cy.token);

    // Refused: the description is empty, so nothing is recorded, and no notice either.
    const refused = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: bob.token,
      body: { description: '  ', amount: 900, date: utcDay(0), splitBetween: [bob.id, cy.id] },
    });
    expect(refused.status).toBe(422);
    expect(storedNotices()).toBe(0);

    const expense = await record(bob.token, groupId, { splitBetween: [bob.id, cy.id] });
    expect(storedNotices()).toBe(1);

    const edited = await send(app, 'PUT', `/expenses/${expense.id}`, {
      token: bob.token,
      body: { description: 'Pasta', amount: 1200, date: utcDay(0), splitBetween: [bob.id, cy.id], version: 1 },
    });
    expect(edited.status).toBe(200);
    expect(storedNotices()).toBe(1);

    expect((await send(app, 'DELETE', `/expenses/${expense.id}`, { token: bob.token })).status).toBe(204);
    expect(storedNotices()).toBe(1);
    // The notice made when the expense was recorded stays, and is read as it was.
    expect(await noticesAs(cy.token)).toMatchObject({ body: [{ expenseId: expense.id, amount: 450 }] });
  });

  it('answers a person’s notices the most recent first', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const groupId = await createGroup(bob.token);
    await join(bob.token, groupId, cy.token);

    const first = await record(bob.token, groupId, { splitBetween: [bob.id, cy.id] });
    const second = await record(bob.token, groupId, { splitBetween: [bob.id, cy.id] });
    const third = await record(bob.token, groupId, { splitBetween: [bob.id, cy.id] });

    const reply = await noticesAs(cy.token);
    expect((reply.body as { expenseId: string }[]).map(notice => notice.expenseId)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
  });

  it('shows a notice at once, with the expense, and without any job having run', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const groupId = await createGroup(bob.token);
    await join(bob.token, groupId, cy.token);

    const expense = await record(bob.token, groupId, { splitBetween: [bob.id, cy.id] });
    expect(await noticesAs(cy.token)).toMatchObject({ status: 200, body: [{ expenseId: expense.id }] });
  });

  it('keeps one notice per member, across a restart of the server on the same file', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const groupId = await createGroup(bob.token);
    await join(bob.token, groupId, cy.token);
    const expense = await record(bob.token, groupId, { splitBetween: [bob.id, cy.id] });

    await app.stop();
    db.close();
    app = await startApplication(directory.databasePath);
    db = openDatabase(directory.databasePath);

    expect(storedNotices()).toBe(1);
    expect(await noticesAs(cy.token)).toMatchObject({ status: 200, body: [{ expenseId: expense.id }] });
  });

  it('never makes two notices for one expense and one member', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const groupId = await createGroup(bob.token);
    await join(bob.token, groupId, cy.token);
    const expense = await record(bob.token, groupId, { splitBetween: [bob.id, cy.id] });

    expect(() =>
      db
        .prepare(
          `INSERT INTO notices (id, recipient_id, kind, group_id, expense_id, amount, created_at)
           VALUES ('again', ?, 'expense', ?, ?, 1, '2026-01-01T00:00:00.000Z')`,
        )
        .run(cy.id, groupId, expense.id as string),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('lets a person read only their own notices', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const di = await signedUpAccount(app, { email: 'di@example.com', name: 'Di' });
    const groupId = await createGroup(bob.token);
    await join(bob.token, groupId, cy.token);
    await join(bob.token, groupId, di.token);
    await record(bob.token, groupId, { splitBetween: [bob.id, cy.id] });

    expect(await noticesAs(bob.token)).toEqual({ status: 200, body: [] });
    expect(await noticesAs(di.token)).toEqual({ status: 200, body: [] });
    expect(await noticesAs(cy.token)).toMatchObject({ body: [{ kind: 'expense' }] });
  });

  it('keeps a notice after the member leaves the group', async () => {
    const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
    const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
    const groupId = await createGroup(bob.token);
    await join(bob.token, groupId, cy.token);
    // Cy's share is 0, so Cy's balance is 0 and Cy may leave; the notice still names their share.
    const expense = await record(bob.token, groupId, {
      splitExactly: [
        { memberId: bob.id, amount: 900 },
        { memberId: cy.id, amount: 0 },
      ],
    });
    expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: cy.token })).status).toBe(204);

    expect(await noticesAs(cy.token)).toEqual({
      status: 200,
      body: [
        { id: expect.any(String), kind: 'expense', groupId, expenseId: expense.id, amount: 0, at: expect.any(String) },
      ],
    });
  });

  it('refuses a read without a valid token with 401', async () => {
    expect((await send(app, 'GET', '/notices')).status).toBe(401);
    expect((await send(app, 'GET', '/notices', { token: 'nope' })).status).toBe(401);
  });

  it('answers an empty list to a person with no notices', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.com', name: 'Ana' });
    expect(await noticesAs(ana.token)).toEqual({ status: 200, body: [] });
  });
});

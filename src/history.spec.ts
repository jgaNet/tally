import type { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

describe('the expenses of a group', () => {
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

  /** Records an expense in `groupId` as `token`'s account and answers its id; it must be accepted. */
  async function record(
    token: string,
    groupId: string,
    description: string,
    splitBetween: string[],
    date = utcDay(0),
    amount = 1000,
  ): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description, amount, date, splitBetween },
    });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** The expenses of `groupId`, read as `token`'s account. */
  async function expensesAs(token: string, groupId: string) {
    return send(app, 'GET', `/groups/${groupId}/expenses`, { token });
  }

  /** The descriptions of the expenses of `groupId`, in the order they are read. */
  async function descriptionsAs(token: string, groupId: string): Promise<string[]> {
    const reply = await expensesAs(token, groupId);
    if (reply.status !== 200) throw new Error(`list answered ${reply.status}`);
    return (reply.body as { description: string }[]).map(expense => expense.description);
  }

  /** How many expenses and shares the file holds, read on the second connection. */
  function storedCounts(): { expenses: number; shares: number } {
    const expenses = db.prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number };
    const shares = db.prepare('SELECT COUNT(*) AS n FROM expense_shares').get() as { n: number };
    return { expenses: expenses.n, shares: shares.n };
  }

  it('answers an empty list for a group with no expenses', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    const reply = await expensesAs(ana.token, groupId);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual([]);
  });

  it('lists the latest date first', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    await record(ana.token, groupId, 'Old', [ana.id], utcDay(-5));
    await record(ana.token, groupId, 'Newest', [ana.id], utcDay(0));
    await record(ana.token, groupId, 'Middle', [ana.id], utcDay(-2));
    expect(await descriptionsAs(ana.token, groupId)).toEqual(['Newest', 'Middle', 'Old']);
  });

  it('lists, on the same date, the most recently recorded first', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(ana.token, groupId, 'First', [ana.id, ben.id], utcDay(-1));
    await record(ana.token, groupId, 'Second', [ana.id, ben.id], utcDay(-1));
    await record(ben.token, groupId, 'Third', [ana.id, ben.id], utcDay(-1));
    expect(await descriptionsAs(ana.token, groupId)).toEqual(['Third', 'Second', 'First']);
  });

  it('does not move an expense it edits: the edit does not change when it was recorded', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    const first = await record(ana.token, groupId, 'First', [ana.id], utcDay(0));
    await record(ana.token, groupId, 'Second', [ana.id], utcDay(0));
    const edit = await send(app, 'PUT', `/expenses/${first}`, {
      token: ana.token,
      body: { description: 'First, corrected', amount: 1200, date: utcDay(0), splitBetween: [ana.id], version: 1 },
    });
    expect(edit.status).toBe(200);
    expect(await descriptionsAs(ana.token, groupId)).toEqual(['Second', 'First, corrected']);
  });

  it('moves an expense it edits to its new date, the order of dates still first', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    const older = await record(ana.token, groupId, 'Older', [ana.id], utcDay(-3));
    await record(ana.token, groupId, 'Recent', [ana.id], utcDay(-1));
    await send(app, 'PUT', `/expenses/${older}`, {
      token: ana.token,
      body: { description: 'Older', amount: 1000, date: utcDay(0), splitBetween: [ana.id], version: 1 },
    });
    expect(await descriptionsAs(ana.token, groupId)).toEqual(['Older', 'Recent']);
  });

  it('answers each expense as GET /v1/expenses/{id} reads it', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    const byShares = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ben.token,
      body: {
        description: 'Cottage',
        amount: 1001,
        date: utcDay(0),
        splitByShares: [
          { memberId: ana.id, shares: 2 },
          { memberId: ben.id, shares: 1 },
        ],
      },
    });
    expect(byShares.status).toBe(201);
    const sharesId = (byShares.body as { id: string }).id;
    const listed = (await expensesAs(ana.token, groupId)).body as unknown[];
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual((await send(app, 'GET', `/expenses/${sharesId}`, { token: ana.token })).body);
    expect(listed[0]).toMatchObject({
      id: sharesId,
      groupId,
      description: 'Cottage',
      amount: 1001,
      date: utcDay(0),
      paidBy: ben.id,
      version: 1,
      splitKind: 'shares',
      shares: [
        { memberId: ana.id, amount: 667 },
        { memberId: ben.id, amount: 334 },
      ],
    });
  });

  it('leaves out an expense that was deleted', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    const gone = await record(ana.token, groupId, 'Gone', [ana.id], utcDay(0));
    await record(ana.token, groupId, 'Kept', [ana.id], utcDay(0));
    const deleted = await send(app, 'DELETE', `/expenses/${gone}`, { token: ana.token });
    expect(deleted.status).toBe(204);
    expect(await descriptionsAs(ana.token, groupId)).toEqual(['Kept']);
  });

  it('lists only the expenses of its own group', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const flat = await createGroup(ana.token);
    const trip = await createGroup(ana.token);
    await record(ana.token, flat, 'Flat only', [ana.id], utcDay(0));
    expect(await descriptionsAs(ana.token, trip)).toEqual([]);
  });

  it('answers the same list to every member of the group', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(ben.token, groupId, 'Bread', [ana.id, ben.id], utcDay(0));
    expect((await expensesAs(ben.token, groupId)).body).toEqual((await expensesAs(ana.token, groupId)).body);
  });

  it('answers 404 to a signed-in account that is not a member, exactly as for a group that does not exist', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await record(ana.token, groupId, 'Secret', [ana.id], utcDay(0));
    const outsider = await expensesAs(ben.token, groupId);
    const missing = await expensesAs(ben.token, 'no-such-group');
    expect(outsider.status).toBe(404);
    expect(outsider.body).toMatchObject({ error: 'GroupNotFound' });
    expect(outsider.body).toEqual(missing.body);
  });

  it('refuses a request with no token, or an unproven one, with 401', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    expect((await send(app, 'GET', `/groups/${groupId}/expenses`)).status).toBe(401);
    expect((await expensesAs('not-a-real-token', groupId)).status).toBe(401);
  });

  it('stays the same however often it is read, and changes nothing stored', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(ana.token, groupId, 'Bread', [ana.id, ben.id], utcDay(0));
    const before = storedCounts();
    const first = await expensesAs(ana.token, groupId);
    const second = await expensesAs(ben.token, groupId);
    expect(second.body).toEqual(first.body);
    expect(storedCounts()).toEqual(before);
  });

  it('keeps the order across restarts', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    await record(ana.token, groupId, 'Old', [ana.id], utcDay(-1));
    await record(ana.token, groupId, 'New', [ana.id], utcDay(0));
    const before = await expensesAs(ana.token, groupId);
    await app.stop();
    db.close();

    app = await startApplication(directory.databasePath);
    db = openDatabase(directory.databasePath);
    expect((await expensesAs(ana.token, groupId)).body).toEqual(before.body);
  });
});

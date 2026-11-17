import type { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

describe('a statement of a member', () => {
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

  /** Records an expense equally split between `splitBetween`, as `token`'s account; answers its id. */
  async function record(
    token: string,
    groupId: string,
    description: string,
    amount: number,
    splitBetween: string[],
    date = utcDay(0),
  ): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description, amount, date, splitBetween },
    });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** The statement of `memberId` in `groupId`, read as `token`'s account. */
  async function statementAs(token: string, groupId: string, memberId: string) {
    return send(app, 'GET', `/groups/${groupId}/members/${memberId}/statement`, { token });
  }

  /** The balances of `groupId`, read as `token`'s account. */
  async function balancesAs(token: string, groupId: string) {
    return send(app, 'GET', `/groups/${groupId}/balances`, { token });
  }

  /** How many expenses and shares the file holds, read on the second connection. */
  function storedCounts(): { expenses: number; shares: number } {
    const expenses = db.prepare('SELECT COUNT(*) AS n FROM expenses').get() as { n: number };
    const shares = db.prepare('SELECT COUNT(*) AS n FROM expense_shares').get() as { n: number };
    return { expenses: expenses.n, shares: shares.n };
  }

  it('answers an empty statement, with balance 0, for a member who has recorded nothing and is in no split', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    const reply = await statementAs(ben.token, groupId, ben.id);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ memberId: ben.id, balance: 0, entries: [] });
  });

  it('lists, for each expense the member paid or is in the split of, what they paid, their share and their balance', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await join(ana.token, groupId, cleo.token);
    const dinner = await record(ana.token, groupId, 'Dinner', 900, [ana.id, ben.id, cleo.id], utcDay(-2));
    const wine = await record(ben.token, groupId, 'Wine', 1000, [ben.id, cleo.id], utcDay(-1));

    expect((await statementAs(ana.token, groupId, ana.id)).body).toEqual({
      memberId: ana.id,
      balance: 600,
      entries: [{ expenseId: dinner, date: utcDay(-2), description: 'Dinner', paid: 900, share: 300, balance: 600 }],
    });
    expect((await statementAs(cleo.token, groupId, cleo.id)).body).toEqual({
      memberId: cleo.id,
      balance: -800,
      entries: [
        { expenseId: dinner, date: utcDay(-2), description: 'Dinner', paid: 0, share: 300, balance: -300 },
        { expenseId: wine, date: utcDay(-1), description: 'Wine', paid: 0, share: 500, balance: -800 },
      ],
    });
    expect((await statementAs(ben.token, groupId, ben.id)).body).toEqual({
      memberId: ben.id,
      balance: 200,
      entries: [
        { expenseId: dinner, date: utcDay(-2), description: 'Dinner', paid: 0, share: 300, balance: -300 },
        { expenseId: wine, date: utcDay(-1), description: 'Wine', paid: 1000, share: 500, balance: 200 },
      ],
    });
  });

  it('lists the earliest date first, and on the same date the earliest recorded first', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    const first = await record(ana.token, groupId, 'Today, first', 100, [ana.id], utcDay(0));
    const second = await record(ana.token, groupId, 'Yesterday', 100, [ana.id], utcDay(-1));
    const third = await record(ana.token, groupId, 'Today, second', 100, [ana.id], utcDay(0));
    const reply = await statementAs(ana.token, groupId, ana.id);
    const entries = (reply.body as { entries: { expenseId: string }[] }).entries;
    expect(entries.map(entry => entry.expenseId)).toEqual([second, first, third]);
  });

  it('answers the balance of the last entry, which is the balance the group gives the member', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await join(ana.token, groupId, cleo.token);
    await record(ana.token, groupId, 'Bread', 1001, [ana.id, ben.id, cleo.id], utcDay(-3));
    await record(cleo.token, groupId, 'Milk', 700, [ana.id, cleo.id], utcDay(-2));
    await record(ben.token, groupId, 'Cake', 999, [ben.id, cleo.id, ana.id], utcDay(-1));
    const balances = (await balancesAs(ana.token, groupId)).body as { memberId: string; balance: number }[];
    for (const member of [ana, ben, cleo]) {
      const statement = (await statementAs(ana.token, groupId, member.id)).body as {
        balance: number;
        entries: { balance: number }[];
      };
      const groupBalance = balances.find(balance => balance.memberId === member.id)?.balance;
      expect(statement.balance).toBe(groupBalance);
      expect(statement.entries.at(-1)?.balance ?? 0).toBe(statement.balance);
    }
  });

  it('answers the same statement to every member of the group, the member themselves included', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(ben.token, groupId, 'Bread', 1000, [ben.id, ana.id], utcDay(0));
    const asAna = await statementAs(ana.token, groupId, ben.id);
    const asBen = await statementAs(ben.token, groupId, ben.id);
    expect(asAna.status).toBe(200);
    expect(asAna.body).toEqual(asBen.body);
  });

  it('leaves out an expense the member neither paid nor is in the split of', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await join(ana.token, groupId, cleo.token);
    await record(ana.token, groupId, 'Ana and Ben', 1000, [ana.id, ben.id], utcDay(0));
    const statement = (await statementAs(cleo.token, groupId, cleo.id)).body as { entries: unknown[] };
    expect(statement.entries).toEqual([]);
  });

  it('leaves out an expense that was deleted, and counts it in no balance', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(ana.token, groupId, 'Kept', 900, [ana.id, ben.id], utcDay(-1));
    const gone = await record(ben.token, groupId, 'Gone', 1000, [ana.id, ben.id], utcDay(0));
    expect((await send(app, 'DELETE', `/expenses/${gone}`, { token: ben.token })).status).toBe(204);
    const statement = (await statementAs(ben.token, groupId, ben.id)).body as {
      balance: number;
      entries: { description: string }[];
    };
    expect(statement.entries.map(entry => entry.description)).toEqual(['Kept']);
    expect(statement.balance).toBe(-450);
    expect((await balancesAs(ben.token, groupId)).body).toEqual([
      { memberId: ana.id, balance: 450 },
      { memberId: ben.id, balance: -450 },
    ]);
  });

  it('answers an edit: the entry reads the edited expense, and the member leaves a split they are taken out of', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await join(ana.token, groupId, cleo.token);
    const dinner = await record(ana.token, groupId, 'Dinner', 900, [ana.id, ben.id, cleo.id], utcDay(-1));
    const edit = await send(app, 'PUT', `/expenses/${dinner}`, {
      token: ana.token,
      body: {
        description: 'Dinner, for two',
        amount: 600,
        date: utcDay(-1),
        splitBetween: [ana.id, ben.id],
        version: 1,
      },
    });
    expect(edit.status).toBe(200);
    expect((await statementAs(cleo.token, groupId, cleo.id)).body).toEqual({
      memberId: cleo.id,
      balance: 0,
      entries: [],
    });
    expect((await statementAs(ben.token, groupId, ben.id)).body).toEqual({
      memberId: ben.id,
      balance: -300,
      entries: [
        { expenseId: dinner, date: utcDay(-1), description: 'Dinner, for two', paid: 0, share: 300, balance: -300 },
      ],
    });
  });

  it('answers 404 to a signed-in account that is not a member, exactly as for a group that does not exist', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await record(ana.token, groupId, 'Secret', 1000, [ana.id], utcDay(0));
    const outsider = await statementAs(ben.token, groupId, ana.id);
    const missing = await statementAs(ben.token, 'no-such-group', ana.id);
    expect(outsider.status).toBe(404);
    expect(outsider.body).toMatchObject({ error: 'GroupNotFound' });
    expect(outsider.body).toEqual(missing.body);
  });

  it('answers 404 for a member who has never been a member of the group, as if they did not exist', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const stranger = await signedUpAccount(app, { email: 'stranger@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    const reply = await statementAs(ben.token, groupId, stranger.id);
    expect(reply.status).toBe(404);
    expect(reply.body).toMatchObject({ error: 'MemberNotFound' });
    expect((await statementAs(ben.token, groupId, 'no-such-member')).status).toBe(404);
  });

  it('refuses a request with no token, or an unproven one, with 401', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    expect((await send(app, 'GET', `/groups/${groupId}/members/${ana.id}/statement`)).status).toBe(401);
    expect((await statementAs('not-a-real-token', groupId, ana.id)).status).toBe(401);
  });

  it('stays the same however often it is read, and changes nothing stored', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(ana.token, groupId, 'Bread', 1000, [ana.id, ben.id], utcDay(0));
    const before = storedCounts();
    const first = await statementAs(ana.token, groupId, ben.id);
    const second = await statementAs(ben.token, groupId, ben.id);
    expect(second.body).toEqual(first.body);
    expect(storedCounts()).toEqual(before);
  });

  it('keeps the statement across restarts', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(ben.token, groupId, 'Bread', 999, [ana.id, ben.id], utcDay(0));
    const before = await statementAs(ana.token, groupId, ben.id);
    await app.stop();
    db.close();

    app = await startApplication(directory.databasePath);
    db = openDatabase(directory.databasePath);
    expect((await statementAs(ana.token, groupId, ben.id)).body).toEqual(before.body);
  });
});

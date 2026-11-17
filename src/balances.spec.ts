import type { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { equalShares } from './expenses';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

describe('balances', () => {
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

  /** Records an expense in `groupId` as `token`'s account; it must be accepted. */
  async function record(
    server: Application,
    token: string,
    groupId: string,
    amount: number,
    splitBetween: string[],
    date = utcDay(0),
  ): Promise<void> {
    const reply = await send(server, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Groceries', amount, date, splitBetween },
    });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
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

  it('answers 0 for the only member of a group who has recorded nothing', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    const reply = await balancesAs(ana.token, groupId);
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual([{ memberId: ana.id, balance: 0 }]);
  });

  it('lists every member in the order they joined, the earliest first, not by name', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org', name: 'Ana' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org', name: 'Cleo' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, cleo.token);
    await join(ana.token, groupId, ben.token);
    const reply = await balancesAs(ana.token, groupId);
    expect(reply.body).toEqual([
      { memberId: ana.id, balance: 0 },
      { memberId: cleo.id, balance: 0 },
      { memberId: ben.id, balance: 0 },
    ]);
  });

  it('answers the balance of a member who is in no split and recorded nothing as 0', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await join(ana.token, groupId, cleo.token);
    await record(app, ana.token, groupId, 1000, [ana.id, ben.id]);
    const reply = await balancesAs(cleo.token, groupId);
    expect(reply.body).toEqual([
      { memberId: ana.id, balance: 500 },
      { memberId: ben.id, balance: -500 },
      { memberId: cleo.id, balance: 0 },
    ]);
  });

  it('answers what each member paid minus their shares, the payer being owed the rest of the amount', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await join(ana.token, groupId, cleo.token);
    // Ana pays 1000 split three ways: shares 334 (Ana, the remainder), 333 (Ben), 333 (Cleo).
    await record(app, ana.token, groupId, 1000, [ana.id, ben.id, cleo.id]);
    expect((await balancesAs(ana.token, groupId)).body).toEqual([
      { memberId: ana.id, balance: 666 },
      { memberId: ben.id, balance: -333 },
      { memberId: cleo.id, balance: -333 },
    ]);
  });

  it('sums over every expense of the group, a member owed by one and owing by another', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await join(ana.token, groupId, cleo.token);
    await record(app, ana.token, groupId, 1000, [ana.id, ben.id, cleo.id]);
    // Ben pays 900 split between Ben and Cleo: 450 each.
    await record(app, ben.token, groupId, 900, [ben.id, cleo.id]);
    expect((await balancesAs(cleo.token, groupId)).body).toEqual([
      { memberId: ana.id, balance: 666 },
      { memberId: ben.id, balance: 117 },
      { memberId: cleo.id, balance: -783 },
    ]);
  });

  it('answers the same balances to every member of the group', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(app, ben.token, groupId, 1001, [ben.id, ana.id]);
    const asAna = await balancesAs(ana.token, groupId);
    const asBen = await balancesAs(ben.token, groupId);
    expect(asAna.body).toEqual(asBen.body);
  });

  it('keeps the balances of the group out of the balances of another group', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const flat = await createGroup(ana.token);
    const trip = await createGroup(ana.token);
    await join(ana.token, flat, ben.token);
    await join(ana.token, trip, ben.token);
    await record(app, ana.token, flat, 1000, [ana.id, ben.id]);
    expect((await balancesAs(ana.token, trip)).body).toEqual([
      { memberId: ana.id, balance: 0 },
      { memberId: ben.id, balance: 0 },
    ]);
  });

  it('answers the balances an account sees after a refused expense as before it', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(app, ana.token, groupId, 1000, [ana.id, ben.id]);
    const before = await balancesAs(ana.token, groupId);
    const refused = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token: ana.token,
      body: { description: 'Refused', amount: 0, date: utcDay(0), splitBetween: [ana.id, ben.id] },
    });
    expect(refused.status).toBe(422);
    expect((await balancesAs(ana.token, groupId)).body).toEqual(before.body);
  });

  it('stays the same however often it is read, and changes nothing stored', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(app, ana.token, groupId, 1000, [ana.id, ben.id]);
    const before = storedCounts();
    const first = await balancesAs(ana.token, groupId);
    const second = await balancesAs(ben.token, groupId);
    expect(second.body).toEqual(first.body);
    expect(storedCounts()).toEqual(before);
  });

  it('answers 404 to a signed-in account that is not a member, as if the group did not exist', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    const outsider = await balancesAs(ben.token, groupId);
    const missing = await balancesAs(ben.token, 'no-such-group');
    expect(outsider.status).toBe(404);
    expect(outsider.body).toMatchObject({ error: 'GroupNotFound' });
    expect(outsider.body).toEqual(missing.body);
  });

  it('refuses a request with no token, or an unproven one, with 401', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const groupId = await createGroup(ana.token);
    expect((await send(app, 'GET', `/groups/${groupId}/balances`)).status).toBe(401);
    expect((await balancesAs('not-a-real-token', groupId)).status).toBe(401);
  });

  it('keeps the balances across restarts', async () => {
    const ana = await signedUpAccount(app, { email: 'ana@example.org' });
    const ben = await signedUpAccount(app, { email: 'ben@example.org' });
    const groupId = await createGroup(ana.token);
    await join(ana.token, groupId, ben.token);
    await record(app, ben.token, groupId, 999, [ana.id, ben.id]);
    const before = await balancesAs(ana.token, groupId);
    await app.stop();
    db.close();

    app = await startApplication(directory.databasePath);
    db = openDatabase(directory.databasePath);
    expect((await balancesAs(ana.token, groupId)).body).toEqual(before.body);
  });

  it('adds up to 0 and counts each expense once, however many servers record them at once', async () => {
    const second = await startApplication(directory.databasePath);
    try {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      await join(ana.token, groupId, cleo.token);

      // Forty expenses recorded at the same moment, alternating between the two servers and the payers.
      const payers = [
        { id: ana.id, token: ana.token },
        { id: ben.id, token: ben.token },
        { id: cleo.id, token: cleo.token },
      ];
      const expenses = Array.from({ length: 40 }, (_, index) => ({
        payer: payers[index % payers.length],
        amount: 101 + index * 997,
        split:
          index % 2 === 0
            ? [ana.id, ben.id, cleo.id]
            : payers[index % payers.length].id === ana.id
              ? [ana.id, cleo.id]
              : [payers[index % payers.length].id, ana.id],
      }));
      const replies = await Promise.all(
        expenses.map((expense, index) =>
          send(index % 2 === 0 ? app : second, 'POST', `/groups/${groupId}/expenses`, {
            token: expense.payer.token,
            body: {
              description: 'Groceries',
              amount: expense.amount,
              date: utcDay(0),
              splitBetween: expense.split,
            },
          }),
        ),
      );
      expect(replies.map(reply => reply.status)).toEqual(expenses.map(() => 201));

      // What the balances must be: each expense's amount to its payer, less the shares equalShares gives.
      const expected = new Map([ana.id, ben.id, cleo.id].map(id => [id, 0]));
      for (const expense of expenses) {
        expected.set(expense.payer.id, (expected.get(expense.payer.id) ?? 0) + expense.amount);
        for (const share of equalShares(expense.amount, expense.split, expense.payer.id)) {
          expected.set(share.memberId, (expected.get(share.memberId) ?? 0) - share.amount);
        }
      }
      const balances = (await balancesAs(ana.token, groupId)).body as { memberId: string; balance: number }[];
      expect(balances).toEqual([...expected].map(([memberId, balance]) => ({ memberId, balance })));
      expect(balances.reduce((sum, { balance }) => sum + balance, 0)).toBe(0);
      expect(storedCounts()).toEqual({ expenses: 40, shares: expenses.reduce((n, e) => n + e.split.length, 0) });
    } finally {
      await second.stop();
    }
  });
});

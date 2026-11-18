import { DatabaseSync } from 'node:sqlite';
import type { Application } from './app';
import { openDatabase } from './database';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

/** Today's day in UTC, `YYYY-MM-DD`: the latest date an expense may have. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('leaving a group', () => {
  let directory: TestDirectory;
  let app: Application;

  beforeEach(async () => {
    directory = testDirectory();
    app = await startApplication(directory.databaseUrl);
  });

  afterEach(async () => {
    await app.stop();
    await directory.remove();
  });

  /** Creates a group as `token`'s account and answers its id. */
  async function createGroup(token: string, name = 'Flat'): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name, currency: 'EUR' } });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Creates an invitation to `groupId` as `token`'s account and answers its id. */
  async function invite(token: string, groupId: string): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/invitations`, { token });
    if (reply.status !== 201) throw new Error(`invite answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Makes the account of `token` a member of the group, through the invitation `id`. */
  async function accept(token: string, id: string): Promise<void> {
    const reply = await send(app, 'POST', `/invitations/${id}/accept`, { token });
    if (reply.status !== 204) throw new Error(`accept answered ${reply.status}`);
  }

  /** Makes the account of `joinerToken` a member of the group, through an invitation its owner creates. */
  async function joinGroup(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
    await accept(joinerToken, await invite(ownerToken, groupId));
  }

  /** Leaves the group as `token`'s account, answering the reply. */
  async function leave(token: string, groupId: string) {
    return send(app, 'POST', `/groups/${groupId}/leave`, { token });
  }

  /** Leaves the group as `token`'s account, which must succeed: the member is gone when this answers. */
  async function leaveOrFail(token: string, groupId: string): Promise<void> {
    const reply = await leave(token, groupId);
    if (reply.status !== 204) throw new Error(`leave answered ${reply.status}`);
  }

  /** Records an expense as `token`'s account, answering its id. */
  async function record(token: string, groupId: string, body: Record<string, unknown>): Promise<string> {
    const reply = await send(app, 'POST', `/groups/${groupId}/expenses`, {
      token,
      body: { description: 'Dinner', amount: 1000, date: today(), ...body },
    });
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** The members of the group, as `token`'s account reads them, answering their ids in order. */
  async function memberIds(token: string, groupId: string): Promise<string[]> {
    const reply = await send(app, 'GET', `/groups/${groupId}/members`, { token });
    return (reply.body as { memberId: string }[]).map(member => member.memberId);
  }

  describe('answering the request', () => {
    it('answers 204 with nothing, to a member whose balance is 0', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      const reply = await leave(ben.token, groupId);
      expect(reply.status).toBe(204);
      expect(reply.body).toBeUndefined();
    });

    it('refuses a request with no token, or an unproven one, with 401, and removes nobody', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      expect((await send(app, 'POST', `/groups/${groupId}/leave`)).status).toBe(401);
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: 'not-a-real-token' })).status).toBe(401);
      expect(await memberIds(ana.token, groupId)).toEqual([ana.id, ben.id]);
    });

    it('answers 404 to an account that is not a member, or no longer is, as if the group did not exist', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      const outsider = await leave(cleo.token, groupId);
      const missing = await leave(cleo.token, 'no-such-group');
      expect(outsider.status).toBe(404);
      expect(outsider.body).toMatchObject({ error: 'GroupNotFound' });
      expect(outsider.body).toEqual(missing.body);

      await joinGroup(ana.token, groupId, ben.token);
      expect((await leave(ben.token, groupId)).status).toBe(204);
      const again = await leave(ben.token, groupId);
      expect(again.status).toBe(404);
      expect(again.body).toMatchObject({ error: 'GroupNotFound' });
    });
  });

  describe('the owner and the balance', () => {
    it('refuses the owner, who created the group, with 403, and the owner stays a member', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const reply = await leave(ana.token, groupId);
      expect(reply.status).toBe(403);
      expect(reply.body).toMatchObject({ error: 'OwnerCannotLeave' });
      expect(await memberIds(ana.token, groupId)).toEqual([ana.id]);
    });

    it('lets a member whose balance is not 0 leave, and passes it to the owner in the same step: the balances add up to 0', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      await joinGroup(ana.token, groupId, cleo.token);
      await record(ana.token, groupId, { amount: 900, splitBetween: [ana.id, ben.id, cleo.id] });
      const before = await send(app, 'GET', `/groups/${groupId}/balances`, { token: ana.token });
      expect(before.body).toEqual([
        { memberId: ana.id, balance: 600 },
        { memberId: ben.id, balance: -300 },
        { memberId: cleo.id, balance: -300 },
      ]);

      expect((await leave(ben.token, groupId)).status).toBe(204);

      const after = await send(app, 'GET', `/groups/${groupId}/balances`, { token: ana.token });
      expect(after.body).toEqual([
        { memberId: ana.id, balance: 300 },
        { memberId: cleo.id, balance: -300 },
      ]);
      expect(await memberIds(ana.token, groupId)).toEqual([ana.id, cleo.id]);
    });

    it('passes a balance owed to the member to the owner, who then owes it', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      await record(ben.token, groupId, { amount: 1000, splitBetween: [ben.id, ana.id] });
      expect((await leave(ben.token, groupId)).status).toBe(204);
      const balances = await send(app, 'GET', `/groups/${groupId}/balances`, { token: ana.token });
      expect(balances.body).toEqual([{ memberId: ana.id, balance: 0 }]);
    });

    it('lets a member leave once their balance is back at 0', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      await record(ana.token, groupId, { amount: 1000, splitBetween: [ana.id, ben.id] });
      await record(ben.token, groupId, {
        amount: 1000,
        splitExactly: [
          { memberId: ben.id, amount: 500 },
          { memberId: ana.id, amount: 500 },
        ],
      });
      expect((await leave(ben.token, groupId)).status).toBe(204);
    });
  });

  describe('once a member has left', () => {
    it('takes the leaver out of the members and the balances, and the group out of their groups', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      await joinGroup(ana.token, groupId, cleo.token);
      // Ben is in the split with no share: his balance is 0, so he may leave.
      await record(ana.token, groupId, {
        amount: 900,
        splitExactly: [
          { memberId: ana.id, amount: 300 },
          { memberId: ben.id, amount: 0 },
          { memberId: cleo.id, amount: 600 },
        ],
      });
      expect((await leave(ben.token, groupId)).status).toBe(204);

      expect(await memberIds(ana.token, groupId)).toEqual([ana.id, cleo.id]);
      const balances = await send(app, 'GET', `/groups/${groupId}/balances`, { token: ana.token });
      expect(balances.body).toEqual([
        { memberId: ana.id, balance: 600 },
        { memberId: cleo.id, balance: -600 },
      ]);
      const sum = (balances.body as { balance: number }[]).reduce((total, row) => total + row.balance, 0);
      expect(sum).toBe(0);
      const mine = await send(app, 'GET', '/groups/mine', { token: ben.token });
      expect(mine.body).toEqual([]);
    });

    it('makes the group not exist to the leaver: it reads as it does for anyone who is not a member', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      const expenseId = await record(ana.token, groupId, {
        amount: 1000,
        splitExactly: [
          { memberId: ana.id, amount: 1000 },
          { memberId: ben.id, amount: 0 },
        ],
      });
      await leaveOrFail(ben.token, groupId);

      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const stranger = await send(app, 'GET', `/groups/${groupId}`, { token: cleo.token });
      const reads = [
        await send(app, 'GET', `/groups/${groupId}`, { token: ben.token }),
        await send(app, 'GET', `/groups/${groupId}/members`, { token: ben.token }),
        await send(app, 'GET', `/groups/${groupId}/balances`, { token: ben.token }),
        await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ben.token }),
        await send(app, 'GET', `/groups/${groupId}/members/${ana.id}/statement`, { token: ben.token }),
        await send(app, 'GET', `/groups/${groupId}/members/${ben.id}/statement`, { token: ben.token }),
        await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ben.token }),
      ];
      for (const reply of reads) {
        expect(reply.status).toBe(404);
        expect(reply.body).toMatchObject({ error: 'GroupNotFound' });
      }
      expect(reads[5].body).toEqual(stranger.body);
      const expense = await send(app, 'GET', `/expenses/${expenseId}`, { token: ben.token });
      expect(expense.status).toBe(404);
      expect(expense.body).toMatchObject({ error: 'ExpenseNotFound' });
    });

    it('keeps the expenses they were in as they were, with their shares, for the group’s members to read', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      const expenseId = await record(ana.token, groupId, {
        description: 'Dinner',
        amount: 1000,
        splitExactly: [
          { memberId: ana.id, amount: 1000 },
          { memberId: ben.id, amount: 0 },
        ],
      });
      await leaveOrFail(ben.token, groupId);

      const listed = await send(app, 'GET', `/groups/${groupId}/expenses`, { token: ana.token });
      expect(listed.body).toEqual([
        expect.objectContaining({ id: expenseId, description: 'Dinner', amount: 1000, paidBy: ana.id }),
      ]);
      const read = await send(app, 'GET', `/expenses/${expenseId}`, { token: ana.token });
      expect(read.body).toMatchObject({
        shares: [
          { memberId: ana.id, amount: 1000 },
          { memberId: ben.id, amount: 0 },
        ],
        splitKind: 'exact',
      });
    });

    it('lets the group’s members read the leaver’s statement, and not the leaver read it', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      await record(ana.token, groupId, { amount: 1000, splitBetween: [ana.id, ben.id] });
      await record(ben.token, groupId, {
        amount: 1000,
        splitExactly: [
          { memberId: ben.id, amount: 500 },
          { memberId: ana.id, amount: 500 },
        ],
      });
      await leaveOrFail(ben.token, groupId);

      const statement = await send(app, 'GET', `/groups/${groupId}/members/${ben.id}/statement`, { token: ana.token });
      expect(statement.status).toBe(200);
      expect(statement.body).toMatchObject({ memberId: ben.id, balance: 0 });
      expect((statement.body as { entries: unknown[] }).entries).toHaveLength(2);
    });

    it('refuses a new expense that splits with the leaver, and one the leaver pays, while the others still record', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      await leaveOrFail(ben.token, groupId);

      const split = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: ana.token,
        body: { description: 'Dinner', amount: 1000, date: today(), splitBetween: [ana.id, ben.id] },
      });
      expect(split.status).toBe(422);
      expect(split.body).toMatchObject({ error: 'MemberNotInGroup' });

      const paid = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token: ben.token,
        body: { description: 'Dinner', amount: 1000, date: today(), splitBetween: [ana.id] },
      });
      expect(paid.status).toBe(404);

      await record(ana.token, groupId, { amount: 300, splitBetween: [ana.id] });
    });

    it('refuses to change or delete an expense that concerns the leaver, as payer or in its split', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      await joinGroup(ana.token, groupId, cleo.token);
      // Ben is in the split with no share, and is the payer of the second: his balance stays at 0.
      const inSplit = await record(ana.token, groupId, {
        amount: 1000,
        splitExactly: [
          { memberId: ana.id, amount: 1000 },
          { memberId: ben.id, amount: 0 },
        ],
      });
      const paidByBen = await record(ben.token, groupId, {
        amount: 1000,
        splitExactly: [{ memberId: ben.id, amount: 1000 }],
      });
      // Not concerning Ben: still changeable.
      const other = await record(ana.token, groupId, { amount: 300, splitBetween: [ana.id, cleo.id] });
      expect((await leave(ben.token, groupId)).status).toBe(204);

      const edit = {
        description: 'Dinner',
        amount: 1000,
        date: today(),
        splitExactly: [
          { memberId: ana.id, amount: 1000 },
          { memberId: ben.id, amount: 0 },
        ],
        version: 1,
      };
      const changedInSplit = await send(app, 'PUT', `/expenses/${inSplit}`, { token: ana.token, body: edit });
      expect(changedInSplit.status).toBe(409);
      expect(changedInSplit.body).toMatchObject({ error: 'MemberHasLeft' });
      const deletedInSplit = await send(app, 'DELETE', `/expenses/${inSplit}`, { token: ana.token });
      expect(deletedInSplit.status).toBe(409);
      expect(deletedInSplit.body).toMatchObject({ error: 'MemberHasLeft' });

      const deletedPaidByBen = await send(app, 'DELETE', `/expenses/${paidByBen}`, { token: ana.token });
      expect(deletedPaidByBen.status).toBe(409);
      expect(deletedPaidByBen.body).toMatchObject({ error: 'MemberHasLeft' });

      const changedOther = await send(app, 'PUT', `/expenses/${other}`, {
        token: ana.token,
        body: {
          description: 'Dinner',
          amount: 300,
          date: today(),
          splitBetween: [ana.id, cleo.id],
          version: 1,
        },
      });
      expect(changedOther.status).toBe(200);
    });

    it('keeps the balances adding up to 0 after the leaver has gone, and the expenses since', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      await joinGroup(ana.token, groupId, cleo.token);
      await record(ana.token, groupId, { amount: 999, splitBetween: [ana.id, ben.id, cleo.id] });
      await record(ben.token, groupId, {
        amount: 1000,
        splitExactly: [
          { memberId: ben.id, amount: 667 },
          { memberId: ana.id, amount: 333 },
        ],
      });
      expect((await leave(ben.token, groupId)).status).toBe(204);
      await record(cleo.token, groupId, { amount: 250, splitBetween: [cleo.id, ana.id] });

      const balances = (await send(app, 'GET', `/groups/${groupId}/balances`, { token: ana.token })).body as {
        balance: number;
      }[];
      expect(balances.reduce((total, row) => total + row.balance, 0)).toBe(0);
    });
  });

  describe('at the same moment', () => {
    it('counts an expense recorded as the member leaves, or refuses it, and the balances add up to 0 either way', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      await joinGroup(ana.token, groupId, ben.token);
      await joinGroup(ana.token, groupId, cleo.token);
      await record(ana.token, groupId, { amount: 900, splitBetween: [ana.id, ben.id, cleo.id] });

      // Ben pays 600 split with Cleo, as he leaves: recorded first, it moves 300 onto Ann; refused, it moves nothing.
      const [left, paid] = await Promise.all([
        leave(ben.token, groupId),
        send(app, 'POST', `/groups/${groupId}/expenses`, {
          token: ben.token,
          body: { description: 'Taxi', amount: 600, date: today(), splitBetween: [ben.id, cleo.id] },
        }),
      ]);
      expect(left.status).toBe(204);
      expect([201, 404]).toContain(paid.status);
      const balances = (await send(app, 'GET', `/groups/${groupId}/balances`, { token: ana.token })).body as {
        memberId: string;
        balance: number;
      }[];
      const expected =
        paid.status === 201
          ? [
              { memberId: ana.id, balance: 600 },
              { memberId: cleo.id, balance: -600 },
            ]
          : [
              { memberId: ana.id, balance: 300 },
              { memberId: cleo.id, balance: -300 },
            ];
      expect(balances).toEqual(expected);
      expect(balances.reduce((total, row) => total + row.balance, 0)).toBe(0);
    });
  });

  describe('coming back', () => {
    it('joins again with an invitation: last in the order of the members, with the balance 0, and the group back among their groups', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      const invitation = await invite(ana.token, groupId);
      await accept(ben.token, invitation);
      await joinGroup(ana.token, groupId, cleo.token);
      await record(ben.token, groupId, { amount: 1000, splitBetween: [ben.id, ana.id] });
      await record(ana.token, groupId, { amount: 1000, splitBetween: [ana.id, ben.id] });
      expect((await leave(ben.token, groupId)).status).toBe(204);

      expect((await send(app, 'POST', `/invitations/${invitation}/accept`, { token: ben.token })).status).toBe(204);

      expect(await memberIds(ana.token, groupId)).toEqual([ana.id, cleo.id, ben.id]);
      const balances = await send(app, 'GET', `/groups/${groupId}/balances`, { token: ana.token });
      expect(balances.body).toEqual([
        { memberId: ana.id, balance: 0 },
        { memberId: cleo.id, balance: 0 },
        { memberId: ben.id, balance: 0 },
      ]);
      const mine = await send(app, 'GET', '/groups/mine', { token: ben.token });
      expect(mine.body).toEqual([expect.objectContaining({ id: groupId })]);
    });

    it('joins again at a balance of 0, and what they passed to the owner when they left stays with the owner', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const cleo = await signedUpAccount(app, { email: 'cleo@example.org' });
      const groupId = await createGroup(ana.token);
      const invitation = await invite(ana.token, groupId);
      await accept(ben.token, invitation);
      await joinGroup(ana.token, groupId, cleo.token);
      await record(ana.token, groupId, { amount: 900, splitBetween: [ana.id, ben.id, cleo.id] });
      await leaveOrFail(ben.token, groupId);

      await accept(ben.token, invitation);
      expect(await memberIds(ana.token, groupId)).toEqual([ana.id, cleo.id, ben.id]);
      const joined = await send(app, 'GET', `/groups/${groupId}/balances`, { token: ana.token });
      expect(joined.body).toEqual([
        { memberId: ana.id, balance: 300 },
        { memberId: cleo.id, balance: -300 },
        { memberId: ben.id, balance: 0 },
      ]);

      // Counted from the new start: Ben pays 600 split with Ann, so Ben is owed 300 and Ann owes 300.
      await record(ben.token, groupId, { amount: 600, splitBetween: [ben.id, ana.id] });
      const later = await send(app, 'GET', `/groups/${groupId}/balances`, { token: ana.token });
      expect(later.body).toEqual([
        { memberId: ana.id, balance: 0 },
        { memberId: cleo.id, balance: -300 },
        { memberId: ben.id, balance: 300 },
      ]);
    });

    it('leaves a rejoined member to leave again, once their balance is 0 again', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      const invitation = await invite(ana.token, groupId);
      await accept(ben.token, invitation);
      expect((await leave(ben.token, groupId)).status).toBe(204);
      await accept(ben.token, invitation);
      expect((await leave(ben.token, groupId)).status).toBe(204);
      expect(await memberIds(ana.token, groupId)).toEqual([ana.id]);
    });

    it('refuses a member who is still in the group with 409, and an invitation does not add them twice', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      const invitation = await invite(ana.token, groupId);
      await accept(ben.token, invitation);
      const again = await send(app, 'POST', `/invitations/${invitation}/accept`, { token: ben.token });
      expect(again.status).toBe(409);
      expect(await memberIds(ana.token, groupId)).toEqual([ana.id, ben.id]);
    });
  });

  describe('a file written before leaving', () => {
    it('gives its memberships no leaving date, so every member is still a member', async () => {
      const written = testDirectory();
      try {
        const old = new DatabaseSync(written.legacyPath);
        old.exec(`
          CREATE TABLE accounts (
            id TEXT PRIMARY KEY, email TEXT NOT NULL, email_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            password_hash TEXT NOT NULL, created_at TEXT NOT NULL
          );
          INSERT INTO accounts VALUES ('a', 'a@example.org', 'a@example.org', 'A', 'x', '2026-01-01T00:00:00.000Z');
          CREATE TABLE groups (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL, owner_id TEXT NOT NULL,
            created_at TEXT NOT NULL, archived_at TEXT
          );
          INSERT INTO groups VALUES ('g', 'Flat', 'EUR', 'a', '2026-01-01T00:00:00.000Z', NULL);
          CREATE TABLE group_members (
            group_id   TEXT NOT NULL,
            account_id TEXT NOT NULL,
            joined_at  TEXT NOT NULL,
            PRIMARY KEY (group_id, account_id)
          );
          INSERT INTO group_members (group_id, account_id, joined_at) VALUES ('g', 'a', '2026-01-01T00:00:00.000Z');
        `);
        old.close();
        const upgradedApp = await startApplication(written.databaseUrl, { databasePath: written.legacyPath });
        await upgradedApp.stop();

        const db = await openDatabase({ url: written.databaseUrl });
        try {
          const columns = await db
            .prepare(
              `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'group_members'`,
            )
            .all<{ name: string }>();
          expect(columns.map(column => column.name)).toContain('left_at');
          expect(await db.prepare('SELECT left_at FROM group_members').all()).toEqual([{ left_at: null }]);
          // Nothing had been passed on before, so every membership's base is 0.
          expect(columns.map(column => column.name)).toContain('balance_base');
          expect(await db.prepare('SELECT balance_base FROM group_members').all()).toEqual([{ balance_base: 0 }]);
        } finally {
          await db.close();
        }
      } finally {
        await written.remove();
      }
    });
  });
});

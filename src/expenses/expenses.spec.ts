import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';
import { equalShares } from './expenses';
import { todayInUtc } from './validation';

describe('expenses', () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  const dayBefore = (day: string): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const dayAfter = (day: string): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  async function createdGroup(token: string): Promise<string> {
    const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  /** An expense body; overrides replace its fields. */
  const expense = (overrides: Record<string, unknown> = {}) => ({
    description: 'Groceries',
    amount: 1000,
    date: todayInUtc(),
    splitBetween: [] as string[],
    ...overrides,
  });

  async function record(token: string, groupId: string, payload: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
  }

  /** Ada owns a group with Grace and Linus in it; answers their ids and tokens. */
  async function threeMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  describe('recording an expense', () => {
    it('records it for a member and answers its id', async () => {
      const { ada, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ id: expect.any(String) });
    });

    it('makes the member who records it the payer', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = (await record(grace.token, groupId, expense({ splitBetween: [grace.id, ada.id] }))).json().id;
      const read = await send(app, 'GET', `/expenses/${id}`, { token: ada.token });
      expect(read.json().paidBy).toBe(grace.id);
    });

    it('answers 404 to a person who is not a member, as if the group did not exist', async () => {
      const { ada, groupId } = await threeMembers();
      const outsider = await signedUpAccount(app, { email: 'outsider@example.com', name: 'Eve' });
      const payload = expense({ splitBetween: [ada.id] });
      const refused = await record(outsider.token, groupId, payload);
      const missing = await record(outsider.token, 'no-such-group', payload);
      expect(refused.statusCode).toBe(404);
      expect(refused.json().type).toBe('NotFound');
      expect(refused.json()).toEqual(missing.json());
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { ada, groupId } = await threeMembers();
      const payload = expense({ splitBetween: [ada.id] });
      expect((await send(app, 'POST', `/groups/${groupId}/expenses`, { payload })).statusCode).toBe(401);
      expect((await record('not-a-real-token', groupId, payload)).statusCode).toBe(401);
    });

    it.each([['description'], ['amount'], ['date'], ['splitBetween']])(
      'refuses a body without its %s with 400',
      async field => {
        const { ada, groupId } = await threeMembers();
        const payload: Record<string, unknown> = expense({ splitBetween: [ada.id] });
        delete payload[field];
        const response = await record(ada.token, groupId, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().type).toBe('InvalidBody');
      },
    );

    it('refuses an amount that is sent as a string with 400, since types are not converted', async () => {
      const { ada, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, expense({ amount: '1000', splitBetween: [ada.id] }));
      expect(response.statusCode).toBe(400);
      expect(response.json().type).toBe('InvalidBody');
    });
  });

  describe('the description', () => {
    it('accepts 1 and 100 characters, and refuses 101', async () => {
      const { ada, groupId } = await threeMembers();
      const split = [ada.id];
      expect((await record(ada.token, groupId, expense({ description: 'x', splitBetween: split }))).statusCode).toBe(
        201,
      );
      expect(
        (await record(ada.token, groupId, expense({ description: 'x'.repeat(100), splitBetween: split }))).statusCode,
      ).toBe(201);

      const tooLong = await record(ada.token, groupId, expense({ description: 'x'.repeat(101), splitBetween: split }));
      expect(tooLong.statusCode).toBe(422);
      expect(tooLong.json().type).toBe('InvalidDescription');
    });

    it('counts characters, not UTF-16 units', async () => {
      const { ada, groupId } = await threeMembers();
      const response = await record(
        ada.token,
        groupId,
        expense({ description: '😀'.repeat(100), splitBetween: [ada.id] }),
      );
      expect(response.statusCode).toBe(201);
    });

    it('refuses a description that is only spaces, or empty, with 422', async () => {
      const { ada, groupId } = await threeMembers();
      for (const description of ['   ', '']) {
        const response = await record(ada.token, groupId, expense({ description, splitBetween: [ada.id] }));
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe('InvalidDescription');
      }
    });

    it('stores the description trimmed', async () => {
      const { ada, groupId } = await threeMembers();
      const id = (
        await record(ada.token, groupId, expense({ description: '  Groceries  ', splitBetween: [ada.id] }))
      ).json().id;
      expect((await send(app, 'GET', `/expenses/${id}`, { token: ada.token })).json().description).toBe('Groceries');
    });
  });

  describe('the amount', () => {
    it('accepts 1 and 100 000 000, and refuses 0, 100 000 001, negatives and fractions', async () => {
      const { ada, groupId } = await threeMembers();
      const split = [ada.id];
      expect((await record(ada.token, groupId, expense({ amount: 1, splitBetween: split }))).statusCode).toBe(201);
      expect((await record(ada.token, groupId, expense({ amount: 100_000_000, splitBetween: split }))).statusCode).toBe(
        201,
      );

      for (const amount of [0, 100_000_001, -5, 10.5]) {
        const response = await record(ada.token, groupId, expense({ amount, splitBetween: split }));
        expect(response.statusCode).toBe(422);
        expect(response.json().type).toBe('InvalidAmount');
      }
    });
  });

  describe('the date', () => {
    it('accepts today and a day before it, in UTC', async () => {
      const { ada, groupId } = await threeMembers();
      const split = [ada.id];
      expect((await record(ada.token, groupId, expense({ date: todayInUtc(), splitBetween: split }))).statusCode).toBe(
        201,
      );
      expect(
        (await record(ada.token, groupId, expense({ date: dayBefore(todayInUtc()), splitBetween: split }))).statusCode,
      ).toBe(201);
    });

    it('refuses a day after today, in UTC, with 422', async () => {
      const { ada, groupId } = await threeMembers();
      const response = await record(
        ada.token,
        groupId,
        expense({ date: dayAfter(todayInUtc()), splitBetween: [ada.id] }),
      );
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidDate');
    });

    it.each([
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2026-04-31',
      '17/11/2026',
      '2026-11-1',
      '2026-11-17T10:00:00Z',
    ])('refuses %j, which is not a day of the calendar written YYYY-MM-DD, with 422', async date => {
      const { ada, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, expense({ date, splitBetween: [ada.id] }));
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidDate');
    });

    it('accepts 29 February of a leap year', async () => {
      const { ada, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, expense({ date: '2024-02-29', splitBetween: [ada.id] }));
      expect(response.statusCode).toBe(201);
    });
  });

  describe('who is in the split', () => {
    it('refuses an empty split with 422', async () => {
      const { ada, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, expense({ splitBetween: [] }));
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidSplit');
    });

    it('refuses a member listed twice with 422', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id, grace.id] }));
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidSplit');
    });

    it('refuses an account that is not a member of the group with 422', async () => {
      const { ada, groupId } = await threeMembers();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const response = await record(ada.token, groupId, expense({ splitBetween: [ada.id, eve.id] }));
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('NotAMember');
    });

    it('refuses a split that leaves out the payer, with 422', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const response = await record(ada.token, groupId, expense({ splitBetween: [grace.id] }));
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('PayerNotInSplit');
    });

    it('lets the payer be anywhere in the split', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = (await record(ada.token, groupId, expense({ splitBetween: [grace.id, linus.id, ada.id] }))).json().id;
      const shares = (await send(app, 'GET', `/expenses/${id}`, { token: ada.token })).json().shares;
      expect(shares.map((s: { memberId: string }) => s.memberId)).toEqual([grace.id, linus.id, ada.id]);
    });
  });

  describe('the equal split', () => {
    it('divides 1000 between three members, the remainder going whole to the payer', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = (
        await record(ada.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id, linus.id] }))
      ).json().id;
      const shares = (await send(app, 'GET', `/expenses/${id}`, { token: ada.token })).json().shares;
      expect(shares).toEqual([
        { memberId: ada.id, amount: 334 },
        { memberId: grace.id, amount: 333 },
        { memberId: linus.id, amount: 333 },
      ]);
    });

    it('gives the remainder to the payer even when the payer is not the first', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const id = (
        await record(grace.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id, linus.id] }))
      ).json().id;
      const shares = (await send(app, 'GET', `/expenses/${id}`, { token: ada.token })).json().shares;
      expect(shares).toEqual([
        { memberId: ada.id, amount: 333 },
        { memberId: grace.id, amount: 334 },
        { memberId: linus.id, amount: 333 },
      ]);
    });

    it('keeps the amount whole when it divides evenly', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = (await record(ada.token, groupId, expense({ amount: 900, splitBetween: [ada.id, grace.id] }))).json()
        .id;
      const shares = (await send(app, 'GET', `/expenses/${id}`, { token: ada.token })).json().shares;
      expect(shares).toEqual([
        { memberId: ada.id, amount: 450 },
        { memberId: grace.id, amount: 450 },
      ]);
    });

    it('gives a single member the whole amount', async () => {
      const { ada, groupId } = await threeMembers();
      const id = (await record(ada.token, groupId, expense({ amount: 777, splitBetween: [ada.id] }))).json().id;
      const shares = (await send(app, 'GET', `/expenses/${id}`, { token: ada.token })).json().shares;
      expect(shares).toEqual([{ memberId: ada.id, amount: 777 }]);
    });
  });

  describe('equalShares', () => {
    it('always adds up to the amount exactly, with each share a whole number', () => {
      for (const members of [1, 2, 3, 7, 13]) {
        const split = Array.from({ length: members }, (_, i) => `m${i}`);
        for (const amount of [1, 2, 7, 99, 1000, 999_999, 100_000_000]) {
          const shares = equalShares(amount, split, 'm0');
          expect(shares.reduce((sum, share) => sum + share.amount, 0)).toBe(amount);
          expect(shares.every(share => Number.isInteger(share.amount) && share.amount >= 0)).toBe(true);
        }
      }
    });

    it('gives each non-payer the amount divided by the number of members, rounded down', () => {
      const shares = equalShares(1000, ['a', 'b', 'c'], 'a');
      expect(shares.map(share => share.amount)).toEqual([334, 333, 333]);
    });
  });

  describe('reading an expense', () => {
    it('answers its description, amount, date, payer and shares, in the order of the split', async () => {
      const { ada, grace, linus, groupId } = await threeMembers();
      const date = dayBefore(todayInUtc());
      const id = (
        await record(
          ada.token,
          groupId,
          expense({ description: 'Groceries', amount: 1000, date, splitBetween: [grace.id, ada.id, linus.id] }),
        )
      ).json().id;

      const response = await send(app, 'GET', `/expenses/${id}`, { token: linus.token });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        id,
        groupId,
        description: 'Groceries',
        amount: 1000,
        date,
        paidBy: ada.id,
        shares: [
          { memberId: grace.id, amount: 333 },
          { memberId: ada.id, amount: 334 },
          { memberId: linus.id, amount: 333 },
        ],
      });
    });

    it('answers the same expense to every member of the group', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = (await record(ada.token, groupId, expense({ splitBetween: [ada.id, grace.id] }))).json().id;
      const forAda = await send(app, 'GET', `/expenses/${id}`, { token: ada.token });
      const forGrace = await send(app, 'GET', `/expenses/${id}`, { token: grace.token });
      expect(forGrace.json()).toEqual(forAda.json());
    });

    it('answers the same expense on every read', async () => {
      const { ada, groupId } = await threeMembers();
      const id = (await record(ada.token, groupId, expense({ splitBetween: [ada.id] }))).json().id;
      const first = await send(app, 'GET', `/expenses/${id}`, { token: ada.token });
      const second = await send(app, 'GET', `/expenses/${id}`, { token: ada.token });
      expect(second.json()).toEqual(first.json());
    });

    it('answers 404 to a signed-in person who is not a member, as if the expense did not exist', async () => {
      const { ada, groupId } = await threeMembers();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const id = (await record(ada.token, groupId, expense({ splitBetween: [ada.id] }))).json().id;
      const outsider = await send(app, 'GET', `/expenses/${id}`, { token: eve.token });
      const missing = await send(app, 'GET', '/expenses/no-such-expense', { token: eve.token });
      expect(outsider.statusCode).toBe(404);
      expect(outsider.json().type).toBe('NotFound');
      expect(outsider.json()).toEqual(missing.json());
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { ada, groupId } = await threeMembers();
      const id = (await record(ada.token, groupId, expense({ splitBetween: [ada.id] }))).json().id;
      expect((await send(app, 'GET', `/expenses/${id}`)).statusCode).toBe(401);
      expect((await send(app, 'GET', `/expenses/${id}`, { token: 'not-a-real-token' })).statusCode).toBe(401);
    });
  });

  describe('what is kept', () => {
    it('keeps expenses and their shares when the application stops and starts again on the same file', async () => {
      const { ada, grace, groupId } = await threeMembers();
      const id = (
        await record(grace.token, groupId, expense({ amount: 1000, splitBetween: [ada.id, grace.id] }))
      ).json().id;
      const before = (await send(app, 'GET', `/expenses/${id}`, { token: ada.token })).json();
      await app.stop();

      app = await createApplication({ databasePath });
      const after = await send(app, 'GET', `/expenses/${id}`, { token: ada.token });
      expect(after.json()).toEqual(before);
    });
  });
});

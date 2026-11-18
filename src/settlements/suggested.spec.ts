import { type Application, createApplication } from '../app';
import { type Balance } from '../balances/balances';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';
import { type Transfer, suggestedTransfers } from './suggested';

/** Balances in the order the members joined, from the ids and amounts given in that order. */
function balancesInOrder(...entries: [string, number][]): Balance[] {
  return entries.map(([memberId, balance]) => ({ memberId, balance }));
}

/** The balances left once `transfers` are made, in the same order. */
function balancesAfter(balances: Balance[], transfers: Transfer[]): Balance[] {
  const result = balances.map(balance => ({ ...balance }));
  for (const transfer of transfers) {
    result.find(balance => balance.memberId === transfer.from)!.balance += transfer.amount;
    result.find(balance => balance.memberId === transfer.to)!.balance -= transfer.amount;
  }
  return result;
}

/** A small deterministic generator, so the random cases are the same on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('the suggested transfers', () => {
  describe('the algorithm', () => {
    it('is the example of the request: the largest debtor and creditor settle first, the earliest on a tie', () => {
      // Ann 500, Bob 100, Cy -300, Dan -300, in the order they joined.
      const transfers = suggestedTransfers(balancesInOrder(['ann', 500], ['bob', 100], ['cy', -300], ['dan', -300]));
      expect(transfers).toEqual([
        { from: 'cy', to: 'ann', amount: 300 },
        { from: 'dan', to: 'ann', amount: 200 },
        { from: 'dan', to: 'bob', amount: 100 },
      ]);
    });

    it('is no transfer when every balance is already 0', () => {
      expect(suggestedTransfers(balancesInOrder(['ann', 0], ['bob', 0]))).toEqual([]);
      expect(suggestedTransfers([])).toEqual([]);
    });

    it('is one transfer between two members, the owing one to the owed one', () => {
      expect(suggestedTransfers(balancesInOrder(['ann', -750], ['bob', 750]))).toEqual([
        { from: 'ann', to: 'bob', amount: 750 },
      ]);
    });

    it('takes the member who owes the most first, the earlier one of two who owe the same', () => {
      // Bob and Cy both owe 100; Bob joined first, so Bob pays first, to Ann.
      const transfers = suggestedTransfers(balancesInOrder(['ann', 200], ['bob', -100], ['cy', -100]));
      expect(transfers).toEqual([
        { from: 'bob', to: 'ann', amount: 100 },
        { from: 'cy', to: 'ann', amount: 100 },
      ]);
    });

    it('takes the member who is owed the most first, the earlier one of two who are owed the same', () => {
      // Ann and Bob are both owed 300; Ann joined first, so Cy pays Ann first.
      const transfers = suggestedTransfers(balancesInOrder(['ann', 300], ['bob', 300], ['cy', -600]));
      expect(transfers).toEqual([
        { from: 'cy', to: 'ann', amount: 300 },
        { from: 'cy', to: 'bob', amount: 300 },
      ]);
    });

    it('settles a pair that is tied on both sides in the order the members joined', () => {
      // Ann and Bob are owed 300 each; Cy and Dan owe 300 each. Cy pays Ann, then Dan pays Bob.
      const transfers = suggestedTransfers(balancesInOrder(['ann', 300], ['cy', -300], ['bob', 300], ['dan', -300]));
      expect(transfers).toEqual([
        { from: 'cy', to: 'ann', amount: 300 },
        { from: 'dan', to: 'bob', amount: 300 },
      ]);
    });

    it('does not change the balances it is given', () => {
      const balances = balancesInOrder(['ann', 500], ['bob', 100], ['cy', -300], ['dan', -300]);
      suggestedTransfers(balances);
      expect(balances).toEqual(balancesInOrder(['ann', 500], ['bob', 100], ['cy', -300], ['dan', -300]));
    });

    it('brings every balance to 0, in no more transfers than one fewer than the members not at 0, for any balances', () => {
      const next = generator(20260411);
      for (let trial = 0; trial < 500; trial++) {
        const size = 1 + Math.floor(next() * 8);
        const balances: Balance[] = [];
        let sum = 0;
        for (let index = 0; index < size - 1; index++) {
          // Mostly small, sometimes 0: a balance of 0 is a member who is even.
          const value = next() < 0.2 ? 0 : Math.floor(next() * 2001) - 1000;
          balances.push({ memberId: `member-${index}`, balance: value });
          sum += value;
        }
        balances.push({ memberId: `member-${size - 1}`, balance: -sum });

        const transfers = suggestedTransfers(balances);
        const notZero = balances.filter(balance => balance.balance !== 0).length;

        expect(transfers.length).toBeLessThanOrEqual(Math.max(0, notZero - 1));
        for (const transfer of transfers) {
          expect(Number.isInteger(transfer.amount)).toBe(true);
          expect(transfer.amount).toBeGreaterThanOrEqual(1);
        }
        expect(balancesAfter(balances, transfers).every(balance => balance.balance === 0)).toBe(true);
      }
    });

    it('has a transfer only from a member who owes to one who is owed, and never more than either has', () => {
      const next = generator(7);
      for (let trial = 0; trial < 200; trial++) {
        const balances: Balance[] = [];
        for (let index = 0; index < 5; index++) {
          balances.push({ memberId: `member-${index}`, balance: Math.floor(next() * 401) - 200 });
        }
        const total = balances.reduce((sum, balance) => sum + balance.balance, 0);
        balances[4].balance -= total;

        let current = balances.map(balance => ({ ...balance }));
        for (const transfer of suggestedTransfers(balances)) {
          const from = current.find(balance => balance.memberId === transfer.from)!;
          const to = current.find(balance => balance.memberId === transfer.to)!;
          expect(from.balance).toBeLessThan(0);
          expect(to.balance).toBeGreaterThan(0);
          expect(transfer.amount).toBeLessThanOrEqual(Math.min(-from.balance, to.balance));
          current = balancesAfter(current, [transfer]);
        }
      }
    });
  });

  describe('the suggestion of a group', () => {
    let app: Application;

    beforeEach(async () => {
      app = await createApplication({ databaseUrl: await temporaryDatabaseUrl() });
    });

    afterEach(async () => {
      await app.stop();
    });

    async function createdGroup(token: string): Promise<string> {
      const response = await send(app, 'POST', '/groups', { token, payload: { name: 'Flat 4B', currency: 'EUR' } });
      expect(response.statusCode).toBe(201);
      return response.json<{ id: string }>().id;
    }

    /** Ann owns a group that Bob, Cy and Dan join, in that order; answers their ids and tokens. */
    async function fourMembers() {
      const ann = await signedUpAccount(app, { email: 'ann@example.com', name: 'Ann' });
      const bob = await signedUpAccount(app, { email: 'bob@example.com', name: 'Bob' });
      const cy = await signedUpAccount(app, { email: 'cy@example.com', name: 'Cy' });
      const dan = await signedUpAccount(app, { email: 'dan@example.com', name: 'Dan' });
      const groupId = await createdGroup(ann.token);
      await joinThroughInvitation(app, ann.token, bob.token, groupId);
      await joinThroughInvitation(app, ann.token, cy.token, groupId);
      await joinThroughInvitation(app, ann.token, dan.token, groupId);
      return { ann, bob, cy, dan, groupId };
    }

    async function record(token: string, groupId: string, amount: number, splitBetween: string[]) {
      const response = await send(app, 'POST', `/groups/${groupId}/expenses`, {
        token,
        payload: { description: 'Groceries', amount, date: todayInUtc(), splitBetween },
      });
      expect(response.statusCode).toBe(201);
    }

    /**
     * Balances of Ann 500, Bob 100, Cy -300, Dan -300: Ann paid 600 for Cy's share with her own, and
     * 400 for Dan's with hers, and Bob paid 200 for Dan's with his own.
     */
    async function withTheExampleBalances() {
      const members = await fourMembers();
      await record(members.ann.token, members.groupId, 600, [members.ann.id, members.cy.id]);
      await record(members.ann.token, members.groupId, 400, [members.ann.id, members.dan.id]);
      await record(members.bob.token, members.groupId, 200, [members.bob.id, members.dan.id]);
      return members;
    }

    function suggested(token: string, groupId: string) {
      return send(app, 'GET', `/groups/${groupId}/settlements/suggested`, { token });
    }

    it('answers the transfers that bring every balance of the group to 0, in the order made', async () => {
      const { ann, bob, cy, dan, groupId } = await withTheExampleBalances();
      const response = await suggested(ann.token, groupId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        { from: cy.id, to: ann.id, amount: 300 },
        { from: dan.id, to: ann.id, amount: 200 },
        { from: dan.id, to: bob.id, amount: 100 },
      ]);
    });

    it('answers only from, to and amount for each transfer', async () => {
      const { ann, groupId } = await withTheExampleBalances();
      const [first] = (await suggested(ann.token, groupId)).json<Record<string, unknown>[]>();
      expect(Object.keys(first).sort()).toEqual(['amount', 'from', 'to']);
    });

    it('answers no transfer in a group with no expenses, or where everyone is even', async () => {
      const { ann, bob, cy, dan, groupId } = await fourMembers();
      expect((await suggested(bob.token, groupId)).json()).toEqual([]);

      // Each member pays for their own share alone: every balance is 0.
      await record(ann.token, groupId, 100, [ann.id]);
      await record(bob.token, groupId, 100, [bob.id]);
      await record(cy.token, groupId, 100, [cy.id]);
      await record(dan.token, groupId, 100, [dan.id]);
      expect((await suggested(dan.token, groupId)).json()).toEqual([]);
    });

    it('is the same to every member, and the same on every read', async () => {
      const { ann, bob, cy, dan, groupId } = await withTheExampleBalances();
      const first = (await suggested(ann.token, groupId)).json();
      expect((await suggested(bob.token, groupId)).json()).toEqual(first);
      expect((await suggested(cy.token, groupId)).json()).toEqual(first);
      expect((await suggested(dan.token, groupId)).json()).toEqual(first);
      expect((await suggested(ann.token, groupId)).json()).toEqual(first);
    });

    it('changes nothing: the balances are the same after reading the suggestion', async () => {
      const { ann, groupId } = await withTheExampleBalances();
      const balancesBefore = (await send(app, 'GET', `/groups/${groupId}/balances`, { token: ann.token })).json();
      await suggested(ann.token, groupId);
      await suggested(ann.token, groupId);
      const balancesAfterReads = (await send(app, 'GET', `/groups/${groupId}/balances`, { token: ann.token })).json();
      expect(balancesAfterReads).toEqual(balancesBefore);
    });

    it('answers 404 to a signed-in person who is not a member, as if the group did not exist', async () => {
      const { groupId } = await withTheExampleBalances();
      const outsider = await signedUpAccount(app, { email: 'outsider@example.com', name: 'Eve' });
      const refused = await suggested(outsider.token, groupId);
      const missing = await suggested(outsider.token, 'no-such-group');
      expect(refused.statusCode).toBe(404);
      expect(refused.json().type).toBe('NotFound');
      expect(refused.json()).toEqual(missing.json());
    });

    it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
      const { groupId } = await withTheExampleBalances();
      expect((await send(app, 'GET', `/groups/${groupId}/settlements/suggested`)).statusCode).toBe(401);
      expect((await suggested('not-a-real-token', groupId)).statusCode).toBe(401);
    });
  });
});

import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-balances-${randomUUID()}.db`);

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

const PASSWORD = 'a-good-password';
const PAST = '2026-01-15';

/** Signs up and signs in a fresh account, answering its token and its id. */
async function signedIn(email: string, name: string): Promise<{ token: string; id: string }> {
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: PASSWORD } });
  return { token: (login.body as { token: string }).token, id: (created.body as { id: string }).id };
}

/** A group with its owner as first member, and each given account joined by an invitation, in that order. */
async function groupWith(owner: { token: string }, joiners: Array<{ token: string }>): Promise<string> {
  const group = await http.request('POST', `${api}/groups`, {
    body: { name: 'Flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (group.body as { id: string }).id;
  for (const joiner of joiners) {
    const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: owner.token });
    await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
      token: joiner.token,
    });
  }
  return groupId;
}

const record = (token: string | undefined, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const readBalances = (groupId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

type Balance = { memberId: string; balance: number };
const sum = (balances: Balance[]) => balances.reduce((total, { balance }) => total + balance, 0);

describe("a group's balances", () => {
  it('lists every member in the order they joined, what each is owed or owes, and 0 for one with nothing recorded', async () => {
    const ada = await signedIn('bal-ada@example.com', 'Ada');
    const bob = await signedIn('bal-bob@example.com', 'Bob');
    const cy = await signedIn('bal-cy@example.com', 'Cy');
    const dee = await signedIn('bal-dee@example.com', 'Dee');
    const groupId = await groupWith(ada, [bob, cy, dee]);

    // 1000 paid by Ada, split equally: 334 to Ada, 333 to Bob and to Cy; Dee is in no split.
    expect(
      (
        await record(ada.token, groupId, {
          description: 'Groceries',
          amount: 1000,
          date: PAST,
          splitBetween: [ada.id, bob.id, cy.id],
        })
      ).status,
    ).toBe(201);

    const read = await readBalances(groupId, ada.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual([
      { memberId: ada.id, balance: 666 },
      { memberId: bob.id, balance: -333 },
      { memberId: cy.id, balance: -333 },
      { memberId: dee.id, balance: 0 },
    ]);
  });

  it('answers 0 for every member of a group with nothing recorded', async () => {
    const ada = await signedIn('empty-ada@example.com', 'Ada');
    const bob = await signedIn('empty-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    expect((await readBalances(groupId, bob.token)).body).toEqual([
      { memberId: ada.id, balance: 0 },
      { memberId: bob.id, balance: 0 },
    ]);
  });

  it('adds up to 0 exactly, after expenses recorded at once', async () => {
    const ada = await signedIn('burst-ada@example.com', 'Ada');
    const bob = await signedIn('burst-bob@example.com', 'Bob');
    const cy = await signedIn('burst-cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob, cy]);
    const payers = [ada, bob, cy];

    // Twenty expenses at once, each paid by a different member in turn, with uneven amounts and splits.
    const recorded = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const payer = payers[i % payers.length];
        const splitBetween = i % 2 === 0 ? [ada.id, bob.id, cy.id] : [payer.id, ada.id];
        return record(payer.token, groupId, {
          description: `Expense ${i}`,
          amount: 97 + i * 13,
          date: PAST,
          splitBetween: [...new Set(splitBetween)],
        });
      }),
    );
    expect(recorded.every(response => response.status === 201)).toBe(true);

    const read = await readBalances(groupId, ada.token);
    const balances = read.body as Balance[];
    expect(balances.map(({ memberId }) => memberId)).toEqual([ada.id, bob.id, cy.id]);
    expect(sum(balances)).toBe(0);
    expect(balances.some(({ balance }) => balance !== 0)).toBe(true);
  });

  it('refuses a missing caller with 401', async () => {
    const ada = await signedIn('anon-bal-ada@example.com', 'Ada');
    const groupId = await groupWith(ada, []);

    expect((await readBalances(groupId)).status).toBe(401);
  });

  it('answers a group the caller is not a member of as if it did not exist', async () => {
    const ada = await signedIn('owner-bal-ada@example.com', 'Ada');
    const eve = await signedIn('eve-bal@example.com', 'Eve');
    const groupId = await groupWith(ada, []);

    expect(await readBalances(groupId, eve.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
  });
});

describe('Groups → Ledger', () => {
  it('reads the balances of the group Groups made, by the id its creation answered, once a member has joined it', async () => {
    const ada = await signedIn('gl-bal-ada@example.com', 'Ada');
    const bob = await signedIn('gl-bal-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    // Bob has just joined: Ledger asks Groups' membership at once (T3, ADR 4), and the balances list him in join order.
    expect(
      (
        await record(bob.token, groupId, {
          description: 'Dinner',
          amount: 90,
          date: PAST,
          splitBetween: [bob.id, ada.id],
        })
      ).status,
    ).toBe(201);

    expect((await readBalances(groupId, bob.token)).body).toEqual([
      { memberId: ada.id, balance: -45 },
      { memberId: bob.id, balance: 45 },
    ]);
  });
});

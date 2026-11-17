import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-expenses-${randomUUID()}.db`);

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
const readExpense = (id: string, token?: string) => http.request('GET', `${api}/expenses/${id}`, { token });

describe('recording an expense', () => {
  it('records an expense the caller paid, answering 201 with its id, and reads it back as recorded', async () => {
    const ada = await signedIn('ada@example.com', 'Ada');
    const bob = await signedIn('bob@example.com', 'Bob');
    const cy = await signedIn('cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob, cy]);

    const created = await record(ada.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: PAST,
      splitBetween: [ada.id, bob.id, cy.id],
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String) });

    const read = await readExpense((created.body as { id: string }).id, ada.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id: (created.body as { id: string }).id,
      groupId,
      description: 'Groceries',
      amount: 1000,
      date: PAST,
      paidBy: ada.id,
      shares: [
        { memberId: ada.id, amount: 334 },
        { memberId: bob.id, amount: 333 },
        { memberId: cy.id, amount: 333 },
      ],
    });
  });

  it('keeps the shares in the order the split was given, and the shares add up to the amount', async () => {
    const ada = await signedIn('order-ada@example.com', 'Ada');
    const bob = await signedIn('order-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    const created = await record(ada.token, groupId, {
      description: 'Taxi',
      amount: 7,
      date: PAST,
      splitBetween: [bob.id, ada.id],
    });
    const read = await readExpense((created.body as { id: string }).id, ada.token);

    expect((read.body as { shares: unknown }).shares).toEqual([
      { memberId: bob.id, amount: 3 },
      { memberId: ada.id, amount: 4 },
    ]);
  });

  it('refuses a missing caller with 401, before anything is recorded', async () => {
    const ada = await signedIn('anon-ada@example.com', 'Ada');
    const groupId = await groupWith(ada, []);

    expect(
      (await record(undefined, groupId, { description: 'X', amount: 5, date: PAST, splitBetween: [ada.id] })).status,
    ).toBe(401);
  });

  it('answers a group the caller is not a member of as if it did not exist', async () => {
    const ada = await signedIn('owner-ada@example.com', 'Ada');
    const eve = await signedIn('eve@example.com', 'Eve');
    const groupId = await groupWith(ada, []);

    expect(
      await record(eve.token, groupId, { description: 'X', amount: 5, date: PAST, splitBetween: [eve.id] }),
    ).toMatchObject({
      status: 404,
      body: { type: 'NotFound' },
    });
  });

  it('refuses what the domain refuses with 422, named by the rule', async () => {
    const ada = await signedIn('rules-ada@example.com', 'Ada');
    const bob = await signedIn('rules-bob@example.com', 'Bob');
    const eve = await signedIn('rules-eve@example.com', 'Eve');
    const groupId = await groupWith(ada, [bob]);
    const FUTURE = '2999-01-01'; // after today, whenever the suite runs
    const valid = { description: 'Rent', amount: 500, date: PAST, splitBetween: [ada.id, bob.id] };

    const refusals: Array<[unknown, string]> = [
      [{ ...valid, description: '   ' }, 'InvalidDescription'],
      [{ ...valid, amount: 0 }, 'InvalidAmount'],
      [{ ...valid, amount: 100_000_001 }, 'InvalidAmount'],
      [{ ...valid, date: '2026-02-30' }, 'InvalidDate'],
      [{ ...valid, date: FUTURE }, 'InvalidDate'],
      [{ ...valid, splitBetween: [ada.id, ada.id] }, 'DuplicateInSplit'],
      [{ ...valid, splitBetween: [ada.id, eve.id] }, 'NotAMemberInSplit'],
      [{ ...valid, splitBetween: [bob.id] }, 'PayerNotInSplit'],
    ];
    for (const [body, type] of refusals) {
      expect(await record(ada.token, groupId, body)).toMatchObject({ status: 422, body: { type } });
    }
  });

  it('refuses a body of the wrong shape with 400', async () => {
    const ada = await signedIn('shape-ada@example.com', 'Ada');
    const groupId = await groupWith(ada, []);

    expect(
      (await record(ada.token, groupId, { description: 'Rent', amount: 'ten', date: PAST, splitBetween: [ada.id] }))
        .status,
    ).toBe(400);
    expect((await record(ada.token, groupId, { description: 'Rent', amount: 5, date: PAST })).status).toBe(400);
  });
});

describe('reading an expense', () => {
  it('answers 404 to anyone who is not a member of its group, and to a missing expense', async () => {
    const ada = await signedIn('read-ada@example.com', 'Ada');
    const eve = await signedIn('read-eve@example.com', 'Eve');
    const groupId = await groupWith(ada, []);
    const created = await record(ada.token, groupId, {
      description: 'Rent',
      amount: 5,
      date: PAST,
      splitBetween: [ada.id],
    });
    const id = (created.body as { id: string }).id;

    expect(await readExpense(id, eve.token)).toMatchObject({ status: 404, body: { type: 'NotFound' } });
    expect(await readExpense(id)).toMatchObject({ status: 401 });
    expect(await readExpense(randomUUID(), ada.token)).toMatchObject({ status: 404 });
  });
});

describe('Groups → Ledger', () => {
  it('records an expense in the group Groups made, by the id its creation answered, and reads it back in that group', async () => {
    const ada = await signedIn('gl-ada@example.com', 'Ada');
    const bob = await signedIn('gl-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    // Bob has just joined: he may be in a split at once, from the membership Groups committed (T3, ADR 4).
    const created = await record(bob.token, groupId, {
      description: 'Dinner',
      amount: 90,
      date: PAST,
      splitBetween: [bob.id, ada.id],
    });
    expect(created.status).toBe(201);

    const read = await readExpense((created.body as { id: string }).id, ada.token);
    expect(read.body).toMatchObject({
      groupId,
      paidBy: bob.id,
      shares: [
        { memberId: bob.id, amount: 45 },
        { memberId: ada.id, amount: 45 },
      ],
    });
  });
});

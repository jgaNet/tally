import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-recurring-${randomUUID()}.db`);
// The background job runs every 0.2 seconds, so a day that has come is recorded within the suite, and a suite that waits for a
// month would not finish (as the reminders' suite does).
process.env.JOBS_INTERVAL_SECONDS = '0.2';

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
/** A first day well after the suite runs, so the job has nothing to record for it: a read sees the recurring expense as set up. */
const LATER = '2027-06-01';
/** A first day that has come, so the job records its day at its first run. */
const DUE = '2026-11-01';

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

const setUp = (token: string | undefined, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/recurring`, { body, token });
const readRecurring = (id: string, token?: string) => http.request('GET', `${api}/recurring/${id}`, { token });
const stop = (id: string, token?: string) => http.request('DELETE', `${api}/recurring/${id}`, { token });
const expensesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/expenses`, { token })).body as Array<{
    date: string;
    paidBy: string;
    amount: number;
    splitKind: string;
  }>;

/** The job's work shows in the API only after a run: wait for it, for a while, and never for a timer's own period. */
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = await read();
    if (found !== undefined) return found;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('The background job did not record the day in time');
}

describe('setting up a recurring expense', () => {
  it('is set up by a member, its payer, answering 201 with its id, and reads back as it was given', async () => {
    const ada = await signedIn('ada@example.com', 'Ada');
    const bob = await signedIn('bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    const created = await setUp(ada.token, groupId, {
      description: 'Rent',
      amount: 90_000,
      startsOn: LATER,
      splitBetween: [ada.id, bob.id],
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const read = await readRecurring(id, bob.token);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      paidBy: ada.id,
      description: 'Rent',
      amount: 90_000,
      startsOn: LATER,
      next: LATER,
      splitBetween: [ada.id, bob.id],
    });
  });

  it('keeps an exact split and a split by shares as they were given', async () => {
    const ada = await signedIn('exact@example.com', 'Ada');
    const bob = await signedIn('exact-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);

    const exact = await setUp(ada.token, groupId, {
      description: 'Internet',
      amount: 3_000,
      startsOn: LATER,
      splitExactly: [
        { memberId: ada.id, amount: 1_000 },
        { memberId: bob.id, amount: 2_000 },
      ],
    });
    const shares = await setUp(ada.token, groupId, {
      description: 'Gas',
      amount: 3_000,
      startsOn: LATER,
      splitByShares: [
        { memberId: ada.id, shares: 1 },
        { memberId: bob.id, shares: 2 },
      ],
    });
    const exactRead = await readRecurring((exact.body as { id: string }).id, ada.token);
    const sharesRead = await readRecurring((shares.body as { id: string }).id, ada.token);
    expect((exactRead.body as { splitExactly: unknown }).splitExactly).toEqual([
      { memberId: ada.id, amount: 1_000 },
      { memberId: bob.id, amount: 2_000 },
    ]);
    expect((sharesRead.body as { splitByShares: unknown }).splitByShares).toEqual([
      { memberId: ada.id, shares: 1 },
      { memberId: bob.id, shares: 2 },
    ]);
  });

  it('refuses a first day that is not one every month has, or is too far away, as a refusal of the operation', async () => {
    const ada = await signedIn('day@example.com', 'Ada');
    const groupId = await groupWith(ada, []);
    const body = { description: 'Rent', amount: 90_000, splitBetween: [ada.id] };

    const twentyNinth = await setUp(ada.token, groupId, { ...body, startsOn: '2026-11-29' });
    expect(twentyNinth.status).toBe(422);
    expect(twentyNinth.body).toMatchObject({ type: 'InvalidStartsOn' });

    const tooFar = await setUp(ada.token, groupId, { ...body, startsOn: '2040-01-01' });
    expect(tooFar.status).toBe(422);
  });

  it('answers a non-member as if the group did not exist', async () => {
    const ada = await signedIn('owner@example.com', 'Ada');
    const cy = await signedIn('cy@example.com', 'Cy');
    const groupId = await groupWith(ada, []);
    const answer = await setUp(cy.token, groupId, {
      description: 'Rent',
      amount: 90_000,
      startsOn: LATER,
      splitBetween: [cy.id],
    });
    expect(answer.status).toBe(404);
  });

  it('lists the group recurring expenses, the earliest set up first, to a member only', async () => {
    const ada = await signedIn('list@example.com', 'Ada');
    const bob = await signedIn('list-bob@example.com', 'Bob');
    const cy = await signedIn('list-cy@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob]);
    const first = await setUp(ada.token, groupId, {
      description: 'Rent',
      amount: 90_000,
      startsOn: LATER,
      splitBetween: [ada.id],
    });
    const second = await setUp(bob.token, groupId, {
      description: 'Water',
      amount: 2_000,
      startsOn: LATER,
      splitBetween: [bob.id, ada.id],
    });

    const list = await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: ada.token });
    expect(list.status).toBe(200);
    expect((list.body as Array<{ id: string }>).map(recurring => recurring.id)).toEqual([
      (first.body as { id: string }).id,
      (second.body as { id: string }).id,
    ]);
    const outsider = await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: cy.token });
    expect(outsider.status).toBe(404);
  });
});

describe('stopping a recurring expense', () => {
  it('is stopped by its payer, then it no longer exists', async () => {
    const ada = await signedIn('stop@example.com', 'Ada');
    const groupId = await groupWith(ada, []);
    const created = await setUp(ada.token, groupId, {
      description: 'Rent',
      amount: 90_000,
      startsOn: LATER,
      splitBetween: [ada.id],
    });
    const id = (created.body as { id: string }).id;

    expect((await stop(id, ada.token)).status).toBe(204);
    expect((await readRecurring(id, ada.token)).status).toBe(404);
  });

  it('is refused to a member who is neither its payer nor the owner, and answers a stranger as if it did not exist', async () => {
    const ada = await signedIn('owner-stop@example.com', 'Ada');
    const bob = await signedIn('member-stop@example.com', 'Bob');
    const cy = await signedIn('stranger-stop@example.com', 'Cy');
    const groupId = await groupWith(ada, [bob]);
    const created = await setUp(bob.token, groupId, {
      description: 'Water',
      amount: 2_000,
      startsOn: LATER,
      splitBetween: [bob.id],
    });
    const id = (created.body as { id: string }).id;

    expect((await stop(id, ada.token)).status).toBe(204);
    const other = await setUp(ada.token, groupId, {
      description: 'Gas',
      amount: 3_000,
      startsOn: LATER,
      splitBetween: [ada.id],
    });
    const otherId = (other.body as { id: string }).id;
    expect((await stop(otherId, bob.token)).status).toBe(403);
    expect((await stop(otherId, cy.token)).status).toBe(404);
  });
});

describe('Groups → Ledger', () => {
  it('sets up a recurring expense in the group Groups made, by the id its creation answered, and finds it in that group', async () => {
    const ada = await signedIn('rgl-ada@example.com', 'Ada');
    const bob = await signedIn('rgl-bob@example.com', 'Bob');
    // The group is made through Groups' API; `groupWith` keeps the `{ id }` that `POST /groups` answered.
    const groupId = await groupWith(ada, [bob]);

    // Bob has just joined: he may be the payer of a recurring expense at once, from the membership Groups committed (ADR 0004).
    const created = await setUp(bob.token, groupId, {
      description: 'Water',
      amount: 2_000,
      startsOn: LATER,
      splitBetween: [bob.id, ada.id],
    });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;

    const listed = await http.request('GET', `${api}/groups/${groupId}/recurring`, { token: ada.token });
    expect(listed.body).toEqual([expect.objectContaining({ id, groupId, paidBy: bob.id })]);
  });
});

describe('the background job records the days that have come', () => {
  it('records a day that has come once, and the recurring expense goes on from the next day', async () => {
    const ada = await signedIn('job@example.com', 'Ada');
    const bob = await signedIn('job-bob@example.com', 'Bob');
    const groupId = await groupWith(ada, [bob]);
    const created = await setUp(ada.token, groupId, {
      description: 'Rent',
      amount: 90_000,
      startsOn: DUE,
      splitBetween: [ada.id, bob.id],
    });
    const id = (created.body as { id: string }).id;

    // The job records the day at one of its runs: the expense is there, dated that day, paid by Ada, split as given.
    const recorded = await until(async () => (await expensesOf(groupId, ada.token)).find(e => e.date === DUE));
    expect(recorded).toMatchObject({ paidBy: ada.id, amount: 90_000, splitKind: 'equal' });

    // Several more runs go by, and the day is still recorded once: the next day has moved past it.
    await new Promise(resolve => setTimeout(resolve, 700));
    const expenses = await expensesOf(groupId, ada.token);
    expect(expenses.filter(expense => expense.date === DUE)).toHaveLength(1);
    const read = await readRecurring(id, ada.token);
    expect((read.body as { next: string }).next > DUE).toBe(true);
  });
});

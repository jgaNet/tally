import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import pg from 'pg';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The notices over HTTP, against a database file (request 17, fragment 17): each member of an expense's split but its payer gets one
 * notice with their share, soon after the expense is recorded; the payer gets none; an edit or a deletion makes none; a person lists
 * only their own, the most recent first; a notice stays theirs after they leave; and a notice is made once, even when the server stops
 * and starts again while the expense's fact is still pending.
 */
let directory: string;
let databaseUrl: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-notices-'));
  databaseUrl = await freshDatabase();
  app = await start();
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  cy = await person('Cy', 'cy@example.com');
  dee = await person('Dee', 'dee@example.com');
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

/** The application over the database file, as a server starts on it. */
async function start(): Promise<FastifyApplication> {
  const started = await createApplication({ databaseUrl, logger: silent });
  await started.start(0);
  http = apiClient(started.address);
  api = `/${started.apiPrefix}`;
  return started;
}

/** A signed-in person: their token, and their account id as the account answers it. */
async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, name };
}

type Person = Awaited<ReturnType<typeof person>>;
let ann: Person;
let bob: Person;
let cy: Person;
let dee: Person;

const createGroup = async () => {
  const { body } = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Flat', currency: 'EUR' },
  });
  return (body as { id: string }).id;
};

/** Joins the person to the group through an invitation, the way Groups lets them: by its link. */
const joinGroup = async (groupId: string, who: Person) => {
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitationId = (invitation.body as { id: string }).id;
  await http.request('POST', `${api}/invitations/${invitationId}/accept`, { token: who.token });
};

const record = async (token: string, groupId: string, body: Record<string, unknown>): Promise<string> => {
  const { body: answer } = await http.request('POST', `${api}/groups/${groupId}/expenses`, { token, body });
  return (answer as { id: string }).id;
};

const notices = (token: string) => http.request('GET', `${api}/notices`, { token });

/** Reads what the test waits for, again and again, until it holds or the polls run out: a notice is made soon, not at once (3 s). */
async function eventually<T>(read: () => Promise<T>, holds: (value: T) => boolean, polls = 120): Promise<T> {
  let value = await read();
  for (let poll = 0; poll < polls && !holds(value); poll++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

/** A person's notices about one group: the tests share the people, so each reads only the notices of its own group. */
const listOf = async (token: string, groupId: string) =>
  ((await notices(token)).body as Array<Record<string, unknown>>).filter(notice => notice.groupId === groupId);

/** The outbox's pending facts, read from the database the server keeps them in: nothing is pending once every fact is published. */
const pendingFacts = async (): Promise<number> => {
  const database = new pg.Client({ connectionString: databaseUrl });
  await database.connect();
  try {
    return Number((await database.query('SELECT COUNT(*) AS n FROM outbox')).rows[0].n);
  } finally {
    await database.end();
  }
};
const settled = () =>
  eventually(
    async () => pendingFacts(),
    n => n === 0,
  );

describe('notices', () => {
  it('makes one notice for each member of the split but the payer, with their share, soon after the expense is recorded', async () => {
    const groupId = await createGroup();
    await joinGroup(groupId, bob);
    await joinGroup(groupId, cy);
    await joinGroup(groupId, dee);

    const expenseId = await record(bob.token, groupId, {
      description: 'Pizzas',
      amount: 3000,
      date: '2020-01-10',
      splitBetween: [bob.id, cy.id, dee.id],
    });

    const cyNotices = await eventually(
      () => listOf(cy.token, groupId),
      list => list.length === 1,
    );
    expect(cyNotices).toEqual([
      {
        id: expect.any(String),
        kind: 'expense',
        groupId,
        expenseId,
        amount: 1000,
        at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
      },
    ]);
    expect(
      await eventually(
        () => listOf(dee.token, groupId),
        list => list.length === 1,
      ),
    ).toHaveLength(1);
    // The payer recorded it, so receives none.
    expect(await listOf(bob.token, groupId)).toEqual([]);
    await settled();
    expect(await listOf(bob.token, groupId)).toEqual([]);
  });

  it('lists a person their own notices, the most recent first, and nobody else reads them', async () => {
    const groupId = await createGroup();
    await joinGroup(groupId, bob);
    await joinGroup(groupId, cy);
    const first = await record(bob.token, groupId, {
      description: 'First',
      amount: 3000,
      date: '2020-01-10',
      splitBetween: [ann.id, bob.id, cy.id],
    });
    await eventually(
      () => listOf(cy.token, groupId),
      list => list.length === 1,
    );
    const second = await record(ann.token, groupId, {
      description: 'Second',
      amount: 600,
      date: '2020-01-11',
      splitBetween: [ann.id, cy.id],
    });

    const cyList = await eventually(
      () => listOf(cy.token, groupId),
      list => list.length === 2,
    );
    expect(cyList.map(notice => notice.expenseId)).toEqual([second, first]);
    expect(cyList.map(notice => notice.amount)).toEqual([300, 1000]);
    // Bob paid the first and is in no notice of it; he is in none of the second either.
    await settled();
    expect(await listOf(bob.token, groupId)).toEqual([]);
    // Someone who is not signed in is refused, and nobody's notices are read with someone else's token.
    expect((await http.request('GET', `${api}/notices`)).status).toBe(401);
  });

  it('makes no notice for an edit or a deletion of an expense', async () => {
    const groupId = await createGroup();
    await joinGroup(groupId, bob);
    await joinGroup(groupId, cy);
    const expenseId = await record(bob.token, groupId, {
      description: 'Rent part',
      amount: 1000,
      date: '2020-01-10',
      splitBetween: [bob.id, cy.id],
    });
    await eventually(
      () => listOf(cy.token, groupId),
      list => list.length === 1,
    );
    await settled();
    const before = (await listOf(cy.token, groupId)).length;

    const read = (await http.request('GET', `${api}/expenses/${expenseId}`, { token: bob.token })).body as {
      version: number;
    };
    const edit = await http.request('PUT', `${api}/expenses/${expenseId}`, {
      token: bob.token,
      body: {
        description: 'Rent',
        amount: 2000,
        date: '2020-01-10',
        splitBetween: [bob.id, cy.id],
        version: read.version,
      },
    });
    expect(edit.status).toBeLessThan(300);
    await settled();
    expect(await listOf(cy.token, groupId)).toHaveLength(before);

    const removal = await http.request('DELETE', `${api}/expenses/${expenseId}`, { token: bob.token });
    expect(removal.status).toBeLessThan(300);
    await settled();
    expect(await listOf(cy.token, groupId)).toHaveLength(before);
  });

  it('makes each notice once, even when the server stops and starts again while the fact is still pending', async () => {
    const groupId = await createGroup();
    await joinGroup(groupId, bob);
    await joinGroup(groupId, cy);
    const expenseId = await record(bob.token, groupId, {
      description: 'Restart',
      amount: 800,
      date: '2020-01-10',
      splitBetween: [bob.id, cy.id],
    });
    await eventually(
      () => listOf(cy.token, groupId),
      list => list.length === 1,
    );
    await settled();

    // The fact is put back as pending, as a server that stopped after the notice committed and before the relay acknowledged it leaves
    // it; the next start hands it out again.
    const pending = async (id: string) => {
      const database = new pg.Client({ connectionString: databaseUrl });
      await database.connect();
      try {
        await database.query('INSERT INTO outbox (id, name, payload) VALUES ($1, $2, $3)', [
          id,
          'ExpenseRecordedIntegrationEvent',
          JSON.stringify({
            expenseId,
            groupId,
            paidBy: bob.id,
            shares: [
              { memberId: bob.id, amount: 400 },
              { memberId: cy.id, amount: 400 },
            ],
          }),
        ]);
      } finally {
        await database.end();
      }
    };
    const fact = '00000000-0000-4000-8000-00000000f017';

    await app.stop();
    await pending(fact);
    app = await start();
    await settled();
    expect(await listOf(cy.token, groupId)).toHaveLength(2);

    await app.stop();
    await pending(fact);
    app = await start();
    await settled();
    expect(await listOf(cy.token, groupId)).toHaveLength(2);
  });
});

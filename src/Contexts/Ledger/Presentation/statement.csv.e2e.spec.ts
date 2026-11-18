import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A member's statement with the settlements the balances count (request 29), over HTTP: a settlement in cash is an entry of the statement
 * beside the expenses, with its kind and its settlement id; the same statement is answered as CSV, in the order the statement lists it, with
 * the header and a CRLF line for each entry; and the answers for those who may not read it. Groups, expenses and settlements are made through
 * their own routes; every answer is held to the API `api/` gives, through `apiClient()`.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-statement-csv-')), 'tally.sqlite');
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

let accountCount = 0;
/** A signed-in person, with a fresh email, and their token. */
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  return { token, id: (created.body as { id: string }).id };
}

/** A group owned by `owner`, which each of `others` has joined through an invitation, in that order. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const { id } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: owner.token })
  ).body as { id: string };
  for (const person of others) {
    const invitation = (await http.request('POST', `${api}/groups/${id}/invitations`, { token: owner.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  return id;
}

const record = (groupId: string, body: Record<string, unknown>, token?: string) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const statementOf = (groupId: string, memberId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/members/${memberId}/statement`, { token });
const statementCsvOf = (groupId: string, memberId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/members/${memberId}/statement.csv`, { token });
const idOf = (answer: { body: unknown }) => (answer.body as { id: string }).id;

/** Lets the clock move on, so that two records are not made in the same millisecond. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

/**
 * Ada and Grace of a group, with four records. The day the balances count in is the server's, in UTC, and no test reads a clock: a probe
 * expense dated in the past is recorded first, and the audit gives when it was recorded, which is the day the others are dated on. Then an
 * expense Ada paid, a settlement in cash Grace pays Ada (recorded by Ada), and an expense Grace paid, each recorded after the one before.
 */
async function scenario() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const groupId = await groupWith(ada, [grace]);

  const probe = idOf(
    await record(
      groupId,
      { description: 'Probe', amount: 2, date: '2025-06-01', splitBetween: [ada.id, grace.id] },
      ada.token,
    ),
  );
  const audit = (await http.request('GET', `${api}/groups/${groupId}/audit`, { token: ada.token })).body as {
    at: string;
  }[];
  const today = audit[0].at.slice(0, 10);
  await tick();
  const first = idOf(
    await record(
      groupId,
      { description: 'Pizza, "the big one"', amount: 60, date: today, splitBetween: [ada.id, grace.id] },
      ada.token,
    ),
  );
  await tick();
  const settlement = idOf(
    await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 10 },
      token: ada.token,
    }),
  );
  await tick();
  const second = idOf(
    await record(
      groupId,
      { description: 'Drinks', amount: 20, date: today, splitBetween: [ada.id, grace.id] },
      grace.token,
    ),
  );
  return { ada, grace, groupId, probe, first, settlement, second, today };
}

describe('Settlements → Ledger (request 29)', () => {
  it('lists a settlement in cash beside the expenses, with its kind, its settlement id and what it moved for the member', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);
    const expense = idOf(
      await record(
        groupId,
        { description: 'Rent', amount: 100, date: '2025-04-01', splitBetween: [ada.id, grace.id] },
        ada.token,
      ),
    );
    const settlement = idOf(
      await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: grace.id, amount: 30 },
        token: ada.token,
      }),
    );
    // The settlement's day is the day it was recorded, in UTC, as the settlement itself says.
    const settledAt = (await http.request('GET', `${api}/settlements/${settlement}`, { token: ada.token })).body as {
      at: string;
    };

    const statement = (await statementOf(groupId, grace.id, grace.token)).body as {
      memberId: string;
      balance: number;
      entries: Record<string, unknown>[];
    };
    expect(statement.memberId).toBe(grace.id);
    expect(statement.entries).toEqual([
      {
        kind: 'expense',
        expenseId: expense,
        date: '2025-04-01',
        description: 'Rent',
        paid: 0,
        share: 50,
        balance: -50,
      },
      {
        kind: 'settlement',
        settlementId: settlement,
        date: settledAt.at.slice(0, 10),
        description: 'Settlement in cash',
        paid: 30,
        share: 0,
        balance: -20,
      },
    ]);
    expect(statement.balance).toBe(-20);
    // The group's balance of the member is the statement's: a settlement in cash counts from when it is recorded.
    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ada.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances.find(line => line.memberId === grace.id)?.balance).toBe(-20);
  });
});

describe('a member’s statement as CSV (request 29)', () => {
  it('orders the expenses and the settlement of one day by when each was recorded or counted', async () => {
    const { ada, groupId, probe, first, settlement, second } = await scenario();

    const statement = (await statementOf(groupId, ada.id, ada.token)).body as {
      balance: number;
      entries: Record<string, unknown>[];
    };
    expect(statement.entries.map(entry => entry.kind)).toEqual(['expense', 'expense', 'settlement', 'expense']);
    expect(statement.entries.map(entry => entry.expenseId ?? entry.settlementId)).toEqual([
      probe,
      first,
      settlement,
      second,
    ]);
    expect(statement.entries.map(entry => entry.balance)).toEqual([1, 31, 21, 11]);
    expect(statement.balance).toBe(11);
  });

  it('answers the same statement as CSV: a header, a CRLF line for each entry in order, and quotes only what needs them', async () => {
    const { ada, groupId, probe, first, settlement, second, today } = await scenario();

    const answer = await statementCsvOf(groupId, ada.id, ada.token);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/csv');
    expect(answer.body).toBe(
      [
        'date,kind,id,description,paid,share,balance',
        `2025-06-01,expense,${probe},Probe,2,1,1`,
        `${today},expense,${first},"Pizza, ""the big one""",60,30,31`,
        `${today},settlement,${settlement},Settlement in cash,0,10,21`,
        `${today},expense,${second},Drinks,0,10,11`,
        '',
      ].join('\r\n'),
    );
  });

  it('answers the CSV of a member with no entries as the header alone', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const groupId = await groupWith(ada, [grace]);

    const answer = await statementCsvOf(groupId, grace.id, grace.token);
    expect(answer.status).toBe(200);
    expect(answer.body).toBe('date,kind,id,description,paid,share,balance\r\n');
  });

  it('answers the same refusals as the JSON statement: 401 to no one signed in, 404 to someone who is not a member', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const outsider = await signedInPerson('Linus');
    const groupId = await groupWith(ada, [grace]);

    expect((await statementCsvOf(groupId, ada.id)).status).toBe(401);
    expect((await statementCsvOf(groupId, ada.id, outsider.token)).status).toBe(404);
    expect((await statementCsvOf(groupId, outsider.id, ada.token)).status).toBe(404);
  });
});

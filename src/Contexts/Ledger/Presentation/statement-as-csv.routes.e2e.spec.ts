import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * A member's statement with the settlements it counts, and as CSV, over HTTP against a database file (request 29, fragment 29): a cash
 * settlement lists beside the expenses, with its kind and its id, on the day the balances started to count it, and the statement ends at the
 * balance the group's balances give the member; the same statement as `text/csv` in UTF-8, a header line then one line an entry, CRLF
 * ended, a field with a comma or a double quote quoted; and the refusals a statement answers (`401` to no one signed in, `404` to a caller
 * outside the group).
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';
const DAY_1 = '2020-01-10';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-statement-csv-'));
  app = await createApplication({ databasePath: join(directory, 'tally.sqlite'), logger: silent });
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
  ann = await person('Ann', 'ann@example.com');
  bob = await person('Bob', 'bob@example.com');
  dana = await person('Dana', 'dana@example.com');
});
afterAll(async () => {
  await app.stop();
  rmSync(directory, { recursive: true, force: true });
});

/** A signed-in person: their token, and their account id as the account answers it. */
async function person(name: string, email: string) {
  await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password } });
  const token = (login.body as { token: string }).token;
  const me = await http.request('GET', `${api}/accounts/me`, { token });
  return { token, id: (me.body as { id: string }).id, name };
}

let ann: Awaited<ReturnType<typeof person>>;
let bob: Awaited<ReturnType<typeof person>>;
let dana: Awaited<ReturnType<typeof person>>;

/** A group of Ann's with Bob in it, and Ann's expense of 1000 split between the two, described with a comma and a quote. */
async function groupWithTaxi() {
  const created = await http.request('POST', `${api}/groups`, {
    token: ann.token,
    body: { name: 'Flat', currency: 'EUR' },
  });
  const groupId = (created.body as { id: string }).id;
  const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
    token: bob.token,
  });
  const taxi = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    token: ann.token,
    body: { description: 'Taxi, "airport"', amount: 1000, date: DAY_1, splitBetween: [ann.id, bob.id] },
  });
  return { groupId, taxiId: (taxi.body as { id: string }).id };
}

const statement = (token: string | undefined, groupId: string, memberId: string) =>
  http.request('GET', `${api}/groups/${groupId}/members/${memberId}/statement`, { token });
const statementCsv = (token: string | undefined, groupId: string, memberId: string) =>
  http.request('GET', `${api}/groups/${groupId}/members/${memberId}/statement.csv`, { token });

describe('a member’s statement with the settlements it counts', () => {
  it('lists a cash settlement beside the expenses, with its kind and its id, and ends at the balance the group gives', async () => {
    const { groupId, taxiId } = await groupWithTaxi();
    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 300 },
    });
    expect(recorded.status).toBe(201);
    const settlementId = (recorded.body as { id: string }).id;
    const settlement = (await http.request('GET', `${api}/settlements/${settlementId}`, { token: ann.token })).body as {
      at: string;
    };

    const answer = await statement(bob.token, groupId, bob.id);
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({
      memberId: bob.id,
      balance: -200,
      entries: [
        {
          kind: 'expense',
          expenseId: taxiId,
          date: DAY_1,
          description: 'Taxi, "airport"',
          paid: 0,
          share: 500,
          balance: -500,
        },
        {
          kind: 'settlement',
          settlementId,
          date: settlement.at.slice(0, 10),
          description: 'Settlement in cash',
          paid: 300,
          share: 0,
          balance: -200,
        },
      ],
    });
    expect((await http.request('GET', `${api}/groups/${groupId}/balances`, { token: bob.token })).body).toContainEqual({
      memberId: bob.id,
      balance: -200,
    });
  });

  it('is the same statement as CSV: UTF-8 text, a header line and a line an entry, CRLF ended, the quoted fields quoted', async () => {
    const { groupId, taxiId } = await groupWithTaxi();
    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      token: ann.token,
      body: { from: bob.id, amount: 300 },
    });
    const settlementId = (recorded.body as { id: string }).id;
    const settlement = (await http.request('GET', `${api}/settlements/${settlementId}`, { token: ann.token })).body as {
      at: string;
    };

    const answer = await statementCsv(ann.token, groupId, bob.id);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(answer.body).toBe(
      'date,kind,id,description,paid,share,balance\r\n' +
        `${DAY_1},expense,${taxiId},"Taxi, ""airport""",0,500,-500\r\n` +
        `${settlement.at.slice(0, 10)},settlement,${settlementId},Settlement in cash,300,0,-200\r\n`,
    );
  });

  it('is the 404 of the statement to someone outside the group, and 401 to no one signed in, as the JSON is', async () => {
    const { groupId } = await groupWithTaxi();
    const outside = await statementCsv(dana.token, groupId, bob.id);
    expect(outside.status).toBe(404);
    expect(outside.headers.get('content-type')).toContain('application/json');
    expect((await statementCsv(undefined, groupId, bob.id)).status).toBe(401);
  });

  it('is an empty statement as a header line alone', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Empty', currency: 'EUR' },
    });
    const groupId = (created.body as { id: string }).id;
    const answer = await statementCsv(ann.token, groupId, ann.id);
    expect(answer.body).toBe('date,kind,id,description,paid,share,balance\r\n');
    expect((await statement(ann.token, groupId, ann.id)).body).toEqual({ memberId: ann.id, balance: 0, entries: [] });
  });
});

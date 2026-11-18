import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

// The application keeps what it knows in the file DATABASE_PATH names: this suite has a file of its own.
process.env.DATABASE_PATH = join(tmpdir(), `tally-statement-${randomUUID()}.db`);

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
/**
 * The day, in UTC, a member joined the group, which is today: the suite does not read the clock. A settlement counts from the moment it is
 * recorded, so its line is on this day (request 29), and an expense may be dated on it.
 */
async function dayOfJoining(groupId: string, token: string, memberId: string): Promise<string> {
  const members = (await http.request('GET', `${api}/groups/${groupId}/members`, { token })).body as Array<{
    memberId: string;
    joinedAt: string;
  }>;
  return members.find(member => member.memberId === memberId)?.joinedAt.slice(0, 10) ?? '';
}

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

const record = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/expenses`, { body, token });
const payInCash = (token: string, groupId: string, body: unknown) =>
  http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body, token });
const readStatement = (groupId: string, memberId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/members/${memberId}/statement`, { token });
const readStatementCsv = (groupId: string, memberId: string, token?: string) =>
  http.request('GET', `${api}/groups/${groupId}/members/${memberId}/statement.csv`, { token });
const readBalances = (groupId: string, token: string) =>
  http.request('GET', `${api}/groups/${groupId}/balances`, { token });

type Entry = {
  kind: 'expense' | 'settlement';
  expenseId?: string;
  settlementId?: string;
  date: string;
  description: string;
  paid: number;
  share: number;
  balance: number;
};
type Statement = { memberId: string; balance: number; entries: Entry[] };

describe('Settlements → Ledger', () => {
  it('reads the cash settlement Settlements answered, by the id that request answered, beside the expenses in a member statement, on the day it is recorded, after the expense of that day recorded before it', async () => {
    const ada = await signedIn('stmt-settle-ada@example.com', 'Ada');
    const ben = await signedIn('stmt-settle-ben@example.com', 'Ben');
    const groupId = await groupWith(ada, [ben]);
    const TODAY = await dayOfJoining(groupId, ada.token, ben.id);

    const dinner = (
      await record(ada.token, groupId, {
        description: 'Dinner',
        amount: 6000,
        date: TODAY,
        splitBetween: [ada.id, ben.id],
      })
    ).body as { id: string };
    const settled = (await payInCash(ada.token, groupId, { from: ben.id, amount: 1000 })).body as { id: string };

    // Ben owes 3000 for the dinner and paid 1000 back: his balance is -2000, the statement's last line's, and so is Ada's +2000.
    const bens = await readStatement(groupId, ben.id, ben.token);
    expect(bens.status).toBe(200);
    expect(bens.body).toEqual<Statement>({
      memberId: ben.id,
      balance: -2000,
      entries: [
        {
          kind: 'expense',
          expenseId: dinner.id,
          date: TODAY,
          description: 'Dinner',
          paid: 0,
          share: 3000,
          balance: -3000,
        },
        {
          kind: 'settlement',
          settlementId: settled.id,
          date: TODAY,
          description: 'Settlement in cash',
          paid: 1000,
          share: 0,
          balance: -2000,
        },
      ],
    });
    const adas = (await readStatement(groupId, ada.id, ada.token)).body as Statement;
    expect(adas).toMatchObject({ balance: 2000 });
    expect(adas.entries[1]).toEqual({
      kind: 'settlement',
      settlementId: settled.id,
      date: TODAY,
      description: 'Settlement in cash',
      paid: 0,
      share: 1000,
      balance: 2000,
    });
    // Each statement's balance is the group's balance of the member (request 5).
    expect((await readBalances(groupId, ada.token)).body).toEqual(
      expect.arrayContaining([
        { memberId: ada.id, balance: 2000 },
        { memberId: ben.id, balance: -2000 },
      ]),
    );
  });
});

describe("a member's statement as CSV", () => {
  it('answers the statement as text/csv: the header, then one CRLF line per entry in the statement order, quoting the fields that need it', async () => {
    const ada = await signedIn('stmt-csv-ada@example.com', 'Ada');
    const ben = await signedIn('stmt-csv-ben@example.com', 'Ben');
    const groupId = await groupWith(ada, [ben]);
    const TODAY = await dayOfJoining(groupId, ada.token, ben.id);

    const dinner = (
      await record(ada.token, groupId, {
        description: 'Dinner',
        amount: 6000,
        date: TODAY,
        splitBetween: [ada.id, ben.id],
      })
    ).body as { id: string };
    const pizza = (
      await record(ada.token, groupId, {
        description: 'Pizza, "big"',
        amount: 1200,
        date: TODAY,
        splitBetween: [ada.id, ben.id],
      })
    ).body as { id: string };
    const settled = (await payInCash(ada.token, groupId, { from: ben.id, amount: 1000 })).body as { id: string };

    const csv = await readStatementCsv(groupId, ben.id, ben.token);
    expect(csv.status).toBe(200);
    expect(String(csv.headers.get('content-type'))).toMatch(/^text\/csv/);
    expect(csv.body).toBe(
      [
        'date,kind,id,description,paid,share,balance',
        `${TODAY},expense,${dinner.id},Dinner,0,3000,-3000`,
        `${TODAY},expense,${pizza.id},"Pizza, ""big""",0,600,-3600`,
        `${TODAY},settlement,${settled.id},Settlement in cash,1000,0,-2600`,
        '',
      ].join('\r\n'),
    );
  });

  it('answers the members only, as the statement does: no token is 401, and a stranger has no statement', async () => {
    const ada = await signedIn('stmt-csv-only-ada@example.com', 'Ada');
    const ben = await signedIn('stmt-csv-only-ben@example.com', 'Ben');
    const eve = await signedIn('stmt-csv-only-eve@example.com', 'Eve');
    const groupId = await groupWith(ada, [ben]);

    expect((await readStatementCsv(groupId, ben.id)).status).toBe(401);
    expect(await readStatementCsv(groupId, ben.id, eve.token)).toMatchObject({
      status: 404,
      body: { type: 'NotFound' },
    });
  });
});

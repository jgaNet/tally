import { type Application, createApplication } from '../app';
import { todayInUtc } from '../expenses/validation';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabasePath } from '../test-support';

describe("a member's statement as CSV", () => {
  let app: Application;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = temporaryDatabasePath();
    app = await createApplication({ databasePath });
  });

  afterEach(async () => {
    await app.stop();
  });

  const dayBefore = (day: string, days = 1): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

  async function threeMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const linus = await signedUpAccount(app, { email: 'linus@example.com', name: 'Linus' });
    const created = await send(app, 'POST', '/groups', {
      token: ada.token,
      payload: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = created.json<{ id: string }>().id;
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    await joinThroughInvitation(app, ada.token, linus.token, groupId);
    return { ada, grace, linus, groupId };
  }

  async function record(token: string, groupId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function csvOf(token: string, groupId: string, memberId: string) {
    return send(app, 'GET', `/groups/${groupId}/members/${memberId}/statement.csv`, { token });
  }

  /**
   * Ada paid 1000 two days ago, split with Grace (Ada's balance 500); Grace paid 400 today, split with Ada
   * (Ada's balance 300); Grace pays Ada 300 in cash today, recorded by Ada (Ada's balance 0). The first
   * expense's description has a comma and double quotes, the second's a line break.
   */
  async function adaIsOwedAndPaidBack() {
    const members = await threeMembers();
    const { ada, grace, groupId } = members;
    const first = await record(ada.token, groupId, {
      description: 'Dinner, "the good one"',
      amount: 1000,
      date: dayBefore(todayInUtc(), 2),
      splitBetween: [ada.id, grace.id],
    });
    const second = await record(grace.token, groupId, {
      description: 'Multi\nline',
      amount: 400,
      date: todayInUtc(),
      splitBetween: [ada.id, grace.id],
    });
    const settled = await send(app, 'POST', `/groups/${groupId}/settlements/cash`, {
      token: ada.token,
      payload: { from: grace.id, amount: 300 },
    });
    expect(settled.statusCode).toBe(201);
    return { ...members, first, second, settlementId: settled.json<{ id: string }>().id };
  }

  it('answers the statement as CSV: text, in UTF-8, one header line and then a line per entry, each ending CRLF', async () => {
    const { ada, groupId, first, second, settlementId } = await adaIsOwedAndPaidBack();
    const response = await csvOf(ada.token, groupId, ada.id);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    const today = todayInUtc();
    expect(response.body).toBe(
      [
        'date,kind,id,description,paid,share,balance',
        `${dayBefore(today, 2)},expense,${first},"Dinner, ""the good one""",1000,500,500`,
        `${today},expense,${second},"Multi\nline",0,200,300`,
        `${today},settlement,${settlementId},Settlement in cash,0,300,0`,
      ]
        .map(line => `${line}\r\n`)
        .join(''),
    );
  });

  it('gives the same entries, in the same order, as the statement answers as JSON', async () => {
    const { ada, groupId } = await adaIsOwedAndPaidBack();
    const json = (await send(app, 'GET', `/groups/${groupId}/members/${ada.id}/statement`, { token: ada.token })).json<{
      entries: { date: string; kind: string; paid: number; share: number; balance: number; description: string }[];
    }>();
    const lines = (await csvOf(ada.token, groupId, ada.id)).body.split('\r\n').slice(1, -1);
    expect(lines).toHaveLength(json.entries.length);
    json.entries.forEach((entry, index) => {
      expect(lines[index].split(',')[0]).toBe(entry.date);
      expect(lines[index].split(',')[1]).toBe(entry.kind);
      expect(lines[index].endsWith(`,${entry.paid},${entry.share},${entry.balance}`)).toBe(true);
    });
  });

  it('is the header line alone for a member with nothing recorded', async () => {
    const { ada, linus, groupId } = await threeMembers();
    await record(ada.token, groupId, {
      description: 'Groceries',
      amount: 1000,
      date: todayInUtc(),
      splitBetween: [ada.id],
    });
    const response = await csvOf(linus.token, groupId, linus.id);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('date,kind,id,description,paid,share,balance\r\n');
  });

  it('writes a field in double quotes only when it holds a comma, a double quote or a line break', async () => {
    const { ada, grace, groupId } = await threeMembers();
    await record(ada.token, groupId, {
      description: 'Plain words',
      amount: 200,
      date: todayInUtc(),
      splitBetween: [ada.id, grace.id],
    });
    const lines = (await csvOf(grace.token, groupId, grace.id)).body.split('\r\n');
    expect(lines[1]).toBe(`${todayInUtc()},expense,${lines[1].split(',')[2]},Plain words,0,100,-100`);
  });

  it('writes the statement in UTF-8', async () => {
    const { ada, grace, groupId } = await threeMembers();
    await record(ada.token, groupId, {
      description: 'Café — 5€',
      amount: 200,
      date: todayInUtc(),
      splitBetween: [ada.id, grace.id],
    });
    const response = await csvOf(grace.token, groupId, grace.id);
    expect(response.rawPayload.toString('utf8')).toContain('Café — 5€');
  });

  describe('who reads it', () => {
    it('lets any member read the CSV of any member, a former member included', async () => {
      const { ada, grace, linus, groupId } = await adaIsOwedAndPaidBack();
      // Grace's balance is 0 once she has paid Ada, so she may leave, and her statement stays.
      expect((await send(app, 'POST', `/groups/${groupId}/leave`, { token: grace.token })).statusCode).toBe(204);
      for (const reader of [ada, linus]) {
        for (const member of [ada, grace, linus]) {
          expect((await csvOf(reader.token, groupId, member.id)).statusCode).toBe(200);
        }
      }
    });

    it('answers the same CSV to every member', async () => {
      const { ada, grace, groupId } = await adaIsOwedAndPaidBack();
      expect((await csvOf(ada.token, groupId, grace.id)).body).toBe((await csvOf(grace.token, groupId, grace.id)).body);
    });

    it('answers 404 to a person who is not a member, and 401 to no token', async () => {
      const { ada, groupId } = await adaIsOwedAndPaidBack();
      const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
      const refused = await csvOf(eve.token, groupId, ada.id);
      expect(refused.statusCode).toBe(404);
      expect(refused.json().type).toBe('NotFound');
      expect((await send(app, 'GET', `/groups/${groupId}/members/${ada.id}/statement.csv`)).statusCode).toBe(401);
    });
  });
});

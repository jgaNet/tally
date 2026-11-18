import { type Application, createApplication } from '../app';
import { joinThroughInvitation, send, signedUpAccount, temporaryDatabaseUrl } from '../test-support';
import { todayInUtc } from './validation';

describe("a group's expenses", () => {
  let app: Application;
  let databaseUrl: string;

  beforeEach(async () => {
    databaseUrl = await temporaryDatabaseUrl();
    app = await createApplication({ databaseUrl });
  });

  afterEach(async () => {
    await app.stop();
  });

  const dayBefore = (day: string, days = 1): string =>
    new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

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

  async function record(token: string, groupId: string, payload: Record<string, unknown>): Promise<string> {
    const response = await send(app, 'POST', `/groups/${groupId}/expenses`, { token, payload });
    expect(response.statusCode).toBe(201);
    return response.json<{ id: string }>().id;
  }

  async function listed(token: string, groupId: string) {
    return send(app, 'GET', `/groups/${groupId}/expenses`, { token });
  }

  /** Ada owns a group with Grace in it; answers their ids and tokens. */
  async function twoMembers() {
    const ada = await signedUpAccount(app);
    const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
    const groupId = await createdGroup(ada.token);
    await joinThroughInvitation(app, ada.token, grace.token, groupId);
    return { ada, grace, groupId };
  }

  it('answers an empty list for a group with no expenses', async () => {
    const { ada, groupId } = await twoMembers();
    const response = await listed(ada.token, groupId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  it('lists the latest date first', async () => {
    const { ada, groupId } = await twoMembers();
    const today = todayInUtc();
    const older = await record(ada.token, groupId, expense({ date: dayBefore(today, 2), splitBetween: [ada.id] }));
    const newest = await record(ada.token, groupId, expense({ date: today, splitBetween: [ada.id] }));
    const middle = await record(ada.token, groupId, expense({ date: dayBefore(today), splitBetween: [ada.id] }));
    const ids = (await listed(ada.token, groupId)).json().map((e: { id: string }) => e.id);
    expect(ids).toEqual([newest, middle, older]);
  });

  it('lists, on the same date, the most recently recorded first', async () => {
    const { ada, grace, groupId } = await twoMembers();
    const date = dayBefore(todayInUtc());
    const first = await record(ada.token, groupId, expense({ date, splitBetween: [ada.id] }));
    const second = await record(grace.token, groupId, expense({ date, splitBetween: [grace.id] }));
    const third = await record(ada.token, groupId, expense({ date, splitBetween: [ada.id, grace.id] }));
    const ids = (await listed(ada.token, groupId)).json().map((e: { id: string }) => e.id);
    expect(ids).toEqual([third, second, first]);
  });

  it('does not move an expense when it is edited: the order is when it was recorded', async () => {
    const { ada, groupId } = await twoMembers();
    const date = dayBefore(todayInUtc());
    const first = await record(ada.token, groupId, expense({ date, splitBetween: [ada.id] }));
    const second = await record(ada.token, groupId, expense({ date, splitBetween: [ada.id] }));
    const edit = await send(app, 'PUT', `/expenses/${first}`, {
      token: ada.token,
      payload: { description: 'Edited', amount: 500, date, version: 1, splitBetween: [ada.id] },
    });
    expect(edit.statusCode).toBe(204);
    const ids = (await listed(ada.token, groupId)).json().map((e: { id: string }) => e.id);
    expect(ids).toEqual([second, first]);
  });

  it('leaves out a deleted expense', async () => {
    const { ada, groupId } = await twoMembers();
    const kept = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
    const deleted = await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
    expect((await send(app, 'DELETE', `/expenses/${deleted}`, { token: ada.token })).statusCode).toBe(204);
    const ids = (await listed(ada.token, groupId)).json().map((e: { id: string }) => e.id);
    expect(ids).toEqual([kept]);
  });

  it('answers each expense as GET /expenses/{id} reads it, with its shares in the order of the split', async () => {
    const { ada, grace, groupId } = await twoMembers();
    const id = await record(ada.token, groupId, expense({ amount: 1001, splitBetween: [grace.id, ada.id] }));
    const [listedOne] = (await listed(grace.token, groupId)).json();
    const read = await send(app, 'GET', `/expenses/${id}`, { token: grace.token });
    expect(listedOne).toEqual(read.json());
    expect(listedOne.shares).toEqual([
      { memberId: grace.id, amount: 501 },
      { memberId: ada.id, amount: 500 },
    ]);
  });

  it('answers the same list to every member of the group', async () => {
    const { ada, grace, groupId } = await twoMembers();
    await record(grace.token, groupId, expense({ splitBetween: [ada.id, grace.id] }));
    const forAda = await listed(ada.token, groupId);
    const forGrace = await listed(grace.token, groupId);
    expect(forGrace.json()).toEqual(forAda.json());
  });

  it('answers the same list on every read', async () => {
    const { ada, groupId } = await twoMembers();
    await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
    const first = await listed(ada.token, groupId);
    const second = await listed(ada.token, groupId);
    expect(second.json()).toEqual(first.json());
  });

  it('answers 404 to a person who is not a member, the same as a group that does not exist', async () => {
    const { ada, groupId } = await twoMembers();
    await record(ada.token, groupId, expense({ splitBetween: [ada.id] }));
    const eve = await signedUpAccount(app, { email: 'eve@example.com', name: 'Eve' });
    const refused = await listed(eve.token, groupId);
    const missing = await listed(eve.token, 'no-such-group');
    expect(refused.statusCode).toBe(404);
    expect(refused.json().type).toBe('NotFound');
    expect(refused.json()).toEqual(missing.json());
  });

  it('answers 401 to a request with no token, and to a token that proves nothing', async () => {
    const { ada, groupId } = await twoMembers();
    expect((await send(app, 'GET', `/groups/${groupId}/expenses`)).statusCode).toBe(401);
    expect((await listed('not-a-real-token', groupId)).statusCode).toBe(401);
    expect((await listed(ada.token, groupId)).statusCode).toBe(200);
  });
});

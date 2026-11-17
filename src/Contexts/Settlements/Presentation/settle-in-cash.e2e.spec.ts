import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Request 12 over HTTP: a payee records a cash payment from another member and it is counted by the balances at once; a payment
 * more than is owed is refused and changes nothing; two recorded at once keep one; a settlement is read by its group's members only.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-settle-in-cash-')), 'tally.sqlite');
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

let accountCount = 0;
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

/** A group of an owner and two members who joined, with the owner's expense of 60 split between the owner and `payer`: `payer` owes 30. */
async function groupWhereGraceOwes30() {
  const ada = await signedInPerson('Ada');
  const grace = await signedInPerson('Grace');
  const linus = await signedInPerson('Linus');
  const { id: groupId } = (
    await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'EUR' }, token: ada.token })
  ).body as { id: string };
  for (const person of [grace, linus]) {
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
  }
  await http.request('POST', `${api}/groups/${groupId}/expenses`, {
    body: { description: 'Dinner', amount: 60, date: '2020-01-15', splitBetween: [ada.id, grace.id] },
    token: ada.token,
  });
  return { ada, grace, linus, groupId };
}

const balancesOf = async (groupId: string, token: string) =>
  (
    (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as {
      memberId: string;
      balance: number;
    }[]
  ).reduce<Record<string, number>>((all, row) => ({ ...all, [row.memberId]: row.balance }), {});

describe('Settlements in cash (request 12)', () => {
  it('records a payment by its payee, counts it in the balances at once, and answers it to the group only', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const zed = await signedInPerson('Zed');

    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 30 },
      token: ada.token,
    });
    expect(recorded.status).toBe(201);
    const { id } = recorded.body as { id: string };

    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });

    const read = await http.request('GET', `${api}/settlements/${id}`, { token: grace.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({
      id,
      groupId,
      from: grace.id,
      to: ada.id,
      amount: 30,
      method: 'cash',
      status: 'paid',
      at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
      history: [{ status: 'paid', at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/) }],
    });
    expect((await http.request('GET', `${api}/settlements/${id}`, { token: zed.token })).status).toBe(404);
  });

  it('refuses a payment more than is owed, and an amount below 1, a payer who is the payee, or a body of the wrong shape', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const record = (token: string, body: unknown) =>
      http.request('POST', `${api}/groups/${groupId}/settlements/cash`, { body, token });

    const over = await record(ada.token, { from: grace.id, amount: 31 });
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ type: 'SettlementMoreThanOwed' });

    const toPayeeNotOwed = await record(linus.token, { from: grace.id, amount: 10 });
    expect(toPayeeNotOwed.status).toBe(400);
    expect(toPayeeNotOwed.body).toMatchObject({ type: 'SettlementMoreThanIsOwed' });

    expect((await record(ada.token, { from: grace.id, amount: 0 })).status).toBe(400);
    expect((await record(ada.token, { from: ada.id, amount: 1 })).status).toBe(400);
    expect((await record(ada.token, { from: grace.id })).status).toBe(400);

    expect(await balancesOf(groupId, ada.token)).toEqual({ [ada.id]: 30, [grace.id]: -30, [linus.id]: 0 });
  });

  it('refuses a recording by no one signed in, and one by someone outside the group as for a group that does not exist', async () => {
    const { ada, grace, groupId } = await groupWhereGraceOwes30();
    const zed = await signedInPerson('Zed');
    expect(
      (
        await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
          body: { from: grace.id, amount: 1 },
        })
      ).status,
    ).toBe(401);
    const outsider = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 1 },
      token: zed.token,
    });
    expect(outsider.status).toBe(404);
    expect(ada.id).toBeTruthy();
  });

  it('keeps one of two payments recorded at once, and refuses the other, the balances counting only the one kept', async () => {
    const { ada, grace, linus, groupId } = await groupWhereGraceOwes30();
    const record = () =>
      http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
        body: { from: grace.id, amount: 30 },
        token: ada.token,
      });

    const [first, second] = await Promise.all([record(), record()]);
    expect([first.status, second.status].sort()).toEqual([201, 400]);
    expect(await balancesOf(groupId, linus.token)).toEqual({ [ada.id]: 0, [grace.id]: 0, [linus.id]: 0 });
  });
});

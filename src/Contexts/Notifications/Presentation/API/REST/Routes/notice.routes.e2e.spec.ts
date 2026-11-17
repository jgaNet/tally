import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Notices, end to end (request 17): the application booted in this process on a free port, spoken to over HTTP, every
 * answer held to api/17-notices.yaml by the client. The background job runs once an hour here, so a notice that appears
 * did not wait for it. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication({ jobsIntervalSeconds: 3600 });
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
const SPENT = '2020-01-02';
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface NoticeAnswer {
  id: string;
  kind: string;
  groupId: string;
  expenseId: string;
  amount: number;
  at: string;
}

/** Signs an account up and in, and answers its token and its id. */
async function accountOf(email: string, name: string): Promise<{ token: string; id: string }> {
  await http.request('POST', '/v1/accounts', { body: { email, password: PASSWORD, name } });
  const login = await http.request('POST', '/v1/accounts/login', { body: { email, password: PASSWORD } });
  const token = (login.body as { token: string }).token;
  const me = await http.get('/v1/accounts/me', { token });
  return { token, id: (me.body as { id: string }).id };
}

/** A group founded by `owner`, which each of `others` joins by an invitation, in the order given: the group's id. */
async function groupWith(owner: { token: string }, others: { token: string }[]): Promise<string> {
  const created = await http.request('POST', '/v1/groups', {
    body: { name: 'The flat', currency: 'EUR' },
    token: owner.token,
  });
  const groupId = (created.body as { id: string }).id;
  for (const other of others) {
    const invitation = await http.request('POST', `/v1/groups/${groupId}/invitations`, { token: owner.token });
    const invitationId = (invitation.body as { id: string }).id;
    const joined = await http.request('POST', `/v1/invitations/${invitationId}/accept`, { token: other.token });
    expect(joined.status).toBe(201);
  }
  return groupId;
}

/** Records an expense paid by the holder of `token`, split equally between `between`: the expense's id. */
async function record(groupId: string, token: string, description: string, amount: number, between: string[]) {
  const answer = await http.request('POST', `/v1/groups/${groupId}/expenses`, {
    body: { description, amount, date: SPENT, splitBetween: between },
    token,
  });
  expect(answer.status).toBe(201);
  return (answer.body as { id: string }).id;
}

const noticesOf = async (token?: string) => http.get('/v1/notices', { token });

/** The notices of the holder of `token` once they number `count`, read again until then, for at most 3 seconds. */
async function noticesOnce(token: string, count: number): Promise<NoticeAnswer[]> {
  let notices: NoticeAnswer[] = [];
  for (let attempt = 0; attempt < 120; attempt++) {
    const answer = await noticesOf(token);
    expect(answer.status).toBe(200);
    notices = answer.body as NoticeAnswer[];
    if (notices.length >= count) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return notices;
}

/** A moment for any reaction still on its way to land: what has not appeared by then was not made. */
const settle = () => new Promise(resolve => setTimeout(resolve, 300));

describe('Ledger → Notifications', () => {
  it('tells each member of the split but its payer their share, within seconds, without the background job', async () => {
    const bob = await accountOf('bob.notices@example.com', 'Bob');
    const cy = await accountOf('cy.notices@example.com', 'Cy');
    const dee = await accountOf('dee.notices@example.com', 'Dee');
    const eve = await accountOf('eve.notices@example.com', 'Eve');
    const groupId = await groupWith(bob, [cy, dee, eve]);

    const pizzas = await record(groupId, bob.token, 'Pizzas', 1000, [bob.id, cy.id, dee.id]);

    const cys = await noticesOnce(cy.token, 1);
    expect(cys).toEqual([
      {
        id: expect.any(String),
        kind: 'expense',
        groupId,
        expenseId: pizzas,
        amount: 333,
        at: expect.stringMatching(ISO_INSTANT),
      },
    ]);
    expect(await noticesOnce(dee.token, 1)).toEqual([expect.objectContaining({ expenseId: pizzas, amount: 333 })]);
    await settle();
    // One per member, never two; the payer recorded it and is told nothing; Eve is not in the split.
    expect((await noticesOf(cy.token)).body).toHaveLength(1);
    expect((await noticesOf(bob.token)).body).toEqual([]);
    expect((await noticesOf(eve.token)).body).toEqual([]);
  });
});

describe('notices', () => {
  it('lists a person’s notices the most recent first, and only theirs', async () => {
    const ann = await accountOf('ann.notices@example.com', 'Ann');
    const ben = await accountOf('ben.notices@example.com', 'Ben');
    const cal = await accountOf('cal.notices@example.com', 'Cal');
    const groupId = await groupWith(ann, [ben, cal]);

    const first = await record(groupId, ann.token, 'Bread', 200, [ann.id, ben.id]);
    await noticesOnce(ben.token, 1);
    const second = await record(groupId, cal.token, 'Wine', 900, [cal.id, ben.id, ann.id]);

    const bens = await noticesOnce(ben.token, 2);
    expect(bens.map(notice => [notice.expenseId, notice.amount])).toEqual([
      [second, 300],
      [first, 100],
    ]);
    expect(bens[0].at >= bens[1].at).toBe(true);
    const anns = await noticesOnce(ann.token, 1);
    expect(anns.map(notice => notice.expenseId)).toEqual([second]);
    expect((await noticesOf(cal.token)).body).toEqual([]);
  });

  it('makes no notice of an edit or a deletion', async () => {
    const fay = await accountOf('fay.notices@example.com', 'Fay');
    const gus = await accountOf('gus.notices@example.com', 'Gus');
    const groupId = await groupWith(fay, [gus]);
    const lunch = await record(groupId, fay.token, 'Lunch', 400, [fay.id, gus.id]);
    await noticesOnce(gus.token, 1);

    const edited = await http.request('PUT', `/v1/expenses/${lunch}`, {
      body: { description: 'Lunch', amount: 600, date: SPENT, splitBetween: [fay.id, gus.id], version: 1 },
      token: fay.token,
    });
    expect(edited.status).toBe(201);
    const deleted = await http.request('DELETE', `/v1/expenses/${lunch}`, { token: fay.token });
    expect(deleted.status).toBe(201);
    await settle();

    expect(
      ((await noticesOf(gus.token)).body as NoticeAnswer[]).map(notice => [notice.expenseId, notice.amount]),
    ).toEqual([[lunch, 200]]);
    expect((await noticesOf(fay.token)).body).toEqual([]);
  });

  it('keeps a person’s notices after they leave the group', async () => {
    const hal = await accountOf('hal.notices@example.com', 'Hal');
    const ivy = await accountOf('ivy.notices@example.com', 'Ivy');
    const groupId = await groupWith(hal, [ivy]);
    const taxi = await record(groupId, hal.token, 'Taxi', 600, [hal.id, ivy.id]);
    await record(groupId, ivy.token, 'Taxi back', 600, [ivy.id, hal.id]); // Ivy's balance is 0 again
    await noticesOnce(ivy.token, 1);

    const left = await http.request('POST', `/v1/groups/${groupId}/leave`, { token: ivy.token });
    expect(left.status).toBe(201);

    const answer = await noticesOf(ivy.token);
    expect(answer.status).toBe(200);
    expect((answer.body as NoticeAnswer[]).map(notice => notice.expenseId)).toEqual([taxi]);
  });

  it('refuses a caller who is not signed in with 401', async () => {
    const answer = await noticesOf();

    expect(answer.status).toBe(401);
  });
});

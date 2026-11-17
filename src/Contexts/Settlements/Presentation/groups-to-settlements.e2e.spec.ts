import { createHmac } from 'crypto';
import { mkdtempSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Groups → Settlements (ADR 10): Settlements asks Groups who the members of a group are, in the order they joined, through its
 * `ISettlementMembers` port, over Groups' read model. Over HTTP: a group made in Groups keeps the id its request answered, and
 * Settlements finds it by that id when a member asks for its suggested settlements, a member who joined later included; to
 * anyone who is not a member the group does not exist.
 */

const SECRET = 'a shared secret for the relationship test';

/** A fake payment provider: `POST /payments` answers `201 { id, payUrl }`, and keeps what it was asked. */
let provider: Server;
let asked: { reference: string; amount: number; currency: string }[] = [];

async function startProvider(): Promise<string> {
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    // The provider knows every account asked about (request 16): a `GET /accounts/{id}` answers `200 { id }`.
    if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
      return;
    }
    let body = '';
    request.on('data', chunk => (body += chunk));
    request.on('end', () => {
      asked = [...asked, JSON.parse(body) as { reference: string; amount: number; currency: string }];
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: `pay_${asked.length}`, payUrl: `https://pay.example/${asked.length}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
}

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.PROVIDER_URL = await startProvider();
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  // The reminders of request 18: the job runs every tenth of a second, and a period is a second.
  process.env.JOBS_INTERVAL_SECONDS = '0.1';
  process.env.REMINDER_PERIOD_SECONDS = '1';
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-groups-to-settlements-')), 'tally.sqlite');
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise(resolve => provider.close(resolve));
});

let accountCount = 0;
async function signedInPerson(name: string): Promise<{ token: string; id: string }> {
  accountCount += 1;
  const email = `${name.toLowerCase()}${accountCount}@example.org`;
  const password = 'a long password';
  const created = await http.request('POST', `${api}/accounts`, { body: { email, password, name } });
  const { token } = (await http.request('POST', `${api}/accounts/login`, { body: { email, password } })).body as {
    token: string;
  };
  const id = (created.body as { id: string }).id;
  await http.request('PUT', `${api}/accounts/me/payout-account`, { body: { accountId: `acct_${id}` }, token });
  return { token, id };
}

describe('Groups → Settlements', () => {
  it('finds, by the id Groups answered, the group whose suggested settlements a member asks for, a member who joined later included', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    expect(created.status).toBe(201);
    const { id: groupId } = created.body as { id: string };

    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as { id: string };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    const second = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token })).body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${second.id}/accept`, { token: linus.token });

    // Nothing is owed yet, so every member is even: Settlements finds the group by the id, and Linus, who joined last, is a member.
    const answer = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: linus.token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([]);
  });

  it('answers a group to a non-member, and a group that is not there, as a group that does not exist', async () => {
    const ada = await signedInPerson('Ada');
    const outsider = await signedInPerson('Outsider');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    const { id: groupId } = created.body as { id: string };

    const notAMember = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, {
      token: outsider.token,
    });
    expect(notAMember.status).toBe(404);

    const notThere = await http.request('GET', `${api}/groups/no-such-group/settlements/suggested`, {
      token: ada.token,
    });
    expect(notThere.status).toBe(404);
  });
  it('asks the provider for a payment in the group Groups made, by the id it answered, in its currency, and keeps it for a member who joined later', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'CHF' },
      token: ada.token,
    });
    const { id: groupId } = created.body as { id: string };
    for (const person of [grace, linus]) {
      const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
        .body as { id: string };
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
    }
    // Grace owes Ada 30; Linus, who joined last, owes nothing.
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: '2026-03-01', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });

    const asking = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    expect(asking.status).toBe(201);
    const { id } = asking.body as { id: string };
    expect(asked.at(-1)).toEqual({ reference: id, amount: 30, currency: 'CHF', payee: `acct_${ada.id}` });

    // Settlements finds the settlement by its id, and its group by the id Groups answered.
    const read = await http.request('GET', `${api}/settlements/${id}`, { token: grace.token });
    expect(read.body).toMatchObject({ groupId, status: 'pending', method: 'provider' });

    // Linus, who joined last, is a member: he owes nothing, so he may not ask for any. A non-member gets the answer for a group that does not exist.
    const byLinus = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 1 },
      token: linus.token,
    });
    expect(byLinus.body).toMatchObject({ type: 'SettlementMoreThanOwed' });
    const outsider = await signedInPerson('Outsider');
    const notAMember = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 1 },
      token: outsider.token,
    });
    expect(notAMember.status).toBe(404);
  });

  it('refuses to refund a payment whose payer has left the group Groups made, found by the id it answered (request 15)', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Flat', currency: 'CHF' }, token: ada.token })
    ).body as { id: string };
    for (const person of [grace, linus]) {
      const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
        .body as { id: string };
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
    }
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: '2026-03-01', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    const asking = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 30 },
      token: grace.token,
    });
    const { id } = asking.body as { id: string };

    // The provider says the payment succeeded; its signed webhook is the proof.
    const webhook = {
      id: 'evt_paid',
      paymentId: `pay_${asked.length}`,
      status: 'succeeded',
      at: '2026-03-01T10:00:00Z',
    };
    const signature = createHmac('sha256', SECRET).update(JSON.stringify(webhook)).digest('hex');
    await http.request('POST', `${api}/provider/webhooks`, {
      body: webhook,
      headers: { 'content-type': 'application/json', 'provider-signature': signature },
    });

    // Grace leaves with a balance of 0 (request 9): Ada may not refund what Grace paid, as the balances of the group must still add up to 0.
    const left = await http.request('POST', `${api}/groups/${groupId}/leave`, { token: grace.token });
    expect(left.status).toBeLessThan(300);
    const refused = await http.request('POST', `${api}/settlements/${id}/refund`, { token: ada.token });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ type: 'RefundPartyNotMember' });
    expect((await http.request('GET', `${api}/settlements/${id}`, { token: ada.token })).body).toMatchObject({
      status: 'paid',
    });
  });

  it('lists, by the id Groups answered, the settlements of the group a member of it asks for, a member who joined later included (request 19)', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    expect(created.status).toBe(201);
    const { id: groupId } = created.body as { id: string };
    for (const person of [grace, linus]) {
      const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
        .body as { id: string };
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
    }
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 60, date: '2026-03-01', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    const recorded = await http.request('POST', `${api}/groups/${groupId}/settlements/cash`, {
      body: { from: grace.id, amount: 30 },
      token: ada.token,
    });
    const { id } = recorded.body as { id: string };

    // Settlements finds the group's settlements by the id Groups answered: the one recorded, with its history.
    const listed = await http.request('GET', `${api}/groups/${groupId}/settlements`, { token: linus.token });
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      expect.objectContaining({ id, groupId, history: [expect.objectContaining({ status: 'paid' })] }),
    ]);
  });
});

describe('Groups → Settlements', () => {
  it('reminds a member of the group Groups answered, once the debt Settlements reads there has lasted a period', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Reminded', currency: 'EUR' },
      token: ada.token,
    });
    const { id: groupId } = created.body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Rent', amount: 6000, date: '2026-03-01', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });

    let reminders: { groupId: string; amount: number }[] = [];
    for (let poll = 0; poll < 200 && reminders.length === 0; poll++) {
      const notices = (await http.request('GET', `${api}/notices`, { token: grace.token })).body as {
        kind: string;
        groupId: string;
        amount: number;
      }[];
      reminders = notices.filter(notice => notice.kind === 'reminder');
      if (reminders.length === 0) await new Promise(resolve => setTimeout(resolve, 50));
    }

    expect(reminders[0]).toMatchObject({ groupId, amount: 3000 });
    const members = (await http.request('GET', `${api}/groups/${groupId}/members`, { token: ada.token }))
      .body as unknown[];
    expect(members).toHaveLength(2);
  }, 30_000);
});

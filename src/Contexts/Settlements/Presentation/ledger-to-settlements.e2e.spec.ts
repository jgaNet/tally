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
 * Ledger → Settlements (ADR 10): Settlements reads the balances of a group through its `IGroupBalances` port, over Ledger's
 * balances read model. Over HTTP: an expense made in Ledger keeps the id its request answered, Ledger holds it under that id,
 * and Settlements reads the group the expense was recorded in by the group's id, the transfer the expense makes among its
 * suggested settlements. Settlements has no route keyed by an expense, so the group's id is the one it finds the thing by.
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

/** The provider's webhook about one of its payments, signed with the shared secret over the body as sent. */
const signedWebhook = (paymentId: string, status: string) => {
  const body = { id: `evt_${paymentId}`, paymentId, status, at: '2026-03-02T10:00:00Z' };
  const json = JSON.stringify(body);
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'provider-signature': createHmac('sha256', SECRET).update(json).digest('hex'),
    },
  };
};

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  process.env.PROVIDER_URL = await startProvider();
  process.env.PROVIDER_WEBHOOK_SECRET = SECRET;
  // The reminders of request 18: the job runs every tenth of a second, and a period is a second.
  process.env.JOBS_INTERVAL_SECONDS = '0.1';
  process.env.REMINDER_PERIOD_SECONDS = '1';
  process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tally-ledger-to-settlements-')), 'tally.sqlite');
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

describe('Ledger → Settlements', () => {
  it('reads the balances an expense made in Ledger gives, by the group id, and suggests the transfer that settles it', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    const { id: groupId } = created.body as { id: string };
    for (const person of [grace, linus]) {
      const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
        .body as { id: string };
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
    }

    // Ada pays 300 for the three of them: she is owed 200, and Grace and Linus each owe 100.
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: {
        description: 'Groceries',
        amount: 300,
        date: '2026-03-01',
        splitBetween: [ada.id, grace.id, linus.id],
      },
      token: ada.token,
    });
    expect(recorded.status).toBe(201);
    const { id: expenseId } = recorded.body as { id: string };

    // Ledger holds the expense under the id its request answered.
    const expense = await http.request('GET', `${api}/expenses/${expenseId}`, { token: grace.token });
    expect(expense.status).toBe(200);

    const answer = await http.request('GET', `${api}/groups/${groupId}/settlements/suggested`, { token: grace.token });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual([
      { from: grace.id, to: ada.id, amount: 100 },
      { from: linus.id, to: ada.id, amount: 100 },
    ]);
  });
  it('counts, in the balances Ledger gives the group, a payment through the provider once the provider says it succeeded', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const linus = await signedInPerson('Linus');

    const created = await http.request('POST', `${api}/groups`, {
      body: { name: 'Flat', currency: 'EUR' },
      token: ada.token,
    });
    const { id: groupId } = created.body as { id: string };
    for (const person of [grace, linus]) {
      const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
        .body as { id: string };
      await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: person.token });
    }
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Groceries', amount: 300, date: '2026-03-01', splitBetween: [ada.id, grace.id, linus.id] },
      token: ada.token,
    });
    const { id: expenseId } = recorded.body as { id: string };

    const asking = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ada.id, amount: 100 },
      token: grace.token,
    });
    expect(asking.status).toBe(201);
    const { id: settlementId } = asking.body as { id: string };

    // Waiting at the provider, the payment is not in Ledger's balances yet; Ledger still holds the expense under its id.
    expect((await http.request('GET', `${api}/expenses/${expenseId}`, { token: grace.token })).status).toBe(200);
    const before = await http.request('GET', `${api}/groups/${groupId}/balances`, { token: grace.token });
    expect(before.body).toEqual([
      { memberId: ada.id, balance: 200 },
      { memberId: grace.id, balance: -100 },
      { memberId: linus.id, balance: -100 },
    ]);

    const { body, headers } = signedWebhook(`pay_${asked.length}`, 'succeeded');
    expect((await http.request('POST', `${api}/provider/webhooks`, { body, headers })).status).toBe(204);

    expect(
      (await http.request('GET', `${api}/settlements/${settlementId}`, { token: grace.token })).body,
    ).toMatchObject({ status: 'paid' });
    const after = await http.request('GET', `${api}/groups/${groupId}/balances`, { token: grace.token });
    expect(after.body).toEqual([
      { memberId: ada.id, balance: 100 },
      { memberId: grace.id, balance: 0 },
      { memberId: linus.id, balance: -100 },
    ]);
  });
});

describe('Ledger → Settlements', () => {
  it('reminds a member of what the balances Ledger answers say they owe, once the debt Settlements reads there has lasted a period', async () => {
    const ada = await signedInPerson('Ada');
    const grace = await signedInPerson('Grace');
    const { id: groupId } = (
      await http.request('POST', `${api}/groups`, { body: { name: 'Reminded', currency: 'EUR' }, token: ada.token })
    ).body as { id: string };
    const invitation = (await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ada.token }))
      .body as {
      id: string;
    };
    await http.request('POST', `${api}/invitations/${invitation.id}/accept`, { token: grace.token });
    const recorded = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Rent', amount: 7000, date: '2026-03-01', splitBetween: [ada.id, grace.id] },
      token: ada.token,
    });
    const { id: expenseId } = recorded.body as { id: string };
    expect(expenseId).toEqual(expect.any(String));

    const balances = (await http.request('GET', `${api}/groups/${groupId}/balances`, { token: ada.token })).body as {
      memberId: string;
      balance: number;
    }[];
    const owed = -balances.find(balance => balance.memberId === grace.id)!.balance;
    expect(owed).toBe(3500);

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

    expect(reminders[0]).toMatchObject({ groupId, amount: owed });
  }, 30_000);
});

import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('deletion');

const WEBHOOK_SECRET = 'a-shared-secret-for-the-deletion';

/** The payment provider, as a server of its own: it answers a payment with a link (request 13). */
let paymentCount = 0;
let providerServer: Server;

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  providerServer = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      const url = request.url ?? '';
      if (request.method === 'POST' && url === '/payments') {
        paymentCount += 1;
        const id = `pay-${paymentCount}`;
        response.writeHead(201, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id, payUrl: `https://pay.example/${id}`, fee: 0 }));
      } else if (request.method === 'GET' && /^\/accounts\/[^/]+$/.test(url)) {
        // A payout account is known to the provider: the one a member sets is found here (request 16).
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: decodeURIComponent(url.slice('/accounts/'.length)) }));
      } else {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise<void>(resolve => providerServer.listen(0, '127.0.0.1', () => resolve()));
  process.env.PROVIDER_URL = `http://127.0.0.1:${(providerServer.address() as AddressInfo).port}`;
  process.env.PROVIDER_WEBHOOK_SECRET = WEBHOOK_SECRET;

  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise<void>(resolve => providerServer.close(() => resolve()));
  delete process.env.PROVIDER_URL;
  delete process.env.PROVIDER_WEBHOOK_SECRET;
});

const PASSWORD = 'a-good-password';
const PAST = '2026-01-15';

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

const deleteMe = (token: string) => http.request('DELETE', `${api}/accounts/me`, { token });
const members = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/members`, { token })).body as Array<{
    memberId: string;
    name: string;
  }>;
const balancesOf = async (groupId: string, token: string) =>
  (await http.request('GET', `${api}/groups/${groupId}/balances`, { token })).body as Array<{
    memberId: string;
    balance: number;
  }>;

describe('deleting an account', () => {
  it('is refused while the account owns a group with another member, and nothing changes', async () => {
    const ann = await signedIn('delete-owner-ann@example.com', 'Ann');
    const cy = await signedIn('delete-owner-cy@example.com', 'Cy');
    await groupWith(ann, [cy]);

    expect(await deleteMe(ann.token)).toMatchObject({ status: 422, body: { type: 'OwnsGroupWithMembers' } });
    expect((await http.request('GET', `${api}/accounts/me`, { token: ann.token })).status).toBe(200);
  });

  it('erases the name and the email; the account signs in no more, its token proves nothing, and its email may be used again', async () => {
    const bob = await signedIn('delete-gone-bob@example.com', 'Bob');

    expect(await deleteMe(bob.token)).toMatchObject({ status: 204 });

    expect(await http.request('GET', `${api}/accounts/me`, { token: bob.token })).toMatchObject({ status: 401 });
    expect(
      await http.request('POST', `${api}/accounts/login`, {
        body: { email: 'delete-gone-bob@example.com', password: PASSWORD },
      }),
    ).toMatchObject({ status: 401 });

    const again = await signedIn('delete-gone-bob@example.com', 'Bob, again');
    expect(again.id).not.toBe(bob.id);
  });

  it('keeps the deleted account a member, at its place and with its balance, named Deleted account; the balances still add up to 0', async () => {
    const ann = await signedIn('delete-balance-ann@example.com', 'Ann');
    const bob = await signedIn('delete-balance-bob@example.com', 'Bob');
    const cy = await signedIn('delete-balance-cy@example.com', 'Cy');
    const groupId = await groupWith(ann, [bob, cy]);
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 300, date: PAST, splitBetween: [ann.id, bob.id, cy.id] },
      token: ann.token,
    });

    expect(await deleteMe(bob.token)).toMatchObject({ status: 204 });

    const listed = await members(groupId, ann.token);
    expect(listed.map(member => member.memberId)).toEqual([ann.id, bob.id, cy.id]);
    expect(listed.find(member => member.memberId === bob.id)?.name).toBe('Deleted account');
    expect(listed.find(member => member.memberId === ann.id)?.name).toBe('Ann');

    const balances = await balancesOf(groupId, ann.token);
    expect(balances.find(balance => balance.memberId === bob.id)?.balance).toBe(-100);
    expect(balances.reduce((sum, balance) => sum + balance.balance, 0)).toBe(0);
  });

  it('puts a deleted account in no new split: the split refuses it as a member it does not know', async () => {
    const ann = await signedIn('delete-split-ann@example.com', 'Ann');
    const bob = await signedIn('delete-split-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    expect(await deleteMe(bob.token)).toMatchObject({ status: 204 });

    const refused = await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Lunch', amount: 40, date: PAST, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    expect(refused).toMatchObject({ status: 422, body: { type: 'NotAMemberInSplit' } });
  });
});

describe('Groups → Ledger', () => {
  it('reads a deleted member by the id its sign-up answered: its balance stays, and no new split names it', async () => {
    const ann = await signedIn('ledger-rel-deleted-ann@example.com', 'Ann');
    const bob = await signedIn('ledger-rel-deleted-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 200, date: PAST, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });

    expect(await deleteMe(bob.token)).toMatchObject({ status: 204 });

    expect(
      await http.request('POST', `${api}/groups/${groupId}/expenses`, {
        body: { description: 'Snack', amount: 4, date: PAST, splitBetween: [ann.id, bob.id] },
        token: ann.token,
      }),
    ).toMatchObject({ status: 422, body: { type: 'NotAMemberInSplit' } });
    const balances = await balancesOf(groupId, ann.token);
    expect(balances.find(balance => balance.memberId === bob.id)).toEqual({ memberId: bob.id, balance: -100 });
  });
});

describe('Groups → Settlements', () => {
  it('refuses, by AccountDeleted in Settlements, a provider payment to a deleted account and a netting with it, by the id its sign-up answered', async () => {
    const ann = await signedIn('settle-rel-deleted-ann@example.com', 'Ann');
    const bob = await signedIn('settle-rel-deleted-bob@example.com', 'Bob');
    const cy = await signedIn('settle-rel-deleted-cy@example.com', 'Cy');
    const groupId = await groupWith(ann, [bob, cy]);
    // Cy paid 300 for the three of them: Ann and Bob each owe Cy 100, so Bob may pay Cy.
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Hotel', amount: 300, date: PAST, splitBetween: [ann.id, bob.id, cy.id] },
      token: cy.token,
    });
    await http.request('PUT', `${api}/accounts/me/payout-account`, {
      body: { accountId: `acct-${cy.id}` },
      token: cy.token,
    });

    expect(await deleteMe(cy.token)).toMatchObject({ status: 204 });

    expect(
      await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
        body: { to: cy.id, amount: 100 },
        token: bob.token,
      }),
    ).toMatchObject({ status: 422, body: { type: 'AccountDeleted' } });
    expect(
      await http.request('POST', `${api}/nettings`, { body: { with: cy.id, currency: 'EUR' }, token: bob.token }),
    ).toMatchObject({ status: 422, body: { type: 'AccountDeleted' } });
  });
});

describe('Settlements → Groups (WaitingPayments)', () => {
  it('refuses the deletion of an account whose provider payment waits, and Settlements finds the payment by the id its sign-up answered', async () => {
    const ann = await signedIn('waiting-deletion-ann@example.com', 'Ann');
    const bob = await signedIn('waiting-deletion-bob@example.com', 'Bob');
    const groupId = await groupWith(ann, [bob]);
    await http.request('POST', `${api}/groups/${groupId}/expenses`, {
      body: { description: 'Dinner', amount: 200, date: PAST, splitBetween: [ann.id, bob.id] },
      token: ann.token,
    });
    await http.request('PUT', `${api}/accounts/me/payout-account`, {
      body: { accountId: `acct-${ann.id}` },
      token: ann.token,
    });
    const paid = await http.request('POST', `${api}/groups/${groupId}/settlements/provider`, {
      body: { to: ann.id, amount: 50 },
      token: bob.token,
    });
    expect(paid.status).toBe(201);

    expect(await deleteMe(bob.token)).toMatchObject({ status: 422, body: { type: 'AccountPaymentWaiting' } });
    expect((await http.request('GET', `${api}/accounts/me`, { token: bob.token })).status).toBe(200);
  });
});

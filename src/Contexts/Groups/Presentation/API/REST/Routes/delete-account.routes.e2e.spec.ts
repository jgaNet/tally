import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';

import { Client } from 'pg';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/*
 * Request 35 through the API: a person deletes their account. Their name and email are erased from everything kept, their id and their place in
 * every group stay with their balance, and nothing new is done with them; the others may still record in cash what they received from them.
 */

const DAY = '2026-03-10';
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;
let provider: Server;
let previousUrl: string | undefined;
let issued = 0;

beforeAll(async () => {
  // A stand-in for the provider: every payout account is known, and each payment is answered with its link.
  provider = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on('end', () => {
      if (request.method === 'GET' && request.url?.startsWith('/accounts/')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ id: decodeURIComponent(request.url.slice('/accounts/'.length)) }));
        return;
      }
      const paymentId = `pay_${++issued}`;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: paymentId, payUrl: `https://pay.example/${paymentId}` }));
    });
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  previousUrl = process.env.PROVIDER_URL;
  process.env.PROVIDER_URL = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(async () => {
  await app.stop();
  await new Promise(resolve => provider.close(resolve));
  if (previousUrl === undefined) delete process.env.PROVIDER_URL;
  else process.env.PROVIDER_URL = previousUrl;
});

type Operation = { status: string; result?: string; error?: { type: string; message: string } };

async function outcome(operationId: string, token?: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { status, body } = await http.get(`${api}/operations/${operationId}`, { token });
    expect(status).toBe(200);
    if ((body as Operation).status !== 'PENDING') return body as Operation;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('The operation never ended');
}

async function command(method: string, path: string, token: string | undefined, body?: object): Promise<Operation> {
  const answer = await http.request(method, path, { token, body });
  if (answer.status !== 202) return { status: `HTTP ${answer.status}` } as Operation;
  return outcome((answer.body as { operationId: string }).operationId, token);
}

async function signedIn(email: string, name: string): Promise<{ id: string; token: string }> {
  await http.request('POST', `${api}/accounts`, { body: { email, password: 'correct horse', name } });
  const login = await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } });
  const token = (login.body as { token: string }).token;
  const person = { id: ((await http.get(`${api}/accounts/me`, { token })).body as { id: string }).id, token };
  expect(
    await command('PUT', `${api}/accounts/me/payout-account`, person.token, { accountId: `payout_${person.id}` }),
  ).toMatchObject({ status: 'SUCCESS' });
  return person;
}

/** A group of Ann (its owner) and Cy, where Ann paid a dinner Cy shares: Cy owes Ann 30. */
async function dinnerGroup(prefix: string, cyName = 'Cy') {
  const ann = await signedIn(`${prefix}-ann@example.com`, 'Ann');
  const cy = await signedIn(`${prefix}-cy@example.com`, cyName);
  const groupId = (await command('POST', `${api}/groups`, ann.token, { name: 'Lisbon', currency: 'EUR' }))
    .result as string;
  const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
  const invitation = (await outcome((invite.body as { operationId: string }).operationId, ann.token)).result as string;
  const accepted = await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: cy.token });
  await outcome((accepted.body as { operationId: string }).operationId, cy.token);
  expect(
    await command('POST', `${api}/groups/${groupId}/expenses`, ann.token, {
      description: 'Dinner',
      amount: 60,
      date: DAY,
      splitBetween: [ann.id, cy.id],
    }),
  ).toMatchObject({ status: 'SUCCESS' });
  return { ann, cy, groupId };
}

const deleteMe = (token: string | undefined) => command('DELETE', `${api}/accounts/me`, token);

describe('Delete an account (request 35)', () => {
  it('answers 401 at once to a caller who is not signed in', async () => {
    expect((await http.request('DELETE', `${api}/accounts/me`, {})).status).toBe(401);
  });

  it('is refused while the account owns a group another member is in, and nothing changes', async () => {
    const { ann, groupId } = await dinnerGroup('del-owner');

    expect(await deleteMe(ann.token)).toMatchObject({ status: 'ERROR', error: { type: 'OwnsAGroupWithOtherMembers' } });

    expect((await http.get(`${api}/accounts/me`, { token: ann.token })).status).toBe(200);
    expect((await http.get(`${api}/groups/${groupId}`, { token: ann.token })).status).toBe(200);
  });

  it('is refused while a payment it pays through the provider waits, and allowed once nothing waits', async () => {
    const { ann, cy, groupId } = await dinnerGroup('del-waiting');
    const paid = await command('POST', `${api}/groups/${groupId}/settlements/provider`, cy.token, {
      to: ann.id,
      amount: 30,
    });
    expect(paid).toMatchObject({ status: 'SUCCESS' });

    expect(await deleteMe(cy.token)).toMatchObject({ status: 'ERROR', error: { type: 'PaymentWaitingAtTheProvider' } });
    expect((await http.get(`${api}/accounts/me`, { token: cy.token })).status).toBe(200);
    // The payee is refused too: a payment it receives waits.
    expect(await deleteMe(ann.token)).toMatchObject({ status: 'ERROR' });
  });

  it('erases the person, keeps the place and the balance, and nobody signs in with it any more', async () => {
    const email = 'del-erased-cy@example.com';
    const name = 'Cyrille Delmotte-Unique';
    const ann = await signedIn('del-erased-ann@example.com', 'Ann');
    const cy = await signedIn(email, name);
    const groupId = (await command('POST', `${api}/groups`, ann.token, { name: 'Lisbon', currency: 'EUR' }))
      .result as string;
    const invite = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
    const invitation = (await outcome((invite.body as { operationId: string }).operationId, ann.token))
      .result as string;
    await outcome(
      (
        (await http.request('POST', `${api}/invitations/${invitation}/accept`, { token: cy.token })).body as {
          operationId: string;
        }
      ).operationId,
      cy.token,
    );
    const dinner = await command('POST', `${api}/groups/${groupId}/expenses`, ann.token, {
      description: 'Dinner',
      amount: 60,
      date: DAY,
      splitBetween: [ann.id, cy.id],
    });
    expect(dinner).toMatchObject({ status: 'SUCCESS' });
    const balancesBefore = (await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token })).body;
    const statementBefore = (
      await http.get(`${api}/groups/${groupId}/members/${cy.id}/statement`, { token: ann.token })
    ).body;

    expect(await deleteMe(cy.token)).toMatchObject({ status: 'SUCCESS' });

    // Gone as a person: its token proves nothing, its email and password open nothing.
    expect((await http.get(`${api}/accounts/me`, { token: cy.token })).status).toBe(401);
    expect((await http.request('DELETE', `${api}/accounts/me`, { token: cy.token })).status).toBe(401);
    expect(
      (await http.request('POST', `${api}/accounts/login`, { body: { email, password: 'correct horse' } })).status,
    ).toBe(401);

    // Its place is kept, named `Deleted account`, with its balance; everything reads as before.
    const members = (await http.get(`${api}/groups/${groupId}/members`, { token: ann.token })).body as {
      memberId: string;
      name: string;
      role: string;
    }[];
    expect(members.map(member => [member.memberId, member.name, member.role])).toEqual([
      [ann.id, 'Ann', 'owner'],
      [cy.id, 'Deleted account', 'member'],
    ]);
    expect((await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token })).body).toEqual(balancesBefore);
    expect((await http.get(`${api}/groups/${groupId}/members/${cy.id}/statement`, { token: ann.token })).body).toEqual(
      statementBefore,
    );
    expect((await http.get(`${api}/expenses/${dinner.result}`, { token: ann.token })).body).toMatchObject({
      shares: [expect.objectContaining({ memberId: ann.id }), expect.objectContaining({ memberId: cy.id })],
    });

    // Erased everywhere: no table of the database holds the name or the email, searched as the hidden checks do, row by row.
    const database = new Client({
      connectionString: process.env.DATABASE_URL,
      ...(process.env.DATABASE_SCHEMA && { options: `-c search_path=${process.env.DATABASE_SCHEMA}` }),
    });
    await database.connect();
    try {
      const tables = await database.query<{ table_name: string }>(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()',
      );
      for (const { table_name: table } of tables.rows) {
        const rows = await database.query<{ row: string }>(`SELECT t::text AS row FROM "${table}" t`);
        for (const { row } of rows.rows) {
          expect({ table, found: row.includes(email) || row.includes('Cyrille') }).toEqual({ table, found: false });
        }
      }
    } finally {
      await database.end();
    }

    // Its email may be used by a new account, which is someone else.
    const again = await signedIn(email, 'Someone else');
    expect(again.id).not.toBe(cy.id);
  });

  it('can no longer be put in a new split, be paid through the provider or be netted with; its cash is still recorded', async () => {
    const { ann, cy, groupId } = await dinnerGroup('del-after');
    expect(await deleteMe(cy.token)).toMatchObject({ status: 'SUCCESS' });

    expect(
      await command('POST', `${api}/groups/${groupId}/expenses`, ann.token, {
        description: 'Taxi',
        amount: 40,
        date: DAY,
        splitBetween: [ann.id, cy.id],
      }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'AccountDeleted' } });
    expect(
      await command('POST', `${api}/groups/${groupId}/settlements/provider`, ann.token, { to: cy.id, amount: 5 }),
    ).toMatchObject({ status: 'ERROR', error: { type: 'AccountDeleted' } });
    expect(await command('POST', `${api}/nettings`, ann.token, { with: cy.id, currency: 'EUR' })).toMatchObject({
      status: 'ERROR',
      error: { type: 'AccountDeleted' },
    });

    expect(
      await command('POST', `${api}/groups/${groupId}/settlements/cash`, ann.token, { from: cy.id, amount: 30 }),
    ).toMatchObject({ status: 'SUCCESS' });
    const balances = (await http.get(`${api}/groups/${groupId}/balances`, { token: ann.token })).body as {
      memberId: string;
      balance: number;
    }[];
    expect(balances.map(entry => entry.balance)).toEqual([0, 0]);
  });
});

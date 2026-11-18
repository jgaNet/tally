import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient, freshDatabase } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * The notice preferences over HTTP (request 36, fragment 36): every kind is on until a person turns it off; a notice of a kind turned
 * off is not made for them from then on, and one turned on again is made; what one person turns off changes nothing for the others; a
 * person reads their own preferences only; a kind that is not one of the three is refused.
 */
let directory: string;
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const password = 'a long enough password';

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tally-preferences-'));
  const databaseUrl = await freshDatabase();
  const started = await createApplication({ databaseUrl, logger: silent });
  await started.start(0);
  app = started;
  http = apiClient(started.address);
  api = `/${started.apiPrefix}`;
  ann = await person('Ann', 'ann-preferences@example.com');
  bob = await person('Bob', 'bob-preferences@example.com');
  cy = await person('Cy', 'cy-preferences@example.com');
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

type Person = Awaited<ReturnType<typeof person>>;
let ann: Person;
let bob: Person;
let cy: Person;

const preferences = (token: string) => http.request('GET', `${api}/accounts/me/notice-preferences`, { token });
const setPreference = (token: string, kind: string, enabled: boolean) =>
  http.request('PUT', `${api}/accounts/me/notice-preferences/${kind}`, { token, body: { enabled } });

/** Reads what the test waits for, again and again, until it holds or the polls run out: a notice is made soon, not at once. */
async function eventually<T>(read: () => Promise<T>, holds: (value: T) => boolean, polls = 120): Promise<T> {
  let value = await read();
  for (let poll = 0; poll < polls && !holds(value); poll++) {
    await new Promise(resolve => setTimeout(resolve, 25));
    value = await read();
  }
  return value;
}

describe('notice preferences', () => {
  it('has every kind on for a person who has changed none, in the order the API lists them', async () => {
    const { status, body } = await preferences(ann.token);

    expect(status).toBe(200);
    expect(body).toEqual([
      { kind: 'expense', enabled: true },
      { kind: 'reminder', enabled: true },
      { kind: 'budget', enabled: true },
    ]);
  });

  it('turns a kind off and on for the caller, and answers nothing', async () => {
    expect((await setPreference(ann.token, 'reminder', false)).status).toBe(204);
    expect(((await preferences(ann.token)).body as Array<{ kind: string; enabled: boolean }>)[1]).toEqual({
      kind: 'reminder',
      enabled: false,
    });

    expect((await setPreference(ann.token, 'reminder', true)).status).toBe(204);
    expect(((await preferences(ann.token)).body as Array<{ enabled: boolean }>).every(kind => kind.enabled)).toBe(true);
  });

  it('makes no expense notice for a member who has turned them off, and makes them again once turned on', async () => {
    const created = await http.request('POST', `${api}/groups`, {
      token: ann.token,
      body: { name: 'Flat', currency: 'EUR' },
    });
    const groupId = (created.body as { id: string }).id;
    for (const who of [bob, cy]) {
      const invitation = await http.request('POST', `${api}/groups/${groupId}/invitations`, { token: ann.token });
      await http.request('POST', `${api}/invitations/${(invitation.body as { id: string }).id}/accept`, {
        token: who.token,
      });
    }
    const record = () =>
      http.request('POST', `${api}/groups/${groupId}/expenses`, {
        token: ann.token,
        body: { description: 'Bread', amount: 900, date: '2020-01-10', splitBetween: [ann.id, bob.id, cy.id] },
      });
    const listOf = async (token: string) =>
      ((await http.request('GET', `${api}/notices`, { token })).body as Array<{ groupId: string }>).filter(
        notice => notice.groupId === groupId,
      );

    expect((await setPreference(cy.token, 'expense', false)).status).toBe(204);
    await record();
    expect(
      (
        await eventually(
          () => listOf(bob.token),
          list => list.length === 1,
        )
      ).length,
    ).toBe(1);
    expect(await listOf(cy.token)).toEqual([]);

    expect((await setPreference(cy.token, 'expense', true)).status).toBe(204);
    await record();
    expect(
      (
        await eventually(
          () => listOf(cy.token),
          list => list.length === 1,
        )
      ).length,
    ).toBe(1);
  });

  it('refuses a kind that is not one of the three, and a body without enabled', async () => {
    const unknown = await setPreference(ann.token, 'weekly', false);
    expect(unknown.status).toBe(422);
    expect(unknown.body).toMatchObject({ type: 'UnknownNoticeKind' });

    const missing = await http.request('PUT', `${api}/accounts/me/notice-preferences/budget`, {
      token: ann.token,
      body: {},
    });
    expect(missing.status).toBe(400);
  });

  it('is refused to a caller who is not signed in', async () => {
    expect((await http.request('GET', `${api}/accounts/me/notice-preferences`)).status).toBe(401);
    expect(
      (await http.request('PUT', `${api}/accounts/me/notice-preferences/budget`, { body: { enabled: false } })).status,
    ).toBe(401);
  });
});

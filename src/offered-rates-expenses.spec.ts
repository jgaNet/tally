import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Application, createApplication } from './app';
import { type Database, openDatabase } from './database';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The answer a fake rates service gives to one request. */
interface RatesAnswer {
  status: number;
  body?: unknown;
  /** Waits this long before answering. */
  delayMs?: number;
}

describe('an expense in another currency, at the rate offered', () => {
  let directory: TestDirectory;
  let app: Application;
  let db: Database;
  let service: Server;
  let serviceUrl: string;
  /** The paths (with their queries) the fake rates service was asked. */
  let calls: string[];
  let answerWith: (path: string) => RatesAnswer;

  beforeEach(async () => {
    directory = testDirectory();
    calls = [];
    answerWith = () => ({ status: 200, body: { rate: '0.95' } });
    service = createServer((request, response) => {
      const path = request.url ?? '';
      calls.push(path);
      const answer = answerWith(path);
      const respond = () => {
        try {
          response.writeHead(answer.status, { 'content-type': 'application/json' });
          response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
        } catch {
          // The caller gave up on the answer already.
        }
      };
      if (answer.delayMs) setTimeout(respond, answer.delayMs);
      else respond();
    });
    await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
    serviceUrl = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    await ensureDatabase(directory.databaseUrl);
    app = await createApplication({ databaseUrl: directory.databaseUrl, ratesUrl: serviceUrl, ratesTimeoutMs: 200 });
    await app.start(0);
    // A second connection to the same file, to count what was stored.
    db = await openDatabase({ url: directory.databaseUrl });
  });

  afterEach(async () => {
    await db.close();
    await app.stop();
    await new Promise<void>(resolve => service.close(() => resolve()));
    service.closeAllConnections();
    await directory.remove();
  });

  /** Creates a euro group as `token`'s account and answers its id. */
  async function createGroup(token: string): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Trip', currency: 'EUR' } });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Makes the account of `joinerToken` a member of `groupId`, through an invitation its owner creates. */
  async function join(ownerToken: string, groupId: string, joinerToken: string): Promise<void> {
    const invitation = await send(app, 'POST', `/groups/${groupId}/invitations`, { token: ownerToken });
    const id = (invitation.body as { id: string }).id;
    const accepted = await send(app, 'POST', `/invitations/${id}/accept`, { token: joinerToken });
    if (accepted.status !== 204) throw new Error(`accept answered ${accepted.status}`);
  }

  /**
   * The body of an expense of 1000 francs on `date` (today by default), split equally between `ids`, with its rate
   * left out; `fields` override it.
   */
  function bodyOf(ids: string[], fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      description: 'Dinner',
      date: utcDay(0),
      original: { currency: 'CHF', amount: 1000 },
      splitBetween: ids,
      ...fields,
    };
  }

  /** The `original` of a body, with the rate given as `rate` (left out when `undefined`). */
  function originalAt(rate: string | undefined): Record<string, unknown> {
    return rate === undefined ? { currency: 'CHF', amount: 1000 } : { currency: 'CHF', amount: 1000, rate };
  }

  /** Records an expense in `groupId` as `token`'s account, with `body`. */
  async function record(token: string, groupId: string, body: Record<string, unknown>) {
    return send(app, 'POST', `/groups/${groupId}/expenses`, { token, body });
  }

  /** Records an expense with `body`, which must be accepted; answers its id. */
  async function recordOk(token: string, groupId: string, body: Record<string, unknown>): Promise<string> {
    const reply = await record(token, groupId, body);
    if (reply.status !== 201) throw new Error(`record answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  async function read(token: string, id: string) {
    return send(app, 'GET', `/expenses/${id}`, { token });
  }

  /** Edits the expense `id` as `token`'s account, from `version`, with `fields` replacing the valid body. */
  async function edit(token: string, id: string, fields: Record<string, unknown>, version = 1) {
    return send(app, 'PUT', `/expenses/${id}`, { token, body: { version, ...fields } });
  }

  /** How many expenses the file holds, read on the second connection. */
  async function storedExpenses(): Promise<number> {
    return ((await db.prepare('SELECT COUNT(*) AS n FROM expenses').get()) as { n: number }).n;
  }

  describe('recording', () => {
    it('records at the rate offered on the expense’s date when the rate is left out: 1000 francs at 0.95 is 950 euros', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const day = utcDay(-1);
      const reply = await record(ana.token, groupId, bodyOf([ana.id], { date: day }));
      expect(reply.status).toBe(201);
      const expense = await read(ana.token, (reply.body as { id: string }).id);
      expect(expense.body).toMatchObject({
        amount: 950,
        original: { currency: 'CHF', amount: 1000, rate: '0.95' },
      });
      expect(calls).toEqual([`/rates/CHF/EUR?date=${day}`]);
    });

    it('reads the rate offered back as the service gave it, and splits the converted amount', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token);
      await join(ana.token, groupId, ben.token);
      answerWith = () => ({ status: 200, body: { rate: '0.123456' } });
      const id = await recordOk(
        ana.token,
        groupId,
        bodyOf([ana.id, ben.id], { original: { currency: 'USD', amount: 1000 } }),
      );
      // 1000 at 0.123456 is 123.456, so 123; split between two, the payer has the 62 and the other 61.
      expect((await read(ben.token, id)).body).toMatchObject({
        amount: 123,
        original: { currency: 'USD', amount: 1000, rate: '0.123456' },
        shares: [
          { memberId: ana.id, amount: 62 },
          { memberId: ben.id, amount: 61 },
        ],
      });
    });

    it('takes a rate given within 2 % of the rate offered, as the payer states it: 0.931 and 0.969 against 0.95', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      for (const rate of ['0.931', '0.969']) {
        const reply = await record(ana.token, groupId, bodyOf([ana.id], { original: originalAt(rate) }));
        expect(reply.status).toBe(201);
        expect((await read(ana.token, (reply.body as { id: string }).id)).body).toMatchObject({
          original: { rate },
        });
      }
    });

    it('refuses a rate given more than 2 % from the rate offered, with 422 and the rule’s name, and stores nothing', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      for (const rate of ['0.93', '0.97', '0.9309', '0.9691']) {
        const reply = await record(ana.token, groupId, bodyOf([ana.id], { original: originalAt(rate) }));
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'RateDiffersFromOffered' });
      }
      expect(await storedExpenses()).toBe(0);
    });

    it('refuses a rate left out when no rate is offered for its date, with 422 and the rule’s name, and stores nothing', async () => {
      answerWith = () => ({ status: 404 });
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const reply = await record(ana.token, groupId, bodyOf([ana.id]));
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ error: 'RateIsNotOffered' });
      expect(await storedExpenses()).toBe(0);
    });

    it('refuses a rate given when no rate is offered to check it against, with 422, and stores nothing', async () => {
      answerWith = () => ({ status: 404 });
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const reply = await record(ana.token, groupId, bodyOf([ana.id], { original: originalAt('0.95') }));
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ error: 'RateIsNotOffered' });
      expect(await storedExpenses()).toBe(0);
    });

    it('refuses both a rate left out and a rate given when the service does not answer in time, with 422', async () => {
      answerWith = () => ({ status: 200, body: { rate: '0.95' }, delayMs: 1000 });
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const left = await record(ana.token, groupId, bodyOf([ana.id]));
      const given = await record(ana.token, groupId, bodyOf([ana.id], { original: originalAt('0.95') }));
      expect(left.status).toBe(422);
      expect(left.body).toMatchObject({ error: 'RateIsNotOffered' });
      expect(given.status).toBe(422);
      expect(given.body).toMatchObject({ error: 'RateIsNotOffered' });
      expect(await storedExpenses()).toBe(0);
    });

    it('takes the rate given, whatever it is, on a server with no rates service, and refuses a rate left out there', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const unconfigured = await createApplication({ databaseUrl: directory.databaseUrl, ratesUrl: '' });
      await unconfigured.start(0);
      try {
        const given = await send(unconfigured, 'POST', `/groups/${groupId}/expenses`, {
          token: ana.token,
          body: bodyOf([ana.id], { original: originalAt('5') }),
        });
        expect(given.status).toBe(201);
        expect(await read(ana.token, (given.body as { id: string }).id)).toMatchObject({
          body: { amount: 5000, original: { rate: '5' } },
        });
        const left = await send(unconfigured, 'POST', `/groups/${groupId}/expenses`, {
          token: ana.token,
          body: bodyOf([ana.id]),
        });
        expect(left.status).toBe(422);
        expect(left.body).toMatchObject({ error: 'RateIsNotOffered' });
      } finally {
        await unconfigured.stop();
      }
      expect(calls).toEqual([]);
    });

    it('does not ask the rates service for an expense in the group’s own currency', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const reply = await record(ana.token, groupId, {
        description: 'Dinner',
        amount: 900,
        date: utcDay(0),
        splitBetween: [ana.id],
      });
      expect(reply.status).toBe(201);
      expect(calls).toEqual([]);
    });

    it('refuses an invalid rate given with 422, as before, even when a rate is offered', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      for (const rate of ['0', '1e3', '']) {
        const reply = await record(ana.token, groupId, bodyOf([ana.id], { original: originalAt(rate) }));
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'RateIsInvalid' });
      }
      expect(await storedExpenses()).toBe(0);
    });
  });

  describe('editing', () => {
    it('edits with the rate left out at the rate offered on the new date, at the next version', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const first = utcDay(-2);
      const second = utcDay(-1);
      answerWith = path => ({ status: 200, body: { rate: path.endsWith(second) ? '0.9' : '0.95' } });
      const id = await recordOk(ana.token, groupId, bodyOf([ana.id], { date: first }));
      const reply = await edit(ana.token, id, bodyOf([ana.id], { date: second }));
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        version: 2,
        amount: 900,
        original: { currency: 'CHF', amount: 1000, rate: '0.9' },
      });
      expect(calls).toEqual([`/rates/CHF/EUR?date=${first}`, `/rates/CHF/EUR?date=${second}`]);
    });

    it('refuses an edit with the rate left out when no rate is offered, with 422, and keeps the expense as it was', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await recordOk(ana.token, groupId, bodyOf([ana.id], { original: originalAt('0.95') }));
      const before = await read(ana.token, id);
      answerWith = () => ({ status: 404 });
      const reply = await edit(ana.token, id, bodyOf([ana.id], { date: utcDay(-3) }));
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ error: 'RateIsNotOffered' });
      expect((await read(ana.token, id)).body).toEqual(before.body);
    });

    it('refuses an edit whose rate given differs from the rate offered by more than 2 %, and keeps the expense', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await recordOk(ana.token, groupId, bodyOf([ana.id]));
      const before = await read(ana.token, id);
      const reply = await edit(ana.token, id, bodyOf([ana.id], { original: originalAt('0.97') }));
      expect(reply.status).toBe(422);
      expect(reply.body).toMatchObject({ error: 'RateDiffersFromOffered' });
      expect((await read(ana.token, id)).body).toEqual(before.body);
    });

    it('takes an edit whose rate given is within 2 % of the rate offered for its date', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token);
      const id = await recordOk(ana.token, groupId, bodyOf([ana.id]));
      const reply = await edit(ana.token, id, bodyOf([ana.id], { original: originalAt('0.969') }));
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ version: 2, amount: 969, original: { rate: '0.969' } });
    });
  });
});

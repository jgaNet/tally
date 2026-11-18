import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Application, createApplication } from './app';
import { ensureDatabase, send, signedUpAccount, testDirectory, type TestDirectory } from './test-helpers';

/** The day `offset` days from today, in UTC, as `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

/** The answer a fake rates service gives to one request. */
interface RatesAnswer {
  status: number;
  body?: unknown;
  /** Sent as the body instead of `body`, as it is. */
  text?: string;
  /** Waits this long before answering. */
  delayMs?: number;
}

describe('the rate offered by a rates service', () => {
  let directory: TestDirectory;
  let app: Application;
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
          response.end(answer.text ?? (answer.body === undefined ? '' : JSON.stringify(answer.body)));
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
  });

  afterEach(async () => {
    await app.stop();
    await new Promise<void>(resolve => service.close(() => resolve()));
    service.closeAllConnections();
    await directory.remove();
  });

  /** Creates a group in `currency` as `token`'s account and answers its id. */
  async function createGroup(token: string, currency = 'EUR'): Promise<string> {
    const reply = await send(app, 'POST', '/groups', { token, body: { name: 'Trip', currency } });
    if (reply.status !== 201) throw new Error(`create answered ${reply.status}`);
    return (reply.body as { id: string }).id;
  }

  /** Asks the rate offered from `currency` to the group's, on `date` when given. */
  async function rateOf(token: string, groupId: string, currency: string, date?: string) {
    const query = date === undefined ? '' : `?date=${date}`;
    return send(app, 'GET', `/groups/${groupId}/rates/${currency}${query}`, { token });
  }

  describe('reading the rate offered', () => {
    it('answers the rate the service offers from the currency to the group’s on the day, asking it for that pair and day', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      const reply = await rateOf(ana.token, groupId, 'CHF', '2026-03-02');
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ currency: 'CHF', date: '2026-03-02', rate: '0.95' });
      expect(calls).toEqual(['/rates/CHF/EUR?date=2026-03-02']);
    });

    it('keeps the rate as the service gives it, the same string, with its digits as they are', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'USD');
      for (const rate of ['12.5', '0.123456', '1']) {
        answerWith = () => ({ status: 200, body: { rate } });
        expect((await rateOf(ana.token, groupId, 'GBP', utcDay(0))).body).toEqual({
          currency: 'GBP',
          date: utcDay(0),
          rate,
        });
      }
    });

    it('takes today, in UTC, as the day when the date is left out', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      const reply = await rateOf(ana.token, groupId, 'USD');
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ currency: 'USD', date: utcDay(0), rate: '0.95' });
      expect(calls).toEqual([`/rates/USD/EUR?date=${utcDay(0)}`]);
    });

    it('answers 404 when the service has no rate for the day, or answers anything but a rate', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      const answers: RatesAnswer[] = [
        { status: 404, body: { error: 'no rate' } },
        { status: 500, body: { rate: '0.95' } },
        { status: 200, text: 'not json' },
        { status: 200, body: {} },
        { status: 200, body: [] },
        { status: 200, body: { rate: 0.95 } },
        { status: 200, body: { rate: null } },
        { status: 200, body: { rate: '' } },
        { status: 200, body: { rate: 'abc' } },
        { status: 200, body: { rate: '0' } },
        { status: 200, body: { rate: '0.000000' } },
        { status: 200, body: { rate: '-1' } },
        { status: 200, body: { rate: '1e3' } },
        { status: 200, body: { rate: '1.0000001' } },
      ];
      for (const answer of answers) {
        answerWith = () => answer;
        const reply = await rateOf(ana.token, groupId, 'CHF', '2026-03-02');
        expect(reply.status).toBe(404);
        expect(reply.body).toMatchObject({ error: 'RateNotOffered' });
      }
    });

    it('answers 404 when the service does not answer within the time limit', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      answerWith = () => ({ status: 200, body: { rate: '0.95' }, delayMs: 1000 });
      const reply = await rateOf(ana.token, groupId, 'CHF', '2026-03-02');
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ error: 'RateNotOffered' });
    });

    it('answers 404 on a server started without a rates service, which asks nothing', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      const unconfigured = await createApplication({ databaseUrl: directory.databaseUrl, ratesUrl: '' });
      await unconfigured.start(0);
      try {
        const reply = await send(unconfigured, 'GET', `/groups/${groupId}/rates/CHF?date=2026-03-02`, {
          token: ana.token,
        });
        expect(reply.status).toBe(404);
        expect(reply.body).toMatchObject({ error: 'RateNotOffered' });
        expect(calls).toEqual([]);
      } finally {
        await unconfigured.stop();
      }
    });

    it('answers 404 for the group’s own currency and for a currency that is not Tally’s, without asking the service', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      for (const currency of ['EUR', 'SEK']) {
        const reply = await rateOf(ana.token, groupId, currency, '2026-03-02');
        expect(reply.status).toBe(404);
        expect(reply.body).toMatchObject({ error: 'RateNotOffered' });
      }
      expect(calls).toEqual([]);
    });

    it('answers 404 to anyone who is not a member of the group, as if it did not exist, without asking the service', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      const reply = await rateOf(ben.token, groupId, 'CHF', '2026-03-02');
      expect(reply.status).toBe(404);
      expect(reply.body).toMatchObject({ error: 'GroupNotFound' });
      expect(calls).toEqual([]);
    });

    it('refuses a request without a valid token with 401', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      const reply = await send(app, 'GET', `/groups/${groupId}/rates/CHF?date=2026-03-02`);
      expect(reply.status).toBe(401);
      expect(calls).toEqual([]);
    });

    it('refuses a date that is not a real day of the calendar with 422, without asking the service', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org' });
      const groupId = await createGroup(ana.token, 'EUR');
      for (const date of ['2026-02-30', '2026-3-2', 'yesterday', '']) {
        const reply = await rateOf(ana.token, groupId, 'CHF', date);
        expect(reply.status).toBe(422);
        expect(reply.body).toMatchObject({ error: 'DateIsInvalid' });
      }
      expect(calls).toEqual([]);
    });
  });
});

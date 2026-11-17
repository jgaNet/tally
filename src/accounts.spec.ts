import type { Application } from './app';
import { send, signedUpAccount, startApplication, testDirectory, type TestDirectory } from './test-helpers';

describe('accounts', () => {
  let directory: TestDirectory;
  let app: Application;

  beforeEach(async () => {
    directory = testDirectory();
    app = await startApplication(directory.databasePath);
  });

  afterEach(async () => {
    await app.stop();
    directory.remove();
  });

  describe('signing up', () => {
    it('creates an account and answers its id', async () => {
      const reply = await send(app, 'POST', '/accounts', {
        body: { email: 'ana@example.org', password: 'correct horse', name: 'Ana' },
      });
      expect(reply.status).toBe(201);
      expect(reply.body).toEqual({ id: expect.any(String) });
    });

    it('gives each account its own id', async () => {
      const first = await signedUpAccount(app, { email: 'ana@example.org' });
      const second = await signedUpAccount(app, { email: 'ben@example.org' });
      expect(first.id).not.toBe(second.id);
    });

    it.each(['ana', 'ana@host', 'ana @example.org', '@example.org', 'ana@.org', 'ana@example.', 'ana@ex ample.org'])(
      'refuses the email %j, which does not look like one',
      async email => {
        const reply = await send(app, 'POST', '/accounts', {
          body: { email, password: 'correct horse', name: 'Ana' },
        });
        expect(reply.status).toBe(422);
      },
    );

    it('refuses a password of fewer than 8 characters and accepts one of 8', async () => {
      const short = await send(app, 'POST', '/accounts', {
        body: { email: 'ana@example.org', password: 'sevench', name: 'Ana' },
      });
      expect(short.status).toBe(422);
      const exact = await send(app, 'POST', '/accounts', {
        body: { email: 'ana@example.org', password: 'eightchr', name: 'Ana' },
      });
      expect(exact.status).toBe(201);
    });

    it('refuses a name that is empty, only spaces, or longer than 60 characters', async () => {
      for (const name of ['', '   ', 'a'.repeat(61)]) {
        const reply = await send(app, 'POST', '/accounts', {
          body: { email: `${name.length}@example.org`, password: 'correct horse', name },
        });
        expect(reply.status).toBe(422);
      }
    });

    it('accepts a name of 1 or 60 characters', async () => {
      const one = await send(app, 'POST', '/accounts', {
        body: { email: 'one@example.org', password: 'correct horse', name: 'A' },
      });
      const sixty = await send(app, 'POST', '/accounts', {
        body: { email: 'sixty@example.org', password: 'correct horse', name: 'a'.repeat(60) },
      });
      expect(one.status).toBe(201);
      expect(sixty.status).toBe(201);
    });

    it('counts characters, not bytes or UTF-16 units', async () => {
      const reply = await send(app, 'POST', '/accounts', {
        body: { email: 'emoji@example.org', password: 'correct horse', name: '😀'.repeat(60) },
      });
      expect(reply.status).toBe(201);
    });

    it('refuses an email already used, whatever its case', async () => {
      await signedUpAccount(app, { email: 'ana@example.org' });
      const reply = await send(app, 'POST', '/accounts', {
        body: { email: 'ANA@Example.ORG', password: 'correct horse', name: 'Other' },
      });
      expect(reply.status).toBe(409);
    });

    it('refuses a body missing a field, or with a field of the wrong type, with 400', async () => {
      const bodies: unknown[] = [
        { password: 'correct horse', name: 'Ana' },
        { email: 'ana@example.org', name: 'Ana' },
        { email: 'ana@example.org', password: 'correct horse' },
        { email: 'ana@example.org', password: 12345678, name: 'Ana' },
        { email: 'ana@example.org', password: 'correct horse', name: null },
        ['not', 'an', 'object'],
      ];
      for (const body of bodies) {
        const reply = await send(app, 'POST', '/accounts', { body });
        expect(reply.status).toBe(400);
      }
    });
  });

  describe('signing in', () => {
    it('answers a token for the right email and password', async () => {
      await signedUpAccount(app, { email: 'ana@example.org' });
      const reply = await send(app, 'POST', '/accounts/login', {
        body: { email: 'ana@example.org', password: 'correct horse' },
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ token: expect.any(String) });
    });

    it('signs in whatever the case of the email', async () => {
      await signedUpAccount(app, { email: 'ana@example.org' });
      const reply = await send(app, 'POST', '/accounts/login', {
        body: { email: 'Ana@EXAMPLE.org', password: 'correct horse' },
      });
      expect(reply.status).toBe(200);
    });

    it('refuses a wrong password and an unknown email with the same answer', async () => {
      await signedUpAccount(app, { email: 'ana@example.org' });
      const wrongPassword = await send(app, 'POST', '/accounts/login', {
        body: { email: 'ana@example.org', password: 'wrong horse' },
      });
      const unknownEmail = await send(app, 'POST', '/accounts/login', {
        body: { email: 'nobody@example.org', password: 'correct horse' },
      });
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(unknownEmail.body).toEqual(wrongPassword.body);
    });

    it('refuses a login body missing a field with 400', async () => {
      const reply = await send(app, 'POST', '/accounts/login', { body: { email: 'ana@example.org' } });
      expect(reply.status).toBe(400);
    });
  });

  describe('reading my account', () => {
    it('answers the signed-in account: its id, email and name', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org', name: 'Ana' });
      const reply = await send(app, 'GET', '/accounts/me', { token: ana.token });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ id: ana.id, email: 'ana@example.org', name: 'Ana' });
    });

    it('answers the name trimmed of surrounding spaces, as the account is shown to others', async () => {
      await send(app, 'POST', '/accounts', {
        body: { email: 'spaced@example.org', password: 'correct horse', name: '  Ana  ' },
      });
      const logIn = await send(app, 'POST', '/accounts/login', {
        body: { email: 'spaced@example.org', password: 'correct horse' },
      });
      const reply = await send(app, 'GET', '/accounts/me', {
        token: (logIn.body as { token: string }).token,
      });
      expect(reply.body).toMatchObject({ name: 'Ana' });
    });

    it('answers only the caller’s own account, never another’s', async () => {
      const ana = await signedUpAccount(app, { email: 'ana@example.org', name: 'Ana' });
      const ben = await signedUpAccount(app, { email: 'ben@example.org', name: 'Ben' });
      const anaReply = await send(app, 'GET', '/accounts/me', { token: ana.token });
      const benReply = await send(app, 'GET', '/accounts/me', { token: ben.token });
      expect(anaReply.body).toMatchObject({ id: ana.id, name: 'Ana' });
      expect(benReply.body).toMatchObject({ id: ben.id, name: 'Ben' });
    });

    it('refuses a request with no token with 401', async () => {
      const reply = await send(app, 'GET', '/accounts/me');
      expect(reply.status).toBe(401);
    });

    it('refuses a token that proves nothing, or a malformed Authorization header, with 401', async () => {
      await signedUpAccount(app, { email: 'ana@example.org' });
      const unknown = await send(app, 'GET', '/accounts/me', { token: 'not-a-real-token' });
      const malformed = await send(app, 'GET', '/accounts/me', { authorization: 'Basic abc' });
      const empty = await send(app, 'GET', '/accounts/me', { authorization: 'Bearer' });
      expect(unknown.status).toBe(401);
      expect(malformed.status).toBe(401);
      expect(empty.status).toBe(401);
    });
  });
});

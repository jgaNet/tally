import { Application } from './app';
import { ada, call, startApplication, temporaryDatabase } from './test-support';

describe('accounts', () => {
  let database: ReturnType<typeof temporaryDatabase>;
  let app: Application;

  beforeEach(async () => {
    database = temporaryDatabase();
    app = await startApplication(database.path);
  });

  afterEach(async () => {
    await app.stop();
    database.remove();
  });

  const signUp = (fields: Record<string, unknown> = {}) =>
    call(app, 'POST', '/accounts', { body: { ...ada, ...fields } });

  const signIn = (fields: Record<string, unknown> = {}) =>
    call(app, 'POST', '/accounts/login', { body: { email: ada.email, password: ada.password, ...fields } });

  describe('signing up', () => {
    it('creates the account and answers its id', async () => {
      const answer = await signUp();
      expect(answer.status).toBe(201);
      expect(typeof answer.body.id).toBe('string');
    });

    it.each([
      ['no at-sign', 'ada.example.com'],
      ['nothing before the at-sign', '@example.com'],
      ['no dot after the at-sign', 'ada@example'],
      ['a space in it', 'ada @example.com'],
      ['nothing after the dot', 'ada@example.'],
    ])('refuses an email that does not look like one (%s)', async (_, email) => {
      const answer = await signUp({ email });
      expect(answer).toEqual({ status: 422, body: { type: 'InvalidEmail', message: expect.any(String) } });
    });

    it('refuses a password of fewer than 8 characters, and accepts one of exactly 8', async () => {
      expect((await signUp({ password: '1234567' })).status).toBe(422);
      expect((await signUp({ password: '12345678' })).status).toBe(201);
    });

    it('refuses a name that is empty, only spaces, or longer than 60 characters', async () => {
      expect((await signUp({ name: '' })).status).toBe(422);
      expect((await signUp({ name: '   ' })).status).toBe(422);
      expect((await signUp({ name: 'x'.repeat(61) })).status).toBe(422);
    });

    it('accepts a name of exactly 60 characters', async () => {
      expect((await signUp({ name: 'x'.repeat(60), email: 'long@example.com' })).status).toBe(201);
    });

    it('refuses an email already used by an account, whatever its case', async () => {
      await signUp();
      const answer = await signUp({ email: 'ADA@Example.com' });
      expect(answer).toEqual({ status: 409, body: { type: 'EmailTaken', message: expect.any(String) } });
    });

    it.each(['email', 'password', 'name'])('refuses a body without %s with 400', async field => {
      const body: Record<string, unknown> = { ...ada };
      delete body[field];
      expect((await call(app, 'POST', '/accounts', { body })).status).toBe(400);
    });

    it('refuses a field of the wrong type with 400, without coercing it', async () => {
      expect((await signUp({ password: 12345678 })).status).toBe(400);
      expect((await signUp({ name: 42 })).status).toBe(400);
    });
  });

  describe('signing in', () => {
    beforeEach(async () => {
      await signUp();
    });

    it('answers a token for the right email and password, in any case of the email', async () => {
      const answer = await signIn({ email: 'ADA@example.com' });
      expect(answer.status).toBe(200);
      expect(typeof answer.body.token).toBe('string');
    });

    it('refuses a wrong password and an unknown email with the same answer', async () => {
      const wrongPassword = await signIn({ password: 'not-the-password' });
      const unknownEmail = await signIn({ email: 'nobody@example.com' });
      const malformedEmail = await signIn({ email: 'not an email' });
      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(malformedEmail.status).toBe(401);
      expect(unknownEmail.body).toEqual(wrongPassword.body);
      expect(malformedEmail.body).toEqual(wrongPassword.body);
    });

    it('refuses a body without a password with 400', async () => {
      expect((await call(app, 'POST', '/accounts/login', { body: { email: ada.email } })).status).toBe(400);
    });

    it('issues a new token at each sign-in, and each token signs in', async () => {
      const first = await signIn();
      const second = await signIn();
      expect(first.body.token).not.toBe(second.body.token);
      expect((await call(app, 'GET', '/accounts/me', { token: first.body.token })).status).toBe(200);
      expect((await call(app, 'GET', '/accounts/me', { token: second.body.token })).status).toBe(200);
    });
  });

  describe('reading the signed-in account', () => {
    it('answers the account of the token, and only that one', async () => {
      const { body: grace } = await call(app, 'POST', '/accounts', {
        body: { email: 'grace@example.com', password: 'compiler-1952', name: 'Grace Hopper' },
      });
      await signUp();
      const token = (await signIn({ email: 'grace@example.com', password: 'compiler-1952' })).body.token;
      const answer = await call(app, 'GET', '/accounts/me', { token });
      expect(answer).toEqual({ status: 200, body: { id: grace.id, email: 'grace@example.com', name: 'Grace Hopper' } });
    });

    it('answers 401 without a token', async () => {
      expect((await call(app, 'GET', '/accounts/me')).status).toBe(401);
    });

    it('answers 401 for a token that proves nothing', async () => {
      expect((await call(app, 'GET', '/accounts/me', { token: 'made-up-token' })).status).toBe(401);
    });

    it('answers 401 for a header that is not a bearer token', async () => {
      const response = await fetch(`${app.address}/${app.apiPrefix}/accounts/me`, {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      });
      expect(response.status).toBe(401);
    });
  });
});

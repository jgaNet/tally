import { type Application, createApplication } from '../app';
import { send, signedUpAccount, temporaryDatabasePath, validSignup } from '../test-support';

describe('accounts', () => {
  let app: Application;

  beforeEach(async () => {
    app = await createApplication({ databasePath: temporaryDatabasePath() });
  });

  afterEach(async () => {
    await app.stop();
  });

  describe('signing up', () => {
    it('creates an account and answers its id', async () => {
      const response = await send(app, 'POST', '/accounts', { payload: validSignup });
      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ id: expect.any(String) });
    });

    it('gives each account its own id', async () => {
      const first = await send(app, 'POST', '/accounts', { payload: validSignup });
      const second = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'grace@example.com' },
      });
      expect(first.json().id).not.toBe(second.json().id);
    });

    it.each(['ada', 'ada@', '@example.com', 'ada@example', 'ada@example.', 'ada@.com', 'a da@example.com'])(
      'refuses the email %j, which does not look like one, with 422',
      async email => {
        const response = await send(app, 'POST', '/accounts', { payload: { ...validSignup, email } });
        expect(response.statusCode).toBe(422);
        expect(response.json()).toEqual({ type: 'InvalidEmail', message: expect.any(String) });
      },
    );

    it('refuses a password of 7 characters with 422, and accepts one of 8', async () => {
      const short = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'short@example.com', password: '1234567' },
      });
      expect(short.statusCode).toBe(422);
      expect(short.json().type).toBe('PasswordTooShort');

      const exact = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'exact@example.com', password: '12345678' },
      });
      expect(exact.statusCode).toBe(201);
    });

    it('accepts a name of 1 and of 60 characters, and refuses 61', async () => {
      const one = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'one@example.com', name: 'A' },
      });
      expect(one.statusCode).toBe(201);

      const sixty = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'sixty@example.com', name: 'x'.repeat(60) },
      });
      expect(sixty.statusCode).toBe(201);

      const sixtyOne = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'sixtyone@example.com', name: 'x'.repeat(61) },
      });
      expect(sixtyOne.statusCode).toBe(422);
      expect(sixtyOne.json().type).toBe('InvalidName');
    });

    it('counts a name in characters, not in UTF-16 units', async () => {
      const response = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'emoji@example.com', name: '😀'.repeat(60) },
      });
      expect(response.statusCode).toBe(201);
    });

    it('refuses a name that is only spaces with 422', async () => {
      const response = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'spaces@example.com', name: '   ' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().type).toBe('InvalidName');
    });

    it('refuses an email already used with 409, whatever its case', async () => {
      await send(app, 'POST', '/accounts', { payload: validSignup });
      const response = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'ADA@Example.com' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().type).toBe('EmailTaken');
    });

    it.each([
      ['email', { password: 'correct horse', name: 'Ada' }],
      ['password', { email: 'ada@example.com', name: 'Ada' }],
      ['name', { email: 'ada@example.com', password: 'correct horse' }],
    ])('refuses a body without its %s with 400', async (_field, payload) => {
      const response = await send(app, 'POST', '/accounts', { payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().type).toBe('InvalidBody');
    });

    it('refuses a field of the wrong type with 400, without converting it', async () => {
      const numericPassword = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'number@example.com', password: 12345678 },
      });
      expect(numericPassword.statusCode).toBe(400);

      const numericName = await send(app, 'POST', '/accounts', {
        payload: { ...validSignup, email: 'name@example.com', name: 42 },
      });
      expect(numericName.statusCode).toBe(400);
    });
  });

  describe('signing in', () => {
    beforeEach(async () => {
      await send(app, 'POST', '/accounts', { payload: validSignup });
    });

    it('answers a token for the right email and password', async () => {
      const response = await send(app, 'POST', '/accounts/login', {
        payload: { email: validSignup.email, password: validSignup.password },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ token: expect.any(String) });
    });

    it('matches the email whatever its case', async () => {
      const response = await send(app, 'POST', '/accounts/login', {
        payload: { email: 'ADA@EXAMPLE.COM', password: validSignup.password },
      });
      expect(response.statusCode).toBe(200);
    });

    it('answers the same refusal for a wrong password and for an email with no account', async () => {
      const wrongPassword = await send(app, 'POST', '/accounts/login', {
        payload: { email: validSignup.email, password: 'wrong password' },
      });
      const noAccount = await send(app, 'POST', '/accounts/login', {
        payload: { email: 'nobody@example.com', password: validSignup.password },
      });
      expect(wrongPassword.statusCode).toBe(401);
      expect(noAccount.statusCode).toBe(401);
      expect(noAccount.json()).toEqual(wrongPassword.json());
    });

    it('refuses a login without a password with 400', async () => {
      const response = await send(app, 'POST', '/accounts/login', { payload: { email: validSignup.email } });
      expect(response.statusCode).toBe(400);
    });

    it('gives a new token on each sign-in, and each token works', async () => {
      const first = await send(app, 'POST', '/accounts/login', {
        payload: { email: validSignup.email, password: validSignup.password },
      });
      const second = await send(app, 'POST', '/accounts/login', {
        payload: { email: validSignup.email, password: validSignup.password },
      });
      expect(first.json().token).not.toBe(second.json().token);
      for (const token of [first.json().token, second.json().token]) {
        expect((await send(app, 'GET', '/accounts/me', { token })).statusCode).toBe(200);
      }
    });
  });

  describe('reading the signed-in account', () => {
    it('answers the account the token belongs to', async () => {
      const { id, token } = await signedUpAccount(app);
      const response = await send(app, 'GET', '/accounts/me', { token });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ id, email: validSignup.email, name: validSignup.name });
    });

    it('answers each signed-in person only their own account', async () => {
      const ada = await signedUpAccount(app);
      const grace = await signedUpAccount(app, { email: 'grace@example.com', name: 'Grace' });
      expect((await send(app, 'GET', '/accounts/me', { token: grace.token })).json().id).toBe(grace.id);
      expect((await send(app, 'GET', '/accounts/me', { token: ada.token })).json().id).toBe(ada.id);
    });

    it('refuses a request with no token with 401', async () => {
      const response = await send(app, 'GET', '/accounts/me');
      expect(response.statusCode).toBe(401);
      expect(response.json().type).toBe('Unauthenticated');
    });

    it('refuses a token that proves nothing with 401', async () => {
      const response = await send(app, 'GET', '/accounts/me', { token: 'not-a-real-token' });
      expect(response.statusCode).toBe(401);
    });

    it('refuses a malformed Authorization header with 401', async () => {
      const { token } = await signedUpAccount(app);
      for (const authorization of [token, `Basic ${token}`, 'Bearer', 'Bearer a b']) {
        const response = await send(app, 'GET', '/accounts/me', { headers: { authorization } });
        expect(response.statusCode).toBe(401);
      }
    });

    it('does not accept a token that was never issued by a sign-in', async () => {
      const { id } = await signedUpAccount(app);
      // The account id is not a token, nor is the password.
      expect((await send(app, 'GET', '/accounts/me', { token: id })).statusCode).toBe(401);
      expect((await send(app, 'GET', '/accounts/me', { token: validSignup.password })).statusCode).toBe(401);
    });
  });
});

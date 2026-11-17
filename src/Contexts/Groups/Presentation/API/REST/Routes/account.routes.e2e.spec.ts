import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';

/**
 * Accounts, end to end: the application booted in this process on a free port, spoken to over HTTP, every
 * answer held to api/1-accounts.yaml by the client. One application per suite, shared by its tests in order.
 */
let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
beforeAll(async () => {
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
});
afterAll(() => app.stop());

const PASSWORD = 'correct horse';
const ANA = { email: 'ana@example.com', password: PASSWORD, name: 'Ana' };

const signUp = (body: unknown) => http.request('POST', '/v1/accounts', { body });
const signIn = (body: unknown) => http.request('POST', '/v1/accounts/login', { body });
const me = (token?: string) => http.get('/v1/accounts/me', { token });

describe('signing up', () => {
  it('opens an account and answers its id at once', async () => {
    const answer = await signUp(ANA);

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({ id: expect.any(String) });
  });

  it('refuses an email that does not look like one', async () => {
    const answer = await signUp({ ...ANA, email: 'not-an-email' });

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: 'InvalidEmailFormat' });
  });

  it('refuses a password of fewer than 8 characters', async () => {
    const answer = await signUp({ ...ANA, email: 'short@example.com', password: '1234567' });

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ type: 'PasswordTooShort' });
  });

  it('refuses a name that is only spaces, or longer than 60 characters', async () => {
    const blank = await signUp({ ...ANA, email: 'blank@example.com', name: '    ' });
    const long = await signUp({ ...ANA, email: 'long@example.com', name: 'x'.repeat(61) });

    expect(blank.status).toBe(400);
    expect(blank.body).toMatchObject({ type: 'InvalidAccountName' });
    expect(long.status).toBe(400);
    expect(long.body).toMatchObject({ type: 'InvalidAccountName' });
  });

  it('refuses an email an account already uses, whatever its case', async () => {
    const answer = await signUp({ ...ANA, email: 'ANA@Example.com' });

    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ type: 'EmailAlreadyRegistered' });
  });

  it('refuses a body missing a field, or with a field of the wrong type, before anything else', async () => {
    const missing = await signUp({ email: 'nameless@example.com', password: PASSWORD });
    const wrongType = await signUp({ ...ANA, email: 'number@example.com', password: 12345678 });

    expect(missing.status).toBe(400);
    expect(wrongType.status).toBe(400);
  });
});

describe('signing in', () => {
  it('answers a token for the right password, whatever the case of the email', async () => {
    const answer = await signIn({ email: ANA.email.toUpperCase(), password: PASSWORD });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ token: expect.any(String) });
  });

  it('refuses a wrong password and an email no account has with the same answer', async () => {
    const wrongPassword = await signIn({ email: ANA.email, password: 'not the password' });
    const unknownEmail = await signIn({ email: 'nobody@example.com', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });
});

describe('reading your own account', () => {
  it('reads the signed-in account, as its id, email and name', async () => {
    const { body: session } = await signIn({ email: ANA.email, password: PASSWORD });
    const answer = await me((session as { token: string }).token);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ id: expect.any(String), email: ANA.email, name: ANA.name });
  });

  it('refuses a read with no token, or with one that proves nothing', async () => {
    const anonymous = await me();
    const forged = await me('not.a-token');

    expect(anonymous.status).toBe(401);
    expect(forged.status).toBe(401);
  });
});

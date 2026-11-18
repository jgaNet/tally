import { FastifyApplication } from '@Bootstrap/Fastify/FastifyApplication';
import { apiClient } from '@Bootstrap/Fastify/api.spec-helper';
import { createApplication } from '@Bootstrap/Fastify/createApplication';
import { useFreshDatabase } from '@Bootstrap/Fastify/freshDatabase.spec-helper';

// The application keeps what it knows in the database DATABASE_URL names: this suite has a database of its own.
const database = useFreshDatabase('accounts');

let app: FastifyApplication;
let http: ReturnType<typeof apiClient>;
let api: string;

beforeAll(async () => {
  await database;
  app = await createApplication();
  await app.start(0);
  http = apiClient(app.address);
  api = `/${app.apiPrefix}`;
});
afterAll(() => app.stop());

const signUp = (body: unknown) => http.request('POST', `${api}/accounts`, { body });
const signIn = (email: string, password: string) =>
  http.request('POST', `${api}/accounts/login`, { body: { email, password } });
const ada = { email: 'ada@example.com', password: 'a-good-password', name: 'Ada' };

describe('accounts', () => {
  it('signs up: answers 201 with the new account’s id, and refuses what the domain refuses', async () => {
    const created = await signUp(ada);
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String) });

    expect(await signUp({ ...ada, email: 'ADA@example.com' })).toMatchObject({
      status: 409,
      body: { type: 'EmailAlreadyUsed' },
    });
    expect(await signUp({ ...ada, email: 'ada@example' })).toMatchObject({
      status: 422,
      body: { type: 'InvalidEmailFormat' },
    });
    expect(await signUp({ ...ada, email: 'bob@example.com', password: 'short' })).toMatchObject({
      status: 422,
      body: { type: 'PasswordTooShort' },
    });
    expect(await signUp({ ...ada, email: 'bob@example.com', name: '   ' })).toMatchObject({
      status: 422,
      body: { type: 'InvalidAccountName' },
    });
  });

  it('refuses a body whose field has the wrong type, or is missing, with 400', async () => {
    expect((await signUp({ ...ada, email: 'carol@example.com', password: 12345678 })).status).toBe(400);
    expect((await signUp({ email: 'dave@example.com', password: 'a-good-password' })).status).toBe(400);
  });

  it('signs in with the right password, and answers the same refusal for a wrong one and an unknown email', async () => {
    await signUp({ ...ada, email: 'erin@example.com' });

    const signedIn = await signIn('ERIN@example.com', 'a-good-password');
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toEqual({ token: expect.any(String) });

    const wrong = await signIn('erin@example.com', 'not-the-password');
    const unknown = await signIn('nobody@example.com', 'a-good-password');
    expect(wrong.status).toBe(401);
    expect(unknown).toEqual({ ...wrong, headers: unknown.headers });
  });

  it('answers the signed-in caller’s own account, and refuses a missing or a forged token with 401', async () => {
    const created = await signUp({ ...ada, email: 'fay@example.com', name: 'Fay' });
    const { token } = (await signIn('fay@example.com', 'a-good-password')).body as { token: string };

    expect(await http.get(`${api}/accounts/me`, { token })).toMatchObject({
      status: 200,
      body: { id: (created.body as { id: string }).id, email: 'fay@example.com', name: 'Fay' },
    });
    expect((await http.get(`${api}/accounts/me`)).status).toBe(401);
    expect((await http.get(`${api}/accounts/me`, { token: `${token.slice(0, -2)}xx` })).status).toBe(401);
  });

  it('keeps the accounts and the tokens across a restart of the application', async () => {
    await signUp({ ...ada, email: 'gus@example.com' });
    const { token } = (await signIn('gus@example.com', 'a-good-password')).body as { token: string };

    await app.stop();
    await database;
    app = await createApplication();
    await app.start(0);
    http = apiClient(app.address);

    expect((await http.get(`${api}/accounts/me`, { token })).status).toBe(200);
    expect((await signIn('gus@example.com', 'a-good-password')).status).toBe(200);
  });

  it('answers an operation that was never made with 404, for any caller', async () => {
    expect((await http.get(`${api}/operations/00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });
});

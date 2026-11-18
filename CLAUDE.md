# Working on tally (guide for AI assistance)

A TypeScript HTTP API on Fastify. Structure the code as you see fit.

## Commands

```bash
yarn verify        # what must pass: typecheck, lint, format, tests
yarn typecheck
yarn lint
yarn format        # prettier, in place
yarn test
yarn start         # the server, on $PORT (10000 by default)
```

## Where things are

- `src/app.ts` — `createApplication()` builds the application and is what the server and the tests start; every route is under `/<apiPrefix>` (`/v1`).
- `src/server.ts` — the entry point.
- `src/database.ts` — all state is in the PostgreSQL database at `DATABASE_URL` (required). Queries go through `db.rows` / `db.row` / `db.execute`; a write runs in `inTransaction`, which takes the write lock, so one writer at a time. A SQLite file of Tally's, named by `DATABASE_PATH`, is moved into an empty database on start (`src/legacy/`); the file is read only then.
- The tests make their own databases on the server `DATABASE_URL` names (`temporaryDatabaseUrl()` in `src/test-support.ts`).

Keep the code tested: every behaviour a feature brings has a test. The requests say where data is kept.

## One rule

A read never changes what is stored: a `GET` answers from what is there. What changes with time (something that
expires, lapses or falls due) is changed by a background job on its schedule, never by a read.

## The API's shapes

When a request says what the API answers, that is the shape, even where the code already answers otherwise: change
the code that projects the answer — the read model, its projection and its route's schema — and the tree's own tests
that read the old shape, never the request.

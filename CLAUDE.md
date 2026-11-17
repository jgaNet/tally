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

Keep the code tested: every behaviour a feature brings has a test. The requests say where data is kept.

## One rule

A read never changes what is stored: a `GET` answers from what is there. What changes with time (something that
expires, lapses or falls due) is changed by a background job on its schedule, never by a read.

## The API's shapes

When a request says what the API answers, that is the shape, even where the code already answers otherwise: change
the code that projects the answer — the read model, its projection and its route's schema — and the tree's own tests
that read the old shape, never the request.

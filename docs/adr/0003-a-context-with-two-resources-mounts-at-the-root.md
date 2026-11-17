# 3. A context with two resources mounts its routes at the root, each with its full path

## Context

Feature 1 gave the Groups context its accounts, mounted under `/accounts`. Feature 2 gives it its groups, which the API
answers under `/groups`. The binding says a context's routes go under its own prefix, and the reference's inventory
reads one prefix per context: the last `registerRoutes` of a context's routes. With two prefixes in Groups, the
inventory attributed the accounts' routes to `/groups` (`SignUp` read as `POST /groups`), and the conventions check
failed on the storm feature 1 had already carried.

## Decision

- A context that serves **one** resource keeps its own prefix, as before (`/notes`, the binding's example).
- A context that serves **more than one** resource mounts its routes at the API's root (`registerRoutes('/', …)`),
  and each route file writes the route's full path (`'/accounts/me'`, `'/groups/:id'`). Groups does this now, for its
  accounts and its groups. The accounts' routes change their paths only; their answers and their tests do not.
- The binding's wording says both (`conventions/typescript.yaml`, the context checklist and the Lite checklist).

## Consequences

- The routes of Ledger, which ADR 1 says serve `/groups/{id}/…` for the expenses, will be written in full as well, so
  the two contexts' routes under one resource stay readable side by side.
- A route file that writes its full path is read correctly by the inventory; a route file under a shared prefix is not.
- The inventory also credits an `X.create(` call in a use case to every aggregate of the context that has a `create`
  behaviour. Groups' creation behaviour is therefore `Group.register()`, which the rule allows
  (DOMAIN-CREATE-VS-RECONSTITUTE), and its use case calls no other `.create(`; `Group.register()` validates the raw
  name and currency itself. Account keeps `create()`.

## Alternatives

- **Accounts in a context of their own.** ADR 1 declared no fifth context for people, and this would re-storm feature 1
  for a tooling reason. Not taken.
- **Keep two prefixes.** The inventory reads them wrong, and the gate fails on the accounts' storm. Not taken.

## When to revisit

When the inventory reads a context's routes under more than one prefix; then the root mount is no longer needed.

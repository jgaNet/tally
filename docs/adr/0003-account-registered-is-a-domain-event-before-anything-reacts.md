# 3. Account is an aggregate, and AccountRegistered is a domain event before anything reacts to it

## Context

The Lite profile holds that an aggregate comes in where two commands write one thing (several-writers), and a domain
event where something reacts to it: "does not use aggregates (until several-writers, by an ADR)" and "does not use
domain-events (until reacts-to-domain-event, by an ADR): a fact nothing reacts to is not recorded." Neither trigger
fires for accounts yet: one command writes an account, and nothing reacts to its sign-up.

The storm of the accounts feature (`conventions/storms/accounts.yaml`, decided with the product's owner before the first
code) names `Account` as the aggregate of `SignUp` and `AccountRegistered` as its event, in Groups. The storm is the
session's decision, so the code carries it.

## Decision

- **`Account` is an aggregate root** (`Domain/Account/Account.ts`). Its `create()` validates the sign-up (the email
  through the shared kernel's `Email`, the password of 8 characters at least, the name of 1 to 60 characters and not only
  spaces), refuses an email already used, generates the identity (DOMAIN-IDENTITY), and records `AccountRegisteredEvent`
  with the id and the time. `fromSnapshot()` records nothing and throws on corrupted data.
- **The sign-up use case calls `Account.create` and saves the account**, then calls `publishDomainEvents()` on it: the
  event is made durable with the account and published after the commit, through the outbox (ADR 2, ADR 24). Nothing
  subscribes to it yet, so no delivery happens.
- **The Lite trigger is taken by this ADR, for these two facts only.** Groups' other aggregates and events are not
  introduced by it; each comes in by its own ADR, when its feature names it.

## Consequences

- `Account` is not a several-writers aggregate today: the `version` it carries is 0 for a new account and is not yet
  checked by a second writer. When a second command writes accounts (a name change, for instance), the optimistic check
  of CONC-OPTIMISTIC is added to the store, and the decision is recorded then.
- A fact recorded with no reaction is not an integration event, so the published language (`conventions/integration-events.yaml`)
  does not list it.
- When a context first reacts to `AccountRegistered` (checkpoint 2's Notifications, or a feature of Ledger that needs the
  account), it is declared as an integration event before the code carries it (CTX-PUBLISHED-LANGUAGE), and the context
  map gets its relationship.

## When to revisit

When the first reaction to `AccountRegistered` is written, or the first second writer of an account is.

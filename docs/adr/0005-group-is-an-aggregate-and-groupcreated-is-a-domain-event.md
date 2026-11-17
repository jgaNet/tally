# 5. Group is an aggregate, and GroupCreated is a domain event before anything reacts to it

## Context

Request 2 of Tally (groups: a name, a currency fixed for good, an owner who is the first member, and a group seen only by
its members) was stormed before the code (`conventions/storms/create-a-group.yaml`, decided with the product's owner). The
storm names `Group` as the aggregate of `CreateGroup` and `GroupCreated` as its event, in Groups, and links nothing.

The Lite profile takes the same two triggers as ADR 3 describes: an aggregate where two commands write one thing, and a
domain event where something reacts to it. Neither fires yet: one command writes a group, and nothing reacts to its
creation. ADR 3 took both triggers for accounts only, and said that each further aggregate or event comes in by its own
ADR when its feature names it. This is that ADR, for `Group` and `GroupCreated` only.

## Decision

- **`Group` is an aggregate root** (`Domain/Group/Group.ts`). Its `register()` validates the name (1 to 60 characters, not
  only spaces, through `GroupName`) and the currency (one of `EUR`, `USD`, `GBP`, `CHF`, `CAD` and `AUD`, through
  `Currency`), generates the identity (DOMAIN-IDENTITY), makes the owner its first and only member, and records
  `GroupCreatedEvent` with the group's id, its creator and the time. `fromSnapshot()` records nothing and throws on
  corrupted data. The currency is set by `register()` and no behaviour changes it, so every amount of a group is in it.
- **The creation is named `register()`, not `create()`**, which the contract also allows for a creation. The storm's
  inventory takes a behaviour by its method name in a call `X.name(`, across every aggregate of the context: `Account.create`
  would then be read as the behaviour of any `X.create(` in Groups, and `CreateGroup` was inventoried as an Account's
  command (its events included `AccountRegistered`). Naming the creation differently keeps each aggregate's behaviours
  its own. Revisit it when the inventory matches a behaviour by its aggregate.
- **Membership is a fact of the group's state, not a separate event.** `GroupCreated` says who created the group, and
  the group starts with its owner as its first member. `MemberJoined` is for the members who join later (feature 3).
- **Who sees a group is the store's answer, not a filter after the read.** `viewFor(groupId, memberId)` reads the group
  only through a membership row, so a non-member gets the same answer as an unknown id: `404`. `listFor(memberId)` reads
  the groups the account is a member of.
- **The store's order is the store's** (`listFor`): the most recently created first, and for two created in the same
  instant, the one added last first (by insertion order, so the order does not depend on the clock's resolution).
  The query never sorts.
- **Refusals**: a name or a currency the domain refuses is `422` (`InvalidGroupName`, `UnsupportedCurrency`, ADR 4). The
  transport refuses only the body's shape (`400`): the currency is a string there, and whether it is one of the six is the
  domain's to say, so the schema carries no enum. A group a caller is not a member of is `404` (`GroupNotFound`).
- **The creation is a command answered at once** (`201 { id }`), by a signed-in caller (ADR 4 and the Lite transport).

## Consequences

- `Group` is not a several-writers aggregate today: its `version` is 0 for a new group and no second writer checks it. When
  a second command writes a group (a member joins, feature 3), the optimistic check of CONC-OPTIMISTIC is added to the
  store and the decision is recorded then.
- `GroupCreated` is recorded and made durable with the group through the outbox (ADR 24), then published; nothing
  subscribes to it, so it is not an integration event and the published language does not list it.
- The membership is kept in its own table (`group_members`), so feature 3 adds rows and a fact, not a schema change to
  the group.
- **The routes of Groups are mounted at the root, each path whole.** The contract gives a context one mount, and the
  Groups context has two sets of routes, accounts (`/v1/accounts`, ADR 1) and groups (`/v1/groups`). Mounting each at its
  own prefix leaves the inventory one mount for the context, so it attributes the account routes to the groups' prefix.
  Both are mounted at `/`, with their whole paths (`/accounts/me`, `/groups/mine`): the URLs the API gives are unchanged, and
  the accounts' routes file changed its path strings only. A context with two prefixes is a reason to split it, by an ADR.

## When to revisit

When the first reaction to `GroupCreated` is written, or the first second writer of a group (a member joining, a
currency or name edit) is.

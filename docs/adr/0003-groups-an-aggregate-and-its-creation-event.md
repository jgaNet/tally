# 3. Groups: an aggregate and a domain event, brought in by this decision

## Context

Request 2 (create a group) is the second feature. Its storm (`conventions/storms/create-a-group.yaml`), decided with the
product's owner, puts the groups in Groups (ADR 1), makes `CreateGroup` a command answered at once, `GetGroup` and
`GetMyGroups` queries, and records `GroupCreated` as Groups' domain event. Its three hot spots are decided there: the
owner is the group's first member and `GroupCreated` is not a membership fact; the currency is a value of the group,
fixed at creation; and a group is read by its members only, nothing filtered after the read.

The storm names an aggregate, `Group`, and a domain event, `GroupCreated`. The Lite profile (ADR 40) does not bring
either in by default: aggregates and domain events come in "where a trigger fires, by an ADR" (as ADR 2 says for
`Account`). Neither trigger fires here:

- `reacts-to-domain-event` — nothing in Groups reacts to `GroupCreated`; Notifications, the context that will, is
  declared at checkpoint 2.
- `several-writers` — only `CreateGroup` writes a group. Joining a group (feature 3) will write the membership, and
  that is the request that may bring this trigger in.

The rules the two triggers would hold (`DOMAIN-RECORDS-EVENTS`, `DOMAIN-CREATE-VS-RECONSTITUTE`, `CONC-OPTIMISTIC`) are
therefore not held by the binding for Groups, and the code keeps to them by hand where it is cheap, as ADR 2 does.

## Decision

- **`Group` is an aggregate of Groups** (`Domain/Group/Group.ts`), extending the building blocks' `AggregateRoot`. It is
  made by `create()`, which generates its id (`Id.generate()`), and records `GroupCreated` there. It has no
  `fromSnapshot()` yet: no use case loads a group, so nothing rebuilds one; the feature that first does brings it.
- **`GroupCreated` is a domain event of Groups**, carrying the group's id, its owner's id and when it was created. It
  is published through `publishDomainEvents()` after the save, as `AccountRegistered` is. Nothing subscribes to it, so
  it is not an integration event yet.
- **The owner is the first member, written with the group.** The membership is a row of `expense_group_members`,
  inserted in the same SQLite transaction as the group. It is not a domain event (the storm's first hot spot): feature
  3 adds `MemberJoined` for the members who join later.
- **The currency is a value of the group** (`Currency`), one of the six codes the request lists, fixed by `create()`.
  No command changes it, and the group's name (`GroupName`) is 1 to 60 characters once trimmed, as an account's name.
- **Who sees a group is the store's answer.** `GetGroup` joins the group to its membership of the caller and answers
  `404` when the caller is not a member, the same answer as for a group that does not exist. `GetMyGroups` lists the
  groups the caller is a member of, the most recently created first (`created_at`, then insertion order to break ties).
- **Refusals are values**: an invalid name or currency is `400` at once, named by the rule's exception
  (`InvalidGroupName`, `InvalidCurrency`); a missing caller is `401`, from the transport, before the use case runs.

## Consequences

- Lite's aggregate and event rules are not enforced by the binding for Groups; the reviewer holds them. The binding's
  triggers are turned on when a second command writes a group (feature 3's joining, if it writes the group rather than
  its membership alone) or a context reacts to `GroupCreated`; either one brings this decision back for review.
- A group's membership is a table the queries read, not a field of the aggregate. Until feature 3 adds a command that
  writes membership, the aggregate holds only its owner's id.

## When to revisit

When a second command writes a group or its membership (feature 3, joining), or when a context reacts to `GroupCreated`,
whichever comes first.

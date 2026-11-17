# 3. Ledger asks Groups who is a member, through a read model Groups exports

## Context

Request 4 (an expense, split equally) must refuse a split with someone who is not a member of the group, and a read of an
expense must not answer a stranger. Only Groups knows who is a member now. ADR 1 decided that Ledger asks Groups through a
port it owns, `GroupMembers` (T3), and declared the relationship `planned` in the context map until the code carried it.

The building blocks' rules allow an infrastructure adapter to read another context's Domain (ports, read models), never its
Application. Groups keeps its read model (`IGroupQueries`, `MemberReadModel`) under `Application/`, so Ledger cannot import
it, and the rule's remedy for this case is that the other context's wiring exports what is needed (ARCH-WIRING).

## Decision

- **Ledger's port is `IGroupMembers`**, in `Domain/Expense/Ports`: `currentMembers(groupId)`, the account ids of the group's
  members now. It is the fact the Expense's rule needs and nothing more.
- **The adapter is Ledger's**, `GroupsMembers` in `Infrastructure`, which answers the port by reading Groups' read port,
  `IGroupMembership` (`listMemberIds(groupId)`), declared in Groups' own `Domain/Group/Ports`: a read model of member ids,
  nothing of Groups' application. Ledger's infrastructure may import another context's Domain, its ports and read models.
- **Groups' wiring exports the read side, once per kind of caller** (ADR 2): `groupMembership` for Ledger's queries, which
  read through `exclusive()` outside any transaction, and `groupMembershipInCommand` for Ledger's command, which reads the
  connection its transaction holds (an `exclusive()` read inside a command would wait for that same transaction and never
  return). Ledger's wiring imports those exports (`others.wiring`) and passes each to the adapter.
- **The relationship is carried**: `Groups → Ledger` (GroupMembers, owned-port) loses its `planned` flag in the context map.
  The other direction, `Ledger → Groups` (MemberBalances, for leaving), stays planned until request 20.
- **Ledger's query reads the membership the same way**: a member of the expense's group reads it; anyone else is answered
  not found, as for an expense that does not exist.

## Consequences

- A member who has just joined can be in a split at once: the members are read at the moment of the command, not copied.
- The read model Ledger depends on is Groups' `listMembers`, which lists every member, joined or not yet left. If Groups
  ever lists a member who may no longer be in a split (request 20's leaving), the Groups side answers the port differently
  in the same wiring; Ledger's code does not change.
- Groups' wiring now exports a read model. Another context reading Groups the same way gets it through the same export, and
  nothing else of Groups is public.

## When to revisit

When request 20 changes leaving: whether Groups publishes `MemberLeft` for Ledger (T3's alternative), and whether the balance
check (`MemberBalances`, T5) is carried, which is when `Ledger → Groups` loses its `planned` flag.

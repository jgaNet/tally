# 20. Archiving a group: Groups decides, every context asks Groups through its port, and the refusal is one shared name

## Context

Request 27: the group's owner archives a group once every member's balance is 0 and no settlement through the provider is
`pending` or `refunding`. An archived group stays archived and is read only: every request that would change something in it
is refused, by the same rule's name, and changes nothing. The background job records nothing in it. The storm
(`conventions/storms/archive-a-group.yaml`) decided the hot spots before the run.

## Decision

- **No new context and no new relationship.** The four links the storm names are the ones the map already declares: Ledger
  asks Groups for the members (GroupMembers, ADR 3), Groups asks Ledger for a balance (MemberBalances, ADR 4), Settlements asks
  Groups for the members (SettlementMembers, ADR 5), and Groups asks Settlements whether a payment waits (WaitingPayments,
  ADR 13). Each gains one answer, `isArchived`, on the port its asking side already owns.
- **Groups decides.** `Group.archive` is the only place an archive is made. It is refused for anyone but the owner
  (OnlyTheOwnerArchives), when a balance is not 0 (GroupNotSettled), and when a payment waits (PaymentWaitingAtProvider). The
  balances and the waiting payments are read by the handler, inside the command's transaction, and given to the aggregate as
  plain values (DOMAIN-NON-DETERMINISM). The archive is a fact, `GroupArchived` (the event), written once to its own table
  `group_archives`; a group without a row is open. The read model carries `archivedAt` only once there is one.
- **One refusal name, in the shared kernel.** `GroupArchived` is a class in `src/SharedKernel/Domain`, the one word every
  context agrees on. Every change refused for an archived group answers with it: Groups' join, leave, invitation and archive;
  Ledger's expense, receipt, recurring expense, budget and template commands; Settlements' cash and provider settlements and
  refunds. Each aggregate behaviour takes a plain `groupArchived` flag and refuses first; no context keeps a copy of the flag,
  so nothing changes before the group has said it is archived.
- **The background job skips an archived group.** The recurring-expense sweep asks Ledger's GroupMembers whether the group is
  archived when a day comes, and records nothing in it: the day is not recorded and is not a refusal to anyone.
- **Reads are unchanged.** Members read an archived group as before, and it stays among their groups.

## Consequences

- An archived group's `GroupArchived` refusal is the same answer everywhere, so a client need not know which context refused.
- A context that forgets to ask `isArchived` lets a change through: the e2e scenario for archiving covers every refused request
  so that such a gap fails a test, not a user.
- The shared kernel now holds one refusal. It is a word, not a behaviour: the rule itself stays where it is decided.

## When to revisit

When a group must be reopened (the decision is then a new fact, not an undo, and the refusal list changes with it), or when the
background job needs to say why it skipped a group (a log, not a refusal).

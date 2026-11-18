# 30. A merge moves the expenses and the settlements by one fact, and the people stay in Groups

## Context

Checkpoint 4's requests (merging groups, netting across groups, contesting a settlement, suspending a member, deleting
an account, notice preferences, spending insights, the provider's fee, settling in another currency, and an unannounced
change) were stormed before request 31. The session decided whether people become a context of their own, how a merge
moves what two other contexts hold, how a netting over several books stays all or nothing, where a contest and the
administrators' log live, how "erased everywhere" is held, who bears the fee, who asks for a settlement's rate, and
what is declared of request 40 (the session's T21 to T28).

## Decision

- **No new context** (T21): accounts stay in Groups, as checkpoint 1 decided; a suspension and a deletion are two
  behaviours of the `Account`, and the other contexts ask through the ports they own whether an account is suspended or
  deleted. An administrator is a role of the caller, given at sign-in to an account whose email is in `ADMIN_EMAILS`.
- **A merge is one fact, `GroupsMerged`, an integration event Groups publishes** (T22), consumed by Ledger and by
  Settlements, each moving its own in a reaction of its own. Two relationships are declared `planned` at this session,
  Groups → Ledger and Groups → Settlements over that event, beside the owned ports already on those pairs. A port
  cannot carry a move; a merge decided in Ledger would move the expenses before the members.
- **A netting is a domain service of Settlements** (T23), `NetDebts`, deciding over the books the two people share and
  saving them in one transaction, each with its optimistic check: all or nothing.
- **A contest is decided in the `SettlementBook`** (T24); a contested settlement waits and does not count. The
  administrators' log is each context's own entries, written with the decision, Groups answering it with Settlements'
  through a port it owns (`AdministratorDecisions`).
- **Groups alone holds a name and an email** (T25) and scrubs, in the deletion's transaction, its own stored facts that
  carry them; the id stays, opaque.
- **The fee policy is on the `SettlementBook`** (T26), the fee a value the provider answers through `PaymentProvider`;
  Ledger reads what a settlement settles, never the fee.
- **Settlements asks the rates service through a port it owns** (T27), `SettlementRates`, over the same outside service
  as Ledger's `OfferedRates`: two adapters, no relationship between the two contexts.
- **Nothing of request 40 is declared** (T28), as for requests 10, 20 and 30.

## Consequences

- A member's balance after a merge is the sum of the two reactions once both have run, within a few seconds; the zero
  sum holds throughout, by construction.
- `AccountSuspended`, like `GroupArchived`, is one rule decided by the `Account` and asked through each context's port;
  no context keeps a copy of the flag.

## When to revisit

If a later campaign brings sign-in by a provider or roles of its own: T21's alternative, an Accounts context, becomes
worth its three ports.

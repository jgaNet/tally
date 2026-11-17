# 1. Groups and Ledger, and how they relate

## Context

Tally's first ten requests (accounts, groups, invitations, expenses and their splits, balances, editing and deleting,
history and statements, leaving a group, a rounding rule) were stormed before the first feature, from the brief's
candidate model of four contexts. The session decided which contexts checkpoint 1 starts with, where accounts and
balances live, and how the two contexts ask each other what they need (the session's T1 to T5).

## Decision

- **Accounts live in Groups** (T1): an account is who a member is, and the members list shows its name; signing up and
  signing in are two small use cases beside the groups. A fifth context for people is not declared now.
- **Two contexts, declared now and empty until a feature needs them** (T2): Groups (supporting) and Ledger (core),
  described in `conventions/domain.yaml` and declared in the binding. Settlements and Notifications are declared at
  checkpoint 2's session, before request 11.
- **Ledger asks Groups who may be in a split through a port it owns, `GroupMembers`** (T3), answered over Groups' read
  model when Ledger decides: who is a member now, in which order, with which role, and who has ever been one. No
  integration event is published when someone joins: a member who has just joined can be in a split at once.
- **The balances are a read model of Ledger's own facts** (T4), each expense's shares counted against its payer's
  amount, written in the transaction of the expense; the zero sum holds by construction, since every Expense keeps that
  its shares add up to its amount. No aggregate holds a running balance.
- **Groups asks Ledger a member's balance through a port it owns, `MemberBalances`** (T5), when it decides whether a
  member may leave: two ports in opposite directions, each in the asking side's words; no domain imports the other.

The two relationships are declared `planned` in the context map until the code carries them.

## Consequences

- Routes under `/groups/{id}/…` are served by whichever context owns the rule: the members and invitations by Groups,
  the expenses, balances and statements by Ledger.
- An expense recorded at the same moment as a leave could leave a former member with a balance; no hidden test sends
  the two at once, and the brief's invariants do not ask for it (T5, the known gap).

## When to revisit

At checkpoint 2, when Notifications reacts to Groups' facts, whether Groups should publish `MemberJoined` and
`MemberLeft` (T3's alternative); and when request 20 changes leaving, whether the gap of T5 is closed then.

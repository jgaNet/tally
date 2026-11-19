# 26. Deleting an account, and what stays of it

Status: accepted (request 35)

## Context

A person may delete their own account. Their name and their email are erased from everything Tally keeps; their id stays
where it is (the groups' members, the expenses, the settlements, the audit, the administrators' log) and means no one any
more. In every group they were a member of they stay a member, at their place, with their role and their balance, so that the
balances still add up to 0. Nothing else changes for the others.

## Decision

- **Where a deletion is decided.** On the `Account` in Groups: `delete()` refuses while the account owns a group that has
  another member (`AccountOwnsAGroupWithMembers`, a fact of Groups' own repository) or while a settlement it pays or receives
  through the provider is pending, refunding or contested (`PaymentWaitingAtProvider`, asked of Settlements through the
  `WaitingPayments` port Groups already owns, now also account-wide). It records `AccountDeleted`. Nothing changes when it is
  refused, and an account already deleted changes nothing.
- **What is erased.** The account's row keeps its id and a `deleted_at` moment; its email becomes null (so a new account may use
  it), its name `Deleted account` (which is what the members' list reads, the join on the account is unchanged) and its password
  hash empty. In the same transaction the facts Groups kept of the person are scrubbed: `AccountRegistered` still waiting in the
  outbox loses its email and its name. The operations record no payload, and no other context keeps a copy of a name or an
  email, only ids; the audit and the administrators' log keep the id, an opaque one.
- **Tokens.** A token is stateless, so the transport asks Groups whether the account it names is deleted and stays anonymous
  when it is: a token of a deleted account proves nothing, and signing in with its email finds no account.
- **How the others ask.** Ledger and Settlements ask Groups through the ports they already own (`GroupMembers`,
  `SettlementMembers`), with `deletedAmong` / `isDeleted`, answered over Groups' read side, and refuse with the one name
  `AccountDeleted` of the shared kernel, as `AccountSuspended` is: a new expense, edit that adds one, or recurring expense with a
  deleted account in its split; a payment through the provider to one; a netting with one. A cash settlement is not refused: the
  others may record a payment they received from it, so that the group is brought back to even.
- **Recurring expenses end.** The job gives the day the members without the deleted accounts, so a recurring expense it pays or is
  in the split of ends on its next day, as when a member has left (request 23).
- **Tally tells it nothing.** Ledger leaves it out of the members `BudgetPassed` carries, and Settlements out of the debts
  Notifications sweeps (`OutstandingDebts`). No relationship is added: the three links were already declared in the context map.

## Consequences

- A deleted account is read as deleted by every context from Groups' read side, so a deletion decided in a command's transaction
  is seen by the commands that run after it.
- Nothing is copied: no other context holds a flag that could fall out of step.
- A person who deleted an account is not a person who can be reinstated: an administrator's suspension of a deleted account
  changes nothing visible.

# 33. Deleting an account: Groups erases its name and email and keeps its id, each context refuses a deleted account by its port

## Context

Request 35 (`api/35-delete-an-account.yaml`) lets a signed-in person delete their own account. The deletion is refused while they own a group with
another member (a group would be left without the people in it), and while a payment of theirs through the provider is pending, refunding or
contested in one of their groups (requests 13, 15 and 33). Once deleted, nobody signs in with its email and password, and its token proves nothing;
its email may be used by a new account, which is someone else. Its name and its email are erased from everything Tally keeps, but its id stays where
it is: in the groups' members, the expenses' payers and shares, the settlements, the audit (request 28) and the administrators' log (request 33).
In every group it was in, it stays a member, at its place, with its role and its balance, so the balances still add up to 0; the members list names it
`Deleted account`. Nothing it did changes, and nothing can be done to it any more: it is in no new split, it is paid through the provider by no one,
and it is netted with by no one. A recurring expense it pays, or is in the split of, ends on its next day, as when a member has left (request 23), and
Tally tells it nothing any more. A payment in cash it received from others stays recordable, so that a group can be brought back to even (request 12).

The storm (`conventions/storms/delete-an-account.yaml`) decided where the name and the email live (Groups only: the Account holds them, and no other context
keeps a copy), that the id is kept where it is (the audit and the administrators' log are opaque ids), and which relationships carry the refusals: the
three the context map already declares, Groups to Ledger (`GroupMembers`), Groups to Settlements (`SettlementMembers`) and Settlements to Groups
(`WaitingPayments`). No context and no relationship is added.

## Decision

**Groups decides a deletion on the Account and erases it there.** `decideDeleteAccount` is a pure decision over the account, whether it owns a group
with another member, and whether a payment of its waits in one of its groups; the use case reads those in its transaction and refuses with
`OwnsGroupWithMembers` or `AccountPaymentWaiting`, changing nothing. Otherwise `Account.delete` erases the account and records `AccountDeleted`, which is
published after the save. The erasure is a tombstone, not a removal: the row keeps the id, and its email becomes one only that id makes, in the
reserved `.invalid` domain (so the unique email index still holds, and the email is free for someone else), its name becomes `Deleted account` (the one
name every group shows it by), and its password hash becomes one no password matches, so nobody signs in with it. The sign-in finds no account by the
erased email, and a token whose account is deleted is refused by the token check, which every request makes. Account rows are the only place Groups keeps
the name and the email: the outbox carries an account's registration as its id and its time only, the administrators' log and the members' rows keep ids.
The deletion is saved at the version it was read at, as a suspension is (CONC-OPTIMISTIC, ADR 32).

**Every other context asks Groups through the port it owns, and refuses by the shared kernel's name.** `AccountDeleted` is the one word of the shared kernel
(`AccountDeletedException`), as `AccountSuspended` is (ADR 32). Ledger asks `deletedOf` through `GroupMembers`: a new expense, a recurring expense, or a
change of either whose split holds a deleted account is refused (`anyDeletedOf` asks each account once); the background job ends a recurring expense whose
payer or split holds a deleted account, and the day handler records nothing for one that became deleted after the sweep; the budget notice's members
leave a deleted account out. Settlements asks `deletedOf` through `SettlementMembers`: a payment through the provider between a deleted payer or payee is
refused, a netting with a deleted member is refused, and the outstanding debts that reminders are made from leave a deleted member out. A cash settlement
is recorded by its payee, who is signed in, so it is refused for no deleted account: the payer may be one, which is what lets a group come to even.

**The answers of the API.** The deletion answers `204` when it is made, as the suspension does. Its refusals are the names above, at once. The token of a deleted
account answers `401` (the caller is anonymous), and the sign-in with its old email and password is refused as an unknown email is.

## Consequences

- Groups' own table `accounts` gains `deleted_at`, and a deletion writes the erased email, name and password hash in place of the ones it had.
- The members list of a group reads `Deleted account` with no change to its projection: the name of the account is that label after the deletion.
- Ledger and Settlements each gain one method on the port they own (`deletedOf`), and each decision one refusal (`AccountDeleted`) with a flag its use case
  reads through the port. Notifications is told nothing new, and no relationship is added to the context map; the three declared relationships each gain
  the text of request 35.
- The deletion is not an integration event: nothing reacts to `AccountDeleted` outside Groups, since every context asks Groups through its port (as for
  `AccountSuspended`, ADR 32).
- A deleted account's expense, settlement and audit history reads as before, with the id in place of a name, and the balances keep adding up to 0.
- The check that refuses a deletion whose payment waits is a read of each group the account is in, in the deletion's transaction. A payment that starts
  after that read, between two servers, is not refused by it; a payment through the provider is refused once the account is deleted, which is the
  guarantee the storm asked for.

## Rejected alternatives

- **Removing the account row.** The members, expenses, settlements, audit and administrators' log name the id; a removed row would leave them naming no one
  and make the id unsafe to show, and the email would then be free only by a second rule. A tombstone keeps every fact as it is.
- **Making the account leave its groups.** A balance is a member's: leaving passes it to the owner (request 20), which request 35 does not ask. The member
  stays, anonymous, with its balance.
- **A `deleted` flag in every context's own table.** Each context would then keep a copy of a fact Groups owns. Asking Groups through the port each context
  already owns keeps the fact in one place (CTX-CONTRACTS).

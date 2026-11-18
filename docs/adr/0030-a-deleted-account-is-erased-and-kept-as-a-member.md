# 30. A deleted account is erased and kept as a member: Groups decides the deletion, and the others ask Groups whether an account is deleted

## Context

Request 35 of Tally (a signed-in person deletes their own account; it is refused while they own a group that has another member, and while a
payment through the provider they pay or receive is pending, refunding or contested; afterwards nobody signs in with its email and password, its
token proves nothing and its email may be used by a new account; its name and email are erased, its id stays where it is; in every group it was in
it stays a member, at its place, with its balance, named `Deleted account`; it can be in no new split, be paid through the provider or be netted
with; its recurring expenses end on their day, as when a member has left; a cash payment it receives is still recorded) was stormed before the code
(`conventions/storms/delete-an-account.yaml`, decided with the product's owner).

It follows the suspension (ADR 29): one rule's name in the shared kernel, decided by Groups, asked by each context through the port it owns. No
context and no relationship are new. The links the storm needs are declared and carried: Settlements → Groups (`WaitingPayments`), Groups → Ledger
(`GroupMembers`) and Groups → Settlements (`SettlementMembers`). Each of the last two gains one answer, `isDeleted(accountId)`, and the first gains
`hasPaymentWaitingOf(accountId)`, a question across every group rather than one.

## Decision

- **Groups decides, and the deletion is on the account.** `DeleteAccount` is answered at once (`DELETE /v1/accounts/me`, `204`), by the signed-in
  person for themselves; a missing caller is `401` before anything runs, as for every command. The account reads, in the same transaction, the two
  facts it is decided by: whether it owns a group with another member (`IGroupStore.ownsGroupWithOthers`, a merged group not counting), and whether a
  payment it pays or receives through the provider waits (`IWaitingPayments.hasPaymentWaitingOf`, over Settlements' read model: pending, refunding
  or contested, in any group). `Account.delete(reading, now)` refuses with `409` (`OwnedGroupHasMembers`, `PaymentWaiting`) and changes nothing, or
  erases the email, the name and the password, records `AccountDeleted`, and is saved at its version (CONC-OPTIMISTIC).
- **The account keeps its id and nothing else of the person.** The `accounts` row stays, with `deleted_at` set and its email, name and password
  NULL: the email is free for a new account (the unique index allows many NULLs), and no lookup finds a deleted account (`find`, `view`,
  `credentialsOf`, `emailTaken`). The columns that were NOT NULL are made nullable by `ALTER ... DROP NOT NULL`, which a database made before this
  feature gets as well. The id stays in the groups' members, the expenses' payers and shares, the settlements, the audit and the administrators'
  log, which name it and nothing more.
- **Nothing else of the person is kept.** The storm expected the outbox's `AccountRegistered` and the operations of a sign-up to hold the name
  and the email. They do not: the outbox stores each fact's name and payload, and `AccountRegistered` carries `{ accountId, at }`, while operations
  are not stored (there is no tracker context in this application). So the deletion erases the one row, and no other table gets a scrub.
- **A deleted account signs in to nothing, and its token proves nothing.** `signIn` finds no credentials, and the transport's authentication
  (`authenticateWith`) names no caller for a token whose account is deleted, so every route it answers is `401` to it.
- **The members list names it, and its balance stays.** `getGroupMembers` reads each member's name through `IAccountStore.memberName`, which answers
  `Deleted account` for a deleted account. A deleted member is still a member in every read of the group (`membersOf`, the balances, the statements,
  the expenses), so the balances still add up to 0. Nothing passes to the owner: leaving is a different request (ADR 15).
- **One rule's name is a word of the shared kernel.** `AccountDeletedException` and `ACCOUNT_DELETED` live in `src/SharedKernel/Domain/AccountDeleted.ts`,
  the type `AccountDeleted`, `422` (ADR 4), named once for every context that refuses by it.
- **Each context asks Groups through the port it owns, and the use case refuses.** Groups' `IGroupRoster` gains `isDeleted(accountId)`, answered
  from the account's row; Ledger's `IGroupMembers` and Settlements' `ISettlementMembers` gain the same answer over it. The use case asks it and
  refuses by name before it writes:
  - Ledger refuses a new expense, and an edit that adds a deleted account to a split, and a new recurring expense, whose split names one
    (`AccountDeleted`, `422`). A recurring expense whose payer or split member is deleted ends on its next day: the sweep reads the group's members
    without the deleted ones (`liveMembersOf`), exactly as for a member who has left (ADR 18). A month's budget notice (`BudgetPassed`) is judged
    over the same live members, so a deleted account is told nothing and is not in the published members.
  - Settlements refuses a payment through the provider to a deleted payee, and a netting with one (`AccountDeleted`, `422`), before the book or the
    provider is asked. A cash settlement is still recorded: it is recorded by its payee, who is the caller and is never deleted, and it may name a
    deleted payer. The outstanding debts that Notifications reminds of skip a deleted account, so it is not reminded.
- **Notifications is told nothing new.** No integration event carries the deletion; the debts it asks Settlements for and the budget event it reacts
  to are the ones above, filtered.
- **The deletion is a domain event with no subscriber.** `AccountDeleted` is made durable with the account and published after the commit, as
  AccountSuspended is; nothing reacts to it, since each context asks Groups through its port.

## Consequences

- No new context, no new link and no new integration event: the storm's three links were already declared, and each context's port gains one answer.
  The context map and the published language are unchanged.
- A deleted account's id keeps meaning a person in the audit and the administrators' log, which record what they did; the name is never shown
  again, and no one can act as them.
- The members list reads `Deleted account` from the account's row, not from a copy: nothing else in Tally holds a name of the person.

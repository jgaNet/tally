# 23. Groups deletes an account and keeps its balances, and every context refuses by one rule (no new context, no new relationship)

## Context

Request 35 lets a person delete their own account, so that they leave no trace: no sign-in, no token that proves them, their name and
email erased from what Tally keeps, while the groups they were in still add up. The storm `delete-an-account` decided four hot spots with
the product's owner: who decides a deletion and what it refuses, where the name and email are erased, why a deleted account stays a
member, and what can no longer happen to it. This ADR records what the storm left to the code. The three links it needs already exist
(Settlements → Groups through WaitingPayments, Groups → Ledger through GroupMembers, Groups → Settlements through SettlementMembers), so no
context and no relationship is added.

## Decision

- **Groups decides the deletion.** `Account.delete` is the behaviour that records `AccountDeleted`. The handler reads, in its transaction,
  the two facts the rule needs: whether the account owns a group that has another member (`IGroupRepository.hasOwnedGroupWithOtherMembers`,
  a fact about the collection), and whether a payment through the provider it pays or receives is pending, refunding or contested, in any
  group (`IWaitingPayments.hasOpenPaymentOf`, answered by Settlements' read model). Either refuses the deletion by a failed Result (`409`,
  `OwnsGroupWithMembers` or `PaymentWaiting`), and nothing changes. The route is `DELETE /v1/accounts/me`, answered at once like a leave.
- **The erasure.** In one transaction the account row keeps its id and its deletion time, loses its email (the column becomes nullable, so
  a new account may use the email), has its password hash emptied, and takes the name `Deleted account`. The repository erases the name and
  the email wherever Groups' stored facts hold them: the outbox's entries and the operation records that name the account by its id, a whole
  value only (`eraseFactsOf`). The audit and the administrators' log keep the id, which is what they always held.
- **A deleted account is nobody.** Sign-in finds no account by its email; a token proves an account only while the account exists, so the
  bearer check leaves a deleted caller anonymous, and the routes that need a caller answer `401`. Its email is free: a new sign-up gets a new id.
- **It stays a member.** Groups changes no membership and no balance: the balances still add up to 0, and the members list names it
  `Deleted account`, read from the account row. A leave by it is never asked, since it is no caller.
- **What can no longer happen to it.** Ledger refuses a new expense and a new recurring expense that list it (`AccountDeleted`, a word of the
  shared kernel, 409), through `IGroupMembers.isDeleted`. Settlements refuses a payment through the provider to it and a netting with it,
  through `ISettlementMembers.isDeleted`. A cash settlement is untouched: the others still record what they received from it.
- **Its recurring expenses end.** `currentMemberIds`, which the background job and the budget policy read, leaves out the deleted members, so
  `settleDay` finds the payer or a member of the split no longer current and ends the recurring expense on its day, as it does for a member who left.
- **Nobody is told.** Ledger's `BudgetPassed` carries the current members without the deleted ones, and Settlements' outstanding debts skip
  them, so Notifications' reminders and budget notices never reach a deleted account, and no relationship is added for it.

## Consequences

- The `accounts` table's email is nullable and unique where it is held; a deleted account keeps a row so that its id still names a person
  in every group. Its name and password hash are placeholders, not the originals.
- A deleted account's old expenses, settlements, statements and audit read as before, with the id; only the name changes, to `Deleted account`.
- A suggested settlement may still name a deleted account while its balance is not 0; the suggestion is not a change it makes, and nothing
  in the request asks otherwise.
- The erasure of stored facts is by whole value, so a name that another fact holds as a whole value would be erased there too; the rows scanned
  are only those naming the account, which keeps that to the account's own facts.

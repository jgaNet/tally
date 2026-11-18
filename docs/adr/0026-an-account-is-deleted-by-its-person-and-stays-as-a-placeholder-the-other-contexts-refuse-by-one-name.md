# 26. An account is deleted by its person on the Account in Groups, and stays as a placeholder; what would start something new with it is refused by one name, decided by each context through the port it owns

## Context

Request 35 lets a person delete their own account. Their name and email are erased from everything Tally keeps; their id stays where it is (the
groups' members, the expenses' payers and shares, the settlements, the audit and the administrators' log) and means no one any more. In every
group they were a member of they stay a member, at their place, with their role and their balance, so that the balances still add up to 0; the
members list names them `Deleted account`. Nothing new is done with them: they are in no new split, paid through no provider, netted with by no
one, and a recurring expense they are in ends on its next day. The others may still record in cash a payment they received from them.

The storm (`conventions/storms/delete-an-account.yaml`) decided four things: who decides and what is refused, where the name and the email are,
why the account stays a member, and what can no longer happen. This ADR records the one architecture change it adds, a word of the shared
kernel, `AccountDeleted`, and the choices the code rests on. It adds no context and no relationship: the three links it uses (`WaitingPayments`,
`GroupMembers`, `SettlementMembers`) are already in the context map (ADR 4, ADR 5, ADR 25), so the map does not change.

## Decision

- **A deletion is a behaviour of the Account, in Groups.** `Account.delete({ ownedWithOthers, paymentWaiting, now })` refuses
  (`OwnsAGroupWithOtherMembers`, `PaymentWaitingAtTheProvider`) or erases the email, sets the name to `Deleted account`, empties the password hash,
  keeps `deletedAt`, and records `AccountDeleted`, which carries the id and the time and no name or email. An account deleted already is left as it
  is. The handler reads, in its transaction, `countOwnedWithOtherMembers` from the group repository (a fact about the collection of groups) and
  `waitingForAccount` through the port Groups owns to Settlements (`IWaitingPayments`: pending, refunding or contested), so a refusal changes nothing.
- **The placeholder is the name.** Because the account's name becomes `Deleted account`, every reader that joins the accounts, the members list among
  them, reads the placeholder from the Account without a case of its own. The accounts table's email may be null (unique where it is not), so the
  email can be used by a new account, which is someone else.
- **Gone as a person.** A deleted account has no email to sign in with and no password to check. A token it was given proves nothing: the transport's
  `authenticate` asks Groups' account read model whether the account is deleted and leaves the request anonymous when it is, so every route that
  needs a caller answers 401. `GET /accounts/me` finds nothing for it.
- **Erased everywhere is the account's, plus its past facts.** The name and the email are only in Groups. But the facts a sign-up left in the outbox
  (`AccountRegistered` carries the name, the `SignUp` command carries the email, the password and the name) are rewritten in the same transaction by
  a port Groups owns, `IAccountTraces`, whose adapter touches the outbox. The audit and the administrators' log keep the id only.
- **The one refusal is a word of the shared kernel, `AccountDeleted`**, beside `GroupArchived` and `AccountSuspended` (ADR 18, ADR 25). The shared
  kernel gains one word, which the feature mode refuses, so the change runs under the architecture mode and is recorded here.
- **Each context asks Groups through the port it already owns.** Ledger reads `deletedAmong` through `IGroupMembers`, Settlements `deletedOf` through
  `ISettlementMembers`, both answered over Groups' read model inside the command's transaction, taking no lock. `Expense.create` and
  `RecurringExpense.setUp` refuse a split that holds a deleted account. `SettlementBook` refuses a payment through the provider whose payee is deleted
  and a netting with a deleted account (`counterpartyDeleted`); a settlement in cash passes `false`, because its payee is the caller and its payer may be
  deleted: that is what lets the others bring the group back to even.
- **A recurring expense ends, as when a member left.** The sweep passes `recordDay` the members less the deleted ones, so a deleted payer or split member
  is a former member to it, and the day ends the recurring expense (request 23).
- **Tally tells them nothing, and adds no relationship.** Ledger leaves deleted accounts out of the members a budget's notice is for, and Groups' list of
  every group's members, which Settlements reads for what is still owed, leaves them out, so no reminder is made for them. No expense's notice is made for
  them, because they are in no new split. Notifications is told nothing new.

## Consequences

- A recurring expense whose day was decided before a deletion and whose expense reacts after it is refused by the expense's own creation (`AccountDeleted`),
  the window ADR 25 names for a suspension.
- An expense edited after one of its split members was deleted is not refused for that member: the edit keeps the split it concerns, as an edit
  keeps what the expense was; only a new split is refused.
- The accounts table gains `deleted_at` and its email may be null; a database made before this change must be brought up to date when it is opened (as in ADR 25).
- The API answers `DELETE /v1/accounts/me` with `202`, read at the operation; a caller who is not signed in is refused at once with 401.

## When to revisit

If a deleted account should also leave its groups, or its balance pass to the owner, that is request 20's rule, not this one. If other facts that hold a
name or an email appear (a log of what was sent, a copy in another context), the port that erases them grows, and the storm's hot spot is decided again.

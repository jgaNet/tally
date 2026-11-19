# 35. A deleted account is decided by Groups, erased where it is named, and stays a member where its balance is

## Context

Request 35 lets a person delete their own account. It is refused while they own a group that has another member, and while a payment of
theirs waits at the provider (pending, refunding or contested, requests 13, 15 and 33). Once deleted, nobody signs in with its email and
password, a token of it proves nothing, and its email may be used by a new account. Its name and email are erased from everything Tally
keeps, while its id stays where it is (in the members, the expenses' payers and shares, the settlements, the audit and the administrators'
log). In each group it stays a member, with its balance, so the balances still add up to 0, and the members' list names it `Deleted account`.
It is in no new split, is not paid through the provider, is not netted with, and it is told nothing: a recurring expense it pays, or is in the
split of, ends on its day. The storm of the feature (conventions/storms/delete-an-account.yaml) decided where each part lives.

## Decision

- **The deletion is a state of the Account, decided by Groups.** `Account.delete({ ownsGroupWithOtherMembers, paymentWaiting })` refuses
  while either fact holds, and otherwise erases the name, the email and the password hash, and records `AccountDeleted`. The two facts are
  read in the command's transaction: the owned groups from Groups' own store (`IGroupRepository.ownsGroupWithOtherMembers`), the payments
  from Settlements through the WaitingPayments port Groups already owns (`paymentWaitingOfAccount`, which now counts all three statuses
  in every group). The erased email is replaced by `deleted:<id>`, which no sign-up can take, so a new account may use the email.
- **Erasure is where Groups keeps the name.** The accounts row loses its name, email and hash, and the outbox entries of the account's
  `AccountRegistered` fact, which carry the name, are rewritten without it, in the same transaction. Nothing else in the application holds a
  name or an email: Ledger, Settlements and Notifications hold account ids (docs/adr/0011), and the audit and the administrators' log hold ids.
- **A deleted account is anonymous to the transport.** `authenticatedCallerOf` asks the account of a token, and a deleted one proves nothing;
  signed-in routes then answer `401`, and sign-in finds no account with the erased email.
- **The members' list names it.** The group's members are read with `Deleted account` in place of the name of a deleted account. It stays a
  current member, so its balance and its role are the ones it had.
- **What it can no longer do is refused where the rule already lives.** Ledger's new splits and recurring expenses leave a deleted account
  out of the members they are checked against (`NotAMemberInSplit`, the refusal a non-member already gets); the recurring job ends a recurring
  expense whose payer or split member is deleted on its day, as it does for a member who left; the budget notice is told to the current members
  that are not deleted. Settlements refuses a provider payment to a deleted payee and a netting with a deleted account with the shared
  `AccountDeleted` rule (`SharedKernel`, as `AccountSuspended` is), and what is owed to a deleted account is listed to no one. Cash
  settlements, where a deleted payer's payment is recorded by the payee, are unchanged.
- **Ports.** Ledger's GroupMembers and Settlements' SettlementMembers each gain `isDeleted`, answered by Groups' read model; no context
  is added and no link is added to the context map. The relationships Settlements → Groups (WaitingPayments), Groups → Ledger (GroupMembers)
  and Groups → Settlements (SettlementMembers) carry the new answers, as the storm says.

## Consequences

- The balances of a group still add up to 0 after a deletion, and its expenses, settlements, statements and audit read as before, but for
  the name.
- An expense edited after a deletion keeps the deleted account in its split (the edit keeps the members it had): only a new split refuses it.
- An account deleted with a balance in a group it owns alone stays owner of that group; the rule refuses deleting only while another member
  is in it.
- The `accounts` table gains a `deleted` column, added by an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` step when the database is prepared.

See also: docs/adr/0002 (accounts, their token), docs/adr/0034 (the suspension, the same shape of owned port), docs/adr/0009 (a former member
stays readable), docs/adr/0019 (the payment waiting for a leave).

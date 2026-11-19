# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-accounts-in-sqlite-with-its-aggregate-and-its-token.md) | Accounts: SQLite, the Account aggregate, and signed tokens |
| [3](0003-a-context-with-two-resources-mounts-at-the-root.md) | A context with two resources mounts its routes at the root, each with its full path |
| [4](0004-ledger-records-an-expense-split-by-the-groups-members.md) | Ledger records an expense split by the members Groups names, and how it reads them inside its transaction |
| [5](0005-a-groups-balances-are-read-from-ledgers-expenses.md) | A group's balances are read from Ledger's expenses, in one statement, members in the order they joined |
| [6](0006-an-expense-is-edited-and-deleted-by-its-payer-or-the-owner.md) | An expense is edited and deleted by its payer or the group's owner, from the version its author read |
| [7](0007-an-expense-is-split-equally-by-exact-amounts-or-by-shares.md) | An expense is split equally, by exact amounts or by shares, and says which |
| [8](0008-a-group-expenses-and-a-members-statement-are-read-from-ledgers-expenses.md) | A group's expenses and a member's statement are read from Ledger's expenses, the statement's balance running in the read |
| [9](0009-a-member-leaves-a-group-once-its-balance-is-zero.md) | A member leaves a group once its balance is 0, a former member keeps its place in the record, and the cross-context read models open at the composition root |
| [10](0010-the-remainder-of-a-split-goes-to-the-first-member-listed.md) | The remainder of an equal or shares split goes to the first member listed, whoever paid |
| [11](0011-settlements-and-notifications-and-how-the-four-contexts-relate.md) | Settlements and Notifications, and how the four contexts relate |
| [12](0012-suggested-settlements-are-read-from-the-balances-and-the-members.md) | A suggestion of settlements is read from the balances and the members, and recorded nowhere |
| [13](0013-a-cash-settlement-is-recorded-in-the-groups-book-and-counted-by-the-balances.md) | A cash settlement is recorded in the group's book, and the balances count it at once |
| [14](0014-a-settlement-through-the-provider-is-pending-in-the-groups-book.md) | A settlement through the provider is pending in the group's book, and counted once its payment succeeds |
| [15](0015-a-refund-through-the-provider-is-a-status-of-the-settlement.md) | A refund through the provider is a status of the settlement |
| [16](0016-a-payout-account-is-known-to-the-provider-and-required-to-be-paid.md) | A payout account is an aggregate of Settlements, known to the provider, and required to be paid through it |
| [17](0017-an-expense-recorded-is-told-to-notifications-which-issues-a-notice-per-member.md) | An expense recorded is told to Notifications, which issues one notice per member but the payer |
| [18](0018-a-debt-that-lasts-is-reminded-by-the-sweep-of-notifications.md) | A debt that lasts is reminded by Notifications' sweep, which reads what is owed from Settlements |
| [19](0019-a-member-leaves-at-any-balance-and-the-balance-passes-to-the-owner.md) | A member leaves at any balance, and what it owes or is owed passes to the group's owner |
| [20](0020-an-expense-in-another-currency-is-converted-by-its-own-rate.md) | An expense in another currency is converted by the rate its payer states, and Ledger asks the group's currency through a port |
| [21](0021-an-expense-takes-the-rate-a-rates-service-offers-or-corrects-it-within-2-percent.md) | An expense in another currency takes the rate a rates service offers, or corrects it within 2 %, and Ledger asks for it through a port |
| [22](0022-a-recurring-expense-is-recorded-by-the-background-job-once.md) | A recurring expense is an aggregate of Ledger, and the background job records each of its days once |
| [23](0023-a-month-that-passes-a-budget-is-told-once-to-each-member.md) | A month that passes a category's budget is an aggregate of Ledger, and each member is told once for it |
| [24](0024-a-split-template-is-an-aggregate-of-ledger-that-an-expense-takes-the-split-of.md) | A split template is an aggregate of Ledger, and an expense takes the split of the template it names |
| [25](0025-a-receipt-is-an-aggregate-of-ledger-kept-in-an-outside-store-behind-a-port.md) | A receipt is an aggregate of Ledger, kept in an outside store behind a port of Ledger |
| [26](0026-a-group-is-archived-once-and-every-change-in-it-is-refused-by-one-rule.md) | A group is archived once every balance is 0, and every change in it is refused by one rule |
| [27](0027-every-change-of-money-is-an-entry-of-its-groups-audit-written-with-it.md) | Every change of money is an entry of its group's audit, written with the change, and Ledger reads the audit through ports |
| [28](0028-a-member-statement-counts-the-settlements-that-count-and-is-read-as-csv.md) | A member's statement lists the settlements that count, in the order of the moments, and is read as CSV |
| [29](0029-the-application-keeps-its-state-in-postgresql-and-moves-its-sqlite-file-in-once.md) | The application keeps its state in PostgreSQL, and moves what its SQLite file held into it once |
| [30](0030-a-merge-moves-the-expenses-and-the-settlements-by-one-fact.md) | A merge moves the expenses and the settlements by one fact, and the people stay in Groups |
| [31](0031-a-merged-group-is-removed-and-what-it-held-moves-by-the-groups-merged-fact.md) | A merged group is removed, and what it held moves to the group kept by the GroupsMerged fact |
| [32](0032-a-netting-is-decided-across-the-shared-groups-and-stored-with-their-books.md) | A netting is decided by a Settlements domain service across the groups two members share, and stored with their books |
| [33](0033-a-contested-settlement-is-held-until-an-administrator-decides-it.md) | A contested settlement is held by Settlements until an administrator decides it, and the decision is logged by the context that made it |
| [34](0034-a-suspended-account-is-refused-by-one-rule-and-logged-by-groups.md) | A suspended account is decided by Groups, refused by one rule in every context that starts a change, and logged by Groups |
| [35](0035-a-deleted-account-is-erased-by-groups-and-stays-a-member.md) | A deleted account is decided by Groups and erased where it is named, and stays a member where its balance is |
| [36](0036-a-person-turns-each-kind-of-notice-on-or-off-and-the-preference-is-read-when-a-notice-is-made.md) | A person turns each kind of notice on or off, kept by Notifications and read when a notice would be made |
| [37](0037-the-owner-decides-who-bears-the-provider-fee-and-a-settlement-keeps-the-fee-it-was-asked-with.md) | The owner decides who bears the provider's fee, and a settlement keeps the fee it was asked with |
| [38](0038-a-settlement-in-another-currency-takes-the-rate-offered-when-it-is-decided.md) | A settlement in another currency takes the rate offered when it is decided, and keeps it |
| [39](0039-a-currency-has-its-own-minor-unit-and-a-conversion-is-counted-in-the-target-one.md) | A currency has its own minor unit, and a conversion is counted in the target currency's minor unit |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.

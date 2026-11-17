# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-accounts-on-one-sqlite-file.md) | Accounts in Groups, and the application’s state in one SQLite file |
| [3](0003-ledger-asks-groups-who-may-be-in-a-split.md) | Ledger asks Groups who may be in a split (the Groups → Ledger link, carried) |
| [4](0004-a-transaction-reads-its-own-file.md) | A transaction reads its own file: its reads do not wait for the turn it holds |
| [5](0005-groups-asks-ledger-a-members-balance.md) | Groups asks Ledger a member’s balance (the Ledger → Groups link, carried); former members kept; the read model built by the composition root |
| [6](0006-settlements-and-notifications-and-how-the-four-contexts-relate.md) | Settlements and Notifications, and how the four contexts relate |
| [7](0007-settlements-reads-balances-and-members-for-the-suggestion.md) | Settlements asks Ledger the balances and Groups the members (the Ledger → Settlements and Groups → Settlements links, carried) |
| [8](0008-settlement-book-and-ledger-counts-settlements.md) | A settlement is decided in its group’s book, and Ledger counts the settlements paid (the Settlements → Ledger link, carried) |
| [9](0009-notifications-tells-each-member-of-an-expense.md) | Notifications tells each member of an expense from Ledger’s ExpenseRecorded (the Ledger → Notifications link, carried); a notice made once from the fact |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.

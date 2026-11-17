# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-accounts-on-one-sqlite-file.md) | Accounts in Groups, and the application’s state in one SQLite file |
| [3](0003-ledger-asks-groups-who-may-be-in-a-split.md) | Ledger asks Groups who may be in a split (the Groups → Ledger link, carried) |
| [4](0004-a-transaction-reads-its-own-file.md) | A transaction reads its own file: its reads do not wait for the turn it holds |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.

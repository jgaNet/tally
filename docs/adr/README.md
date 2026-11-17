# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-sqlite-and-accounts.md) | One SQLite file, and accounts that sign in |
| [3](0003-ledger-asks-groups-for-the-members.md) | Ledger asks Groups who is a member, through a read model Groups exports |
| [4](0004-leaving-a-group.md) | Leaving a group: Groups asks Ledger a member's balance, and a former member keeps its rows |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.

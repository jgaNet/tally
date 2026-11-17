# Architecture decision records

Short notes on the choices a newcomer is most likely to question. Each one says what was decided,
why, what it costs, and when to revisit it.

| # | Decision |
|---|---|
| [1](0001-groups-and-ledger-and-how-they-relate.md) | Groups and Ledger, and how they relate |
| [2](0002-one-sqlite-file-for-what-the-application-knows.md) | One SQLite file for what the application knows |
| [3](0003-ledger-reads-who-may-be-in-a-split-from-groups.md) | Ledger reads who may be in a split from Groups, through a port it owns |
| [4](0004-groups-and-ledger-ask-each-other-through-ports.md) | Groups and Ledger ask each other through ports, and a leaver is kept |

The decisions behind the building blocks themselves are recorded in the reference:
https://github.com/jgaNet/clean-ddd/tree/main/docs/adr — copy the shape of one, number it, and link
it from this table and from wherever the rule is stated.

# 6. Expenses split three ways: equally, by exact amounts, or by shares

## Context

ADR 5 split an expense equally between the members it names, the remainder to the payer. Request 7 (`api/7-unequal-splits.yaml`)
adds two more ways, decided with the product's owner in `conventions/storms/unequal-splits.yaml`: by exact amounts (each
member with the amount of their share, the amounts adding up to the expense's) and by shares (each member with a whole
number of shares, the amount divided among them in proportion). Its three hot spots are decided there: one command per
recording and per edit, taking a split of one of three kinds, with the facts carrying the kind; the body's shape refused
by the transport (400), and the values refused by the split by name; the remainder of a split by shares whole to the payer.

No context or relationship is added: Ledger still asks Groups for the members (ADR 5), and no integration event carries a
split.

## Decision

- **One command per recording and per edit, one split input.** `RecordExpense` and `EditExpense` take a `SplitRequest`, one
  of three kinds (`equal` with the member ids, `exact` with each member's amount, `shares` with each member's shares). The
  body is refused with 400 unless exactly one of `splitBetween`, `splitExactly` or `splitByShares` is given, and of the
  shape of the one given.
- **`Split` keeps its kind.** `Split.create` checks the members (each listed once, the payer among them, all members of the
  group), then the kind: exact amounts are 0 or more, whole, and add up to the amount (`SplitAmountsDoNotAddUp`,
  `InvalidSplitAmount`); shares are whole and at least 1 (`InvalidSplitShares`). The shares of a split by shares are the
  amount times the member's shares over the total of the shares, rounded down, computed in whole numbers of any size; the
  remainder goes whole to the payer, as an equal split's does.
- **The kind is stored with the expense and carried by its facts.** `ExpenseRecorded` and `ExpenseEdited` carry `splitKind`;
  `GET /v1/expenses/{id}` answers `splitKind`. An expense recorded before this request is `equal`: the column is added with
  that default, in the same migration that adds the version.
- **The shares of a split by shares are stored as amounts, not as the counts they were made from.** Nothing reads the
  counts after the split is made, and an edit makes a new split from the new values. A stored split is restored from its
  kind and amounts, and refused if they are not ones that kind could have given (the expense is then corrupted).
- **Balances are unchanged.** They count each member's share, however the expense was split (feature 5).

## Consequences

- ADR 5's "each share is the amount divided by the number of members" now describes the equal split only; the rest of
  ADR 5 stands.
- The API's `splitBetween` body key is unchanged, so the tests and clients of requests 4 and 6 keep their bodies.

## When to revisit

- When a request needs the share counts after a split was made (a split that is re-divided when a member leaves): then they
  are stored with the expense, and the migration of the earlier expenses gets its own decision.

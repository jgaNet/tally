# 7. An expense is split equally, by exact amounts or by shares, and says which

## Context

Request 7 lets a member split an expense unequally: a couple takes two shares of the cottage, someone had the lobster. The
storm (`conventions/storms/unequal-splits.yaml`) decided three things: one command per action, not one per kind of split
(`RecordExpense` and `EditExpense` take a split of one of three kinds); the transport refuses a body that says none of the
three, or more than one, as the wrong shape (`400`), while the domain refuses what the split says (amounts that do not add
up, shares below 1) by name; and a split by shares rounds each share down and gives the remainder whole to the member listed first, as an
equal split does (ADR 0010; this request first gave it to the payer).

Building it showed two things the storm did not say.

- **Exact arithmetic on the shares.** A share is the amount times the member's weight over the total of the weights, rounded
  down. The amount is at most 100 000 000, but a weight is any whole number the caller gives, so the product can pass what a
  JavaScript number holds exactly. The split computes in BigInt, so the shares add up to the amount exactly, for any weights.
- **Expenses already stored have no kind.** The expenses recorded before this request were split equally, and the store keeps
  them in a file that already exists.

## Decision

- **One split value, three kinds.** `Split.of()` takes a `SplitInput` of kind `equal` (the members the amount is split
  between), `exact` (each member's amount) or `shares` (each member's whole number of shares). It refuses a member listed
  twice, a member who is not a current member and a split without its payer, for all three, by the names the equal split
  already had. The exact kind refuses an amount that is not whole or is below 0 (`InvalidSplitAmount`), and amounts that do not
  add up to the expense's amount, exactly (`SplitDoesNotAddUp`). The shares kind refuses a member with less than 1 share
  (`InvalidShares`).
- **The weights, one rule.** An equal split is a split whose members each weigh 1; a split by shares weighs them by their
  shares. The share is `amount × weight ÷ total of the weights`, rounded down, and the remainder goes whole to the member listed first (ADR 0010). So
  `1000` by shares of 1, 1 and 1 is the equal split, and `1001` by shares of 2 and 1, the payer listed second, is `668` and `333`.
- **The kind is kept with the expense, and the facts carry it.** The expense's table has a column `split_kind`, and
  `ExpenseRecorded` and `ExpenseEdited` carry `splitKind`, so a fact says how the expense was split. The read says it as
  `splitKind`. The shares are kept as the amounts each member owes, as before; the kind is what says how they were made.
- **Files kept before this request are migrated in place.** `prepareLedgerSchema()` adds the column to an `expenses` table
  that lacks it, with the default `equal`, the way Groups added `joined_at` (feature 2). An expense recorded before is read as
  split equally.
- **The transport's body is one of three.** The body of a record and of an edit says `oneOf` of the three keys are required;
  a split of the wrong shape is `400`, and a value the split refuses is `422`, by name.

## Consequences

- The balances (request 5) need no change: they count each stored share, however the expense was split.
- An edit may change the kind of split: the store writes the kind with the expense, and the version still decides which edit
  is kept (ADR 0006).
- The API fragment (`api/8-unequal-splits.yaml`) gives `splitKind` on the expense; the end-to-end tests hold every read to it.

## Alternatives

- **A command per kind of split.** Three commands, one handler each, and the same facts. It multiplies the routes and the
  use cases for one rule. Not taken; the storm decided one.
- **Round the product in JavaScript numbers.** Fast and simple, but wrong once an amount times its weight passes 2^53. The
  BigInt arithmetic costs one conversion. Not taken.
- **Store the given weights, compute the shares on read.** It would tie every balance to the rule's code, and a rule change
  would move money already recorded. Not taken: the shares are kept, as before.

## When to revisit

When a second context reads an expense's split kind, the kind becomes an integration event's field, by an ADR. When a split
may use weights that are not whole numbers, the rounding rule is decided again, here.

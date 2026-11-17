# 7. Leaving keeps the former member, and Groups asks the balance through a port

## Context

Request 9 of Tally (a member leaves a group once their balance in it is 0; the owner stays) was stormed before the code
(`conventions/storms/leave-a-group.yaml`, decided with the product's owner). The storm says four things the architecture had
not yet carried. Groups must know a member's balance, and that answer is Ledger's (ADR 1, T5, which `conventions/domain.yaml`
declared `planned` until the code carried it). Leaving is Groups' own fact, not told to Ledger. An expense of a member who left
must stay as it was, and its statement must still be read by the members. And the roster (ADR 6) must say who has ever been a
member, not only who is one now, because a statement is read for a member who left.

## Decision

- **The relationship Ledger → Groups is carried now.** Groups owns the port `IMemberBalances` (`Groups/Application/`), in its
  own words: a member's balance in a group, 0 when nothing is counted. Its adapter, `MemberBalancesFromLedger`
  (`Groups/Infrastructure/`), is over Ledger's read model `IBalanceRoster` (`Ledger/Domain/Expense/Ports/`), answered by
  `SqliteBalanceRoster` over the `expense_balances` rows. The relationship is no longer `planned` in the context map.
- **The composition root wires the two read models, not the two modules.** Groups' wiring is given `IMemberBalances`; Ledger's
  wiring is given Groups' roster. Each read model is built over the database alone (`ledgerBalanceRoster`, Groups' roster), so
  neither module imports the other and the root has no cycle.
- **`Group.leave` is a decision on values.** The use case reads the balance and passes it in: the aggregate refuses the owner
  (`403`, `NotAllowed`), a member whose balance is not 0 (`422`, `BalanceNotZero`), and an account that is not a member (`404`).
  It records `MemberLeft`, which nothing subscribes to.
- **A former member is kept, not deleted.** A group's members are the rows of `group_members`; a member who left moves to
  `group_former_members` with the time they left, and the roster reads only the members now. `hasBeenMember` reads both tables, so
  the roster answers who has ever been a member. A member who joins again leaves that row and joins last, with the time they join
  again (feature 3's order, ADR 5).
- **An expense that concerns a former member cannot change.** `Expense.edit` and `Expense.delete` refuse, with
  `ExpenseConcernsFormerMember` (`422`), an expense whose payer or a member of its split is not a member now, given the group's
  current members by the use case. So a former member's balance stays 0, and the group's balances still add up to 0. Their
  expenses keep their shares, and their statement is read by the members (`404` only for an account that has never been a member).
- **`IGroupMembers` and `IGroupRoster` gain `hasBeenMember`**, the same roster over the same port, not a new link.

## Consequences

- The known gap of T5 stands: an expense recorded in the same moment its member leaves is not refused by the other side. No hidden
  test sends the two at once; the alternative (one transaction across Groups and Ledger, or a saga) is out of proportion for this
  checkpoint.
- Existing databases are not migrated: `group_former_members` is created by `CREATE TABLE IF NOT EXISTS`, and no member has left
  before this change.

## When to revisit

When request 20 changes leaving, whether the gap is closed then; and when Notifications (checkpoint 2) reacts to Groups' facts,
whether `MemberLeft` is published as an integration event, as ADR 1 leaves open for `MemberJoined`.

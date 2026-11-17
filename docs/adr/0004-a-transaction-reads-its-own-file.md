# 4. A transaction reads its own file

## Context

ADR 2 keeps the application's state in one SQLite file with one connection per process. Every read that is not part of a
transaction waits for the file's turn (`exclusive()`), so that it never sees a transaction in progress. A transaction
holds that turn from its begin to its commit.

Request 4 records an expense, and the command must ask Groups who may be in the split: through Ledger's port
`GroupMembers`, answered over Groups' read model (ADR 1, T3, and the storm's hot spot). That read runs inside the
command's transaction, which already holds the turn. It waits for a turn it holds itself, and the command never
answers: a deadlock, found by the first end-to-end run of request 4.

## Decision

- **A transaction's own reads do not wait for its turn.** The unit of work's transaction runs in a scope
  (`UnitOfWork.within()`), entered for the outermost transaction of a context (`ExecutionContext.withTransaction`) and
  covering its begin, its writes, its outbox entries and its commit. In the SQLite file, the scope is an async context
  (`AsyncLocalStorage`): a read made inside it runs at once on the same connection, as a repository's write already does.
- **Every other reader still waits.** A read made outside the scope — by another request, by a query, by the relay of
  the outbox — waits for the turn exactly as before (ADR 2). The scope does not leak into the requests that did not start
  inside the transaction.
- **The in-memory unit of work** has no turn to wait for, and its `within()` runs the scope as it is.
- **Reactions are unchanged**: a reaction's transaction is its own (ADR 30), begun after the parent's commit, outside the
  scope.

## Consequences

- A command may read a read model of its own application inside its transaction, and see the writes it has made so far.
- The guarantee of ADR 2 holds for every read outside a transaction: a query never sees a transaction in progress.
- Code run inside a transaction's scope and started as a separate asynchronous task inherits the scope; no handler does
  this, and a future one that does must not read another transaction's writes from it.

## When to revisit

When a second process shares the file: the turn is then per process, and a read inside one process's transaction must
still wait for another process's commit through SQLite's own locks, which the busy timeout covers for writes only.

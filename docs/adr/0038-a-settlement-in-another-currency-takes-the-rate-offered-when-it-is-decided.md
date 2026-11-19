# 38. A settlement in another currency takes the rate offered when it is decided, and keeps it

## Context

Request 39 lets a settlement in cash, or through the provider, be paid in another currency than the group's: Bob owes Ann 50 euros and has only
Swiss francs left. The payer does not give a rate: Tally asks the rates service for the day's rate, in UTC, when the settlement is decided, and
takes it. A settlement keeps its rate, and what it was paid in, whatever the rates service says later, so that a payment that lands days later, or
a refund, counts what was decided. The storm of the feature (conventions/storms/settle-in-another-currency.yaml) decided where each part lives.
The rates service is the outside service that Ledger already asks for an expense's rate (docs/adr/0021); Settlements asks it through a port of
its own, as docs/adr/0030 recorded. No context and no relationship between contexts is added: the rates service is an outside system, not a
context, so the context map is unchanged.

## Decision

- **Settlements asks the rates service through a port it owns.** `ISettlementRates.offeredRate({ from, to, date })` answers `offered` with the
  rate or `none`, and never throws. `HttpSettlementRates`, in Settlements' Infrastructure, calls `RATES_URL` with a 5-second limit, as the provider
  does; with no `RATES_URL`, or a failure, no rate is offered. Two adapters over one outside service, each in its context's words.
- **The use case asks the rate before the book decides.** The use case asks only for a currency of Tally other than the group's, on the day of the
  settlement's `at` in UTC. The rate is an input of the decision (DOMAIN-NON-DETERMINISM): the book takes `offered` and refuses it with
  `NoRateOffered` when it is `none`, or is not a rate it can use. A provider is asked only after the book has decided, so a refused settlement asks
  the provider for nothing and keeps nothing.
- **The conversion is a value of the book, as an expense's is.** `OriginalPayment` (Settlements' Domain) keeps the currency, the amount in that
  currency's hundredths and the rate as the string the service wrote. Its amount in the group's currency is the amount times the rate, rounded to the
  nearest whole number, a half up, in integers. Settlements does not import Ledger's `OriginalAmount`: the rule is the same, its code is its own.
- **Exactly one of `amount` and `original`.** The transport refuses a body with both or neither as the wrong shape (`400`). The book refuses both or
  neither too (`InvalidSettlementAmount`), and an original's currency, its group's own currency, or its amount out of 1 to 100 000 000
  (`UnknownCurrency`, `OriginalCurrencyIsGroupCurrency`, `InvalidOriginalAmount`), each `422`, with nothing kept.
- **The provider is asked for the payment in its own currency.** The reservation answers the amount and the currency to ask for: the original's when
  there is one, the group's otherwise. The fee the provider answers is in that currency; the book converts it at the same rate, the same way, before
  request 38's part is taken off, and refuses a fee that is not less than the payment in its currency, or not less than the settlement in the
  group's (`ProviderFeeNotAccepted`).
- **What a settlement keeps.** `amount`, `settled` and `fee` are in the group's currency, so the balances, the statements and the audit count what
  they always counted. The settlement keeps `original: { currency, amount, rate }` as it was decided, the rate as the service wrote it; a settlement
  in the group's currency keeps none and reads as before.

## Consequences

- A settlement in another currency reads `original`, and its `amount` is the group's currency. Its rate is fixed when it is decided: a later offer
  changes nothing about it, and a refund moves the amount decided.
- A settlement is refused, nothing is kept and the provider is not asked when the rates service offers no rate, as an expense is never recorded
  at no rate (docs/adr/0021). The rates service is asked once per settlement.
- The store keeps `original_currency`, `original_amount` and `original_rate` on each settlement row, null for one in the group's currency.

See also: docs/adr/0013 (a settlement is decided by the group's book), docs/adr/0014 (a settlement through the provider is pending in the book),
docs/adr/0021 (an expense takes the rate a rates service offers), docs/adr/0030 (Settlements asks the rates service through its own port),
docs/adr/0037 (the fee a settlement keeps, which is converted here before it is taken).

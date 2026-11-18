/** The rate offered from a currency to the group's on a day: `rate` is what one of `currency` is worth in the group's currency. */
export interface RateReadModel {
  currency: string;
  date: string;
  rate: string;
}

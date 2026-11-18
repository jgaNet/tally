/** The rate a rates service offers from a currency to the group's on a day (request 22): what one `currency` is worth in it. */
export interface OfferedRateReadModel {
  currency: string;
  date: string;
  rate: string;
}

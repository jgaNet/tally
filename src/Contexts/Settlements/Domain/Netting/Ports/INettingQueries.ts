import { NettingView } from '@Contexts/Settlements/Domain/Netting/DTOs';

/** The read side of the nettings (request 32): what `GetNetting` answers. */
export interface INettingQueries {
  /** The netting, or undefined when there is no such netting. Who may read it is the query's to say. */
  findNetting(nettingId: string): Promise<NettingView | undefined>;
}

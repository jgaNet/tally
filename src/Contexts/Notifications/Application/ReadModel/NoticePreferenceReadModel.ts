/** One kind of notice as its person reads it: the kind, and whether they are told of it (request 36). */
export interface NoticePreferenceReadModel {
  kind: 'expense' | 'reminder' | 'budget';
  enabled: boolean;
}

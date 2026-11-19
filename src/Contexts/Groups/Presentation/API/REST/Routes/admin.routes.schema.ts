/** One entry of the administrators' log: its id, when, which administrator, what, and about which settlement (request 33). */
const AdministratorLogEntrySchema = {
  type: 'object',
  required: ['id', 'at', 'by', 'action', 'subjectId'],
  properties: {
    id: { type: 'string' },
    at: { type: 'string' },
    by: { type: 'string' },
    action: { type: 'string', enum: ['decided-paid', 'decided-annulled'] },
    subjectId: { type: 'string' },
  },
} as const;

/** The administrators' log, the oldest first; 401 for a caller not signed in, 404 for one who is not an administrator. */
export const GetAdministratorsLogResSchema = {
  200: { type: 'array', items: AdministratorLogEntrySchema },
} as const;

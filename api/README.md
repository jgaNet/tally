# The API

What this application answers, as data: one fragment per change, `<n>-<name>.yaml`, composed in their order.
A change that adds or changes an answer writes its fragment first, before its code; the end-to-end client
(`src/Bootstrap/Fastify/api.spec-helper.ts`) holds every answer a test reads to the composition, and a
test fails on an answer of another shape, a status its route and `all_routes` do not name, or a route no
fragment declares, naming the fragment whose shape it breaks. `yarn check:conventions` refuses an `api/`
that does not compose (API-ONE-SURFACE).

```yaml
# api/2-tasks.yaml
resources:
  task:
    schema:                      # a JSON Schema (draft-07): the resource, new or replaced whole
      type: object
      required: [id, title, status]
      properties: { id: { type: string }, title: { type: string }, status: { enum: [open, done] } }
    # gains: { dueOn: { … } }    # properties it has from this change on, required from now on
    # states: [{ field: status, add: [archived] }]          # values an enum now takes
    # conditions: [{ field: doneAt, null_only_when: { status: [open] } }]
routes:
  GET /v1/tasks/{id}:
    200: task                    # a resource's name, or a JSON Schema
  GET /v1/tasks:
    200: { type: array, items: { $resource: task } }      # a resource anywhere inside a schema
```

A status is exact (`404`) or a class (`4xx`); `all_routes`, in the first fragment, says what any route may
answer besides its own. A route is the whole path, the prefix included.

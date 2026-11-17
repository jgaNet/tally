# Contexts

One folder per bounded context, each with the four layers (`Domain`, `Application`, `Infrastructure`, `Presentation`)
and its wiring file `module.local.ts`, and each declared in `conventions/typescript.yaml`
so that the import rules apply to it.

Nothing here yet. `clean-ddd checklist context` says what a context is made of, and
`clean-ddd checklist aggregate` what goes in its Domain.

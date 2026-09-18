# Manao Project Guidance

## Workspace

- Check out implementation branches under `D:/DeepLearning/MyProjects/Project_Manao/.worktree/`.
- The active 6B checkout is `.worktree/poc4-stage-6b`, on branch `codex/poc4-stage-6b`; the main checkout remains on `master`.
- Run implementation commands from the active worktree and resolve repository-relative paths there. Check the current branch and local changes before editing; preserve unrelated changes.

## Documentation and stage boundary

- [Stage 6A Current Facts](docs/Stage6A-Current-Facts.md) is the authority for 6A acceptance, evidence, and known limits.
- [Stage 6A Evolution Timeline](docs/Stage6A-Evolution-Timeline.md) records dated decisions and superseded plans.
- [Project Goal](docs/Manao-Projects-goal.md), [Progress](docs/what-we-have-done.md), and [Infrastructure Status](docs/Stage6-Infrastructure-Status.md) provide product scope, stage history, and measured infrastructure conditions.
- 6A was accepted on 2026-09-17 for the real MVP lifecycle, including manual deletion, and merged into `master` with `--no-ff` on 2026-09-18. The 6B branch starts from that baseline.
- Revise historical Tasks 10-12 against the current facts and code. Old gates do not override the user's acceptance; acceptance does not imply that all PTY, audit, stress, fault, or regression tests passed. Distinguish current verification from historical or user-reported results.

## Runtime

- `local-cluster` defaults to `kubectl port-forward` to the server-derived workspace Pod. `MANAO_KUBECTL` selects the executable; `MANAO_BRIDGE_MODE=fabric8` is for explicit transport comparison, and `supervised` requires an intentionally managed external bridge.
- Workspace mutation transport failures remain fail-closed. Before retrying, reconcile the durable operation receipt and verify its operation ID and digests; never blindly replay a possibly-applied mutation.
- Treat tunnel availability, loaded credentials, node readiness, and scheduling capacity as runtime facts to verify before real-cluster tests. An old SSH/session note or the eight-project application limit does not establish current connectivity or capacity.

## Tests, cleanup, and private configuration

- Schema-reset tests must use disposable schemas; never reset `manao_poc4`. Distinguish test-account/migration privileges from runtime failures.
- Runtime cleanup must be project- and owner-scoped. Verify initializer/workspace/Job/Service/PVC resources, applicable PV/storage residue, and dependent database rows. A healthy rerun or successful `afterAll` alone does not prove cleanup; preserve narrowly identified unresolved diagnostics.
- Artifact cleanup does not authorize deleting runtime resources. Inventory and path-check obsolete files, retaining the latest useful reports and minimal unresolved-failure evidence. Avoid broad `git clean`/`mvn clean`, reparse-target deletion, and removal of live configuration; record what was actually deleted.
- Keep passwords, tokens, private configuration, raw kubeconfigs, and unsanitized traces out of commits. Credential refresh does not change RBAC permissions; restart a service when it must reload credentials captured at startup.

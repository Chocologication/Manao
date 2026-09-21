# Manao Project Guidance

# Whenever you make a change that you think is worth documenting, update this document and the files it references.

## Workspace and current baseline

- The main checkout is `D:/DeepLearning/MyProjects/Project_Manao`, on `master`. Stage 6A was merged on 2026-09-18 (`6dfb655`); Stage 6B was accepted, closed and merged on 2026-09-20 (`860cdda`), then pushed to `origin/master`.
- Create new implementation branches under `.worktree/`. The retained `.worktree/poc4-stage-6b` / `codex/poc4-stage-6b` is a completed-stage checkout, not the default workspace for new work. Check the branch and local changes before editing; preserve unrelated changes.
- Resolve repository-relative paths from the checkout actually being edited. Documentation links must work from `master`; do not link through a private or retained `.worktree` path.

## Read the document that owns the question

| Question | Authority |
| --- | --- |
| Product goal, delivered POC4 scope and non-goals | [Project Goal](docs/Manao-Projects-goal.md) |
| Completed stages and what remains undecided | [Progress](docs/what-we-have-done.md) |
| Project, Run and dependency terminology | [Domain glossary](CONTEXT.md) |
| Proposed Java application ports and project MySQL/Redis lifecycle | [Java Runtime Design](docs/superpowers/specs/2026-09-21-java-project-runtime-design.md), design review only |
| Current cloud acceptance, evidence and limits | [Stage 6B Acceptance](poc4/docs/evidence/stage-6b/acceptance.md), current conclusion in section 10 |
| Cloud deployment, pinned images and maintenance | [Stage 6B Deployment](poc4/deploy/6b/README.md) |
| Environment boundaries and dated infrastructure observations | [Infrastructure Status](docs/Stage6-Infrastructure-Status.md) |
| Accepted 6A baseline and its original evidence | [Stage 6A Current Facts](docs/Stage6A-Current-Facts.md) |
| Historical decisions and superseded plans | [Stage 6A Evolution Timeline](docs/Stage6A-Evolution-Timeline.md) |

- Keep current conclusions in their authority documents; indexes summarize and link instead of maintaining another acceptance matrix.
- Historical Tasks 10–12 and old 6A gates are not current execution instructions. Both stages are closed under the accepted MVP scope; this does not establish a full PTY/audit/stress/fault-matrix PASS. Preserve the distinctions between PASS, FAILED, SKIPPED, WAIVED_BY_USER and NOT_REVERIFIED.
- A new product stage or feature needs its own agreed scope; do not infer authorization to start AI, multi-language support or a broader platform from completion of 6B.
- On 2026-09-21 the user confirmed MySQL data must survive stopping, editing and rerunning a user application, and asked to continue the recommended Java runtime design before broader language adaptation and AI. The linked design distinguishes confirmed requirements from proposed defaults; none of its capabilities is delivered or accepted by the existing 6B PASS.

## Runtime boundaries

- The accepted cloud deployment uses the `cluster` profile in `manao-stage6b`, the `manao_poc4_6b` schema and the `manao-backend` ServiceAccount. Browser use does not depend on a local Vite/backend, SSH tunnel or workspace bridge. Deployment and maintenance commands belong in the deployment README.
- For explicit 6A/local debugging, `local-cluster` defaults to `kubectl port-forward` to the server-derived workspace Pod. `MANAO_KUBECTL` selects the executable; `MANAO_BRIDGE_MODE=fabric8` is for transport comparison, and `supervised` requires an intentionally managed external bridge.
- Workspace mutation transport failures remain fail-closed. Before retrying, reconcile the durable operation receipt and verify its operation ID and digests; never blindly replay a possibly-applied mutation.
- Verify the target context/namespace, loaded credentials, node readiness and scheduling capacity before real-cluster tests. For local debugging also verify its tunnel. Old snapshots and the eight-project application limit do not establish current health or capacity.

## Tests, cleanup and private configuration

- Use disposable schemas for schema-reset tests; never reset either runtime schema (`manao_poc4` or `manao_poc4_6b`). Distinguish test-account/migration privileges from runtime failures.
- Runtime cleanup must be project- and owner-scoped. Verify initializer/workspace/Job/Service/PVC resources, applicable PV/storage residue and dependent database rows. Successful `afterAll` alone does not prove cleanup; preserve narrowly identified unresolved diagnostics.
- Artifact cleanup does not authorize deleting runtime resources. Inventory and path-check obsolete files, retaining useful reports and minimal unresolved evidence. Avoid broad `git clean`/`mvn clean`, reparse-target deletion and removal of live configuration; record actual deletion results.
- Keep passwords, tokens, private configuration, raw kubeconfigs and unsanitized traces out of commits. Credential refresh does not change RBAC; restart a service when it must reload credentials captured at startup.

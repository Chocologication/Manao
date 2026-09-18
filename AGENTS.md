# Manao Project Documentation

- [Stage 6A Current Facts](docs/Stage6A-Current-Facts.md) — Sole current 6A evidence and acceptance authority.
- [Stage 6A Evolution Timeline](docs/Stage6A-Evolution-Timeline.md) — Dated decisions, implementation changes, and superseded plans.

- [Manao Project Goal](docs/Manao-Projects-goal.md) — Defines the product vision, the current POC4 validation slice, and the capabilities intentionally deferred from that slice.
- [What We Have Done](docs/what-we-have-done.md) — Summarizes the completed stages, the evidence boundary for each stage, and the remaining Stage 6 work.
- [Stage 6 Infrastructure Status](docs/Stage6-Infrastructure-Status.md) — Records the measured Kubernetes, container-runtime, image-registry, kubeconfig, and network conditions used for Stage 6A validation.

## Stage 6A local-cluster runtime notes

- The local-cluster profile uses kubectl port-forward to the server-derived workspace Pod by default. Set MANAO_KUBECTL only to select the kubectl executable; use MANAO_BRIDGE_MODE=fabric8 only for explicit transport comparison, and supervised only when an external bridge is intentionally managed.
- Workspace mutation transport failures remain fail-closed. Before any retry, reconcile the durable operation receipt and verify its operation ID and digests; do not blindly replay a possibly-applied mutation.

## Stage 6 status and evidence discipline

- Current Stage 6A authority: [Current facts](docs/Stage6A-Current-Facts.md). Older status, gate and runtime reports are historical sources only. Implementation remains in the local Stage 6 worktree, not merged into master.
- On 2026-09-17 the user accepted Stage 6A based on the real MVP lifecycle including manual project deletion and decided to prepare 6B. Do not reinterpret this as all historical PTY/audit/stress/fault gates passing. Use the current facts and actual code when revising the old Tasks 10-12; do not reinstate the old gate as a conflicting current decision.
- Database schema-reset tests must use disposable schemas. Distinguish migration/test-account privileges from runtime failures; never reset `manao_poc4` to fix a test.
- Preserve narrowly identified unresolved cluster/database diagnostics. Artifact cleanup is not permission to delete runtime resources; delete only inventoried, path-checked obsolete logs, keeping latest useful reports and unresolved-failure evidence.
- A healthy-cluster rerun does not repair failure-path cleanup. Verify initializer/workspace/Job/PVC and dependent DB records, not just afterAll status; do not report a zero-residue environment without checking both systems.
- Do not commit passwords, tokens, raw kubeconfigs or unsanitized traces. Keep private configuration outside tracked files; verify current token identity, node readiness and scheduling capacity before real-cluster acceptance.

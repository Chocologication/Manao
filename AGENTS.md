# Manao Project Documentation

- [Manao Project Goal](docs/Manao-Projects-goal.md) — Defines the product vision, the current POC4 validation slice, and the capabilities intentionally deferred from that slice.
- [What We Have Done](docs/what-we-have-done.md) — Summarizes the completed stages, the evidence boundary for each stage, and the remaining Stage 6 work.
- [Stage 6 Infrastructure Status](docs/Stage6-Infrastructure-Status.md) — Records the measured Kubernetes, container-runtime, image-registry, kubeconfig, and network conditions used for Stage 6A validation.

## Stage 6A local-cluster runtime notes

- The local-cluster profile uses kubectl port-forward to the server-derived workspace Pod by default. Set MANAO_KUBECTL only to select the kubectl executable; use MANAO_BRIDGE_MODE=fabric8 only for explicit transport comparison, and supervised only when an external bridge is intentionally managed.
- Workspace mutation transport failures remain fail-closed. Before any retry, reconcile the durable operation receipt and verify its operation ID and digests; do not blindly replay a possibly-applied mutation.

## Stage 6 status and evidence discipline

- Current status and next work: [What We Have Done](docs/what-we-have-done.md); implementation evidence: [Stage 6 current record](.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-10-status-and-next-steps.md). The links into `.worktree` are local; implementation remains on its Stage 6 branch, not merged into master.
- Do not equate the five basic E2E passes with 6A PASS: the Run test currently accepts any terminal state. Full 6A needs actual Maven success/Run agreement, real logs/PTY/audit, stress and all fault phases; only then begin 6B Tasks 10-12.
- Database schema-reset tests must use disposable schemas. Distinguish migration/test-account privileges from runtime failures; never reset `manao_poc4` to fix a test.
- Preserve narrowly identified unresolved cluster/database diagnostics. Artifact cleanup is not permission to delete runtime resources; delete only inventoried, path-checked obsolete logs, keeping latest useful reports and unresolved-failure evidence.
- A healthy-cluster rerun does not repair failure-path cleanup. Verify initializer/workspace/Job/PVC and dependent DB records, not just afterAll status; do not report a zero-residue environment without checking both systems.
- Do not commit passwords, tokens, raw kubeconfigs or unsanitized traces. Keep private configuration outside tracked files; verify current token identity, node readiness and scheduling capacity before real-cluster acceptance.

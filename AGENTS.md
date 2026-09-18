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

- Current Stage 6A authority: [Current facts](docs/Stage6A-Current-Facts.md). Older status, gate and runtime reports are historical sources only. The Stage 6A implementation was integrated into master with a non-fast-forward merge on 2026-09-18; the 6B branch starts from that integrated baseline.
- On 2026-09-17 the user accepted Stage 6A based on the real MVP lifecycle including manual project deletion and decided to prepare 6B. Do not reinterpret this as all historical PTY/audit/stress/fault gates passing. Use the current facts and actual code when revising the old Tasks 10-12; do not reinstate the old gate as a conflicting current decision.
- Database schema-reset tests must use disposable schemas. Distinguish migration/test-account privileges from runtime failures; never reset `manao_poc4` to fix a test.
- Preserve narrowly identified unresolved cluster/database diagnostics. Artifact cleanup is not permission to delete runtime resources; delete only inventoried, path-checked obsolete logs, keeping latest useful reports and unresolved-failure evidence.
- A healthy-cluster rerun does not repair failure-path cleanup. Verify initializer/workspace/Job/PVC and dependent DB records, not just afterAll status; do not report a zero-residue environment without checking both systems.
- Do not commit passwords, tokens, raw kubeconfigs or unsanitized traces. Keep private configuration outside tracked files; verify current token identity, node readiness and scheduling capacity before real-cluster acceptance.

## SSH Access

- Master node:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\learn.pem' root@1.12.245.235
  ```

- Node 1:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\learn.pem' root@193.112.179.183
  ```

- Node 2:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\learn.pem' root@139.199.194.55
  ```

An SSH tunnel has already been established locally through Xshell, so `kubectl` commands can be used directly.

## Stage 6 evidence and cleanup guardrails

- Current status and acceptance authority: [Stage 6A current facts](docs/Stage6A-Current-Facts.md). Older gate, status and SSH/runtime notes are historical; verify operational values before reusing them.
- The user accepted 6A on 2026-09-17 for the real MVP lifecycle including deletion and is preparing 6B. Historical smoke, PTY/audit/stress/fault results retain their evidence limits; they are not retroactively PASS. Revise old Tasks 10-12 against the current facts rather than consuming the historical gate as the current authority.
- Database tests must use disposable schemas. Never let a schema-reset test drop runtime tables; distinguish test-schema migration privileges from runtime API failures.
- Cleanup must be project- and owner-scoped and cover initializer/workspace/Job resources plus dependent DB records. Preserve one explicitly selected unresolved diagnostic; never broadly delete a namespace or runtime database. Historical initializer/active-Run defects must not be presented as still open without checking current code. Current storage/configuration limits are recorded in the current facts.
- After a test, verify both Kubernetes resources and DB rows; afterAll success alone does not prove no leftovers. Failed scheduling and an 8-project application limit say nothing about actual cluster CPU/storage capacity.
- Before deleting logs/evidence, keep the latest complete useful report and one minimal sample per unresolved failure; record paths, hashes and reasons. Do not run broad git clean/mvn clean, delete reparse targets, or remove live/credential-bearing configuration as artifact cleanup.
- Never commit credentials, bearer tokens, raw kubeconfigs or unsanitized browser traces. A token refresh changes credentials, not Role permissions; verify its identity and restart the backend if it loaded credentials at startup.

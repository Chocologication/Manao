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

## Stage 6A local-cluster runtime notes

- The local-cluster profile uses kubectl port-forward to the server-derived workspace Pod by default. Set MANAO_KUBECTL only to select the kubectl executable; use MANAO_BRIDGE_MODE=fabric8 only for explicit transport comparison, and supervised only when an external bridge is intentionally managed.
- Workspace mutation transport failures remain fail-closed. Before any retry, reconcile the durable operation receipt and verify its operation ID and digests; do not blindly replay a possibly-applied mutation.

## Stage 6 evidence and cleanup guardrails

- Current status: [2026-09-10 status and next steps](poc4/docs/evidence/stage-6/2026-09-10-status-and-next-steps.md); acceptance authority: [6A gate](poc4/docs/evidence/stage-6/6a-gate.md). Treat older SSH/runtime notes as historical; verify current keys, tokens, nodes, quota and process state before using them.
- Five real-backend tests passing is not full 6A acceptance: the Run test currently accepts any terminal state. Require a successful Maven Job and matching DB/API Run, real logs/PTY/audit, stress and all fault phases before 6A PASS; do not begin 6B Tasks 10-12 earlier.
- Database tests must use disposable schemas. Never let a schema-reset test drop runtime tables; distinguish test-schema migration privileges from runtime API failures.
- Cleanup must be project- and owner-scoped and cover initializer/workspace/Job resources plus dependent DB records. Preserve one explicitly selected unresolved diagnostic; never broadly delete a namespace or runtime database. Current initializer omission and active-Run-as-404 behavior remain open; do not treat those paths as reliable cleanup.
- After a test, verify both Kubernetes resources and DB rows; afterAll success alone does not prove no leftovers. Failed scheduling and an 8-project application limit say nothing about actual cluster CPU/storage capacity.
- Before deleting logs/evidence, keep the latest complete useful report and one minimal sample per unresolved failure; record paths, hashes and reasons. Do not run broad git clean/mvn clean, delete reparse targets, or remove live/credential-bearing configuration as artifact cleanup.
- Never commit credentials, bearer tokens, raw kubeconfigs or unsanitized browser traces. A token refresh changes credentials, not Role permissions; verify its identity and restart the backend if it loaded credentials at startup.

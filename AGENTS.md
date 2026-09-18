## Current Stage 6A documentation authority (2026-09-17)

- [Current facts](../../docs/Stage6A-Current-Facts.md) is the sole current 6A evidence and acceptance document in the main checkout; do not create a second copy here.
- [Evolution timeline](../../docs/Stage6A-Evolution-Timeline.md) records prior decisions and plan changes.

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

- Current status and acceptance authority: [Stage 6A current facts](../../docs/Stage6A-Current-Facts.md). Older gate, status and SSH/runtime notes are historical; verify operational values before reusing them.
- The user accepted 6A on 2026-09-17 for the real MVP lifecycle including deletion and is preparing 6B. Historical smoke, PTY/audit/stress/fault results retain their evidence limits; they are not retroactively PASS. Revise old Tasks 10-12 against the current facts rather than consuming the historical gate as the current authority.
- Database tests must use disposable schemas. Never let a schema-reset test drop runtime tables; distinguish test-schema migration privileges from runtime API failures.
- Cleanup must be project- and owner-scoped and cover initializer/workspace/Job resources plus dependent DB records. Preserve one explicitly selected unresolved diagnostic; never broadly delete a namespace or runtime database. Historical initializer/active-Run defects must not be presented as still open without checking current code. Current storage/configuration limits are recorded in the current facts.
- After a test, verify both Kubernetes resources and DB rows; afterAll success alone does not prove no leftovers. Failed scheduling and an 8-project application limit say nothing about actual cluster CPU/storage capacity.
- Before deleting logs/evidence, keep the latest complete useful report and one minimal sample per unresolved failure; record paths, hashes and reasons. Do not run broad git clean/mvn clean, delete reparse targets, or remove live/credential-bearing configuration as artifact cleanup.
- Never commit credentials, bearer tokens, raw kubeconfigs or unsanitized browser traces. A token refresh changes credentials, not Role permissions; verify its identity and restart the backend if it loaded credentials at startup.

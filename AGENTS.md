# Manao Project Documentation

- [Manao Project Goal](docs/Manao-Projects-goal.md) — Defines the product vision, the current POC4 validation slice, and the capabilities intentionally deferred from that slice.
- [What We Have Done](docs/what-we-have-done.md) — Summarizes the completed stages, the evidence boundary for each stage, and the remaining Stage 6 work.
- [Stage 6 Infrastructure Status](docs/Stage6-Infrastructure-Status.md) — Records the measured Kubernetes, container-runtime, image-registry, kubeconfig, and network conditions used for Stage 6A validation.

## Stage 6A local-cluster runtime notes

- The local-cluster profile uses kubectl port-forward to the server-derived workspace Pod by default. Set MANAO_KUBECTL only to select the kubectl executable; use MANAO_BRIDGE_MODE=fabric8 only for explicit transport comparison, and supervised only when an external bridge is intentionally managed.
- Workspace mutation transport failures remain fail-closed. Before any retry, reconcile the durable operation receipt and verify its operation ID and digests; do not blindly replay a possibly-applied mutation.
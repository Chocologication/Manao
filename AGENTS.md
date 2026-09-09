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

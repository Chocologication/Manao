# Stage 6 Infrastructure and Environment Boundaries

Updated: 2026-09-20. This document separates the accepted cloud environment from retained local-debugging arrangements. It is based on checked-in configuration and dated acceptance evidence; this documentation pass did not query, restart or provision infrastructure.

## Accepted Cloud Environment (6B)

| Item | Recorded configuration / evidence |
| --- | --- |
| Namespace / runtime schema | `manao-stage6b` / `manao_poc4_6b` |
| Browser entry | `http://1.12.245.235:30080`, frontend NodePort; HTTP without TLS |
| Application path | Browser → frontend nginx → backend Service → MySQL / Kubernetes / workspace-agent Service |
| Backend identity | `cluster` profile, in-cluster `manao-backend` ServiceAccount; one replica, Recreate strategy |
| Platform database | MySQL 8.0.40 StatefulSet; `data-mysql-0`, 5 GiB, `nfs-storage` |
| Project storage | 10 GiB RWX PVCs, `manao-poc4-delete`; accepted deletion checks cover PV and NFS directory removal |
| Images | Digest-pinned application/agent/runner/initializer references in the [deployment baseline](../poc4/deploy/6b/README.md); MySQL version is tag-pinned |
| Login | Absolute 24-hour lifetime from sign-in in the accepted deployment; browser token stays in memory, so reload/closing the page requires re-login |
| Latest recorded health | 2026-09-20: master/node1/node2 Ready; frontend/backend/MySQL Ready; no local application/tunnel listeners needed for the cloud lifecycle |
| Maintenance and cleanup | 2026-09-20: backend/MySQL each rebuilt once with data preserved; the test project, its four Runs and scoped resources/storage were removed; MySQL volume retained |

The exact build IDs, image digests and measured operations live in the [6B acceptance record](../poc4/docs/evidence/stage-6b/acceptance.md), sections 8–10. Use the [deployment README](../poc4/deploy/6b/README.md) for account setup, deploy order, maintenance and recovery; this page does not duplicate commands or maintain another version table.

Cloud browser use has **no local Vite/backend, SSH or kubectl bridge dependency**. An operator's management connection is separate from the application's runtime identity. Do not load an administrator kubeconfig into the backend to compensate for a missing application permission.

## Retained Local-Debugging Environment (6A)

Use this only when explicitly reproducing local-cluster behavior, not as the current cloud startup procedure.

- Frontend Vite `4173` proxies to local backend `18080`; the `local-cluster` profile uses the workspace bridge selected by server-side configuration.
- Default bridge: `kubectl port-forward`; Fabric8 is an explicit comparison option, and `supervised` needs an intentionally managed external bridge.
- Historical local runtime schema: `manao_poc4`; historical namespace/identity: `manao-stage6-test` / `manao-6a-local`. Confirm actual private configuration before starting or testing.
- Private env/kubeconfig files are kept outside the repository, under the operator's private `Project_Manao_kubeconfig` directory. Their existence does not prove that their token, tunnel or selected storage class is currently valid.
- The 6A acceptance recorded different storage classes in its general local env and deletion-test env. Successful 6B deletion does not establish that old 6A volumes were migrated or old private env files were unified. See [6A storage boundary](Stage6A-Current-Facts.md#71-旧本地配置与存储迁移的证据边界).

## Access, Credentials and Capacity

- Select the intended context, namespace and schema before an operation. A database connector pointing at local port 3306 must not be assumed to access cloud MySQL.
- Use the existing private SSH/kubeconfig configuration for management. Earlier statements that an Xshell tunnel was already connected, or that a particular key/WSL gateway was always valid, are no longer current instructions.
- For a restricted local credential refresh, use the operator's authorized token-issuance path, retain the restricted ServiceAccount identity and reload services that cached the credential. Refresh does not modify RBAC or prove E2E availability; the requested token duration is not a guarantee of actual expiry.
- Check actual node readiness, scheduling requests and applicable quota before cluster tests. The application limit of eight projects per owner is not a reservation or capacity guarantee.
- Project cleanup must not delete the MySQL platform PVC. Never reset either runtime schema (`manao_poc4`, `manao_poc4_6b`) in tests.
- Credential values and private keys do not belong in repository documents. Removal of a historical credential from prose is not proof that it was rotated or removed from Git history.

## Historical Infrastructure Notes Worth Retaining

- 2026-09-02 recorded Kubernetes v1.31.13 and containerd on three nodes; these are dated observations, not a current version inventory.
- Docker Hub is the accepted image-distribution path. The former unauthenticated self-hosted registry, its tunnel, WSL gateway and local insecure-registry configuration are not required by the accepted 6B deployment and have been removed from the current operating instructions.
- Historical CRI image pulls and direct `ctr` pulls followed different mirror paths. When diagnosing a current pull failure, distinguish the actual kubelet/CRI path from an unrelated CLI result; a cached-image success does not prove fresh network access.
- The 2026-09-10 scheduling failure was correlated with insufficient CPU, an unreachable worker and a control-plane taint, not a runtime database privilege error. This does not claim the same failure or retained projects still exist today. [Dated snapshot](../poc4/docs/evidence/stage-6/2026-09-10-readonly-snapshot.json).

For actual prior cleanup outcomes and unresolved evidence, follow the dated source records rather than acting on removed “current residue” lists. This documentation cleanup did not delete runtime resources or change credential/registry configuration.

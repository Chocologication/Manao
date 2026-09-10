# Current Stage 6 Infrastructure Snapshot — 2026-09-10

This section supersedes the dated 2026-09-02 measurements below where they differ. Historical SSH, registry and CRI notes are preserved rather than treated as freshly validated facts.

- Read-only checks after the user-reported cluster restart found master/node1/node2 all Ready. The master retains its control-plane taint; both workers have no taints. The earlier 17:06:40 scheduling failure was insufficient CPU plus an unreachable worker and the control-plane taint, not a runtime MySQL privilege error.
- The restricted kubeconfig authenticates as `manao-stage6-test:manao-6a-local`; selected Job/Pod/port-forward permissions passed, while secrets/nodes access was denied. The admin identity was used only for read-only node/quota inventory. Do not grant node access to the backend to run diagnostics.
- No namespace ResourceQuota object was returned by the operator's current check. The old quota example below is historical, not a current capacity guarantee; the backend's 8-project limit also does not guarantee schedulability.
- The 4173 frontend, 18080 backend and 6443 API tunnel have local listeners. Listener existence is not application health. Runtime schema is `manao_poc4`; destructive tests must use disposable schemas instead.
- One earlier failed project still owns a completed initializer Pod, a Bound PVC and a FAILED database row. It is retained for an unresolved cleanup defect; no cluster or database cleanup was performed during this documentation task.
- The user reports five basic E2E tests passing after restart; the latest run-status file corroborates passed. This is not complete 6A acceptance. See [stage status](what-we-have-done.md#current-gate-status) and [timestamped evidence](../.worktree/ensoai-stage-6-real-backend-kubernetes/poc4/docs/evidence/stage-6/2026-09-10-readonly-snapshot.json).
- Original restricted runtime configuration: `D:\DeepLearning\MyProjects\Project_Manao_kubeconfig\stage6-6a-local-cluster.env`. Keep credentials and kubeconfigs outside tracked documentation; temporary admin configurations are not accepted backend identities.

## Credential hygiene

The previously embedded database password has been removed from this working documentation. It may still exist in Git history; removing the line does not revoke it or scrub history. The operator should arrange credential rotation separately and update private consumers. This review does not rotate credentials, alter grants, remove access instructions or rewrite Git history.

# Historical Access and Infrastructure Notes

# SSH Access

- Master node:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\root.pem' root@1.12.245.235
  ```

- Node 1:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\root.pem' root@193.112.179.183
  ```

- Node 2:

  ```bash
  ssh -i 'C:\Users\shili\.ssh\root.pem' root@139.199.194.55
  ```

An SSH tunnel has already been established locally through Xshell, so `kubectl` commands can be used directly.

# Database Access

## Please prefer to use the MySQL mcp tool to access the database.

## The following information is for necessary use only.

- MYSQL_HOST: `127.0.0.1`
- MYSQL_PORT: `3306`
- Username: `root`
- Credentials: use the existing private environment configuration outside this documentation; never store or print the database password in Markdown.

# Stage 6 (6A) Infrastructure Status (measured on 2026-09-02)

## Cluster Topology and Access

- 3-node K8s v1.31.13, runtime **containerd 1.7.13** (not docker), OS CentOS 8, internal interconnect 172.16.0.x.
- The local machine accesses the API through an Xshell SSH tunnel (127.0.0.1:6443), and `kubectl` is used directly.
- SSH to nodes uses root.pem (learn.pem is no longer valid); docker/ctr/crictl are available at /usr/local/bin on the nodes.
- The master has docker daemon 25.0.5; its /etc/docker/daemon.json was once corrupted (invalid JSON) and has been fixed, with backup as daemon.json.bak.*; Tencent Cloud registry-mirror has been configured.

## Private Image Registry (master, registry:2.8.3)

## Attention: Please prioritize the Docker Hub solution; this solution is only used as a fallback.

- Container name manao-registry, listening on 0.0.0.0:5000, --restart=unless-stopped.
- Access methods:
  - On master itself: 127.0.0.1:5000 (docker pull works directly)
  - Local (Windows) push: first establish an SSH tunnel
    ```powershell
    ssh -i (Join-Path $env:USERPROFILE '.ssh\root.pem') -N -L 0.0.0.0:5000:127.0.0.1:5000 root@1.12.245.235
    ```
    Then docker tag/push uses **172.26.160.1:5000** (WSL gateway; already added to the local docker insecure-registries)
- ⚠️ No data volume: `docker rm manao-registry` will lose all images and require re-pushing.
- No authentication: do not open port 5000 in the cloud security group; access only via the tunnel.
- Verified link: hello-world digest sha256:d1a8d0a4eeb63aff09f5f34d4d80505e0ba81905f36158cc3970d8e07179e59e (local push → master pull+run passed).

## Docker Hub Solution (verified conclusion on 2026-09-02)

- Docker Hub account: chocologic; test repository: chocologic/manao_images_repository (public, anonymous readable).
- Local docker credentials are stored in wincred (docker-credential-wincred); after `docker login` there is no plaintext auths in config.json.
- Link verification: local push → Docker Hub ✓ (hello-world digest sha256:d1a8d0a4..., same digest as in the self-built registry, consistent content addressing); master node crictl pull + run ✓.
- ⚠️ Nodes directly connecting to registry-1.docker.io are **intermittent** (ctr pull hit a 29.9s i/o timeout, while crictl pulled the same image successfully) — direct connection from China servers to Docker Hub is unstable.
- When pushing locally to Docker Hub, the Desktop proxy may report several "Unavailable" errors and then succeed on retry (layer idempotency, no action needed).

## Local Docker Desktop (Windows)

- Install path: D:\Docker\DockerDesktop\frontend\Docker Desktop.exe (not the default Program Files).
- dockerd runs inside the WSL2 VM: the VM's 127.0.0.1 is the VM itself; to access the host use 172.26.160.1 (WSL gateway) or host.docker.internal.
- The Desktop built-in HTTP proxy http.docker.internal:3128 intercepts localhost traffic; `docker push localhost` direct connection is unavailable.
- daemon custom config: C:\Users\shili\.docker\daemon.json (insecure-registries: 172.26.160.1:5000, host.docker.internal:5000).
- The local docker is not logged into Docker Hub (anonymous pull works); cluster nodes can access the internet to pull from Docker Hub (registry:2 verified).

## 6A Restricted kubeconfig

- File: D:\DeepLearning\MyProjects\Project_Manao_kubeconfig\stage6-6a-kubeconfig (outside the repo, do not commit).
- Identity manao-6a-local (SA; tokens were requested for 24h, actual lifetime is server-controlled); namespace manao-stage6-test; Role manao-stage6-backend (all 26 can-i checks pass, including pods/portforward; no secrets/nodes/pv).
- Manual token refresh (run intentionally; not executed by this documentation review). The admin kubeconfig is used only to issue the restricted ServiceAccount token. Do not switch the backend to the admin identity:

  ```powershell
  $kubectl = 'D:\Docker\DockerDesktop\resources\bin\kubectl.exe'
  $adminConfig = 'C:\Users\shili\.kube\config'
  $stage6Config = 'D:\DeepLearning\MyProjects\Project_Manao_kubeconfig\stage6-6a-kubeconfig'

  $token = & $kubectl --kubeconfig $adminConfig --context 'kubernetes-admin@learn' `
    --tls-server-name localhost --request-timeout=20s `
    -n manao-stage6-test create token manao-6a-local --duration=24h
  try {
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
      throw 'Token issuance failed; existing kubeconfig was not changed.'
    }
    & $kubectl --kubeconfig $stage6Config config set-credentials `
      manao-6a-local "--token=$($token.Trim())"
    if ($LASTEXITCODE -ne 0) { throw 'Failed to update restricted credentials.' }
  } finally {
    Remove-Variable token -ErrorAction SilentlyContinue
  }
  & $kubectl --kubeconfig $stage6Config --request-timeout=20s `
    -n manao-stage6-test auth can-i create jobs
  & $kubectl --kubeconfig $stage6Config --request-timeout=20s `
    -n manao-stage6-test get pods
  ```

  `--duration=24h` is a request, not a guaranteed expiry. This was checked against local `kubectl create token --help` on 2026-09-10 (Context7 was unavailable, and the official-web lookup returned no usable content). Refresh does not change RBAC. Restart a backend that loaded the old credentials at startup, using its original restricted environment file; a successful refresh is not itself an E2E rerun.
- Structure highlights: server https://127.0.0.1:6443 + tls-server-name: localhost + real CA (no insecure-skip-tls-verify).

## Script Experience and Pitfalls

- When writing Windows paths inside script template strings, backslashes get swallowed by escaping (\l → l, \D → D): use Join-Path to join segments or write double backslashes.
- ssh batch editing of remote files: base64-encode locally then `echo <b64> | base64 -d > /path`, to avoid quote/heredoc escaping hell.
- Tunnel connectivity check: Test-NetConnection 127.0.0.1 -Port <port>; for registry probing use curl http://127.0.0.1:5000/v2/ (returns 200).

## CRI Tencent Cloud Acceleration Config Check (2026-09-02, all three nodes)

- All three (master/node1/node2) containerd 1.7.13 have the docker.io mirror configured: config.toml's [plugins."io.containerd.grpc.v1.cri".registry.mirrors."docker.io"] endpoint = ["https://mirror.ccs.tencentyun.com"] (legacy config.toml style, no certs.d/hosts.toml) — the config exists and is consistent, **normal**.
- Mirror endpoint probe: https://mirror.ccs.tencentyun.com/v2/ returns 200, latency 25-40ms.
- kubelet/crictl (CRI path) pulling docker.io via the Tencent mirror works: registry:2.8 probe pulled in 5.2s; crictl can pull chocologic personal-repo images.
- ⚠️ **ctr CLI direct connection to registry-1.docker.io keeps timing out** (0 B/s, 29.9s+) — ctr does not read the CRI plugin's mirror config and only goes direct. For testing/troubleshooting image pulls, always use crictl (or kubectl Pod), not `ctr images pull docker.io`.
- ⚠️ Node containerd has cached many common images (busybox/nginx/hello-world/alpine, etc., leftovers from KubeKey/POC): `crictl pull` of common images shows "Image is up to date" and cannot test the network; to test real pulls use a brand-new image (unique digest).
- master config.toml has KubeKey placeholder residue: registry.configs."dockerhub.kubekey.local".auth (username=xxx / password=REPLACE_WITH_REGISTRY_PASSWORD, pointing only to a non-existent host, does not affect docker.io); node1/node2 do not have this section.
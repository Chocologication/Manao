# Stage 6B Deployment Assets (poc4/deploy/6b)

Deploy the Stage 6A workbench backend into the cloud cluster namespace
`manao-stage6b` with its own MySQL instance and schema `manao_poc4_6b`.
All values marked *secret* are generated at deploy time and stored only in
Kubernetes Secrets and the private local env file — never in this repository,
never in reports or logs.

Files:

| File | Purpose |
| --- | --- |
| `namespace.yaml` | Namespace `manao-stage6b` |
| `mysql.yaml` | MySQL 8.0 StatefulSet + headless Service `mysql:3306` + PVC (StorageClass `nfs-storage`) |
| `service-accounts.yaml` | `manao-backend` (token mounted), `manao-workspace-agent` and `manao-maven-runner` (no permissions, no token automount) |
| `backend-rbac.yaml` | Namespace Role for workload resources + read-only ClusterRole (`list persistentvolumes`, `get storageclasses`) |
| `backend.yaml` | Backend Service (ClusterIP 8080) + Deployment (replicas 1, Recreate, probes, full config contract) |
| `config.example.env` | Template of every variable with its explanation (no real values) |

## 1. Build and publish the backend image

From the worktree root:

```bash
mvn -q -f poc4/backend/pom.xml -DskipTests package   # verify the jar builds
docker build -t chocologic/manao_images_repository:6b-backend-<yyyymmdd> poc4/backend
docker push chocologic/manao_images_repository:6b-backend-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:6b-backend-<yyyymmdd>
```

Record the returned `...@sha256:<64 hex>` reference — that digest string is the
value of `BACKEND_IMAGE` in the private env file. The image itself runs
non-root (uid/gid 10001), writes only to `/tmp` and `/app/logs`, contains no
kubeconfig and no kubectl, and exposes 8080.

## 2. Generate secrets (values stay private)

Generate values locally (examples use `openssl`; any equivalent tool is fine):

```bash
# MySQL passwords (two independent values)
openssl rand -base64 36   # -> MYSQL_ROOT_PASSWORD
openssl rand -base64 36   # -> MYSQL_PASSWORD

# JWT secret: any string >= 32 chars (JwtService rejects shorter values)
openssl rand -base64 48   # -> JWT_SECRET

# Ed25519 capability key pair: the code (Ed25519Keys) expects the RAW 32-byte
# keys, standard base64-encoded (NOT PEM, NOT base64url). Generate once and
# persist both halves in the Secret and the private env file:
openssl genpkey -algorithm ed25519 -out /tmp/cap.key
CAP_PRIV=$(openssl pkey -in /tmp/cap.key -outform DER | tail -c 32 | base64)
CAP_PUB=$(openssl pkey -in /tmp/cap.key -pubout -outform DER | tail -c 32 | base64)
rm /tmp/cap.key
```

Application-level verification that the pair matches: the backend startup
(`WorkspaceConfig.workspaceCapabilitySigner`) signs and verifies a probe
request and refuses to start if the pair does not match, so a wrong pair fails
fast at deploy time.

Create the Secrets from the private env file (run from the worktree root,
KUBECONFIG pointing at the operator kubeconfig):

```bash
kubectl create namespace -f poc4/deploy/6b/namespace.yaml || kubectl apply -f poc4/deploy/6b/namespace.yaml
kubectl -n manao-stage6b create secret generic manao-mysql-auth \
  --from-literal=MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" \
  --from-literal=MYSQL_PASSWORD="$MYSQL_PASSWORD"
kubectl -n manao-stage6b create secret generic manao-backend-auth \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=CAPABILITY_PRIVATE_KEY="$CAP_PRIV" \
  --from-literal=CAPABILITY_PUBLIC_KEY="$CAP_PUB"
kubectl -n manao-stage6b create secret generic manao-backend-images \
  --from-literal=BACKEND_IMAGE="$BACKEND_IMAGE" \
  --from-literal=MANAO_WORKSPACE_AGENT_IMAGE="$MANAO_WORKSPACE_AGENT_IMAGE" \
  --from-literal=MANAO_WORKSPACE_INITIALIZER_IMAGE="$MANAO_WORKSPACE_INITIALIZER_IMAGE" \
  --from-literal=MANAO_MAVEN_RUNNER_IMAGE="$MANAO_MAVEN_RUNNER_IMAGE"
```

Before `kubectl apply -f backend.yaml`, substitute the placeholder
`image: manao-poc4-backend:replace-me` with `"$BACKEND_IMAGE"` (e.g.
`sed "s|manao-poc4-backend:replace-me|$BACKEND_IMAGE|" poc4/deploy/6b/backend.yaml | kubectl apply -f -`),
so the running deployment also carries the digest-pinned reference.
The three workspace/runner image values MUST be the Task-1-verified digests from
the private env file — the backend rejects zero/placeholder digests
(`WorkspaceResourceFactory.requireDigest`) and refuses to start.

## 3. One-time database setup

The MySQL container auto-creates database `manao_poc4_6b` and user `manao`
(from `mysql.yaml`). Flyway (built into the app) runs migrations V1–V8 on first
startup. V3 creates a trigger; see section 5 for why the MySQL flag is set.

The single application user (`app_user`) is created once, manually, with a
parameterized statement — no registration endpoint exists, and the repository
test credentials (Alice/Bob) must never be used. Generate the BCrypt hash with
the same parameters as the application (`PasswordService`: `BCryptPasswordEncoder(12)`):

```bash
# One-off hash generation, never stored anywhere except the private env file:
mvn -q -f poc4/backend/pom.xml -DskipTests exec:java \
  -Dexec.mainClass=org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder \
  2>/dev/null || true
# Simplest reliable path: use any BCrypt(12) capable tool, e.g. Python's bcrypt:
python -c "import bcrypt,os; print(bcrypt.hashpw(os.environ['APP_PW'].encode(), bcrypt.gensalt(rounds=12)).decode())"
# (run with APP_PW set in the environment, not pasted into history)
```

Then, from inside the cluster (keeps the password off public networks):

```bash
kubectl -n manao-stage6b exec -it mysql-0 -- \
  mysql -u root -p manao_poc4_6b \
  -e "INSERT INTO app_user (id, username, password_hash, enabled) VALUES (UUID(), '$APP_USERNAME', '$APP_HASH', TRUE);"
```

(`$APP_HASH` is the bcrypt string; run inside the pod so the value is passed
over the cluster-internal exec channel and not through kubectl command lines
on shared terminals.) If the user already exists, verify consistency
(`SELECT id, username, enabled FROM app_user WHERE username = ...`) and do NOT
overwrite the stored hash automatically.

## 4. Deploy order and health checks

```bash
kubectl apply -f poc4/deploy/6b/namespace.yaml
kubectl apply -f poc4/deploy/6b/service-accounts.yaml
kubectl apply -f poc4/deploy/6b/backend-rbac.yaml
kubectl apply -f poc4/deploy/6b/mysql.yaml
# wait for mysql-0 Ready, THEN create secrets (section 2) if not done, then:
kubectl apply -f poc4/deploy/6b/backend.yaml   # with image substituted
kubectl -n manao-stage6b get pods -w
kubectl -n manao-stage6b logs deploy/backend --tail=200   # look for Flyway V1..V8 success
```

Smoke checks:

```bash
kubectl -n manao-stage6b get deploy backend -o jsonpath='{.status.readyReplicas}'
# login through the backend Service (cluster-internal or port-forward):
kubectl -n manao-stage6b port-forward svc/backend 18080:8080
curl -s http://127.0.0.1:8080/actuator/health/readiness
curl -s -X POST http://127.0.0.1:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"...","password":"..."}'
```

`readiness` includes the `db` and `kubernetes` health groups, so an outage of
MySQL or the Kubernetes API removes the pod from the Service without liveness
kill loops; `startupProbe` gives the first Flyway run up to 5 minutes.

Restart / recovery:

```bash
kubectl -n manao-stage6b rollout restart deploy/backend   # keys are Secret-backed; restarts reuse them
kubectl -n manao-stage6b rollout status deploy/backend
```

Data durability: the MySQL StatefulSet PVC (`mysql-data`, StorageClass
`nfs-storage`) survives pod rebuilds and reschedules. It deliberately does NOT
use `manao-poc4-delete` (that class is reserved for project workspaces with
delete-reclaim semantics) and carries no backend-managed project labels, so
project cleanup can never touch it.

## 5. Why `log_bin_trust_function_creators=1`

MySQL 8 enables binary logging by default. Creating or executing stored
functions/triggers on a binlog-enabled server requires either the SUPER
privilege or `log_bin_trust_function_creators=ON`; without it, Flyway's V3
(`CREATE TRIGGER workspace_operation_immutable_digest`) fails with error 1419
and the migration must NOT be misread as an application failure or "solved" by
skipping it. Granting SUPER to the application account is unacceptable
(privilege escalation), so the flag is set server-side via the MySQL
command-line args in `mysql.yaml`. It is a standard, documented toggle for this
exact situation on a single-instance deployment where replication (row-based
binlog safety for trigger replication) is not in use.

## 6. Configuration contract (what the backend actually reads)

Verified against the source code (do not rename without re-verifying):

| Variable | Read where | Injected via |
| --- | --- | --- |
| `SPRING_PROFILES_ACTIVE` | Spring profile selection | `backend.yaml` env (fixed `cluster`) |
| `SERVER_PORT` | Spring `server.port` (cluster profile has no local 18080 override) | `backend.yaml` env (fixed `8080`) |
| `MANAO_K8S_NAMESPACE` | `application.yml` → `BackendProperties.kubernetes.namespace` | `backend.yaml` env (fixed `manao-stage6b`) |
| `MANAO_DB_URL` | `application-cluster.yml` → datasource url | `backend.yaml` env (fixed in-cluster Service URL) |
| `MANAO_DB_USERNAME` / `MANAO_DB_PASSWORD` | `application-cluster.yml` → datasource | `backend.yaml` env + Secret `manao-mysql-auth` |
| `MANAO_WS_EXTRA_ORIGIN` | `WebSocketConfig.registerWebSocketHandlers` (env) | ConfigMap `manao-backend-config` |
| `MANAO_WORKSPACE_STORAGE_CLASS` | `application.yml` → `BackendProperties.Workspace.storageClassName` | ConfigMap `manao-backend-config` |
| `MANAO_WORKSPACE_AGENT_IMAGE` | `application.yml` → `BackendProperties.Workspace.agentImage` (digest-validated) | Secret `manao-backend-images` |
| `MANAO_WORKSPACE_INITIALIZER_IMAGE` | `application.yml` → `BackendProperties.Workspace.initializerImage` (digest-validated) | Secret `manao-backend-images` |
| `MANAO_MAVEN_RUNNER_IMAGE` | `WorkspaceConfig.jobResourceFactory` (`@Value`, required) | Secret `manao-backend-images` |
| `MANAO_JWT_SECRET` | `SecurityConfig.jwtService` (`@Value`, >=32 chars) | Secret `manao-backend-auth` |
| `MANAO_WORKSPACE_CAPABILITY_PRIVATE_KEY` / `_PUBLIC_KEY` | `WorkspaceConfig.workspaceCapabilitySigner` (`@Value`, raw-32-byte base64) | Secret `manao-backend-auth` |

The in-cluster Kubernetes identity comes from `application-cluster.yml`
(`in-cluster: true`, ServiceAccount token/CA paths) and the SA token mounted
via `manao-backend`; `MANAO_K8S_MASTER_URL` and `KUBECONFIG` must stay unset.

No credential values appear in this file, in `config.example.env`, or in any
committed manifest — generate them per sections 2–3.

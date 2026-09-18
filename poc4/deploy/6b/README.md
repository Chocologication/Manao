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
| `configmap.yaml` | Non-secret ConfigMap `manao-backend-config` (the two keys backend.yaml reads via configMapKeyRef) |
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

The namespace is created above (or by `kubectl apply -f .../namespace.yaml` in
section 4) before any Secret. The non-secret ConfigMap is delivered as a file —
`kubectl apply -f poc4/deploy/6b/configmap.yaml` (also part of the section 4
order); backend.yaml reads its two keys via configMapKeyRef, and a missing
ConfigMap surfaces as CreateContainerConfigError on the backend pod.

Before `kubectl apply -f backend.yaml`, substitute the placeholder
`image: manao-poc4-backend:replace-me` with `"$BACKEND_IMAGE"` (e.g.
`sed "s|manao-poc4-backend:replace-me|$BACKEND_IMAGE|" poc4/deploy/6b/backend.yaml | kubectl apply -f -`),
so the running deployment also carries the digest-pinned reference.
Applying backend.yaml unmodified leaves the pod in ImagePullBackOff by design
(fail-fast placeholder). The three workspace/runner image values MUST be the
Task-1-verified digests from the private env file — the backend rejects
zero/placeholder digests (`WorkspaceResourceFactory.requireDigest`) and refuses
to start.

## 3. One-time database setup

The MySQL container auto-creates database `manao_poc4_6b` and user `manao`
(from `mysql.yaml`). Flyway (built into the app) runs migrations V1–V8 on first
startup. V3 creates a trigger; see section 5 for why the MySQL flag is set.

The single application user (`app_user`) is created once, manually, via a
parameterized statement executed from a controlled SQL file — no shell
interpolation ever builds the SQL, no registration endpoint exists, and the
repository test credentials (Alice/Bob) must never be used.

Step 1 — generate the BCrypt hash with the same parameters as the application
(`PasswordService`: `BCryptPasswordEncoder(12)`, e.g. Python's `bcrypt`), with
the password passed through the environment, never typed into a command line:

```bash
APP_PW="$(head -c 48 /dev/urandom | base64)"   # or an operator-chosen password in the env only
APP_HASH="$(APP_PW="$APP_PW" python -c "import bcrypt,os; print(bcrypt.hashpw(os.environ['APP_PW'].encode(), bcrypt.gensalt(rounds=12)).decode())")"
```

Step 2 — build the SQL file via stdin redirection (no `echo`/inline
interpolation into a command argument), then execute it inside the cluster so
neither the password nor the hash crosses the public network:

```bash
mkdir -m 700 /tmp/manao-6b && chmod 700 /tmp/manao-6b
umask 077
printf 'SET @u = '"'"'%s'"'"';\nSET @h = '"'"'%s'"'"';\nINSERT INTO app_user (id, username, password_hash, enabled)\nSELECT UUID(), @u, @h, TRUE\nWHERE NOT EXISTS (SELECT 1 FROM app_user WHERE username = @u);\n' \
  "$APP_USERNAME" "$APP_HASH" > /tmp/manao-6b/app_user.sql

kubectl -n manao-stage6b exec -i mysql-0 -- \
  mysql -u root -p"$MYSQL_ROOT_PASSWORD" manao_poc4_6b < /tmp/manao-6b/app_user.sql
rm -f /tmp/manao-6b/app_user.sql && rmdir /tmp/manao-6b
```

Notes on this procedure:

- The SQL uses a user variable + `WHERE NOT EXISTS` guard, so re-running never
  overwrites an existing account (idempotent, no password overwrite). If the
  row already exists, verify consistency with
  `SELECT id, username, enabled FROM app_user WHERE username = '<name>';`
  inside the pod and do NOT rewrite the stored hash.
- The INSERT itself is a single controlled statement read from a 0600-permission
  file over stdin (`exec -i ... mysql < file`); no SQL fragment is passed
  through shell command arguments, so shell metacharacters cannot corrupt the
  statement and the values never appear in process listings. mysql batch mode
  has no client-side placeholders; the user variables (@u, @h) are set inside
  the statement file and the INSERT selects from them, so the only shell
  interpolation is the file composition step above — if the values may contain
  single quotes, escape them first (`APP_HASH=${APP_HASH//\'/\'\'}`); bcrypt
  hashes are `$2b$...` ASCII and usernames are operator-controlled, so quotes
  are not expected in practice.
- The temporary file is removed immediately; the values exist in plaintext only
  in the operator's private session and the cluster exec channel.

## 4. Deploy order and health checks

```bash
kubectl apply -f poc4/deploy/6b/namespace.yaml
kubectl apply -f poc4/deploy/6b/service-accounts.yaml
kubectl apply -f poc4/deploy/6b/backend-rbac.yaml
kubectl apply -f poc4/deploy/6b/configmap.yaml
kubectl apply -f poc4/deploy/6b/mysql.yaml
# wait for mysql-0 Ready, THEN create secrets (section 2) if not done, then:
# backend.yaml ships the placeholder image manao-poc4-backend:replace-me on purpose
# (fail-fast): applying it unmodified WILL leave the pod in ImagePullBackOff. It MUST
# be substituted with the digest-pinned BACKEND_IMAGE from section 2 before apply.
sed "s|manao-poc4-backend:replace-me|$BACKEND_IMAGE|" poc4/deploy/6b/backend.yaml | kubectl apply -f -
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

## 7. Recorded deviation from the configuration contract

- `MANAO_DB_URL`: the contract table literal is
  `jdbc:mysql://mysql:3306/manao_poc4_6b`, but `backend.yaml` injects
  `jdbc:mysql://mysql.manao-stage6b.svc.cluster.local:3306/manao_poc4_6b`. The
  two are functionally equivalent for a pod in the same namespace (the short
  Service name `mysql` also resolves via the cluster DNS search path); the FQDN
  was chosen so the injected value is unambiguous and auditable regardless of
  search-path configuration. The schema name `manao_poc4_6b` matches the
  contract exactly. To use the contract literal verbatim, replace the value in
  `backend.yaml`; nothing else depends on either form.

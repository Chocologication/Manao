# Stage 6B Deployment Assets (poc4/deploy/6b)

Deploy the accepted POC4 frontend/backend and database into the cloud cluster namespace
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
| `backend-rbac.yaml` | Namespace Role for workload resources + read-only ClusterRole (`list persistentvolumes`, `get storageclasses`); since the 2026-09-22 Java runtime increment the Role also covers per-project statefulsets, Redis deployments/replicasets, secrets, networkpolicies, services patch/update and pod label patch (section 10) |
| `backend.yaml` | Backend Service (ClusterIP 8080) + Deployment (replicas 1, Recreate, probes, full config contract) |
| `frontend.yaml` | Frontend Service (**NodePort 30080**, commented ClusterIP alternative) + Deployment (replicas 1, probes); image placeholder must be substituted before apply |
| `configmap.yaml` | Non-secret ConfigMap `manao-backend-config` (`MANAO_WS_EXTRA_ORIGIN` = accepted public origin, `MANAO_WORKSPACE_STORAGE_CLASS` = `manao-poc4-delete`, plus the five runtime-deps keys `MANAO_PUBLIC_ENTRY_HOST` / `MANAO_RESERVED_PUBLIC_PORTS` / `MANAO_MYSQL_IMAGE_DIGEST` / `MANAO_REDIS_IMAGE_DIGEST` / `MANAO_MYSQL_STORAGE_CLASS`, see 6/6.1) |
| `config.example.env` | Template of every variable with its explanation (no real values) |

## 0. Accepted build baseline (closed and integrated 2026-09-20)

The [acceptance record](../../docs/evidence/stage-6b/acceptance.md), section 10, is the
authority for what was measured. The versions currently deployed and accepted
(redeploy with exactly these digests to reproduce the accepted build; never
redeploy a floating tag):

| Component | Reference |
| --- | --- |
| Integrated baseline | `master`, merge `860cdda` (2026-09-20, pushed); retained source branch `codex/poc4-stage-6b`. Backend image source `d1fad6d`; frontend image source `e47b050`; image digests are below |
| Backend image | `chocologic/manao_images_repository@sha256:ac88b11b38096da9fd3056f264782fecd18f3d5a560f5cf3a4ddd670dd5609cf` (tag `6b-backend-20260918c`) |
| Frontend image (currently deployed, 2026-09-19 focus-refetch fix) | `chocologic/manao_images_repository@sha256:a1915ebbfbf17dd2b4e7e4f7bd4a65422021317ee199c4e8b3160bd7d5afbf86` (tag `6b-frontend-20260919`, built from commit `e47b050`); previous accepted frontend `sha256:887c2e9f…e2699e` (tag `6b-frontend-20260918b`, commit `e948b1a`) remains valid for that round's acceptance record |
| MySQL | `mysql:8.0.40` (tag-pinned; optional digest hardening is described in the `mysql.yaml` comments) |
| Workspace agent / maven runner / initializer images | digest-pinned, delivered via Secret `manao-backend-images` / the private env file (accepted: agent `sha256:bb0dd430…920c`, runner `sha256:6c93d34b…7f0c`, initializer `sha256:73aaf090…1662`) |
| Namespace / schema | `manao-stage6b` / `manao_poc4_6b` |
| Public origin | `http://1.12.245.235:30080` (NodePort 30080, plain HTTP — the transport limitation is recorded in the acceptance doc, sections 3 and 7.3) |

The table above is the closed, accepted Stage 6B baseline — do not rewrite it. The
Java project runtime increment (2026-09-22, `java-runtime-implementation` plan)
prepares additional deployment surface (section 10) on top of this baseline; its
deployment decision, resolved image versions/digests and acceptance results are
recorded in [poc4/docs/evidence/java-runtime/acceptance.md](../../docs/evidence/java-runtime/acceptance.md)
only when the real deployment and acceptance round (Task 9) executes them. The old
6B PASS stays untouched by that round.

## 1. Build and publish the backend image

From the root of the checkout being deployed (the accepted baseline is available on `master`):

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

Create the Secrets from the private env file (run from the selected checkout root,
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

`APP_USERNAME` is not defined by this snippet — read it from the private env
file (same handling as `APP_PW`: generated/kept outside the repo, quoted
before `source`, never recorded in reports or commits).

Step 2 — build the SQL file via stdin redirection (no `echo`/inline
interpolation into a command argument), then execute it inside the cluster so
neither the password nor the hash crosses the public network:

```bash
mkdir -m 700 /tmp/manao-6b && chmod 700 /tmp/manao-6b
umask 077
printf 'SET @u = '"'"'%s'"'"';\nSET @h = '"'"'%s'"'"';\nINSERT INTO app_user (id, username, password_hash, enabled, created_at)\nSELECT UUID(), @u, @h, TRUE, CURRENT_TIMESTAMP(6)\nWHERE NOT EXISTS (SELECT 1 FROM app_user WHERE username = @u);\n' \
  "$APP_USERNAME" "$APP_HASH" > /tmp/manao-6b/app_user.sql

kubectl -n manao-stage6b exec -i mysql-0 -- \
  mysql -u root -p"$MYSQL_ROOT_PASSWORD" manao_poc4_6b < /tmp/manao-6b/app_user.sql
rm -f /tmp/manao-6b/app_user.sql && rmdir /tmp/manao-6b
```

Notes on the two values in this statement:

- `created_at` is `timestamp(6) NOT NULL` with no default (Flyway V1), so the
  INSERT must set it explicitly — a bare `(id, username, password_hash, enabled)`
  INSERT fails with error 1364 on a fresh schema.
- If the values are kept in an env file and loaded with `source`, quote every
  value (single quotes) BEFORE sourcing: BCrypt hashes contain `$` (e.g. the
  `$2b$12$` prefix), and an unquoted assignment lets the shell expand those as
  positional parameters, silently truncating the hash (observed as a 40-char
  stored value and `Encoded password does not look like BCrypt` on login).
  Composing the SQL file with a tool that reads the file directly (python,
  etc.) instead of shell variables avoids the problem entirely.

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

After the frontend is deployed (section 8), verify the public entry from
outside the cluster (measured values from the 2026-09-18 acceptance):

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://1.12.245.235:30080/          # 200 (SPA index)
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://1.12.245.235:30080/api/v1/auth/login \
  -H 'Content-Type: application/json' -d '{"username":"probe","password":"x"}'  # 401 proves the nginx->backend proxy chain
```

Restart / recovery:

```bash
kubectl -n manao-stage6b rollout restart deploy/backend   # keys are Secret-backed; restarts reuse them
kubectl -n manao-stage6b rollout status deploy/backend
```

Data durability: the MySQL StatefulSet PVC (`data-mysql-0`, StorageClass
`nfs-storage`) survives pod rebuilds and reschedules. It deliberately does NOT
use `manao-poc4-delete` (that class is reserved for project workspaces with
delete-reclaim semantics) and carries no backend-managed project labels, so
project cleanup can never touch it. Section 9 covers the verified maintenance
procedures (backend maintenance restart, MySQL pod rebuild, project deletion,
and where the saved data lives).

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
| `MANAO_JWT_LIFETIME` | `SecurityConfig.jwtService` (`@Value`, duration) | `backend.yaml` env (fixed `24h`) |
| `MANAO_JWT_SECRET` | `SecurityConfig.jwtService` (`@Value`, >=32 chars) | Secret `manao-backend-auth` |
| `MANAO_WORKSPACE_CAPABILITY_PRIVATE_KEY` / `_PUBLIC_KEY` | `WorkspaceConfig.workspaceCapabilitySigner` (`@Value`, raw-32-byte base64) | Secret `manao-backend-auth` |
| `MANAO_RESERVED_PUBLIC_PORTS` | `application.yml` → `BackendProperties.RuntimeDeps.reservedPublicPorts` (comma list; must match the deployment's reserved NodePorts, incl. 30080) | ConfigMap `manao-backend-config` + backend.yaml env (configMapKeyRef; shipped 2026-09-22 with `30080` = ports projects may never claim, section 10.4) |
| `MANAO_PUBLIC_ENTRY_HOST` | `application.yml` → `BackendProperties.RuntimeDeps.publicEntryHost` (bare host; empty = access URLs stay null) | ConfigMap `manao-backend-config` + backend.yaml env (configMapKeyRef; shipped 2026-09-22 with the platform host, section 6.1) |
| `MANAO_MYSQL_IMAGE_DIGEST` | `application.yml` → `BackendProperties.RuntimeDeps.mysqlImageDigest` (explicit patch tag like `8.0.40` or `repo@sha256:<64hex>`; required before any project selects MySQL) | ConfigMap `manao-backend-config` + backend.yaml env (configMapKeyRef; shipped 2026-09-22 with the resolved digest, section 10.2) |
| `MANAO_REDIS_IMAGE_DIGEST` | `application.yml` → `BackendProperties.RuntimeDeps.redisImageDigest` (same pinning rules; required before any project selects Redis) | ConfigMap `manao-backend-config` + backend.yaml env (configMapKeyRef; shipped 2026-09-22 with the resolved digest, section 10.2) |
| `MANAO_MYSQL_STORAGE_CLASS` | `application.yml` → `BackendProperties.RuntimeDeps.mysqlStorageClassName` (StorageClass of per-project MySQL data claims; empty falls back to the workspace class) | ConfigMap `manao-backend-config` + backend.yaml env (configMapKeyRef; shipped 2026-09-22 empty = Delete-reclaim fallback, section 10.2) |

The Stage 6B login lifetime is 24 hours from sign-in (absolute expiry, not an
inactivity timeout). The frontend uses the login response's `expiresAt`. Existing
tokens keep their original expiry; sign in again after this setting changes.
Tokens remain in browser memory, so reloading or closing the page still requires
signing in again.

The in-cluster Kubernetes identity comes from `application-cluster.yml`
(`in-cluster: true`, ServiceAccount token/CA paths) and the SA token mounted
via `manao-backend`; `MANAO_K8S_MASTER_URL` and `KUBECONFIG` must stay unset.

No credential values appear in this file, in `config.example.env`, or in any
committed manifest — generate them per sections 2–3.

### 6.1 `MANAO_PUBLIC_ENTRY_HOST` — public access URLs for project ports

The Java runtime increment lets a project expose user-selected public ports
(NodePort 30000–31000 range) that reach the project's run pod. The backend
composes each access URL as `http://<host>:<publicPort>` from
`MANAO_PUBLIC_ENTRY_HOST` (read via `ProjectController.publicEndpointUrl`).
The value is non-secret and lives in ConfigMap `manao-backend-config`; the pod
reads it through a `configMapKeyRef` env entry that `backend.yaml` ships since
the 2026-09-22 runtime deployment round (both former wiring steps are done
in-repo; changing the value only requires editing `configmap.yaml`, re-applying
and restarting `deploy/backend`):

- **Empty:** the API returns `publicPortUrl: null` and the frontend shows the
  assigned ports without an access URL. Nothing else changes — the ports are
  still provisioned and reachable by whoever knows the host.
- **Set (current shipped value: the platform public host, bare IP):** the API
  advertises `http://<host>:<publicPort>` for each provisioned public port.

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

## 8. Frontend image and deployment

The frontend is a static production build of `poc4/frontend` served by
nginx, which also proxies same-origin `/api/` (REST and the
`/api/v1/ws/run-logs` WebSocket) to the backend Service. The browser talks to
a single origin only; no second public address is configured.

Build-time flags are set explicitly in the image (do not rely on env files):

- `VITE_ENABLE_MOCK_API=false` — gates the MSW mock worker (`src/main.tsx`).
- `VITE_ENABLE_EXPERIMENTAL_TERMINAL=false` — gates the experimental terminal
  panel (`src/components/shell/WorkbenchShell.tsx`).
- The legacy `VITE_USE_MSW` value in `.env.local-cluster.example` is not read
  by any code and is irrelevant here.

### 8.1 Build and publish the frontend image

From the root of the checkout being deployed (the accepted baseline is available on `master`):

```bash
docker build -t chocologic/manao_images_repository:6b-frontend-<yyyymmdd> poc4/frontend
docker push chocologic/manao_images_repository:6b-frontend-<yyyymmdd>
docker inspect --format '{{index .RepoDigests 0}}' chocologic/manao_images_repository:6b-frontend-<yyyymmdd>
```

After rolling a new frontend image out, update §0 above (and the acceptance
record) with the new digest and the commit it was built from — the deployed
frontend must stay traceable to a source SHA, otherwise the accepted build
cannot be reproduced.

Record the returned `...@sha256:<64 hex>` reference. The image runs nginx
unprivileged (uid/gid 101, no root master or worker) and listens on 8080.

### 8.2 Deploy the frontend

Deploy AFTER the backend: nginx resolves the upstream hostname
`backend.manao-stage6b.svc.cluster.local` once at startup, so the `backend`
Service must already exist or the frontend pod will fail to start.

```bash
# substitute the placeholder with the digest-pinned image from 8.1, then apply:
sed "s|manao-poc4-frontend:replace-me|$FRONTEND_IMAGE|" poc4/deploy/6b/frontend.yaml | kubectl apply -f -
kubectl -n manao-stage6b get pods -l app.kubernetes.io/name=manao-frontend -w
```

Applying `frontend.yaml` unmodified leaves the pod in ImagePullBackOff by
design (fail-fast placeholder, same convention as backend.yaml).

The Service in `frontend.yaml` is NodePort 30080 — the Stage B decision: the
server has no reusable ingress/host port (Task 1 measured all-accept-no-service
on the public IP), so the public origin is `http://<PUBLIC_IP>:30080` and
ConfigMap `MANAO_WS_EXTRA_ORIGIN` must carry that exact origin (section 8.3).
If a reusable entry appears later, switch back to a ClusterIP Service (see the
commented alternative in `frontend.yaml`).

The nginx upstream inside the image is the backend Service FQDN
`backend.manao-stage6b.svc.cluster.local:8080` (the Service is named
`backend`, not `manao-backend`; the FQDN is unambiguous regardless of search
path, same rationale as MANAO_DB_URL in backend.yaml). nginx resolves it once
at startup, so the `backend` Service must already exist or the frontend pod
fails to start (`host not found in upstream`). Conversely, if the `backend`
Service itself is ever recreated with a new ClusterIP, run
`kubectl -n manao-stage6b rollout restart deploy/frontend` so nginx re-resolves
the static upstream address.

### 8.3 Public origin and WebSocket origin list

The accepted public entry (2026-09-18 measurement) is
`http://1.12.245.235:30080`; the repository `configmap.yaml` ships that exact
value in `MANAO_WS_EXTRA_ORIGIN`, matching the live cluster (plain HTTP — the
transport limitation is recorded in section 0 and in the acceptance record).

When the public entry is enabled or changed (whatever form it takes — existing
server entry, NodePort, HTTPS termination):

- If the public origin differs from what the backend already accepts, update
  the ConfigMap `manao-backend-config` key `MANAO_WS_EXTRA_ORIGIN` with the
  exact origin and restart `deploy/backend` (the WebSocket handler compares
  the browser origin; see section 6).
- If HTTPS terminates on a proxy in front of the frontend, browsers will use
  `wss:` (RunLogTransport derives the WebSocket scheme from the page
  protocol); the nginx `/api/` block already forwards Upgrade/Connection
  headers, so no protocol change is needed on the internal hop.

## 9. Day-2 operations (verified 2026-09-19, acceptance sections 5.2–5.8)

Where to run: everything below is plain `kubectl` against the cluster API. The
API endpoint `https://1.12.245.235:6443` was measured reachable from outside
the server (2026-09-18), so maintenance can be executed from any machine that
holds the operator/admin kubeconfig and credentials (kept in the operator's
private directory, never in this repository) — the developer workstation does
not need to be alive. Day-to-day workbench use needs only a browser and the
public origin; the operator CLI is a maintenance path, not a usage dependency.
A kubectl setup on the server itself was not established or verified in this
round — record the actual execution location if that changes.

Before any backend/MySQL maintenance, confirm no run is active (UI Run panel,
or `GET /api/v1/runs/active` returning `{"run": null}`).

### 9.1 Backend maintenance restart (measured ~57 s total window)

```bash
kubectl -n manao-stage6b scale deploy/backend --replicas=0
# Recreate strategy: the Pod is gone within seconds; observe as long as needed
kubectl -n manao-stage6b get pods -l app.kubernetes.io/name=manao-backend
kubectl -n manao-stage6b scale deploy/backend --replicas=1
kubectl -n manao-stage6b rollout status deploy/backend
```

Measured in the acceptance: Pod gone ~2 s after scale-down, deployment
available ~17 s after scale-up (~57 s including a 30 s observation pause). The
same ReplicaSet reuses the digest-pinned image — this is a restart, not a
redeploy. Afterwards: re-login and confirm projects, files, run history and
stored logs are unchanged, then start a run to verify the execution path.

### 9.2 MySQL pod rebuild (data persists; measured ~35 s to Ready)

```bash
kubectl -n manao-stage6b delete pod mysql-0
kubectl -n manao-stage6b get pods -w   # the StatefulSet recreates mysql-0 automatically
```

The StatefulSet recreates the Pod with the same identity; the PVC
`data-mysql-0` (5Gi, StorageClass `nfs-storage`) stays Bound, so all data
survives (verified in the acceptance: login, project, run history and a fresh
run to SUCCEEDED after the rebuild). Never delete the PVC `data-mysql-0`.

### 9.3 Project deletion (UI path) and interrupted-deletion continuation

Delete from the browser only: project card -> **Delete project** -> native
confirm dialog ("Delete project? … cannot be undone") -> **Delete
permanently**. Measured: synchronous completion, `DELETE
/api/v1/projects/{id}` -> 204, the card disappears and stays gone after
reload; the workspace Pod/Service/PVC, run Jobs and DB rows are reclaimed and
the project PV directory is removed from the NFS export (verified down to the
filesystem in acceptance 5.6/5.8).

If a deletion is ever interrupted and a project is stuck in the `DELETING`
state, its project card shows a **Continue deletion** button that resumes the
pending deletion (behavior inherited from Stage 6A, retained in the UI code;
the 6B fault-injection validation was SKIPPED because no deletion-path change
occurred and all four real deletions completed cleanly — see acceptance 5.4).

### 9.4 Where the saved data lives (what survives what)

| Data | Location | Survives |
| --- | --- | --- |
| MySQL schema `manao_poc4_6b` (projects, runs, logs, users) | PVC `data-mysql-0` -> PV `pvc-d6b6bc54…` (nfs-storage, 5Gi) | backend restart (9.1), MySQL pod rebuild (9.2), node reschedule |
| Project files / workspace | per-project PVC `manao-pvc-<projectId>` (`manao-poc4-delete`, 10Gi RWX) | backend restart; **deleted together with the project** (Delete reclaim, verified to the NFS directory level) |
| Platform config / secrets | namespace objects + registry digests | re-apply per sections 2–4 and 8 |

## 10. Java project runtime increment (wired 2026-09-22; cluster results in the acceptance record)

The `java-runtime-implementation` plan (Tasks 1–7, branch
`codex/java-runtime-implementation`) adds per-project runtime dependencies
(MySQL/Redis), user-selected public ports and bounded web (SERVICE) runs, and
the 2026-09-22 Maven-cache supplement (C1/C2) seeds the runner image and
per-project caches. This section describes the deployment surface; since
2026-09-22 the runtime-deps env wiring ships in-repo (`backend.yaml` +
`configmap.yaml`, see section 6). Deployment outcomes, resolved image
tags/digests, checklist results and the E2E run are recorded only in
[poc4/docs/evidence/java-runtime/acceptance.md](../../docs/evidence/java-runtime/acceptance.md),
never by rewriting the closed 6B PASS above.

### 10.1 RBAC increment (apply before the new backend rolls)

`backend-rbac.yaml` now grants the namespace Role — still strictly inside
`manao-stage6b` — what the new code paths actually touch:

- `apps/statefulsets`, `apps/deployments`: get/list/create/delete (per-project
  MySQL StatefulSet, Redis Deployment);
- `apps/replicasets`: list/delete only (Redis Deployment cleanup inventory; the
  Deployment controller creates ReplicaSets, the backend never does);
- `secrets`: get/list/create/delete (per-project MySQL/Redis auth Secrets);
- `networking.k8s.io/networkpolicies`: get/list/create/delete (per-project
  dependency isolation);
- `services`: + patch/update (public-endpoint selector routing);
- `pods`: + patch (server-verified pod identity label before routing).

Deliberately NOT granted: cluster-wide Service listing, cluster-admin, any PV
write/delete. Cross-namespace NodePort conflicts are decided by the API server
at creation time (fail-closed), not by listing cluster Services. Re-apply with
`kubectl apply -f poc4/deploy/6b/backend-rbac.yaml`, then roll the backend.

### 10.2 Runtime dependency images (no placeholder digests)

The backend rejects floating tags at resource build time (`requirePinnedImage`):
only an explicit patch tag (`8.0.40`) or `repo@sha256:<64hex>` is accepted, and
an empty value fails the resource build fail-closed. The plan fixed the families
(MySQL 8.0.40, Redis 7.4 series); the digest references resolved against
docker.io on 2026-09-22 (`mysql@sha256:ed04aca4…873e9d`,
`redis@sha256:95acc004…c9601`, full values in the acceptance record section 3.5)
ship in ConfigMap `manao-backend-config` and are injected as
`MANAO_MYSQL_IMAGE_DIGEST` / `MANAO_REDIS_IMAGE_DIGEST` backend env (section 6
table). Re-resolve before any future redeploy and record the new values in the
acceptance doc — never reuse a digest resolution from a previous date.

`MANAO_MYSQL_STORAGE_CLASS` (empty = falls back to the workspace class
`manao-poc4-delete`, Delete reclaim): the 2026-09-22 deployment round kept the
Delete-reclaim fallback so deleting a project reclaims its MySQL claim —
matching the acceptance cleanup contract. The platform MySQL StatefulSet volume
(`data-mysql-0`, `nfs-storage`) is never touched by project storage.

### 10.3 Maven runner image

The runner image carries the single-run supervisor for bounded web sessions, the
PTY wrapper, and (since the 2026-09-22 Maven-cache supplement C1/C2) a read-only
seeded Maven repository built from the real workspace templates plus the fixed
`manao-maven` wrapper. Build and publish (PowerShell, from the implementation
checkout root; export fresh templates first so the image matches the current
sources):

```powershell
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile org.codehaus.mojo:exec-maven-plugin:3.5.0:java -Dexec.mainClass=com.manao.poc4.workspace.MavenSeedTemplateExporter -Dexec.classpathScope=test "-Dmanao.seed.output=<abs>/poc4/backend/target/maven-seed-templates"
docker build --build-context "seed-templates=<abs>/poc4/backend/target/maven-seed-templates" -t manao-runner-maven-cache poc4/maven-runner
docker tag manao-runner-maven-cache chocologic/manao_images_repository:<runner-tag>
docker push chocologic/manao_images_repository:<runner-tag>
```

The local tag is NOT a production pin: resolve the pushed
`repo@sha256:<64hex>` (`docker manifest inspect --verbose` / `docker buildx imagetools inspect`) and deliver it as
`MANAO_MAVEN_RUNNER_IMAGE` via Secret `manao-backend-images` (section 1/2
flow). Record the digest, the seed-id (`/opt/manao-maven-seed/seed-id` inside
the image) and any pre-pull evidence in the java-runtime acceptance record;
pre-pull the published digest on the nodes that will schedule Run Jobs before
startup measurements, or record the cold-image condition honestly. No extra
cache PVC is required.

### 10.4 Reserved public ports

`MANAO_RESERVED_PUBLIC_PORTS` lists every NodePort that projects may never
claim — the platform-owned ingress 30080 — and the backend refuses any create
request that selects one of these ports. It ships in ConfigMap
`manao-backend-config` since 2026-09-22 and is injected via `backend.yaml`.
Operator-assigned acceptance ports (30281/30282) are deliberately NOT in this
list: a project claims them through its own creation, and afterwards the API
server rejects any conflicting NodePort at Service creation — fail-closed, no
cluster-wide Service listing. (Correction recorded 2026-09-22: the first wiring
shipped `30080,30281,30282`, which made the acceptance project's own creation
fail with PUBLIC_PORT_RESERVED; the value is now `30080`.)

### 10.5 V9 schema migration

Flyway `V9__project_runtime.sql` runs on the new backend's first startup. Follow
the existing maintenance rules: run it with the migration-privileged identity,
never swap or rebuild the platform MySQL volume (`data-mysql-0`) for the
migration, and do not run incompatible old/new backend versions against the
schema during the switchover window (the Recreate strategy keeps exactly one
backend replica; scale to 0 before schema-incompatible operations).

### 10.6 Cloud acceptance entry (independent of the 6B suite)

`pnpm --dir poc4/frontend test:e2e:java-runtime` drives only the new
`java-runtime-lifecycle.spec.ts` against the public ingress:

- `MANAO_RUNTIME_BASE_URL` — deployed frontend URL (missing: the config fails
  fast, never a silent skip);
- `MANAO_RUNTIME_USERNAME` / `MANAO_RUNTIME_PASSWORD` — private env credentials;
- `MANAO_RUNTIME_PUBLIC_PORT_1` / `MANAO_RUNTIME_PUBLIC_PORT_2` — the two test
  NodePorts, fixed by the operator up front; the suite never scans for free
  ports.

Fixed run shape: workers=1, retries=0, no webServer, one complete pass under a
3.5 h global cap; the bounded two-hour session case raises its own 155 min
timeout. The old `stage6b` config and its collection scope are unchanged.

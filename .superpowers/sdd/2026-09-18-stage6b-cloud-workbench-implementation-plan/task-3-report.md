# Task 3 Report — Stage A: Frontend Local Assets and Local Build Verification

Date: 2026-09-18. Branch `codex/poc4-stage-6b`, HEAD at start `f6db6fb`.
Scope executed: Stage A only (all local files + local builds/validation).
Cluster deployment / public-entry verification is Stage B (cluster API tunnel
currently down; no cluster connection attempted).

## 1. Delivered files

| File | Content |
| --- | --- |
| `poc4/frontend/Dockerfile` | Multi-stage. Build: `node:22.23.2-alpine3.23` (pinned), `npm i -g pnpm@10.33.0` (matches `packageManager` field; chosen over corepack so the version is deterministic and corepack's signature-key fetch can never break the build), `pnpm install --frozen-lockfile`, `pnpm build` with `VITE_ENABLE_MOCK_API=false VITE_ENABLE_EXPERIMENTAL_TERMINAL=false`. Runtime: `nginxinc/nginx-unprivileged:1.27-alpine3.21` (pinned; official nginx build whose master runs as uid/gid 101 — no root master, no root worker), `COPY deploy/nginx.conf` to `/etc/nginx/conf.d/default.conf`, `COPY --from=build /app/dist` to `/usr/share/nginx/html`, `EXPOSE 8080`. |
| `poc4/frontend/.dockerignore` | Excludes node_modules, dist, tests/Playwright artifacts, `.env*` (build flags are set explicitly in the Dockerfile so no local env value can leak into the image), git leftovers, docs. |
| `poc4/frontend/deploy/nginx.conf` | conf.d-level config (see section 3). |
| `poc4/deploy/6b/frontend.yaml` | Service ClusterIP 8080 + Deployment replicas 1 (labels/style aligned with backend.yaml: `app.kubernetes.io/name: manao-frontend`, `part-of: manao`, `stage: 6b`). Commented NodePort Service alternative with `<NODE_PORT_PLACEHOLDER>`. Fail-fast image placeholder `manao-poc4-frontend:replace-me` (same convention as backend.yaml). `runAsNonRoot` uid/gid 101 (matches the unprivileged nginx image), readiness/liveness on `/`, tiny resources (50m/64Mi → 250m/256Mi). |
| `poc4/deploy/6b/README.md` | File table updated; new section 8: image build/push commands, deploy order (frontend after backend), NodePort switch instructions, `MANAO_WS_EXTRA_ORIGIN` backfill reminder for Stage B. No credentials. |

## 2. Mock / terminal switch verification (code-level)

- `VITE_ENABLE_MOCK_API` — real and effective: `poc4/frontend/src/main.tsx:9`
  starts the MSW worker only when the value is exactly `'true'`.
  `false` (or unset) means no mock worker.
- `VITE_ENABLE_EXPERIMENTAL_TERMINAL` — real and effective:
  `poc4/frontend/src/components/shell/WorkbenchShell.tsx:50` (via
  `isExperimentalTerminalEnabled`, true only for the exact string `'true'`);
  it lazily loads `JobTerminalPanel`.
- Confirmed the brief's warning: `VITE_USE_MSW` (only in
  `.env.local-cluster.example`) is not read by any code — it is dead for the
  production bundle. The Dockerfile sets the two real variables explicitly and
  `.dockerignore` excludes `.env*`.

## 3. nginx.conf vs plan key configuration (item by item)

| Plan requirement | Implementation |
| --- | --- |
| `map $http_upgrade $connection_upgrade { default upgrade; '' close; }` | Verbatim. Lives at conf.d include level = http context, which is where `map` is allowed. |
| `listen 8080` | Verbatim (also required by the unprivileged image; 8080 avoids the privileged-port problem). |
| `root /usr/share/nginx/html` | Verbatim, plus `index index.html`. |
| `location /api/` → `proxy_pass http://manao-backend:8080` | Verbatim; `proxy_pass` without a URI keeps the original path (REST `/api/v1/...` and WebSocket `/api/v1/ws/run-logs`). |
| `proxy_http_version 1.1` | Verbatim. |
| `Host $http_host` | Verbatim. |
| `Upgrade` / `Connection` forwarding | Verbatim (`$http_upgrade` / `$connection_upgrade`). |
| `proxy_read_timeout 3600s` | Verbatim; `proxy_send_timeout 3600s` added. |
| `proxy_buffering off` | Verbatim (log streaming must not be buffered). |
| `proxy_next_upstream off` | Verbatim — no automatic retry of write requests. |
| `access_log off` in `/api/` | Verbatim — one-time WebSocket ticket query strings never reach the proxy access log. |
| SPA fallback | `location / { try_files $uri $uri/ /index.html; }` with `Cache-Control: no-cache` on index.html. |

Additions (allowed by the brief): gzip for static text assets;
`Cache-Control: public, max-age=31536000, immutable` for `/assets/`; a scoped
`\.wasm$` location with `default_type application/wasm` (currently no wasm
files are emitted in dist, so this is preventive). `server_name _` added.

## 4. Local verification results (all executed)

- `pnpm --dir poc4/frontend install --frozen-lockfile` — Done (pnpm
  10.33.0, lockfileVersion 9.0).
- `VITE_ENABLE_MOCK_API=false VITE_ENABLE_EXPERIMENTAL_TERMINAL=false pnpm --dir poc4/frontend build`
  — success in ~54 s (includes `tsc -b`). `dist/` = `index.html` (403 B) +
  192 files in `assets/` (62 MB incl. sourcemaps; entry
  `assets/index-Ba7rA_I7.js`). No `mockServiceWorker.js`, no MSW references
  in the bundle (checked index.html and entry chunk). Chunk-size warning for
  `WorkbenchPage-*.js` (4 MB) is pre-existing, not introduced here.
- `pnpm --dir poc4/frontend typecheck` — exit 0.
- `nginx -t` in container:
  `nginx: configuration file /etc/nginx/nginx.conf test is successful`
  (mounted as `/etc/nginx/conf.d/default.conf` on
  `nginxinc/nginx-unprivileged:1.27-alpine3.21`; needed a `--add-host
  manao-backend:...` because the k8s Service DNS name does not resolve on a
  plain local container — in-cluster it resolves normally).
- `docker build -t chocologic/manao_images_repository:6b-frontend-20260918 poc4/frontend`
  — success. Image manifest list digest:
  `sha256:d29ff0e8e4ed62626146c6ab6e0c65925fa0f6dea3b0cba7f9bb28e7feee93e7`.
- `docker push` — pushed; `docker inspect` RepoDigest:
  `chocologic/manao_images_repository@sha256:d29ff0e8e4ed62626146c6ab6e0c65925fa0f6dea3b0cba7f9bb28e7feee93e7`.
  This digest-pinned reference is the `FRONTEND_IMAGE` value for Stage B
  (substitute the placeholder in frontend.yaml before apply).
- Image smoke test (local container): index 200 `text/html`, SPA fallback 200,
  entry asset 200 with `Cache-Control: public, max-age=31536000, immutable`,
  192 assets present, process runs as `uid=101(nginx)`. `/api/` proxy path
  works as configured (502 locally because no backend exists upstream — the
  proxy itself is exercised; real connectivity is Stage B).
- Smoke container removed afterwards; no cluster or external resources touched.

## 5. Design notes / decisions

- **Unprivileged nginx**: the official `nginx` image cannot drop the master
  process from root without hacks; `nginxinc/nginx-unprivileged` is the
  official nginx build (nginxinc, same source) running master+workers as uid
  101, enabling `runAsNonRoot: true` in the pod securityContext. The layout
  (`/etc/nginx/conf.d/*.conf`, `/usr/share/nginx/html`, port 8080) is standard.
- **pnpm via `npm i -g pnpm@10.33.0`** instead of corepack: exact version match
  with `packageManager`, immune to corepack registry/signature-key changes.
- **Frontend Deployment uses RollingUpdate (default)** — stateless static
  files + proxy; the Recreate strategy remains backend-only (workspace
  fencing), per backend.yaml comments.
- **Deploy order constraint**: nginx resolves `manao-backend` at startup and
  exits if unresolvable, so frontend.yaml must be applied after the backend
  Service exists. Recorded in README section 8.2. (An alternative
  variable-upstream + resolver setup would trade determinism for lazy
  resolution; not needed since backend precedes frontend in the deploy order.)
- Docker-build asset hashes differ from local-build hashes
  (`index-D18AvTFx.js` vs `index-Ba7rA_I7.js`) — different toolchain path;
  normal Vite behavior, content-addressed names make this safe.

## 6. Stage B checklist (pending, not executed here)

1. Restore cluster connectivity (API tunnel), verify node readiness/capacity
   as runtime facts before deploying.
2. Ensure secrets/configmap/backend are applied per README sections 2–4.
3. Substitute `manao-poc4-frontend:replace-me` with
   `chocologic/manao_images_repository@sha256:d29ff0e8e4ed...93e7` and apply
   `poc4/deploy/6b/frontend.yaml` (after backend Service exists).
4. Decide the public entry: prefer reusing the existing server entry; enable
   the commented NodePort Service in frontend.yaml only if no reusable path
   exists (fill `<NODE_PORT_PLACEHOLDER>`).
5. If the public origin (or HTTPS origin) differs from what the backend
   accepts, update ConfigMap `manao-backend-config` key `MANAO_WS_EXTRA_ORIGIN`
   with the exact origin and `rollout restart deploy/backend`.
6. `nginx -t` inside the running pod (`kubectl exec ... nginx -t`).
7. From the public entry: load page, log in, verify same-origin `/api/`
   proxy, and confirm browser WS requests go to the public origin (wss if
   HTTPS). Log handshake/transport validation stays with Task 4's Run
   verification.

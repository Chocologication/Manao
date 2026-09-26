# poc4/python-runner

Python runner image of the Manao Python runtime (python runtime plan, task 4): fixed
Python 3.13 + uv + the JRE the shared single-run web supervisor needs, no Maven, plus the
read-only uv cache seed built from the real workspace templates. The root-owned fixed
launcher `/usr/local/bin/manao-python` initializes the private per-project cache and execs
the only two modes (`console|web`); `/usr/local/bin/manao-run-supervisor` is the same
shared supervisor binary the Maven runner uses, compiled from the one true source in
`poc4/maven-runner/runtime/src` (never vendored here).

## Toolchain and seed identity (resolved by real pulls, task 4 step 2/5)

| Component | Resolved value | Evidence |
| --- | --- | --- |
| Base image | `python:3.13.15-slim` (Debian 13 trixie, CPython 3.13.15), digest `sha256:8d9d0b8bcf6506481eae4907c18f5e3e7902e629f5f6d684f9e7c32e85e3ddf0` | `docker pull python:3.13.15-slim`, `docker image inspect` RepoDigests, 2026-09-25 |
| uv | `ghcr.io/astral-sh/uv:0.11.6` (x86_64-unknown-linux-musl), digest `sha256:b1e699368d24c57cda93c338a57a8c5a119009ba809305cc8e86986d4a006754` | `docker pull`, `docker image inspect` RepoDigests, `uv self version` in the container |
| JRE | Debian trixie `default-jre-headless` (OpenJDK 21) installed at build time; the compile stage uses `default-jdk-headless` of the same distribution | `apt-cache policy default-jre-headless` (candidate `2:1.21-76`) in the base image |
| Interpreter | `/usr/local/bin/python3` = CPython 3.13.15 (matches the templates' `requires-python ==3.13.*`) | base image `PYTHON_VERSION=3.13.15` |
| Seed | `/opt/manao-python-seed/seed-id` (64-hex content version) over `uv --version`, `python3 -V`, `uname -m` and the sorted sha256 of every seeded file; `/opt/manao-python-seed/uv-cache` holds the seeded cache (747 files, ~30 MB for the current template set) | printed by the seed-build stage; the seed-id `a3687aae7fe59204cd1a23454fd71ccb0c4e400a9200a52cb5e76a090c0295e5` was reproduced unchanged by the 2026-09-26 rebuild below (same template set, same toolchain) |

Recorded builds of this image (local test tags; **a local tag is never a
production pin**):

| Build | Commit state | Local tag / image id | Verification on the built image |
| --- | --- | --- | --- |
| Task 4 first accepted build, 2026-09-25 | `ba7dccb` | `manao-python-runtime-test` (since overwritten) | suites below 13/13 + 12/12 |
| Rebuild with the final branch sources (includes the `419d211` directory-keyed seeding fix in `manao-python`), 2026-09-26 | implementation branch at Task 10 prep (`869c34e`; launcher/seeder/Dockerfile/templates identical to `419d211` state) | `manao-python-runtime-test` id `5027b784050a` | in-image `uv --version` = 0.11.6, `python3 -V` = 3.13.15, seed-id read back = `a3687aae…295e5`; suites below 13/13 + 13/13 |

Release requirement (task 10): the production image is built from the release
checkout, pushed per the deployment README section 11.1, and delivered
digest-pinned as `MANAO_PYTHON_RUNNER_IMAGE` via Secret `manao-backend-images`
— the local image ids above are recording evidence only. The workspace-agent
image (`poc4/workspace-agent`) pins the same `python:3.13.15-slim` and
`uv 0.11.6` digests, so the agent-side dependency resolver and the runner
verify identical Python/uv versions.

uv `0.11.6` is the same version that generated the committed `uv.lock` files (lock
revision 3, `requires-python ==3.13.*`, extras `mysql` = `pymysql[rsa]` and `redis`), so
the seed is produced by the same uv/Python/platform key the runner uses at runtime; cache
keys match. The one-seed-per-toolchain policy (design section 6) is maintained by this
image: no cross-uv/Python/platform cache migration exists.

The seed-id of a built image can be read with:

```bash
docker run --rm --network none --entrypoint /bin/sh <image> -c 'tr -d "[:space:]" < /opt/manao-python-seed/seed-id'
```

## Build and tests

Build from the repository root with the named context carrying the exported templates
(`PythonSeedTemplateExporter` via the backend module; the exporter only ever writes to
`poc4/backend/target/python-seed-templates`):

```bash
mvn -q -f poc4/backend/pom.xml -DskipTests test-compile \
  org.codehaus.mojo:exec-maven-plugin:3.5.0:java \
  '-Dexec.mainClass=com.manao.poc4.workspace.PythonSeedTemplateExporter' \
  '-Dexec.classpathScope=test' "-Dmanao.seed.output=<repo>/poc4/backend/target/python-seed-templates"
docker build -f poc4/python-runner/Dockerfile \
  --build-context "seed-templates=<repo>/poc4/backend/target/python-seed-templates" \
  --target runtime-test -t manao-python-runtime-test .
```

The `runtime-test` stage additionally carries the exported template variants under
`/opt/manao-python-templates` for the black-box container tests; the production stage
copies the seed, supervisor classes and launchers only. Both stages share the same
Python/uv/JRE distribution and the same seed.

Black-box tests (real containers, production shape UID/GID 10001, read-only rootfs,
writable per-container `/tmp` volume mirroring the Job's writable `emptyDir`; every
container/volume removed by exact name on exit):

```bash
bash poc4/python-runner/tests/runtime-lifecycle.sh manao-python-runtime-test
bash poc4/python-runner/tests/python-cache.sh manao-python-runtime-test
```

`runtime-lifecycle.sh` covers the real uv/Python launch chain only (launcher mode
discipline, console TASK exit 0/1, Chinese UTF-8 logs, FastAPI readiness + business
traffic + TERM stop, install blocking past the startup deadline, short expiry, forced
reaping of a TERM-ignoring derived Python child, low port 80). The shared supervisor
claim/receipt/deadline state machine is not re-tested here —
`poc4/maven-runner/tests/runtime-lifecycle.sh` keeps that matrix.
`python-cache.sh` covers the seed/cache contract (seed content, cold cache offline
startup, warm reuse without rewrites, download/reuse/remove via manifests pre-generated
by real `uv add/remove`, stale-lock fail-closed, server-controlled extras booleans,
cross-project cache isolation, wiped-cache repair, stale-marker repair after a
cache-directory-only loss, interrupted seed without marker).

Both suites share their hardened Docker harness — pid-embedded unique names,
register-only-after-creation, semantic volume-name classification, daemon-clock
staleness proof, persistent fail-fast registry, exact-name cleanup — in
`poc4/python-runner/tests/lib.sh`, the pattern accepted for Task 3's
`poc4/maven-runner/tests/runtime-lifecycle.sh`.

## Runtime contracts (design sections 6 and 7)

- Modes: `/usr/local/bin/manao-python console|web` only. Anything else exits 2 before any
  cache, venv or install work. `web` requires the server-provided `MANAO_PRIMARY_PORT`.
- Fixed toolchain environment: `UV_PROJECT_ENVIRONMENT=/tmp/manao-python/.venv` (per-Run
  venv, dies with the Pod), `UV_CACHE_DIR=/python-cache/uv-cache` (inside the private
  per-project cache mount), `UV_LINK_MODE=copy`, `UV_PYTHON_DOWNLOADS=never`,
  `PYTHONUNBUFFERED=1`, `PYTHONDONTWRITEBYTECODE=1`.
- Install argv is fixed: `uv sync --locked --no-dev --no-build --no-config --python
  /usr/local/bin/python3` plus `--extra mysql` / `--extra redis` only when the
  server-controlled booleans `MANAO_PYTHON_MYSQL` / `MANAO_PYTHON_REDIS` are `true`.
  The extras are pinned booleans, never an arbitrary array. A failed install exits
  non-zero before user code starts; preparation logs share the application's
  stdout/stderr and never print environment values or credentials.
- Cache seeding: one seed per fixed uv/Python/platform toolchain. A not-yet-existing
  cache directory (`/python-cache/uv-cache`) is initialized exactly once — whole-seed
  copy into a same-volume staging directory, atomic rename, completion marker
  `/python-cache/seeded-<seed-id>` published last — and the decision keys on the
  directory's existence, so a stale marker left behind by a lost cache directory is
  repaired by the re-seed. An existing cache directory is never copied over; uv manages
  it. Interrupted initializations leave only staging directories, which the next run
  sweeps. There is no cross-toolchain cache migration or auto-refill.
- Mounts: project code at `/workspace` (container working directory), project cache at
  `/python-cache` (the workspace PVC's `.manao-cache/python` subPath), run control at
  `/run-control` (shared supervisor), `/tmp` writable. The image carries no Maven.

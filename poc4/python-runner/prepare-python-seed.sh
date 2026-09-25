#!/bin/bash
# Seeds the read-only uv cache of the Python runner image (python runtime plan, task 4).
# Runs inside the seed-build Docker stage: root, with network access for the first
# downloads.
#
# Usage: prepare-python-seed.sh <exported-templates-dir> <seed-output-dir>
# Produces:
#   <seed-output-dir>/uv-cache  a uv cache covering the five fixed template variants
#                               (console, web, web-mysql, web-redis, web-mysql-redis),
#                               keyed for exactly the uv/Python/platform of this image
#   <seed-output-dir>/seed-id   one-line content version: sha256 over the tool identity
#                               (uv, Python, machine) and the sorted contents of every
#                               seeded file
#
# The seed is built only from the exported real templates (PythonSeedTemplateExporter);
# it never touches user projects and never reads a host cache. Each variant is installed
# with the exact locked-argv shape the runtime launcher uses, so the cache keys match what
# `uv sync --locked` looks up at run time. Locks must already be consistent with their
# declarations: this script never re-locks or rewrites a template. Completeness of the
# seed is proven, not assumed: a fresh venv must install the no-database web template
# fully offline (--offline; tests/python-cache.sh later repeats this under --network
# none), serve readiness and business traffic, and stop cleanly before the build may
# continue. set -euo pipefail per the plan's shell entry constraint.
set -euo pipefail

TEMPLATES="${1:?usage: prepare-python-seed.sh <templates-dir> <seed-output-dir>}"
OUTPUT="${2:?usage: prepare-python-seed.sh <templates-dir> <seed-output-dir>}"
CACHE_DIR="$OUTPUT/uv-cache"
SEED_ID_FILE="$OUTPUT/seed-id"

# Variant -> fixed extras of the single real web lock (named extras, never rewritten).
variant_extras() {
  case "$1" in
    web-mysql)       printf '%s' "--extra mysql" ;;
    web-redis)       printf '%s' "--extra redis" ;;
    web-mysql-redis) printf '%s' "--extra mysql --extra redis" ;;
    *)               printf '%s' "" ;;
  esac
}

VARIANTS="console web web-mysql web-redis web-mysql-redis"
for variant in $VARIANTS; do
  [ -f "$TEMPLATES/$variant/pyproject.toml" ] || { echo "seed: missing exported template '$variant/pyproject.toml'" >&2; exit 2; }
  [ -f "$TEMPLATES/$variant/uv.lock" ] || { echo "seed: missing exported template '$variant/uv.lock'" >&2; exit 2; }
done

# Tool identity of the seed; the runtime launcher relies on exactly this toolchain being
# in the image, so the seed-id pins what the cache keys were derived from.
echo "seed: uv $(uv --version)"
echo "seed: $(python3 -V) on $(uname -m)"

WORK="$(mktemp -d)"
cleanup_work() { rm -rf "$WORK"; }
trap cleanup_work EXIT

mkdir -p "$CACHE_DIR"

# One cache for the fixed toolchain: every variant installs into its own scratch venv but
# shares UV_CACHE_DIR, so the final cache is the union of all locked dependencies.
for variant in $VARIANTS; do
  echo "seed: installing locked dependencies of $variant"
  (
    cd "$TEMPLATES/$variant"
    UV_CACHE_DIR="$CACHE_DIR" \
    UV_PROJECT_ENVIRONMENT="$WORK/venv-$variant" \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    uv sync --locked --no-dev --no-build --no-config \
      --python /usr/local/bin/python3 \
      $(variant_extras "$variant")
  )
done

# Real verification: the no-database web template must start from the seed cache alone,
# in a fresh venv, with uv locked to offline mode so a missing artifact can only fail.
echo "seed: proving offline startup of the web template from the cache"
(
  cd "$TEMPLATES/web"
  UV_CACHE_DIR="$CACHE_DIR" \
  UV_PROJECT_ENVIRONMENT="$WORK/venv-verify" \
  UV_LINK_MODE=copy \
  UV_PYTHON_DOWNLOADS=never \
  uv sync --offline --locked --no-dev --no-build --no-config \
    --python /usr/local/bin/python3
)

"$WORK/venv-verify/bin/python" -u -m uvicorn app.main:app \
  --app-dir "$TEMPLATES/web" --host 127.0.0.1 --port 8000 >/tmp/seed-web-run.log 2>&1 &
UVICORN_PID=$!

probe() { # URL -> exit 0 only for a 200 response
  "$WORK/venv-verify/bin/python" - "$1" <<'PROBE_EOF'
import sys, urllib.request
try:
    with urllib.request.urlopen(sys.argv[1], timeout=3) as response:
        sys.exit(0 if response.status == 200 else 1)
except Exception:
    sys.exit(1)
PROBE_EOF
}

READY=""
i=0
while [ "$i" -lt 240 ]; do
  if probe "http://127.0.0.1:8000/health/ready"; then READY=1; break; fi
  if ! kill -0 "$UVICORN_PID" 2>/dev/null; then break; fi
  sleep 1
  i=$((i+1))
done
if [ -z "$READY" ]; then
  echo "seed: web template never became ready offline" >&2
  tail -n 60 /tmp/seed-web-run.log >&2
  kill -9 "$UVICORN_PID" 2>/dev/null || true
  exit 3
fi
echo "seed: web template listener ready offline"
DEMO="$("$WORK/venv-verify/bin/python" -c '
import sys, urllib.request
with urllib.request.urlopen("http://127.0.0.1:8000/api/demo", timeout=3) as response:
    sys.stdout.write(response.read().decode("utf-8"))
' 2>/dev/null || true)"
case "$DEMO" in
  *'Hello from Manao'*) ;;
  *)
    echo "seed: unexpected business response: $DEMO" >&2
    kill -9 "$UVICORN_PID" 2>/dev/null || true
    exit 4
    ;;
esac
echo "seed: business endpoint verified offline"

# Normal stop: SIGTERM to uvicorn, finite wait, and the listener must stop answering.
kill "$UVICORN_PID" 2>/dev/null || true
i=0
while [ "$i" -lt 30 ]; do
  kill -0 "$UVICORN_PID" 2>/dev/null || break
  sleep 1
  i=$((i+1))
done
if kill -0 "$UVICORN_PID" 2>/dev/null; then
  echo "seed: uvicorn did not stop on SIGTERM" >&2
  kill -9 "$UVICORN_PID" 2>/dev/null || true
  exit 5
fi
wait "$UVICORN_PID" 2>/dev/null || true
if probe "http://127.0.0.1:8000/health/ready"; then
  echo "seed: app still serving after uvicorn stopped" >&2
  exit 6
fi
echo "seed: web template stopped cleanly"

[ -n "$(find "$CACHE_DIR" -type f -print -quit)" ] || { echo "seed: cache is empty" >&2; exit 7; }

cd "$CACHE_DIR"
{
  uv --version
  python3 -V
  uname -m
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
} | sha256sum | cut -d' ' -f1 > "$SEED_ID_FILE"

echo "seed: cache holds $(find . -type f | wc -l) files, seed-id $(cat "$SEED_ID_FILE")"

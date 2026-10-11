#!/bin/bash
# Dependency-editing verification for the workspace-agent image (python runtime plan, task 7).
#
# Usage (needs a Docker CLI talking to a Linux-container daemon):
#   bash poc4/python-runner/tests/dependency-editor.sh <workspace-agent-test-image> [prefix]
# The image is built with:
#   docker build -t manao-python-workspace-agent-test poc4/workspace-agent
#
# Drives the REAL HTTP surface (POST /agent/v1/python-dependencies/prepare and /commit) of a
# real agent container with capability-signed requests — the same Ed25519 line protocol the
# backend uses — over a real workspace volume, and proves design 6.2's boundaries:
#   capability-enforced    the new endpoints are covered by the same capability filter
#   toolchain-identity     the image carries the runner-aligned Python 3.13 / uv 0.11.6 and a
#                          root-owned, non-writable dependency helper
#   prepare-add            one real `uv add httpx==0.28.1` through prepare: sources stay
#                          unchanged, the PREPARED journal exists, and the combined digest
#                          formula recomputes from the manifest to the response digests
#   prepare-idempotent     the same id + request returns the same summary without resolving
#                          again (recorded timing, no second uv run)
#   mismatch-rejected      the same id with a different request digest is rejected 409 without
#                          touching the journal
#   commit-applies         the backend-style receipt is verified against the journal, both
#                          files are replaced, `uv lock --check` confirms lock consistency
#   commit-idempotent      the lost-response replay of the same commit returns the same result
#                          without rewriting (lock mtime unchanged)
#   commit-tamper-rejected a commit whose receipt digest does not match fails closed 409
#   prepare-remove-commit  one real `uv remove httpx` through prepare+commit; the lock keeps
#                          matching and no dependency residue remains
#   unsupported-scope      build backend, private index and dependency-declaration sources
#                          (direct URL, git+, path) all fail 422 PYTHON_DEPENDENCY_UNSUPPORTED
#                          before uv runs — a pre-existing direct URL can never make the agent
#                          contact a non-PyPI address
#   no-wheel-category      a real uv resolution against the pinned registry that cannot provide
#                          a usable wheel (missing package) is its own fixed safe category
#                          422 PYTHON_DEPENDENCY_NO_WHEEL, never a generic failure, and leaves
#                          no journal
#   no-platform-wheel      a package that RESOLVES into the universal lock but has no wheel
#                          for the pinned Linux target (pywin32==312 ships Windows-only
#                          wheels) must be caught by the installability verification
#                          (`uv sync --locked ... --dry-run` in the scratch): 422
#                          PYTHON_DEPENDENCY_NO_WHEEL, no journal, sources untouched — the
#                          successful `uv add --no-sync` alone never means PREPARED
#   helper-hang-kills-tree with the resolution budget at 2 s and a test-only helper that hangs
#                          after spawning a sleeper child (helper-path env override, per-run
#                          volume — the production image is untouched), the OUTER budget kills
#                          the helper AND its whole child tree: 504 within the helper wait
#                          (budget + 2 s agent margin — helperWaitSeconds, strictly below the
#                          backend's budget + 10 s request timeout), no orphaned process, no
#                          journal
#   timeout-kills-tool     with the resolution budget at 2 s and a hanging test-only uv shim
#                          (PATH override, per-run volume — the production image is untouched),
#                          prepare fails 504 PYTHON_DEPENDENCY_TIMEOUT within the budget margin
#                          and the killed uv process tree leaves no orphan
#   mirror-observed        after a real prepare-add + commit, every URL recorded in the
#                          committed uv.lock comes from the pinned Aliyun mirror: the registry
#                          source is byte-identical to https://mirrors.aliyun.com/pypi/simple/
#                          (trailing slash included) and artifacts live under
#                          mirrors.aliyun.com/pypi/packages/ — no pypi.org / pythonhosted
#                          residue, because the lock's recorded URLs are what the runtime's
#                          `uv sync --locked` downloads from
#   fixed-index-argv       with UV_DEFAULT_INDEX and UV_INDEX pointing at a hostile host in
#                          the AGENT container environment, a real prepare-add + commit still
#                          records only the pinned mirror in the generated pyproject and lock
#                          (the helper's fixed `--default-index` argv wins over the
#                          environment; the agent additionally launches the helper with a
#                          minimal environment), so the container env cannot steer resolution
#   tooluva-policy         the [tool.uv] scope check compares index URLs by exact string
#                          equality against the pinned mirror URL (trailing slash included):
#                          a pyproject declaring the FORMER pypi.org default index, or the
#                          mirror URL without its trailing slash, is rejected 422
#                          PYTHON_DEPENDENCY_UNSUPPORTED before uv runs, with no journal
#   prepare-batch          a multi-line requirements text (exact pin, version range, whole-line
#                          comment, blank line) is imported through ONE prepare-batch call with
#                          exactly ONE `uv add -r <private file>` invocation (logged by a
#                          test-only uv shim, per-run volume + PATH override — the production
#                          image is untouched) plus the one installability verification: the
#                          workspace sources stay untouched, the journal holds BOTH packages
#                          and no comment residue, and the pinned mirror is in the fixed argv
#   batch-unsupported      requirements lines that could switch or nest sources (-r,
#                          --index-url, git+, local path) are rejected 422
#                          PYTHON_DEPENDENCY_UNSUPPORTED before uv runs, with no journal and
#                          untouched sources
#
# Docker ownership (names, registration, volume identity, registry, cleanup) is shared with
# the other runner suites via tests/lib.sh — the hardened Task 3 pattern. Host-side JSON
# parsing uses python3/python and signing uses openssl (both present in the accepted
# development environment); assertions use HTTP status codes, response digests, manifest
# content recomputation and workspace file state — never log text matching.
set -euo pipefail

IMAGE="${1:?usage: dependency-editor.sh <workspace-agent-test-image> [prefix]}"
PREFIX="${2:-manao-py-dep-$$}"
HARNESS_NAME="dependency-editor"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "dependency-editor: image '$IMAGE' does not exist; build it first (task 7 step 5)" >&2
  exit 2
fi

PYTHON_BIN=""
for candidate in python3 python; do
  # The Windows Store python3 alias exists but does not execute: verify the interpreter runs.
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'print("ok")' >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v "$candidate")"
    break
  fi
done
for tool in curl openssl sha256sum base64; do
  command -v "$tool" >/dev/null 2>&1 || { echo "dependency-editor: host tool '$tool' is required" >&2; exit 2; }
done
[ -n "$PYTHON_BIN" ] || { echo "dependency-editor: a working python3/python is required on the host for JSON parsing" >&2; exit 2; }

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_DIR="$SOURCE_DIR/../../backend/src/main/resources/workspace-template-python"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/${PREFIX}-work.XXXXXX")"
AGENT_NAME=""
AGENT_PORT=""
PROJECT_ID="0f2b1c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d"
PROJECT_ID_SHIM="1f2b1c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_ADD="7f0a1c3d-0001-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_REMOVE="7f0a1c3d-0003-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_TIMEOUT="7f0a1c3d-0002-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_NOWHEEL="7f0a1c3d-0005-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_PLATFORMWHEEL="7f0a1c3d-0006-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_HELPERHANG="7f0a1c3d-0004-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_ENVOVR="7f0a1c3d-0007-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_TOOLUVA="7f0a1c3d-0008-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_BATCH="7f0a1c3d-0009-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_BATCH_REJECT_1="7f0a1c3d-000a-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_BATCH_REJECT_2="7f0a1c3d-000b-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_BATCH_REJECT_3="7f0a1c3d-000c-4a6b-8c9d-0e1f2a3b4c5d"
OPERATION_BATCH_REJECT_4="7f0a1c3d-000d-4a6b-8c9d-0e1f2a3b4c5d"

# shellcheck source=lib.sh
. "$SOURCE_DIR/lib.sh"

harness_init
trap 'rm -rf "$WORK"; harness_cleanup' EXIT

# ---------------------------------------------------------------------------
# Host-side request machinery (the backend's capability line protocol)
# ---------------------------------------------------------------------------

now_ms() { date +%s%3N; }

# Signs one POST body: canonical "v1\nPOST\n<uri>\n<sha256(body)>\n<projectId>\n<issuedAt>\n<nonce>".
sign_post() { # PROJECT_ID URI_PATH BODY_FILE -> capability header on stdout
  local project="$1" uri="$2" body="$3"
  local nonce issued body_sha
  nonce="$(openssl rand -base64 16 | tr '+/' '-_' | tr -d '=')"
  issued="$(now_ms)"
  body_sha="$(sha256sum "$body" | cut -d' ' -f1)"
  printf 'v1\nPOST\n%s\n%s\n%s\n%s\n%s' "$uri" "$body_sha" "$project" "$issued" "$nonce" > "$WORK/canonical.bin"
  local sig
  sig="$(openssl pkeyutl -sign -inkey "$WORK/capability.pem" -rawin -in "$WORK/canonical.bin" 2>/dev/null \
    | base64 -w0 | tr '+/' '-_' | tr -d '=')"
  printf 'v1.%s.%s.%s.%s' "$project" "$issued" "$nonce" "$sig"
}

# Sends one signed POST: sets HTTP_STATUS and writes the response body to $WORK/resp.json.
post_json() { # AGENT_PORT PROJECT_ID URI_PATH BODY_FILE
  local port="$1" project="$2" uri="$3" body="$4"
  local header
  header="$(sign_post "$project" "$uri" "$body")"
  HTTP_STATUS="$(curl -sS -o "$WORK/resp.json" -w '%{http_code}' -X POST \
    "http://127.0.0.1:$port$uri" \
    -H "X-Manao-Workspace-Capability: $header" \
    -H 'Content-Type: application/json' \
    --data-binary @"$body")"
}

json_field() { # FILE PYTHON-EXPR -> prints the evaluated field
  "$PYTHON_BIN" -c "
import json, sys
with open(sys.argv[1], encoding='utf-8') as handle:
    data = json.load(handle)
print($2)
" "$1" "$2"
}

# Builds one prepare-batch request body: the multi-line requirements text travels as ONE
# properly escaped JSON string — exactly the wire contract the backend transport uses.
build_batch_body() { # OUT_FILE OPERATION_ID REQUEST_SHA REQUIREMENTS_FILE
  "$PYTHON_BIN" - "$@" <<'PYEOF'
import json, sys
out, operation, digest, requirements_path = sys.argv[1:5]
with open(requirements_path, encoding="utf-8") as handle:
    text = handle.read()
body = {"operationId": operation, "requestSha256": digest, "requirementsText": text}
with open(out, "w", encoding="utf-8") as handle:
    handle.write(json.dumps(body))
PYEOF
}

# Copies the real exported template into the agent's workspace volume (via docker cp, no host
# bind mounts) and hands it to the runtime user.
seed_template() { # NAME
  local pyproject_src uvlock_src
  pyproject_src="$TEMPLATE_DIR/pyproject.toml"
  uvlock_src="$TEMPLATE_DIR/uv.lock"
  command -v cygpath >/dev/null 2>&1 && { pyproject_src="$(cygpath -m "$pyproject_src")"; uvlock_src="$(cygpath -m "$uvlock_src")"; }
  docker cp "$pyproject_src" "$1:/workspace/pyproject.toml"
  docker cp "$uvlock_src" "$1:/workspace/uv.lock"
  dc exec --user 0 "$1" chown 10001:10001 /workspace/pyproject.toml /workspace/uv.lock
}

# The agent image has the fixed production ENTRYPOINT, so the shared prep_dir helper (which
# passes the chown as the container command) cannot be used: override the entrypoint for this
# one-shot root chown instead. The image itself is untouched.
prep_agent_volume() { # VOLUME MOUNTPOINT
  dc_t 120 run --rm --user 0 --entrypoint /bin/sh -v "$1:$2" "$IMAGE" -c "chown 10001:10001 '$2'" >/dev/null 2>&1 \
    || { echo "$HARNESS_NAME: cannot prep $1" >&2; exit 1; }
}

workspace_digests() { # NAME -> "<pyproject-sha> <uvlock-sha>"
  dc exec "$1" sh -c 'sha256sum /workspace/pyproject.toml /workspace/uv.lock' | awk '{print $1}' | tr '\n' ' '
}

# Starts one agent container on a dynamically mapped loopback port and waits for healthz.
# Extra arguments are forwarded as additional `docker run` arguments (env overrides).
start_agent() { # NAME PROJECT_ID [EXTRA_RUN_ARGS...]
  local name="$1" project="$2"
  shift 2
  new_volume "$name-ws"
  local ws="$CREATED_VOLUME"
  new_volume "$name-tmp"
  local tmp="$CREATED_VOLUME"
  prep_agent_volume "$ws" /workspace
  prep_agent_volume "$tmp" /tmp
  start_detached "$name" -p 127.0.0.1::8080 \
    -e "MANAO_AGENT_PROJECT_ID=$project" \
    -e "MANAO_AGENT_CAPABILITY_PUBLIC_KEY=$PUBLIC_KEY" \
    -v "$ws:/workspace" -v "$tmp:/tmp" "$@" "$IMAGE"
  local port="" tried=0
  while [ "$tried" -lt 10 ]; do
    port="$(docker port "$name" 8080 2>/dev/null | head -n1 | sed 's/.*://')"
    [ -n "$port" ] && break
    sleep 1
    tried=$((tried+1))
  done
  [ -n "$port" ] || { echo "$HARNESS_NAME: no published port for $name" >&2; exit 1; }
  local waited=0
  until curl -fsS "http://127.0.0.1:$port/agent/v1/healthz" >/dev/null 2>&1; do
    [ "$waited" -lt 60 ] || { echo "$HARNESS_NAME: agent $name never became healthy" >&2; exit 1; }
    sleep 1
    waited=$((waited+1))
  done
  printf '%s %s' "$name" "$port"
}

# ---------------------------------------------------------------------------
# Capability material: the backend-side Ed25519 key pair
# ---------------------------------------------------------------------------
openssl genpkey -algorithm ed25519 -out "$WORK/capability.pem" 2>/dev/null
openssl pkey -in "$WORK/capability.pem" -pubout -outform DER 2>/dev/null | tail -c 32 | base64 -w0 > "$WORK/public.b64"
PUBLIC_KEY="$(cat "$WORK/public.b64")"

# Request digests: fixed-order JSON of the request facts, exactly what the backend hashes.
REQUEST_SHA_ADD="$(printf '{"action":"ADD","packageName":"httpx","version":"0.28.1"}' | sha256sum | cut -d' ' -f1)"
REQUEST_SHA_ADD_OTHER="$(printf '{"action":"ADD","packageName":"httpx","version":"0.29.0"}' | sha256sum | cut -d' ' -f1)"
REQUEST_SHA_REMOVE="$(printf '{"action":"REMOVE","packageName":"httpx","version":null}' | sha256sum | cut -d' ' -f1)"
REQUEST_SHA_NOWHEEL="$(printf '{"action":"ADD","packageName":"manao-no-such-package-probe","version":"0.0.1"}' | sha256sum | cut -d' ' -f1)"
REQUEST_SHA_PLATFORMWHEEL="$(printf '{"action":"ADD","packageName":"pywin32","version":"312"}' | sha256sum | cut -d' ' -f1)"

# The one pinned resolution index. Hard string-identity invariant: this byte-exact string
# (trailing slash included) is the helper's DEFAULT_INDEX_URL, the helper UV_ARGV_PREFIX
# `--default-index` value, the lock-regeneration command's URL, and these test assertions —
# the helper compares [tool.uv] index URLs and lock registry sources by exact string
# equality, so any drift between the places would misreject honest projects.
MANAO_PYTHON_INDEX_URL="https://mirrors.aliyun.com/pypi/simple/"

cat > "$WORK/prepare-add.json" <<EOF
{"operationId":"$OPERATION_ADD","requestSha256":"$REQUEST_SHA_ADD","change":{"action":"ADD","packageName":"httpx","version":"0.28.1"}}
EOF
cat > "$WORK/prepare-add-other.json" <<EOF
{"operationId":"$OPERATION_ADD","requestSha256":"$REQUEST_SHA_ADD_OTHER","change":{"action":"ADD","packageName":"httpx","version":"0.29.0"}}
EOF
cat > "$WORK/prepare-remove.json" <<EOF
{"operationId":"$OPERATION_REMOVE","requestSha256":"$REQUEST_SHA_REMOVE","change":{"action":"REMOVE","packageName":"httpx","version":null}}
EOF
cat > "$WORK/prepare-timeout.json" <<EOF
{"operationId":"$OPERATION_TIMEOUT","requestSha256":"$REQUEST_SHA_ADD","change":{"action":"ADD","packageName":"httpx","version":"0.28.1"}}
EOF
cat > "$WORK/prepare-nowheel.json" <<EOF
{"operationId":"$OPERATION_NOWHEEL","requestSha256":"$REQUEST_SHA_NOWHEEL","change":{"action":"ADD","packageName":"manao-no-such-package-probe","version":"0.0.1"}}
EOF
cat > "$WORK/prepare-platformwheel.json" <<EOF
{"operationId":"$OPERATION_PLATFORMWHEEL","requestSha256":"$REQUEST_SHA_PLATFORMWHEEL","change":{"action":"ADD","packageName":"pywin32","version":"312"}}
EOF
cat > "$WORK/prepare-helperhang.json" <<EOF
{"operationId":"$OPERATION_HELPERHANG","requestSha256":"$REQUEST_SHA_ADD","change":{"action":"ADD","packageName":"httpx","version":"0.28.1"}}
EOF

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

scenario_capability_enforced() {
  local name="${PREFIX}-capability"
  read -r AGENT_NAME AGENT_PORT <<< "$(start_agent "$name" "$PROJECT_ID")"
  seed_template "$AGENT_NAME"

  if [ "$(curl -sS -o "$WORK/resp.json" -w '%{http_code}' -X POST \
      "http://127.0.0.1:$AGENT_PORT/agent/v1/python-dependencies/prepare" \
      -H 'Content-Type: application/json' --data-binary @"$WORK/prepare-add.json")" = "401" ] \
    && grep -q "CAPABILITY_REJECTED" "$WORK/resp.json"; then
    pass "capability-enforced (unsigned prepare rejected by the shared filter)"
  else
    fail "capability-enforced (unsigned prepare was not rejected with CAPABILITY_REJECTED)"
  fi
}

scenario_toolchain_identity() {
  local python_version uv_version helper_state
  python_version="$(dc exec "$AGENT_NAME" sh -c '/usr/local/bin/python3 --version' 2>/dev/null || true)"
  uv_version="$(dc exec "$AGENT_NAME" sh -c 'uv --version' 2>/dev/null || true)"
  helper_state="$(dc exec "$AGENT_NAME" sh -c \
    'echo "$(stat -c %u /opt/manao-python/dependency_helper.py):$(stat -c %a /opt/manao-python/dependency_helper.py)"' 2>/dev/null || true)"
  if printf '%s' "$python_version" | grep -q "Python 3\.13\." \
    && printf '%s' "$uv_version" | grep -q "0\.11\.6" \
    && [ "$helper_state" = "0:555" ] \
    && ! dc exec "$AGENT_NAME" sh -c 'test -w /opt/manao-python/dependency_helper.py' >/dev/null 2>&1; then
    pass "toolchain-identity ($python_version, $uv_version, root-owned 0555 helper not writable by the agent)"
  else
    fail "toolchain-identity (python='$python_version' uv='$uv_version' helper='$helper_state')"
  fi
}

# Real `uv add httpx==0.28.1` through prepare: sources untouched, journal persisted, combined
# digest formula recomputes from the manifest to the response digests.
scenario_prepare_add() {
  local started elapsed py_before lock_before journal py_after lock_after
  read -r py_before lock_before <<< "$(workspace_digests "$AGENT_NAME")"
  started="$(now_ms)"
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-add.json"
  elapsed=$(( $(now_ms) - started ))
  echo "TIMING: prepare-add (real uv resolution) ${elapsed}ms"
  if [ "$HTTP_STATUS" != "200" ]; then
    fail "prepare-add (expected 200, got $HTTP_STATUS: $(cat "$WORK/resp.json"))"
    return 0
  fi
  cp "$WORK/resp.json" "$WORK/prepared-add.json"
  read -r py_after lock_after <<< "$(workspace_digests "$AGENT_NAME")"
  dc exec "$AGENT_NAME" cat "/workspace/.manao/python-dependencies/$OPERATION_ADD/manifest.json" > "$WORK/manifest-add.json" 2>/dev/null || true
  if [ "$py_before" != "$py_after" ] || [ "$lock_before" != "$lock_after" ]; then
    fail "prepare-add (workspace sources changed during prepare)"
  elif [ "$(json_field "$WORK/prepared-add.json" "data['requestSha256']")" != "$REQUEST_SHA_ADD" ]; then
    fail "prepare-add (request digest not echoed)"
  elif [ ! -s "$WORK/manifest-add.json" ]; then
    fail "prepare-add (PREPARED journal manifest missing)"
  elif [ "$(json_field "$WORK/manifest-add.json" "data['requestSha256']")" != "$REQUEST_SHA_ADD" ]; then
    fail "prepare-add (journal bound to a different request)"
  elif [ "$(json_field "$WORK/prepared-add.json" "data['afterSha256']")" = "$(json_field "$WORK/prepared-add.json" "data['beforeSha256']")" ]; then
    fail "prepare-add (resolution produced no change)"
  else
    pass "prepare-add (real uv add; sources unchanged $py_before/$lock_before; journal PREPARED) [${elapsed}ms]"
  fi
}

# The combined digest formula must recompute from the manifest's per-file digests to the
# response's beforeSha256/afterSha256 — the exact wire contract the backend verifies.
scenario_digest_formula() {
  cat > "$WORK/formula.py" <<'PYEOF'
import hashlib, json, sys
manifest = json.load(open(sys.argv[1], encoding="utf-8"))
prepared = json.load(open(sys.argv[2], encoding="utf-8"))
def combined(py, lock):
    payload = ("python-dependencies-v1\npyproject.toml\n%s\nuv.lock\n%s\n" % (py, lock)).encode()
    return hashlib.sha256(payload).hexdigest()
ok = (combined(manifest["pyproject"]["before"], manifest["uvLock"]["before"]) == prepared["beforeSha256"]
      and combined(manifest["pyproject"]["after"], manifest["uvLock"]["after"]) == prepared["afterSha256"])
sys.exit(0 if ok else 1)
PYEOF
  if "$PYTHON_BIN" "$WORK/formula.py" "$WORK/manifest-add.json" "$WORK/prepared-add.json"; then
    pass "digest-formula (manifest per-file digests recombine to the response digests)"
  else
    fail "digest-formula (combined digest formula does not match the design constant)"
  fi
}

scenario_prepare_idempotent() {
  local started elapsed first second
  first="$(cat "$WORK/prepared-add.json")"
  started="$(now_ms)"
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-add.json"
  elapsed=$(( $(now_ms) - started ))
  echo "TIMING: prepare-idempotent (no re-resolution) ${elapsed}ms"
  second="$(cat "$WORK/resp.json")"
  if [ "$HTTP_STATUS" = "200" ] && [ "$first" = "$second" ] && [ "$elapsed" -lt 2000 ]; then
    pass "prepare-idempotent (same id + request returned the same summary without running uv again) [${elapsed}ms]"
  else
    fail "prepare-idempotent (status=$HTTP_STATUS elapsed=${elapsed}ms same_response=$([ "$first" = "$second" ] && echo yes || echo no))"
  fi
}

scenario_mismatch_rejected() {
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-add-other.json"
  local manifest_now
  manifest_now="$(dc exec "$AGENT_NAME" cat "/workspace/.manao/python-dependencies/$OPERATION_ADD/manifest.json" 2>/dev/null || true)"
  if [ "$HTTP_STATUS" = "409" ] \
    && [ "$(json_field "$WORK/resp.json" "data['code']")" = "DEPENDENCY_REQUEST_MISMATCH" ] \
    && [ "$manifest_now" = "$(cat "$WORK/manifest-add.json")" ]; then
    pass "mismatch-rejected (same id, different request -> 409 DEPENDENCY_REQUEST_MISMATCH, journal untouched)"
  else
    fail "mismatch-rejected (status=$HTTP_STATUS body=$(cat "$WORK/resp.json"))"
  fi
}

# Builds the deterministic backend receipt from the prepared summary and commits it.
build_commit_body() { # OUT_FILE PREPARED_FILE
  local operation before after receipt escaped
  operation="$(json_field "$2" "data['operationId']")"
  before="$(json_field "$2" "data['beforeSha256']")"
  after="$(json_field "$2" "data['afterSha256']")"
  receipt="$(printf '{"operationId":"%s","type":"PYTHON_DEPENDENCIES","path":"pyproject.toml","nextPath":"uv.lock","beforeSha256":"%s","afterSha256":"%s"}' \
    "$operation" "$before" "$after")"
  escaped="$(printf '%s' "$receipt" | sed 's/"/\\"/g')"
  printf '{"prepared":%s,"receiptJson":"%s","receiptSha256":"%s"}\n' \
    "$(cat "$2")" "$escaped" "$(printf '%s' "$receipt" | sha256sum | cut -d' ' -f1)" > "$1"
}

scenario_commit_applies() {
  local started elapsed py_after lock_after
  build_commit_body "$WORK/commit-add.json" "$WORK/prepared-add.json"
  started="$(now_ms)"
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/commit" "$WORK/commit-add.json"
  elapsed=$(( $(now_ms) - started ))
  read -r py_after lock_after <<< "$(workspace_digests "$AGENT_NAME")"
  local manifest_py_after manifest_lock_after
  manifest_py_after="$(json_field "$WORK/manifest-add.json" "data['pyproject']['after']")"
  manifest_lock_after="$(json_field "$WORK/manifest-add.json" "data['uvLock']['after']")"
  if [ "$HTTP_STATUS" != "200" ]; then
    fail "commit-applies (expected 200, got $HTTP_STATUS: $(cat "$WORK/resp.json"))"
  elif [ "$(json_field "$WORK/resp.json" "data['afterSha256']")" != "$(json_field "$WORK/prepared-add.json" "data['afterSha256']")" ]; then
    fail "commit-applies (commit response digests differ from the prepared summary)"
  elif [ "$py_after" != "$manifest_py_after" ] || [ "$lock_after" != "$manifest_lock_after" ]; then
    fail "commit-applies (workspace files do not match the journal's prepared content)"
  elif ! dc exec "$AGENT_NAME" grep -q 'httpx==0.28.1' /workspace/pyproject.toml \
    || ! dc exec "$AGENT_NAME" grep -q 'name = "httpx"' /workspace/uv.lock; then
    fail "commit-applies (httpx missing from the committed files)"
  elif ! dc exec "$AGENT_NAME" sh -c \
      'cd /workspace && HOME=/tmp UV_CACHE_DIR=/tmp/.cache/uv UV_LINK_MODE=copy uv lock --check --no-config --no-python-downloads --python /usr/local/bin/python3' \
      >/dev/null 2>&1; then
    fail "commit-applies (uv lock --check rejected the committed lock)"
  else
    pass "commit-applies (receipt verified, both files replaced, uv lock --check consistent) [${elapsed}ms]"
  fi
}

# mirror-observed: the committed lock is what the runtime's `uv sync --locked` downloads
# from, so every URL it records must come from the pinned mirror — the registry source
# byte-identical to MANAO_PYTHON_INDEX_URL, artifacts under mirrors.aliyun.com/pypi/packages/.
scenario_mirror_observed() {
  local urls foreign
  urls="$(dc exec "$AGENT_NAME" sh -c 'grep -hoE "https://[^\"[:space:]]+" /workspace/uv.lock | sort -u' 2>/dev/null || true)"
  if [ -z "$urls" ]; then
    fail "mirror-observed (no URLs found in the committed uv.lock)"
    return 0
  fi
  # Byte-exact fixed-string comparison for the registry URL; every other recorded URL must
  # be a mirror package artifact.
  foreign="$(printf '%s\n' "$urls" | grep -Fxv "$MANAO_PYTHON_INDEX_URL" | grep -v '^https://mirrors\.aliyun\.com/pypi/packages/' || true)"
  if printf '%s\n' "$urls" | grep -Fqx "$MANAO_PYTHON_INDEX_URL" && [ -z "$foreign" ]; then
    pass "mirror-observed (committed lock records only the pinned mirror: $(printf '%s\n' "$urls" | grep -c .) distinct URLs)"
  else
    fail "mirror-observed (mirror registry URL absent or non-mirror sources recorded: ${foreign:-registry URL missing})"
  fi
}

scenario_commit_idempotent() {
  local before_stamp result
  before_stamp="$(dc exec "$AGENT_NAME" sh -c 'stat -c %Y /workspace/uv.lock')"
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/commit" "$WORK/commit-add.json"
  result="$(cat "$WORK/resp.json")"
  local after_stamp
  after_stamp="$(dc exec "$AGENT_NAME" sh -c 'stat -c %Y /workspace/uv.lock')"
  if [ "$HTTP_STATUS" = "200" ] \
    && [ "$result" = "$(cat "$WORK/prepared-add.json")" ] \
    && [ "$before_stamp" = "$after_stamp" ]; then
    pass "commit-idempotent (lost-response replay returned the same result and rewrote nothing)"
  else
    fail "commit-idempotent (status=$HTTP_STATUS same_response=$([ "$result" = "$(cat "$WORK/prepared-add.json")" ] && echo yes || echo no))"
  fi
}

scenario_commit_tamper_rejected() {
  local operation before after receipt escaped
  operation="$(json_field "$WORK/prepared-add.json" "data['operationId']")"
  before="$(json_field "$WORK/prepared-add.json" "data['beforeSha256']")"
  after="$(json_field "$WORK/prepared-add.json" "data['afterSha256']")"
  receipt="$(printf '{"operationId":"%s","type":"PYTHON_DEPENDENCIES","path":"pyproject.toml","nextPath":"uv.lock","beforeSha256":"%s","afterSha256":"%s"}' \
    "$operation" "$before" "$after")"
  escaped="$(printf '%s' "$receipt" | sed 's/"/\\"/g')"
  printf '{"prepared":%s,"receiptJson":"%s","receiptSha256":"%s"}\n' \
    "$(cat "$WORK/prepared-add.json")" "$escaped" "$(printf '%s' "tampered-$receipt" | sha256sum | cut -d' ' -f1)" \
    > "$WORK/commit-tampered.json"
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/commit" "$WORK/commit-tampered.json"
  if [ "$HTTP_STATUS" = "409" ] && [ "$(json_field "$WORK/resp.json" "data['code']")" = "OPERATION_CONFLICT" ]; then
    pass "commit-tamper-rejected (receipt digest mismatch -> 409 OPERATION_CONFLICT)"
  else
    fail "commit-tamper-rejected (status=$HTTP_STATUS body=$(cat "$WORK/resp.json"))"
  fi
}

# Real `uv remove httpx` through prepare + commit; the lock must stay consistent.
scenario_prepare_remove_commit() {
  local started prepare_ms commit_ms
  started="$(now_ms)"
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-remove.json"
  prepare_ms=$(( $(now_ms) - started ))
  echo "TIMING: prepare-remove (real uv resolution) ${prepare_ms}ms"
  if [ "$HTTP_STATUS" != "200" ]; then
    fail "prepare-remove-commit (prepare expected 200, got $HTTP_STATUS: $(cat "$WORK/resp.json"))"
    return 0
  fi
  cp "$WORK/resp.json" "$WORK/prepared-remove.json"
  build_commit_body "$WORK/commit-remove.json" "$WORK/prepared-remove.json"
  started="$(now_ms)"
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/commit" "$WORK/commit-remove.json"
  commit_ms=$(( $(now_ms) - started ))
  if [ "$HTTP_STATUS" != "200" ]; then
    fail "prepare-remove-commit (commit expected 200, got $HTTP_STATUS: $(cat "$WORK/resp.json"))"
  elif dc exec "$AGENT_NAME" grep -q 'httpx' /workspace/pyproject.toml \
    || dc exec "$AGENT_NAME" grep -q 'name = "httpx"' /workspace/uv.lock; then
    fail "prepare-remove-commit (httpx residue remains after removal)"
  elif ! dc exec "$AGENT_NAME" sh -c \
      'cd /workspace && HOME=/tmp UV_CACHE_DIR=/tmp/.cache/uv UV_LINK_MODE=copy uv lock --check --no-config --no-python-downloads --python /usr/local/bin/python3' \
      >/dev/null 2>&1; then
    fail "prepare-remove-commit (uv lock --check rejected the committed lock)"
  else
    pass "prepare-remove-commit (real uv remove; no residue; lock consistent) [prepare ${prepare_ms}ms / commit ${commit_ms}ms]"
  fi
}

# Out-of-scope project configuration must fail with the fixed category error and no side
# effects — a build backend declaration, a private index in [tool.uv], and dependency
# declarations that could aim uv beyond the pinned index: a direct URL to an unroutable
# non-PyPI address, a git+ source and a relative path. The 422 UNSUPPORTED token is only ever
# produced by the helper's pre-uv scope check, so the code itself proves no network contact
# was attempted (uv hitting the unroutable address would end in 504 TIMEOUT instead).
scenario_unsupported_scope() {
  local operation="$OPERATION_TIMEOUT"
  cat > "$WORK/pyproject-build-backend.toml" <<'EOF'
[project]
name = "manao-python-console"
version = "0.1.0"
requires-python = ">=3.13,<3.14"
dependencies = []

[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"
EOF
  cat > "$WORK/pyproject-private-index.toml" <<'EOF'
[project]
name = "manao-python-console"
version = "0.1.0"
requires-python = ">=3.13,<3.14"
dependencies = []

[[tool.uv.index]]
url = "https://private.example/simple"
default = true
EOF
  cat > "$WORK/pyproject-direct-url.toml" <<'EOF'
[project]
name = "manao-python-console"
version = "0.1.0"
requires-python = ">=3.13,<3.14"
dependencies = ["httpx @ http://10.255.255.1:1/simple/httpx-0.28.1.whl"]
EOF
  cat > "$WORK/pyproject-git-source.toml" <<'EOF'
[project]
name = "manao-python-console"
version = "0.1.0"
requires-python = ">=3.13,<3.14"
dependencies = ["httpx @ git+https://github.com/psf/requests"]
EOF
  cat > "$WORK/pyproject-path-source.toml" <<'EOF'
[project]
name = "manao-python-console"
version = "0.1.0"
requires-python = ">=3.13,<3.14"
dependencies = ["../shared-lib"]
EOF
  cat > "$WORK/prepare-unsupported.json" <<EOF
{"operationId":"$operation","requestSha256":"$REQUEST_SHA_ADD","change":{"action":"ADD","packageName":"httpx","version":"0.28.1"}}
EOF
  local result=1
  for variant in build-backend private-index direct-url git-source path-source; do
    docker cp "$WORK/pyproject-$variant.toml" "$AGENT_NAME:/workspace/pyproject.toml"
    dc exec --user 0 "$AGENT_NAME" chown 10001:10001 /workspace/pyproject.toml
    post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-unsupported.json"
    local journal_present=0
    dc exec "$AGENT_NAME" test -f "/workspace/.manao/python-dependencies/$operation/manifest.json" >/dev/null 2>&1 && journal_present=1
    if [ "$HTTP_STATUS" = "422" ] \
      && [ "$(json_field "$WORK/resp.json" "data['code']")" = "PYTHON_DEPENDENCY_UNSUPPORTED" ] \
      && [ "$journal_present" = "0" ]; then
      result=0
    else
      result=1
      break
    fi
  done
  # restore the clean template workspace for any later scenario
  seed_template "$AGENT_NAME"
  if [ "$result" = "0" ]; then
    pass "unsupported-scope (build backend, private index, direct URL, git+ and path sources all rejected 422 PYTHON_DEPENDENCY_UNSUPPORTED before uv, no journal)"
  else
    fail "unsupported-scope (status=$HTTP_STATUS body=$(cat "$WORK/resp.json"))"
  fi
}

# tooluva-policy: the [tool.uv] scope check compares index URLs by exact string equality
# against the pinned mirror URL (trailing slash included). The FORMER default index
# (https://pypi.org/simple) and the mirror URL WITHOUT its trailing slash are both outside
# the supported scope and must be rejected before uv runs, with no PREPARED journal.
scenario_tooluva_policy() {
  local operation="$OPERATION_TOOLUVA"
  cat > "$WORK/pyproject-old-index.toml" <<'EOF'
[project]
name = "manao-python-console"
version = "0.1.0"
requires-python = ">=3.13,<3.14"
dependencies = []

[[tool.uv.index]]
url = "https://pypi.org/simple"
default = true
EOF
  cat > "$WORK/pyproject-mirror-no-slash.toml" <<'EOF'
[project]
name = "manao-python-console"
version = "0.1.0"
requires-python = ">=3.13,<3.14"
dependencies = []

[[tool.uv.index]]
url = "https://mirrors.aliyun.com/pypi/simple"
default = true
EOF
  cat > "$WORK/prepare-tooluva.json" <<EOF
{"operationId":"$operation","requestSha256":"$REQUEST_SHA_ADD","change":{"action":"ADD","packageName":"httpx","version":"0.28.1"}}
EOF
  local result=1 variant journal_present=0
  for variant in old-index mirror-no-slash; do
    docker cp "$WORK/pyproject-$variant.toml" "$AGENT_NAME:/workspace/pyproject.toml"
    dc exec --user 0 "$AGENT_NAME" chown 10001:10001 /workspace/pyproject.toml
    post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-tooluva.json"
    journal_present=0
    dc exec "$AGENT_NAME" test -f "/workspace/.manao/python-dependencies/$operation/manifest.json" >/dev/null 2>&1 && journal_present=1
    if [ "$HTTP_STATUS" = "422" ] \
      && [ "$(json_field "$WORK/resp.json" "data['code']")" = "PYTHON_DEPENDENCY_UNSUPPORTED" ] \
      && [ "$journal_present" = "0" ]; then
      result=0
    else
      result=1
      break
    fi
  done
  # restore the clean template workspace for any later scenario
  seed_template "$AGENT_NAME"
  if [ "$result" = "0" ]; then
    pass "tooluva-policy (former pypi.org index and trailing-slash-missing mirror URL both rejected 422 PYTHON_DEPENDENCY_UNSUPPORTED before uv, no journal)"
  else
    fail "tooluva-policy (variant=$variant status=$HTTP_STATUS body=$(cat "$WORK/resp.json") journal=$journal_present)"
  fi
}

# A real uv resolution that cannot obtain a usable wheel from the pinned registry (here: the
# package does not exist) is its own fixed safe category — never a generic resolution failure,
# and its stderr is still never forwarded to the client.
scenario_no_wheel_category() {
  local started elapsed
  started="$(now_ms)"
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-nowheel.json"
  elapsed=$(( $(now_ms) - started ))
  echo "TIMING: prepare-no-wheel (real uv against the pinned registry) ${elapsed}ms"
  local journal_present=0
  dc exec "$AGENT_NAME" test -f "/workspace/.manao/python-dependencies/$OPERATION_NOWHEEL/manifest.json" >/dev/null 2>&1 && journal_present=1
  if [ "$HTTP_STATUS" = "422" ] \
    && [ "$(json_field "$WORK/resp.json" "data['code']")" = "PYTHON_DEPENDENCY_NO_WHEEL" ] \
    && [ "$journal_present" = "0" ]; then
    pass "no-wheel-category (missing package -> 422 PYTHON_DEPENDENCY_NO_WHEEL, no journal) [${elapsed}ms]"
  else
    fail "no-wheel-category (status=$HTTP_STATUS body=$(cat "$WORK/resp.json"))"
  fi
}

# A package that resolves into the universal lock but has no wheel for the pinned Linux
# target (pywin32 ships Windows-only wheels): the real `uv add --no-sync` SUCCEEDS, so a
# prepare that stopped there would stage a journal for a project that can never start. The
# helper's installability verification (uv sync --locked --dry-run in the same scratch) must
# fail the change into the fixed safe category — 422 PYTHON_DEPENDENCY_NO_WHEEL — with no
# journal and untouched workspace sources.
scenario_no_platform_wheel_category() {
  local started elapsed py_before lock_before py_after lock_after
  read -r py_before lock_before <<< "$(workspace_digests "$AGENT_NAME")"
  started="$(now_ms)"
  post_json "$AGENT_PORT" "$PROJECT_ID" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-platformwheel.json"
  elapsed=$(( $(now_ms) - started ))
  echo "TIMING: prepare-no-platform-wheel (real uv add + installability verification) ${elapsed}ms"
  local journal_present=0
  dc exec "$AGENT_NAME" test -f "/workspace/.manao/python-dependencies/$OPERATION_PLATFORMWHEEL/manifest.json" >/dev/null 2>&1 && journal_present=1
  read -r py_after lock_after <<< "$(workspace_digests "$AGENT_NAME")"
  if [ "$HTTP_STATUS" = "422" ] \
    && [ "$(json_field "$WORK/resp.json" "data['code']")" = "PYTHON_DEPENDENCY_NO_WHEEL" ] \
    && [ "$journal_present" = "0" ] \
    && [ "$py_before" = "$py_after" ] && [ "$lock_before" = "$lock_after" ]; then
    pass "no-platform-wheel-category (pywin32==312 resolves but has no Linux wheel -> 422 PYTHON_DEPENDENCY_NO_WHEEL, no journal, sources unchanged) [${elapsed}ms]"
  else
    fail "no-platform-wheel-category (status=$HTTP_STATUS body=$(cat "$WORK/resp.json") journal=$journal_present digests=$py_before/$lock_before -> $py_after/$lock_after)"
  fi
}

# On the OUTER budget the agent must kill the helper AND its whole child tree — the helper may
# itself be stuck and never reap uv. A test-only helper that spawns a sleeper and hangs
# (helper-path env override, per-run volume; the production image is untouched) must end in
# 504 within the budget margin with no surviving helper or child process and no journal.
scenario_helper_hang_kills_tree() {
  new_volume "helper-shim"
  local shim="$CREATED_VOLUME"
  dc run --rm --user 0 --entrypoint /bin/sh -v "$shim:/shim" "$IMAGE" \
    -c 'printf "#!/usr/local/bin/python3\nimport subprocess, time\nsubprocess.Popen([\"sleep\", \"300\"])\ntime.sleep(600)\n" > /shim/helper.py && chmod 0555 /shim/helper.py' >/dev/null 2>&1 \
    || { fail "helper-hang-kills-tree (cannot write the test-only hanging helper)"; return 0; }
  local agent2 port
  read -r agent2 port <<< "$(start_agent "${PREFIX}-helperhang" "$PROJECT_ID_SHIM" \
    -e 'MANAO_AGENT_PYTHON_DEPENDENCY_HELPER=/shim/helper.py' \
    -e 'MANAO_AGENT_PYTHON_DEPENDENCY_RESOLUTION_SECONDS=2' \
    -v "$shim:/shim")"
  seed_template "$agent2"
  local started elapsed
  started="$(now_ms)"
  post_json "$port" "$PROJECT_ID_SHIM" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-helperhang.json"
  elapsed=$(( $(now_ms) - started ))
  echo "TIMING: prepare-helper-hang (budget 2s, outer margin kills helper + child tree) ${elapsed}ms"
  local orphans
  orphans="$(dc exec "$agent2" sh -c \
    'for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$$" ] && continue; c=$(tr "\0" " " < "$d/cmdline" 2>/dev/null || true); case "$c" in *sleep*|*"/shim/helper.py"*) echo "$c";; esac; done' 2>/dev/null || true)"
  local journal_present=0
  dc exec "$agent2" test -f "/workspace/.manao/python-dependencies/$OPERATION_HELPERHANG/manifest.json" >/dev/null 2>&1 && journal_present=1
  # The helper phase draws ONE deadline of budget + HELPER_MARGIN_SECONDS (2 since the
  # 0a10b7d round; the agent JVM tests pin helperWaitSeconds == budget + 2) before the
  # tree kill, so the honest window is [budget+2s, budget+2s + kill/HTTP slack). The
  # former >= 11 s bound encoded the superseded 10 s margin and failed against the
  # correct, faster behavior.
  local helper_wait_floor=$(( (2 + 2) * 1000 ))
  if [ "$HTTP_STATUS" = "504" ] \
    && [ "$(json_field "$WORK/resp.json" "data['code']")" = "PYTHON_DEPENDENCY_TIMEOUT" ] \
    && [ "$elapsed" -ge "$helper_wait_floor" ] && [ "$elapsed" -lt 25000 ] \
    && [ -z "$orphans" ] \
    && [ "$journal_present" = "0" ]; then
    pass "helper-hang-kills-tree (504 within the budget+2s helper wait, hanging helper and sleeper child killed, no journal) [${elapsed}ms]"
  else
    fail "helper-hang-kills-tree (status=$HTTP_STATUS elapsed=${elapsed}ms orphans='${orphans}' journal=$journal_present)"
  fi
}

# Budget overrun: a hanging test-only uv shim (per-run volume + PATH override; the production
# image is untouched) must be killed within the budget and leave no orphan process.
scenario_timeout_kills_tool() {
  new_volume "shim"
  local shim="$CREATED_VOLUME"
  dc run --rm --user 0 --entrypoint /bin/sh -v "$shim:/shim" "$IMAGE" \
    -c 'printf "#!/bin/sh\nsleep 300\n" > /shim/uv && chmod 0555 /shim/uv' >/dev/null 2>&1 \
    || { fail "timeout-kills-tool (cannot write the test-only uv shim)"; return 0; }
  local agent2 port
  read -r agent2 port <<< "$(start_agent "${PREFIX}-timeout" "$PROJECT_ID_SHIM" \
    -e 'PATH=/shim:/usr/local/bin:/usr/bin:/bin' \
    -e 'MANAO_AGENT_PYTHON_DEPENDENCY_RESOLUTION_SECONDS=2' \
    -v "$shim:/shim")"
  seed_template "$agent2"
  local started elapsed
  started="$(now_ms)"
  post_json "$port" "$PROJECT_ID_SHIM" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-timeout.json"
  elapsed=$(( $(now_ms) - started ))
  echo "TIMING: prepare-timeout (budget 2s, hung uv shim killed) ${elapsed}ms"
  local orphans
  orphans="$(dc exec "$agent2" sh -c \
    'for d in /proc/[0-9]*; do p=${d#/proc/}; [ "$p" = "$$" ] && continue; c=$(tr "\0" " " < "$d/cmdline" 2>/dev/null || true); case "$c" in *sleep*|*"/shim/uv"*) echo "$c";; esac; done' 2>/dev/null || true)"
  local journal_present=0
  dc exec "$agent2" test -f "/workspace/.manao/python-dependencies/$OPERATION_TIMEOUT/manifest.json" >/dev/null 2>&1 && journal_present=1
  if [ "$HTTP_STATUS" = "504" ] \
    && [ "$(json_field "$WORK/resp.json" "data['code']")" = "PYTHON_DEPENDENCY_TIMEOUT" ] \
    && [ "$elapsed" -ge 2000 ] && [ "$elapsed" -lt 20000 ] \
    && [ -z "$orphans" ] \
    && [ "$journal_present" = "0" ]; then
    pass "timeout-kills-tool (504 PYTHON_DEPENDENCY_TIMEOUT within the budget margin, no orphaned uv, no journal) [${elapsed}ms]"
  else
    fail "timeout-kills-tool (status=$HTTP_STATUS elapsed=${elapsed}ms orphans='${orphans}' journal=$journal_present)"
  fi
}

# fixed-index-argv / env-override: the resolution index may never be steered by the
# container environment. With UV_DEFAULT_INDEX and UV_INDEX pointing at a hostile host in
# the AGENT container's environment, a real prepare-add + commit must still record only the
# pinned mirror in the generated pyproject and lock: the helper's fixed `--default-index`
# argv wins over uv environment variables, and the agent additionally launches the helper
# with a minimal environment — neither path can carry the hostile value into the lock.
scenario_fixed_index_env_override() {
  local agent2 port
  read -r agent2 port <<< "$(start_agent "${PREFIX}-envovr" "$PROJECT_ID_SHIM" \
    -e 'UV_DEFAULT_INDEX=https://evil.example/simple' \
    -e 'UV_INDEX=https://evil.example/simple')"
  seed_template "$agent2"
  cat > "$WORK/prepare-envovr.json" <<EOF
{"operationId":"$OPERATION_ENVOVR","requestSha256":"$REQUEST_SHA_ADD","change":{"action":"ADD","packageName":"httpx","version":"0.28.1"}}
EOF
  local started elapsed
  started="$(now_ms)"
  post_json "$port" "$PROJECT_ID_SHIM" "/agent/v1/python-dependencies/prepare" "$WORK/prepare-envovr.json"
  elapsed=$(( $(now_ms) - started ))
  echo "TIMING: prepare-env-override (real uv resolution under hostile UV_* env) ${elapsed}ms"
  if [ "$HTTP_STATUS" != "200" ]; then
    fail "fixed-index-argv (prepare expected 200, got $HTTP_STATUS: $(cat "$WORK/resp.json"))"
    return 0
  fi
  cp "$WORK/resp.json" "$WORK/prepared-envovr.json"
  build_commit_body "$WORK/commit-envovr.json" "$WORK/prepared-envovr.json"
  post_json "$port" "$PROJECT_ID_SHIM" "/agent/v1/python-dependencies/commit" "$WORK/commit-envovr.json"
  if [ "$HTTP_STATUS" != "200" ]; then
    fail "fixed-index-argv (commit expected 200, got $HTTP_STATUS: $(cat "$WORK/resp.json"))"
    return 0
  fi
  local urls foreign
  urls="$(dc exec "$agent2" sh -c 'grep -hoE "https://[^\"[:space:]]+" /workspace/pyproject.toml /workspace/uv.lock | sort -u' 2>/dev/null || true)"
  foreign="$(printf '%s\n' "$urls" | grep -Fxv "$MANAO_PYTHON_INDEX_URL" | grep -v '^https://mirrors\.aliyun\.com/pypi/packages/' || true)"
  if printf '%s\n' "$urls" | grep -Fqx "$MANAO_PYTHON_INDEX_URL" && [ -z "$foreign" ]; then
    pass "fixed-index-argv (hostile UV_DEFAULT_INDEX/UV_INDEX env ignored; generated pyproject+lock record only $MANAO_PYTHON_INDEX_URL) [${elapsed}ms]"
  else
    fail "fixed-index-argv (environment steered the resolution or mirror URL missing: foreign='${foreign:-registry URL missing}')"
  fi
}

# prepare-batch: a multi-line requirements text (exact pin, version range, whole-line comment,
# blank line) is imported through ONE prepare-batch call with exactly ONE `uv add -r` run —
# logged by a test-only uv shim (per-run volume + PATH override; the production image is
# untouched) — plus the one fixed installability verification. Sources stay untouched, the
# journal holds BOTH requirements and no comment residue, and the pinned mirror is in argv.
scenario_prepare_batch() {
  new_volume "uvshim"
  local shim="$CREATED_VOLUME"
  dc run --rm --user 0 --entrypoint /bin/sh -v "$shim:/shim" "$IMAGE" \
    -c 'printf "#!/bin/sh\nprintf \"%%s\\n\" \"\$*\" >> /shim/uv.log\nexec /usr/local/bin/uv \"\$@\"\n" > /shim/uv \
        && chmod 0555 /shim/uv && touch /shim/uv.log && chmod 0666 /shim/uv.log' >/dev/null 2>&1 \
    || { fail "prepare-batch (cannot write the logging uv shim)"; return 0; }
  local agent2 port
  read -r agent2 port <<< "$(start_agent "${PREFIX}-batch" "$PROJECT_ID_SHIM" \
    -e 'PATH=/shim:/usr/local/bin:/usr/bin:/bin' \
    -v "$shim:/shim")"
  seed_template "$agent2"
  cat > "$WORK/batch-requirements.txt" <<'EOF'
# batch import probe
httpx==0.28.1

idna>=3.7
EOF
  local request_sha
  request_sha="$(sha256sum "$WORK/batch-requirements.txt" | cut -d' ' -f1)"
  build_batch_body "$WORK/prepare-batch.json" "$OPERATION_BATCH" "$request_sha" "$WORK/batch-requirements.txt"
  local py_before lock_before py_after lock_after started elapsed
  read -r py_before lock_before <<< "$(workspace_digests "$agent2")"
  started="$(now_ms)"
  post_json "$port" "$PROJECT_ID_SHIM" "/agent/v1/python-dependencies/prepare-batch" "$WORK/prepare-batch.json"
  elapsed=$(( $(now_ms) - started ))
  echo "TIMING: prepare-batch (one real uv requirements import) ${elapsed}ms"
  cp "$WORK/resp.json" "$WORK/prepared-batch.json"
  read -r py_after lock_after <<< "$(workspace_digests "$agent2")"
  local uv_log add_runs sync_runs add_line journal_py manifest_ok
  uv_log="$(dc exec "$agent2" cat /shim/uv.log 2>/dev/null || true)"
  add_runs="$(printf '%s\n' "$uv_log" | grep -c '^add ' || true)"
  sync_runs="$(printf '%s\n' "$uv_log" | grep -c '^sync ' || true)"
  add_line="$(printf '%s\n' "$uv_log" | grep '^add ' | head -n1 || true)"
  journal_py="$(dc exec "$agent2" cat "/workspace/.manao/python-dependencies/$OPERATION_BATCH/pyproject.toml" 2>/dev/null || true)"
  manifest_ok=0
  dc exec "$agent2" test -f "/workspace/.manao/python-dependencies/$OPERATION_BATCH/manifest.json" >/dev/null 2>&1 && manifest_ok=1
  if [ "$HTTP_STATUS" != "200" ]; then
    fail "prepare-batch (expected 200, got $HTTP_STATUS: $(cat "$WORK/resp.json"))"
  elif [ "$(json_field "$WORK/prepared-batch.json" "data['requestSha256']")" != "$request_sha" ]; then
    fail "prepare-batch (request digest not echoed)"
  elif [ "$py_before" != "$py_after" ] || [ "$lock_before" != "$lock_after" ]; then
    fail "prepare-batch (workspace sources changed during prepare)"
  elif [ "$manifest_ok" != "1" ]; then
    fail "prepare-batch (PREPARED journal manifest missing)"
  elif [ "$add_runs" != "1" ] || [ "$sync_runs" != "1" ]; then
    fail "prepare-batch (expected exactly ONE uv add + ONE verification run, got add=$add_runs sync=$sync_runs)"
  elif ! printf '%s' "$add_line" | grep -Fq -- '-r /tmp/manao-python-dependencies-' \
    || ! printf '%s' "$add_line" | grep -Fq 'manao-batch-requirements.txt' \
    || ! printf '%s' "$add_line" | grep -Fq "$MANAO_PYTHON_INDEX_URL"; then
    fail "prepare-batch (the single add run must consume the private requirements file through the pinned mirror argv)"
  elif ! printf '%s' "$journal_py" | grep -Fq 'httpx==0.28.1' \
    || ! printf '%s' "$journal_py" | grep -Fq 'idna>=3.7' \
    || printf '%s' "$journal_py" | grep -Fq 'batch import probe'; then
    fail "prepare-batch (journal must carry both requirements and no comment residue)"
  else
    pass "prepare-batch (ONE uv add -r + ONE verification; sources unchanged $py_before/$lock_before; both requirements journaled, no comment residue) [${elapsed}ms]"
  fi
}

# batch-unsupported: requirements lines that could switch or nest sources (-r, --index-url,
# git+, local path) are rejected 422 PYTHON_DEPENDENCY_UNSUPPORTED — the token only ever
# comes from the helper's pre-uv checks, so the code itself proves no network contact — with
# no journal and untouched workspace sources.
scenario_batch_unsupported_sources() {
  local agent2 port
  read -r agent2 port <<< "$(start_agent "${PREFIX}-batchrej" "$PROJECT_ID_SHIM")"
  seed_template "$agent2"
  local py_before lock_before py_after lock_after
  read -r py_before lock_before <<< "$(workspace_digests "$agent2")"
  local operations=("$OPERATION_BATCH_REJECT_1" "$OPERATION_BATCH_REJECT_2" "$OPERATION_BATCH_REJECT_3" "$OPERATION_BATCH_REJECT_4")
  local result=1 i=0 variant operation digest journal_present
  for variant in '-r ./other.txt' '--index-url https://evil.example/simple' \
                 'git+https://github.com/psf/requests' '../shared-lib'; do
    operation="${operations[$i]}"
    i=$((i+1))
    printf '%s\n' "$variant" > "$WORK/batch-reject.txt"
    digest="$(sha256sum "$WORK/batch-reject.txt" | cut -d' ' -f1)"
    build_batch_body "$WORK/prepare-batch-reject.json" "$operation" "$digest" "$WORK/batch-reject.txt"
    post_json "$port" "$PROJECT_ID_SHIM" "/agent/v1/python-dependencies/prepare-batch" "$WORK/prepare-batch-reject.json"
    journal_present=0
    dc exec "$agent2" test -f "/workspace/.manao/python-dependencies/$operation/manifest.json" >/dev/null 2>&1 && journal_present=1
    if [ "$HTTP_STATUS" = "422" ] \
      && [ "$(json_field "$WORK/resp.json" "data['code']")" = "PYTHON_DEPENDENCY_UNSUPPORTED" ] \
      && [ "$journal_present" = "0" ]; then
      result=0
    else
      result=1
      break
    fi
  done
  read -r py_after lock_after <<< "$(workspace_digests "$agent2")"
  if [ "$result" = "0" ] && [ "$py_before" = "$py_after" ] && [ "$lock_before" = "$lock_after" ]; then
    pass "batch-unsupported (-r, --index-url, git+ and local path requirement lines all rejected 422 PYTHON_DEPENDENCY_UNSUPPORTED before uv, no journal, sources unchanged)"
  else
    fail "batch-unsupported (variant=$variant status=$HTTP_STATUS body=$(cat "$WORK/resp.json") journal=$journal_present)"
  fi
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

scenario_capability_enforced
scenario_toolchain_identity
scenario_prepare_add
scenario_digest_formula
scenario_prepare_idempotent
scenario_mismatch_rejected
scenario_commit_applies
scenario_mirror_observed
scenario_commit_idempotent
scenario_commit_tamper_rejected
scenario_prepare_remove_commit
scenario_unsupported_scope
scenario_tooluva_policy
scenario_no_wheel_category
scenario_no_platform_wheel_category
scenario_helper_hang_kills_tree
scenario_timeout_kills_tool
scenario_fixed_index_env_override
scenario_prepare_batch
scenario_batch_unsupported_sources

echo "dependency-editor: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

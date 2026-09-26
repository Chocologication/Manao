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
OPERATION_HELPERHANG="7f0a1c3d-0004-4a6b-8c9d-0e1f2a3b4c5d"

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
scenario_commit_idempotent
scenario_commit_tamper_rejected
scenario_prepare_remove_commit
scenario_unsupported_scope
scenario_no_wheel_category
scenario_helper_hang_kills_tree
scenario_timeout_kills_tool

echo "dependency-editor: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

# poc4/python-runner/tests/lib.sh
# Shared hardened harness helpers for the Python runner container tests (python runtime
# plan, task 4). Sourced by runtime-lifecycle.sh and python-cache.sh — never executed.
#
# The Docker ownership pattern is the one accepted for Task 3's
# poc4/maven-runner/tests/runtime-lifecycle.sh, extracted here so both Task 4 suites use
# one implementation instead of diverging copies:
#   - container and volume names are unique per invocation (invocation prefix + host pid);
#   - containers are registered for cleanup only after their create+start succeeded;
#   - a failed `docker run --name` only ever best-effort-removes the exact pid-embedded
#     name, which by the live-pid-uniqueness invariant can only be this invocation's own
#     container or an orphan of a dead invocation that recycled the pid — never a foreign
#     container that happens to exist;
#   - volume names are classified semantically (only the daemon's stable "no such volume"
#     error proves a name free; any other inspect failure aborts fail-closed) and a
#     same-name leftover must prove, from the daemon's own clock, that it predates this
#     invocation before it is removed; a newer CreatedAt contradicts the pid invariant
#     and aborts instead of being adopted;
#   - every created volume is written to a persistent registry file (fail-fast) keyed by
#     the invocation pid, and cleanup removes exactly the registered names.
#
# Caller contract: set IMAGE, PREFIX and HARNESS_NAME, then call harness_init. The suites
# run under set -euo pipefail; expected failures are always placed in explicit conditions.

HARNESS_CONTAINERS=()
HARNESS_LOGS=()
HARNESS_REGISTRY=""
HARNESS_CONTAINER_REGISTRY=""
HARNESS_SCRIPT_START=""
HARNESS_CLOCK_PROBE=""
CREATED_VOLUME=""
EXTRA_RUN_ARGS=()
PASS=0
FAIL=0
CASE_EXIT=""

# docker with MSYS/Git Bash path conversion disabled: several arguments carry
# container-absolute paths (--tmpfs /tmp, --sysctl, -e PATH=/shim:..., --entrypoint
# /bin/sh, /usr/local/bin/manao-python). On Linux the variable is simply unknown to
# docker and changes nothing; no host paths are ever passed through dc().
dc() { MSYS_NO_PATHCONV=1 docker "$@"; }

# dc() with a hard timeout: one-shot helper containers (prep, fixture writers, state
# probes) must never hang the whole harness on an intermittent Docker Desktop attach
# stall. An external timeout cannot execute the dc() shell function, hence the direct
# form.
dc_t() { local t="$1"; shift; MSYS_NO_PATHCONV=1 timeout "$t" docker "$@"; }

pass() { PASS=$((PASS+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# Classify a volume name by inspecting it — semantically, never by bare exit code.
# Returns 0 if the volume exists (prints its CreatedAt), 1 if the daemon's stable
# "no such volume" error proves the name free, 2 for any other failure (permission,
# transient connection, timeout — raw daemon error on stdout). A non-zero exit alone
# proves nothing: only the daemon's own "no such volume" text may be read as "free".
volume_state() { # NAME
  local out st=0
  out="$(docker volume inspect -f '{{.CreatedAt}}' "$1" 2>&1)" || st=$?
  if [ "$st" -eq 0 ]; then
    printf '%s' "$out"
    return 0
  fi
  case "$out" in
    *"no such volume"*|*"No such volume"*) return 1 ;;
    *) printf '%s' "$out"; return 2 ;;
  esac
}

# Registers one exact volume name in the persistent registry (fail-fast: an
# unregistrable volume could never be cleaned up, so it is removed again and the
# harness aborts instead of leaving silent residue).
register_volume() {
  printf '%s\n' "$1" >> "$HARNESS_REGISTRY" || {
    docker volume rm "$1" >/dev/null 2>&1 || true
    echo "$HARNESS_NAME: cannot register volume $1 in $HARNESS_REGISTRY" >&2
    exit 1
  }
}

# Registers one exact container name in the FILE-based container registry. The in-memory
# HARNESS_CONTAINERS array silently loses every registration made inside a command
# substitution (start_agent-style callers run in a subshell), so the EXIT trap never saw
# those containers and they leaked — observed across rounds as dozens of leftover test
# agents while the file-based volume registry cleaned up fine. The file survives the
# subshell boundary exactly like the volume registry; the array stays for callers that
# register in the parent shell.
register_container() {
  printf '%s\n' "$1" >> "$HARNESS_CONTAINER_REGISTRY" || {
    docker rm -f "$1" >/dev/null 2>&1 || true
    echo "$HARNESS_NAME: cannot register container $1 in $HARNESS_CONTAINER_REGISTRY" >&2
    exit 1
  }
}

# Acquires one explicitly named volume: proves the name free semantically, removes a
# same-name leftover only after it proved (on the daemon clock) to predate this
# invocation, re-proves the name free, creates the volume and registers it. Sets
# CREATED_VOLUME. Called in the parent shell so a failure aborts through the EXIT trap.
acquire_volume() { # EXACT_NAME
  local v="$1" created st
  st=0
  created="$(volume_state "$v")" || st=$?
  if [ "$st" -eq 2 ]; then
    echo "$HARNESS_NAME: cannot prove volume name $v free (inspect: $created); refusing to create on it" >&2
    exit 1
  fi
  if [ "$st" -eq 0 ]; then
    created="$(date -u -d "$created" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || {
      echo "$HARNESS_NAME: cannot parse CreatedAt '$created' of existing volume $v" >&2
      exit 1
    }
    if [[ "$created" > "$HARNESS_SCRIPT_START" ]]; then
      echo "$HARNESS_NAME: volume $v was created at $created, AFTER this invocation started ($HARNESS_SCRIPT_START) — contradicts the pid-ownership invariant; refusing to adopt it" >&2
      exit 1
    fi
    local rm_err
    rm_err="$(docker volume rm "$v" 2>&1)" || true
    st=0
    created="$(volume_state "$v")" || st=$?
    if [ "$st" -ne 1 ]; then
      echo "$HARNESS_NAME: stale volume $v still exists after removal attempt (rm: ${rm_err:-<no error>}; re-inspect: ${created:-<empty>})" >&2
      echo "$HARNESS_NAME: refusing to create on an occupied name; remove the stale invocation's container and volume first" >&2
      exit 1
    fi
  fi
  docker volume create "$v" >/dev/null || {
    echo "$HARNESS_NAME: cannot create volume $v" >&2
    exit 1
  }
  register_volume "$v"
  CREATED_VOLUME="$v"
}

# Per-invocation named volume with the standard pid-embedded scheme.
new_volume() { acquire_volume "${PREFIX}-$$-vol-$1"; }

harness_init() {
  HARNESS_REGISTRY="${TMPDIR:-/tmp}/${PREFIX}-harness-volumes-$$"
  if ! : > "$HARNESS_REGISTRY"; then
    echo "$HARNESS_NAME: cannot initialize volume registry $HARNESS_REGISTRY" >&2
    exit 1
  fi
  HARNESS_CONTAINER_REGISTRY="${TMPDIR:-/tmp}/${PREFIX}-harness-containers-$$"
  if ! : > "$HARNESS_CONTAINER_REGISTRY"; then
    echo "$HARNESS_NAME: cannot initialize container registry $HARNESS_CONTAINER_REGISTRY" >&2
    exit 1
  fi
  # SCRIPT_START is the daemon's own clock reading at invocation start, taken from the
  # CreatedAt of a short-lived probe volume — deliberately NOT the host `date`, so the
  # staleness comparison in acquire_volume is made in daemon time on both sides and
  # stays sound under host/daemon skew. The probe is removed again immediately; if that
  # removal fails it is registered so the EXIT trap still reclaims it.
  HARNESS_CLOCK_PROBE="${PREFIX}-$$-vol-clockref-$RANDOM"
  if ! docker volume create "$HARNESS_CLOCK_PROBE" >/dev/null 2>&1; then
    echo "$HARNESS_NAME: cannot create clock probe $HARNESS_CLOCK_PROBE to read the daemon clock" >&2
    exit 1
  fi
  HARNESS_SCRIPT_START="$(date -u -d "$(docker volume inspect -f '{{.CreatedAt}}' "$HARNESS_CLOCK_PROBE")" +%Y-%m-%dT%H:%M:%SZ)" || {
    echo "$HARNESS_NAME: cannot read the daemon clock from $HARNESS_CLOCK_PROBE" >&2
    exit 1
  }
  if docker volume rm "$HARNESS_CLOCK_PROBE" >/dev/null 2>&1; then
    :
  else
    register_volume "$HARNESS_CLOCK_PROBE"
  fi
  trap harness_cleanup EXIT
}

harness_cleanup() {
  local c v l
  for c in "${HARNESS_CONTAINERS[@]:-}"; do
    if [ -n "$c" ]; then docker rm -f "$c" >/dev/null 2>&1 || true; fi
  done
  # The file-based registry covers every start_detached container, including the ones
  # registered from inside a command substitution whose array append was lost.
  if [ -f "$HARNESS_CONTAINER_REGISTRY" ]; then
    while IFS= read -r c; do
      if [ -n "$c" ]; then docker rm -f "$c" >/dev/null 2>&1 || true; fi
    done < "$HARNESS_CONTAINER_REGISTRY"
    rm -f "$HARNESS_CONTAINER_REGISTRY"
  fi
  if [ -f "$HARNESS_REGISTRY" ]; then
    while IFS= read -r v; do
      if [ -n "$v" ]; then docker volume rm "$v" >/dev/null 2>&1 || true; fi
    done < "$HARNESS_REGISTRY"
    rm -f "$HARNESS_REGISTRY"
  fi
  for l in "${HARNESS_LOGS[@]:-}"; do
    if [ -n "$l" ]; then rm -f "$l"; fi
  done
}

# start_detached NAME [RUN_ARGS...] — `docker run -d` with the given arguments. The
# container is registered for cleanup only after create+start succeeded (the captured
# container id is the creation proof). On failure the best-effort removal touches ONLY
# the exact pid-embedded name: by the live-pid-uniqueness invariant that name can only
# be this invocation's own container or an orphan of a dead invocation that recycled the
# pid — never a foreign container that happens to exist.
start_detached() { # NAME [RUN_ARGS...]
  local name="$1"; shift
  local id=""
  id="$(dc run -d --name "$name" "$@")" || {
    docker rm -f "$name" >/dev/null 2>&1 || true
    echo "$HARNESS_NAME: cannot start container $name" >&2
    exit 1
  }
  HARNESS_CONTAINERS+=("$name")
  register_container "$name"
}

# Fresh writable /tmp for a run container: the Job provides /tmp as a plain writable
# emptyDir, so the tests mirror that with a fresh per-container volume acquired through
# the hardened ownership path (memory-backed tmpfs would die with the container and
# could never be inspected after exit).
new_run_tmp() { # NAME -> sets CREATED_VOLUME to the run's /tmp volume
  acquire_volume "${1}-tmp"
}

# The shared single-run web supervisor production command, launched through `sh -c
# 'exec java ...'` so container-absolute classpaths are never direct docker arguments
# (MSYS/Git Bash would path-mangle them) and exec replaces sh, keeping java as PID 1.
RUN_CMD='export MANAO_RUN_CONTROL_DIR=/run-control; exec java -cp /opt/manao-runner/classes com.manao.runtime.WebRunSupervisor "$@"'

# Console TASK shape: the fixed launcher directly as PID 1.
start_console_task() { # NAME CACHE_VOL WS_VOL NETWORK(none|bridge) [K=V ...]
  local name="$1" cache="$2" ws="$3" net="$4"
  shift 4
  new_run_tmp "$name"
  local tmpv="$CREATED_VOLUME"
  local -a args=(--user 10001:10001 --read-only -v "${tmpv}:/tmp")
  if [ "$net" = "none" ]; then args+=(--network none); fi
  if [ "${#EXTRA_RUN_ARGS[@]}" -gt 0 ]; then
    args+=("${EXTRA_RUN_ARGS[@]}")
  fi
  args+=(-v "${cache}:/python-cache" -v "${ws}:/workspace")
  local kv
  for kv in "$@"; do args+=(-e "$kv"); done
  args+=("$IMAGE" /usr/local/bin/manao-python console)
  start_detached "$name" "${args[@]}"
}

# Supervised web shape: the shared supervisor production main with the fixed
# python-fastapi-web profile; env pairs become -e flags. EXTRA_RUN_ARGS (when
# non-empty) carries extra docker run flags such as the low-port sysctl or the
# test-only shim volume/PATH override.
start_supervised_web() { # NAME CACHE_VOL WS_VOL CONTROL_VOL NETWORK(none|bridge) [K=V ...]
  local name="$1" cache="$2" ws="$3" control="$4" net="$5"
  shift 5
  new_run_tmp "$name"
  local tmpv="$CREATED_VOLUME"
  local -a args=(--user 10001:10001 --read-only -v "${tmpv}:/tmp")
  if [ "$net" = "none" ]; then args+=(--network none); fi
  if [ "${#EXTRA_RUN_ARGS[@]}" -gt 0 ]; then
    args+=("${EXTRA_RUN_ARGS[@]}")
  fi
  args+=(-v "${cache}:/python-cache" -v "${ws}:/workspace" -v "${control}:/run-control")
  local kv
  for kv in "$@"; do args+=(-e "$kv"); done
  args+=("$IMAGE" sh -c "$RUN_CMD" supervisor run python-fastapi-web)
  start_detached "$name" "${args[@]}"
}

# Wait for a container to exit: sets CASE_EXIT to the exit code, or TIMEOUT.
wait_case() { # NAME BUDGET_SECONDS
  CASE_EXIT=""
  local name="$1" budget="$2" waited=0 st
  while [ "$waited" -lt "$budget" ]; do
    st="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
    if [ "$st" = "exited" ]; then
      CASE_EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
      return 0
    fi
    sleep 1
    waited=$((waited+1))
  done
  CASE_EXIT="TIMEOUT"
  return 0
}

# wait_halt NAME BUDGET_SECONDS -> prints exit code, or TIMEOUT.
wait_halt() {
  wait_case "$1" "$2"
  printf '%s' "$CASE_EXIT"
}

container_running() {
  [ "$(docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null)" = "running" ]
}

runtime_seconds() {
  local s f
  s="$(docker inspect -f '{{.State.StartedAt}}' "$1")"
  f="$(docker inspect -f '{{.State.FinishedAt}}' "$1")"
  echo $(( $(date -u -d "$f" +%s) - $(date -u -d "$s" +%s) ))
}

# docker cp with an explicit Windows-form destination: MSYS/Git Bash path conversion is
# not reliable for every invocation environment (a raw "/tmp/..." destination would be
# resolved by the Windows docker CLI against the current drive as \tmp), so the local
# destination is converted with cygpath -m whenever it exists.
copy_out() { # NAME PATH DEST -> docker cp status
  local dest="$3"
  command -v cygpath >/dev/null 2>&1 && dest="$(cygpath -m "$3")"
  docker cp "$1:$2" "$dest" >/dev/null 2>&1
}

field_of() { # FILE KEY -> last value
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

epoch_of() { date -u -d "$1" +%s; }

future_utc() { date -u -d "+$1 seconds" +%Y-%m-%dT%H:%M:%SZ; }

# Logs of a container into a temp file (removed by the cleanup trap); prints the path.
log_of() {
  local f
  f="$(mktemp "${TMPDIR:-/tmp}/${PREFIX}-log.XXXXXX")" || return 1
  docker logs "$1" >"$f" 2>&1
  HARNESS_LOGS+=("$f")
  printf '%s' "$f"
}

# Readiness probe through the fixed profile; extra arguments (e.g. -e overrides) are
# passed to docker exec. Guarded by a timeout so an attach stall fails the poll instead
# of freezing the harness.
probe_exec() { # NAME [extra docker exec args...]
  local name="$1"; shift
  dc_t 30 exec "$@" "$name" sh -c "$RUN_CMD" supervisor probe python-fastapi-web >/dev/null 2>&1
}

wait_probe_ready() { # NAME BUDGET_SECONDS
  local waited=0
  while [ "$waited" -lt "$2" ]; do
    if probe_exec "$1"; then return 0; fi
    sleep 1
    waited=$((waited+1))
  done
  return 1
}

# Business request through the real venv python: exits 0 only for a 200 response whose
# body contains the template's fixed welcome message.
request_demo() { # NAME PORT
  dc_t 30 exec "$1" /usr/local/bin/python3 -c '
import sys, urllib.request
with urllib.request.urlopen(sys.argv[1], timeout=5) as response:
    body = response.read().decode("utf-8")
    sys.exit(0 if response.status == 200 and "Hello from Manao" in body else 3)
' "http://127.0.0.1:$2/api/demo" >/dev/null 2>&1
}

seed_id_of_image() {
  dc_t 60 run --rm --network none --entrypoint /bin/sh "$IMAGE" -c 'tr -d "[:space:]" < /opt/manao-python-seed/seed-id'
}

# Makes a mounted volume directory writable by the real cluster identity (UID/GID 10001,
# what the workspace initializer and the Job's cache init container achieve in the
# cluster). Mountpoints are only ever used inside sh -c strings.
prep_dir() { # VOLUME MOUNTPOINT
  dc_t 120 run --rm --user 0 -v "$1:$2" "$IMAGE" sh -c "chown 10001:10001 '$2'" >/dev/null 2>&1 \
    || { echo "$HARNESS_NAME: cannot prep $1" >&2; exit 1; }
}

# Loads an exported template variant from the runtime-test image into a fresh workspace
# volume, owned by the cluster identity.
prep_workspace() { # WS_VOL VARIANT
  dc_t 120 run --rm --user 0 -v "$1:/workspace" "$IMAGE" \
    sh -c "cp -r /opt/manao-python-templates/$2/. /workspace/ && chown -R 10001:10001 /workspace" >/dev/null 2>&1 \
    || { echo "$HARNESS_NAME: cannot load workspace $2 into $1" >&2; exit 1; }
}

# One-time image materialization: the first container start of a freshly built image can
# take longer than the per-scenario budgets, so warm the image before any scenario.
harness_warmup() {
  echo "$HARNESS_NAME: warming up (first container start materializes the image)"
  dc_t 120 run --rm --network none "$IMAGE" \
    sh -c 'command -v uv >/dev/null && command -v java >/dev/null && command -v python3 >/dev/null' >/dev/null 2>&1 \
    || { echo "$HARNESS_NAME: image warmup failed (uv/java/python3 missing)" >&2; exit 1; }
}

# Writes a test-only cp shim into a per-run test volume. The launcher reads no
# environment and images contain no such file, so production cannot be influenced; the
# shim is activated only by the harness's PATH override. MODE selects the behavior:
#   block    one whole-call delay (MANAO_TEST_CP_DELAY seconds, then the real copy) —
#            used to hold package preparation past the startup deadline;
#   throttle recursive per-entry copy with MANAO_TEST_COPY_DELAY between entries — used
#            to keep a seed staging copy visibly in progress for the kill-mid-copy test.
# The script travels as a base64 argument (no stdin plumbing) and is verified
# synchronously (existence + executability, timeout-guarded retries) BEFORE the
# scenario's run container starts, because the launcher resolves cp at its first call.
write_delayed_cp_shim() { # VOLUME MODE
  local mode="$2" shim_b64
  if [ "$mode" = "block" ]; then
    shim_b64="$(printf '%s\n' \
      '#!/bin/bash' \
      'set -eu' \
      'if [ "${1:-}" = "--" ]; then shift; fi' \
      'sleep "${MANAO_TEST_CP_DELAY:-0}"' \
      'exec /usr/bin/cp "$@"' \
      | base64 -w0)"
  else
    shim_b64="$(printf '%s\n' \
      '#!/bin/bash' \
      'set -eu' \
      'if [ "${1:-}" = "--" ]; then shift; fi' \
      'delay="${MANAO_TEST_COPY_DELAY:-0}"' \
      '[ "$delay" = "0" ] && exec /usr/bin/cp "$@"' \
      'while [ "$#" -gt 2 ]; do' \
      '  case "$1" in' \
      '    -*) shift ;;' \
      '    *) break ;;' \
      '  esac' \
      'done' \
      'src="$1"; dst="$2"' \
      'if [ -d "$src" ]; then' \
      '  mkdir -p "$dst"' \
      '  (cd "$src" && find . -mindepth 1 -print0) | sort -z | while IFS= read -r -d "" entry; do' \
      '    sleep "$delay"' \
      '    if [ -d "$src/$entry" ]; then' \
      '      mkdir -p "$dst/$entry"' \
      '    else' \
      '      mkdir -p "$dst/$(dirname "$entry")"' \
      '      /usr/bin/cp -- "$src/$entry" "$dst/$entry"' \
      '    fi' \
      '  done' \
      'else' \
      '  sleep "$delay"' \
      '  exec /usr/bin/cp -- "$src" "$dst"' \
      'fi' \
      | base64 -w0)"
  fi
  local wname tried=0 ok=""
  wname="$(dc_t 60 run -d --rm --name "${PREFIX}-$$-shim-writer" --user 0 -v "$1:/shim" "$IMAGE" \
    sh -c 'printf %s "$1" | base64 -d > /shim/cp && chmod 0555 /shim/cp' \
    shim "$shim_b64")" \
    || { echo "$HARNESS_NAME: cannot write the test cp shim into $1" >&2; exit 1; }
  HARNESS_CONTAINERS+=("${PREFIX}-$$-shim-writer")
  while [ "$tried" -lt 10 ]; do
    # timeout guards against a Docker Desktop start stall; docker is called directly
    # (an external timeout cannot execute the dc() shell function).
    if MSYS_NO_PATHCONV=1 timeout 20 docker run --rm --network none -v "$1:/shim" "$IMAGE" \
         sh -c 'test -s /shim/cp && test -x /shim/cp' >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 2
    tried=$((tried+1))
  done
  if [ -z "$ok" ]; then
    echo "$HARNESS_NAME: the test cp shim never became usable in $1" >&2
    exit 1
  fi
}

#!/bin/bash
# Real-container lifecycle tests for the Python runner image and the fixed manao-python
# launcher (python runtime plan, task 4).
#
# Usage (needs a Docker CLI talking to a Linux-container daemon):
#   bash poc4/python-runner/tests/runtime-lifecycle.sh <runtime-test-image> [prefix]
#
# Covers only the real uv/Python launch chain, in the production container shape
# (UID/GID 10001, read-only rootfs, writable tmpfs /tmp, per-project cache volume):
#   - launcher mode discipline: exactly console|web, exit 2 before any cache or venv work
#   - console TASK exit 0 and exit 1 through the real locked install
#   - Chinese (UTF-8) application logs through the real stdout/stderr pipe
#   - FastAPI readiness over the supervisor profile, business traffic, manual stop (TERM)
#   - install blocking past the startup deadline (test-only throttled cp shim in a test
#     volume) ends the run with STARTUP_TIMED_OUT and never starts the application
#   - short expiry honours the service lifetime with the real FastAPI process
#   - TERM to a console run whose derived Python child ignores SIGTERM is reaped with the
#     container (forced namespace teardown)
#   - low port 80 under the safe low-port sysctl
# The shared supervisor state machine (claim, receipt write failures, duplicate claim,
# clocks) is NOT re-tested here — maven-runner/tests/runtime-lifecycle.sh keeps that
# matrix; this script only adds the Python-profile-specific launch chain.
#
# Every container and volume is created under a per-invocation prefix and removed by
# exact name on exit; volume names embed the host pid, so a reused PREFIX can never make
# two invocations share a volume identity. A same-name leftover must prove, from the
# daemon's own clock, that it predates this invocation before it is removed; a name that
# is still occupied or contradicts that proof aborts the run instead of being adopted.
# Assertions use docker wait/inspect state, exit codes, timestamps, receipts and files
# copied out of containers — never log text matching alone. The one deliberate exception
# is the Chinese-log scenario, where the application log itself is the product under test.
set -u

IMAGE="${1:?usage: runtime-lifecycle.sh <runtime-test-image> [prefix]}"
PREFIX="${2:-manao-py-rt-$$}"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "runtime-lifecycle: image '$IMAGE' does not exist; build it first (task 4 step 2)" >&2
  exit 2
fi

CONTAINERS=()
PASS=0
FAIL=0
EXTRA_RUN_ARGS=()

# Exact names of every volume this invocation created. new_volume is always called in the
# parent shell; this registry file, keyed by the unique host process id, is the persistent
# exact-name cleanup source and is removed again on exit. Volume names themselves embed
# the host pid, so even a reused PREFIX can never make this invocation adopt — and later
# delete — a volume that belongs to another invocation.
VOLUME_REGISTRY="${TMPDIR:-/tmp}/python-runtime-lifecycle-volumes-$$"
if ! : > "$VOLUME_REGISTRY"; then
  echo "runtime-lifecycle: cannot initialize volume registry $VOLUME_REGISTRY" >&2
  exit 1
fi

cleanup() {
  local c v
  for c in "${CONTAINERS[@]:-}"; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1
  done
  while IFS= read -r v; do
    [ -n "$v" ] && docker volume rm "$v" >/dev/null 2>&1
  done < "$VOLUME_REGISTRY"
  rm -f "$VOLUME_REGISTRY"
}
trap cleanup EXIT

# SCRIPT_START is the daemon's own clock reading at invocation start, taken from the
# CreatedAt of a short-lived probe volume — deliberately NOT the host `date`, so the
# staleness comparison in new_volume is made in daemon time on both sides and stays sound
# under host/daemon skew. The probe is removed again immediately; if that removal fails it
# is registered so the EXIT trap still reclaims it.
CLOCK_PROBE="${PREFIX}-$$-vol-clockref-$RANDOM"
if ! docker volume create "$CLOCK_PROBE" >/dev/null 2>&1; then
  echo "runtime-lifecycle: cannot create clock probe $CLOCK_PROBE to read the daemon clock" >&2
  exit 1
fi
SCRIPT_START="$(date -u -d "$(docker volume inspect -f '{{.CreatedAt}}' "$CLOCK_PROBE")" +%Y-%m-%dT%H:%M:%SZ)" || {
  echo "runtime-lifecycle: cannot read the daemon clock from $CLOCK_PROBE" >&2
  exit 1
}
docker volume rm "$CLOCK_PROBE" >/dev/null 2>&1 || printf '%s\n' "$CLOCK_PROBE" >> "$VOLUME_REGISTRY"

pass() { PASS=$((PASS+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# docker with MSYS/Git Bash path conversion disabled: several arguments carry
# container-absolute paths (--tmpfs /tmp, --sysctl, -e PATH=/shim:..., --entrypoint /bin/sh,
# /usr/local/bin/manao-python). On Linux the variable is simply unknown to docker and
# changes nothing; no host paths are ever passed through dc().
dc() { MSYS_NO_PATHCONV=1 docker "$@"; }

# Same as dc() with a hard timeout: one-shot helper containers (prep, fixture writers)
# must never hang the whole harness on an intermittent Docker Desktop attach stall.
# An external timeout cannot execute the dc() shell function, hence the direct form.
dc_t() { local t="$1"; shift; MSYS_NO_PATHCONV=1 timeout "$t" docker "$@"; }

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

# Create one uniquely-owned volume, register its exact name and expose it as
# CREATED_VOLUME. Called in the parent shell so a failure aborts the whole script through
# the EXIT trap — a scenario can never keep running with an empty volume name. Ownership
# invariant: a live pid is unique among live (MSYS/Git Bash) processes, so a volume named
# with THIS pid and a matching tag can only have been created by a dead invocation that
# recycled the same pid. Enforced in order: (1) "name is free" must be proven semantically
# before create — any indeterminate inspect aborts; (2) an existing same-name volume must
# prove it predates this invocation (CreatedAt, daemon clock, vs SCRIPT_START) before it
# is removed as a stale orphan; (3) a NEWER CreatedAt contradicts the pid invariant and
# aborts instead of being adopted; (4) after removal the name must again be provably free.
new_volume() {
  local v="${PREFIX}-$$-vol-$1" created st
  created="$(volume_state "$v")"; st=$?
  if [ "$st" -eq 2 ]; then
    echo "runtime-lifecycle: cannot prove volume name $v free (inspect: $created); refusing to create on it" >&2
    exit 1
  fi
  if [ "$st" -eq 0 ]; then
    created="$(date -u -d "$created" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || {
      echo "runtime-lifecycle: cannot parse CreatedAt '$created' of existing volume $v" >&2
      exit 1
    }
    if [[ "$created" > "$SCRIPT_START" ]]; then
      echo "runtime-lifecycle: volume $v was created at $created, AFTER this invocation started ($SCRIPT_START) — contradicts the pid-ownership invariant; refusing to adopt it" >&2
      exit 1
    fi
    local rm_err
    rm_err="$(docker volume rm "$v" 2>&1)" || true
    created="$(volume_state "$v")"; st=$?
    if [ "$st" -ne 1 ]; then
      echo "runtime-lifecycle: stale volume $v still exists after removal attempt (rm: ${rm_err:-<no error>}; re-inspect: ${created:-<empty>})" >&2
      echo "runtime-lifecycle: refusing to create on an occupied name; remove the stale invocation's container and volume first" >&2
      exit 1
    fi
  fi
  docker volume create "$v" >/dev/null || {
    echo "runtime-lifecycle: cannot create volume $v" >&2
    exit 1
  }
  if ! printf '%s\n' "$v" >> "$VOLUME_REGISTRY"; then
    docker volume rm "$v" >/dev/null 2>&1
    echo "runtime-lifecycle: cannot register volume $v in $VOLUME_REGISTRY" >&2
    exit 1
  fi
  CREATED_VOLUME="$v"
}

# Makes a mounted volume directory writable by the real cluster identity (UID/GID 10001,
# what the workspace initializer and the Job's cache init container achieve in the
# cluster). Mountpoints are only ever used inside sh -c strings.
prep_dir() { # VOLUME MOUNTPOINT
  dc_t 120 run --rm --user 0 -v "$1:$2" "$IMAGE" sh -c "chown 10001:10001 '$2'" >/dev/null 2>&1 \
    || { echo "runtime-lifecycle: cannot prep $1" >&2; exit 1; }
}

# Loads an exported template variant from the runtime-test image into a fresh workspace
# volume, owned by the cluster identity.
prep_workspace() { # WS_VOL VARIANT
  dc_t 120 run --rm --user 0 -v "$1:/workspace" "$IMAGE" \
    sh -c "cp -r /opt/manao-python-templates/$2/. /workspace/ && chown -R 10001:10001 /workspace" >/dev/null 2>&1 \
    || { echo "runtime-lifecycle: cannot load workspace $2 into $1" >&2; exit 1; }
}

# Writes the test-only delayed cp shim into a per-run test volume. The launcher reads no
# environment and images contain no such file, so production cannot be influenced; the
# shim is activated only by this harness's PATH override (MANAO_TEST_CP_DELAY). The script
# travels as a base64 argument (no stdin plumbing), the write is detached so a Docker
# Desktop reaping stall can never block the harness, and the file is verified
# synchronously BEFORE the scenario's run container starts — the launcher resolves cp at
# its first call, so a late file would silently bypass the shim.
write_delayed_cp_shim() { # VOLUME
  local shim_b64
  shim_b64="$(printf '%s\n' \
    '#!/bin/bash' \
    'set -eu' \
    'if [ "${1:-}" = "--" ]; then shift; fi' \
    'sleep "${MANAO_TEST_CP_DELAY:-0}"' \
    'exec /usr/bin/cp "$@"' \
    | base64 -w0)"
  local wname tried=0 ok=""
  wname="$(dc run -d --rm --name "${PREFIX}-$$-shim-writer" --user 0 -v "$1:/shim" "$IMAGE" \
    sh -c 'printf %s "$1" | base64 -d > /shim/cp && chmod 0555 /shim/cp' \
    shim "$shim_b64")" \
    || { echo "runtime-lifecycle: cannot write the test cp shim into $1" >&2; exit 1; }
  CONTAINERS+=("$wname")
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
  [ -n "$ok" ] || { echo "runtime-lifecycle: the test cp shim never became usable in $1" >&2; exit 1; }
}

# Java inside containers is always launched through `sh -c 'exec java ...'` so that
# container-absolute classpaths are never direct docker arguments (MSYS/Git Bash would
# path-mangle them) and so that exec replaces sh, keeping java as PID 1.
RUN_CMD='export MANAO_RUN_CONTROL_DIR=/run-control; exec java -cp /opt/manao-runner/classes com.manao.runtime.WebRunSupervisor "$@"'

# start_console_task NAME CACHE_VOL WS_VOL [K=V ...]
# Starts the fixed launcher directly as PID 1 — the console TASK shape. EXTRA_RUN_ARGS
# (when non-empty) carries extra docker run flags such as the evidence volume of the TERM
# scenario.
start_console_task() {
  local name="$1" cache="$2" ws="$3"
  shift 3
  # The Job provides /tmp as a plain writable emptyDir, so the tests mirror that with a
  # fresh per-container volume (memory-backed tmpfs would die with the container and
  # could never be inspected after exit).
  local tmpv="${name}-tmp"
  docker volume create "$tmpv" >/dev/null || { echo "runtime-lifecycle: cannot create $tmpv" >&2; exit 1; }
  printf '%s\n' "$tmpv" >> "$VOLUME_REGISTRY"
  local -a args=(run -d --name "$name"
                 --user 10001:10001 --read-only --network none
                 -v "${tmpv}:/tmp")
  if [ "${#EXTRA_RUN_ARGS[@]}" -gt 0 ]; then
    args+=("${EXTRA_RUN_ARGS[@]}")
  fi
  args+=(-v "${cache}:/python-cache" -v "${ws}:/workspace")
  local kv
  for kv in "$@"; do args+=(-e "$kv"); done
  args+=("$IMAGE" /usr/local/bin/manao-python console)
  if dc "${args[@]}" >/dev/null; then
    CONTAINERS+=("$name")
  else
    docker rm -f "$name" >/dev/null 2>&1 || true
    echo "runtime-lifecycle: cannot start console container $name" >&2
    exit 1
  fi
}

# start_supervised NAME CACHE_VOL WS_VOL CONTROL_VOL [K=V ...] -- run|probe [profile]
# Starts the shared supervisor production main with the fixed Python profile; env pairs
# before the "--" separator become -e flags, the arguments after it are the supervisor
# argv. EXTRA_RUN_ARGS (when non-empty) carries extra docker run flags such as the
# low-port sysctl.
start_supervised() {
  local name="$1" cache="$2" ws="$3" control="$4"
  shift 4
  local -a envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    envs+=("$1")
    shift
  done
  if [ "${1:-}" = "--" ]; then
    shift
  else
    echo "runtime-lifecycle: start_supervised needs '-- run|probe ...' command arguments" >&2
    exit 1
  fi
  local tmpv="${name}-tmp"
  docker volume create "$tmpv" >/dev/null || { echo "runtime-lifecycle: cannot create $tmpv" >&2; exit 1; }
  printf '%s\n' "$tmpv" >> "$VOLUME_REGISTRY"
  local -a args=(run -d --name "$name"
                 --user 10001:10001 --read-only --network none
                 -v "${tmpv}:/tmp")
  if [ "${#EXTRA_RUN_ARGS[@]}" -gt 0 ]; then
    args+=("${EXTRA_RUN_ARGS[@]}")
  fi
  args+=(-v "${cache}:/python-cache" -v "${ws}:/workspace" -v "${control}:/run-control")
  local kv
  for kv in "${envs[@]}"; do args+=(-e "$kv"); done
  args+=("$IMAGE" sh -c "$RUN_CMD" supervisor "$@")
  if dc "${args[@]}" >/dev/null; then
    CONTAINERS+=("$name")
  else
    docker rm -f "$name" >/dev/null 2>&1 || true
    echo "runtime-lifecycle: cannot start supervised container $name" >&2
    exit 1
  fi
}

# wait_halt NAME BUDGET_SECONDS -> prints exit code, or TIMEOUT
wait_halt() {
  local name="$1" budget="$2" waited=0 st
  while [ "$waited" -lt "$budget" ]; do
    st="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
    if [ "$st" = "exited" ]; then
      docker inspect -f '{{.State.ExitCode}}' "$name"
      return 0
    fi
    sleep 1
    waited=$((waited+1))
  done
  echo "TIMEOUT"
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

probe_exec() { # NAME [extra docker exec args...]
  local name="$1"; shift
  dc_t 30 exec "$@" "$name" sh -c "$RUN_CMD" supervisor probe python-fastapi-web >/dev/null 2>&1
}

wait_probe_ready() { # NAME BUDGET_SECONDS
  local waited=0
  while [ "$waited" -lt "$2" ]; do
    probe_exec "$1" && return 0
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

COMMON_ENV=(MANAO_PROJECT_ID=proj-a MANAO_PRIMARY_PORT=18080)

# The launcher is the only accepted entry and must reject everything else with exit 2
# before any cache, venv or install work — proven by no /tmp/manao-python venv being
# created and by runs that mount no cache at all (any cache work would die differently).
scenario_launcher_mode_discipline() {
  local label argv name code
  for label in no-args unknown-mode console-extra web-extra web-without-port; do
    case "$label" in
      no-args)         argv="" ;;
      unknown-mode)    argv="serve" ;;
      console-extra)   argv="console extra" ;;
      web-extra)       argv="web extra" ;;
      web-without-port) argv="web" ;;
    esac
    name="${PREFIX}-$$-mode-$label"
    # No /python-cache and no /workspace mount: a launcher that did cache or install work
    # before mode validation could not exit 2 here.
    docker volume create "${name}-tmp" >/dev/null \
      && printf '%s\n' "${name}-tmp" >> "$VOLUME_REGISTRY" \
      || { echo "runtime-lifecycle: cannot create ${name}-tmp" >&2; exit 1; }
    if dc run -d --name "$name" --user 10001:10001 --read-only --network none \
         -v "${name}-tmp:/tmp" \
         "$IMAGE" /usr/local/bin/manao-python $argv >/dev/null; then
      CONTAINERS+=("$name")
    else
      docker rm -f "$name" >/dev/null 2>&1 || true
      echo "runtime-lifecycle: cannot start mode container $name" >&2
      exit 1
    fi
    code="$(wait_halt "$name" 30)"
    [ "$code" = "2" ] || { fail "$name (argv='$argv': exit=$code, want 2)"; continue; }
    [ "$(runtime_seconds "$name")" -le 10 ] || { fail "$name (argv='$argv': rejection took too long)"; continue; }
    # The rejection proof is the exit code itself: these containers mount no cache and no
    # workspace at all, so any cache, venv or install work could not have exited 2 here.
    pass "$name (argv='$argv' rejected with no venv work)"
  done
}

# Console TASK through the real chain: cold cache, no network, seed + locked install and
# the template's fixed output. Exit 0 is itself the venv proof — the launcher execs the
# fixed path /tmp/manao-python/.venv/bin/python, so a missing venv could never exit 0.
# The tmpfs venv dies with the one-shot container, so it is not copied out post-exit
# (the cache script inspects venv contents on running containers instead).
scenario_console_task_exit_0() {
  local name="${PREFIX}-$$-console0"
  local cache ws marker
  new_volume console0-cache; cache="$CREATED_VOLUME"
  new_volume console0-ws; ws="$CREATED_VOLUME"
  prep_dir "$cache" /python-cache
  prep_workspace "$ws" console
  start_console_task "$name" "$cache" "$ws"
  local code; code="$(wait_halt "$name" 180)"
  [ "$code" = "0" ] || { fail "$name (exit=$code, want 0)"; return 0; }
  [ "$(runtime_seconds "$name")" -le 120 ] || fail "$name (console TASK took too long)"
  SEED_ID="$(seed_id_of_image)"
  marker="${TMPDIR:-/tmp}/${PREFIX}-console0-marker"
  rm -rf "$marker"
  copy_out "$name" "/python-cache/seeded-$SEED_ID" "$marker" \
    || { fail "$name (cache completion marker missing after the run)"; return 0; }
  # The workspace must not be polluted by the install (no bytecode, no venv redirect).
  if dc run --rm --network none -v "${ws}:/workspace" "$IMAGE" \
       sh -c 'test -z "$(find /workspace \( -name __pycache__ -o -name .venv \) -print -quit)"' >/dev/null 2>&1; then
    pass "$name (exit 0 via the venv python, marker published, workspace clean)"
  else
    fail "$name (workspace was polluted by the install)"
  fi
}

# A failing console program must surface its real exit code through the launcher exec.
scenario_console_task_exit_1() {
  local name="${PREFIX}-$$-console1"
  local cache ws
  new_volume console1-cache; cache="$CREATED_VOLUME"
  new_volume console1-ws; ws="$CREATED_VOLUME"
  prep_dir "$cache" /python-cache
  prep_workspace "$ws" console
  dc_t 120 run --rm --user 0 -v "${ws}:/workspace" "$IMAGE" \
    sh -c 'printf "%s\n" "import sys" "sys.exit(1)" > /workspace/main.py && chown 10001:10001 /workspace/main.py' >/dev/null 2>&1
  start_console_task "$name" "$cache" "$ws"
  local code; code="$(wait_halt "$name" 180)"
  [ "$code" = "1" ] || { fail "$name (exit=$code, want the program's own 1)"; return 0; }
  [ "$(runtime_seconds "$name")" -le 120 ] || fail "$name (exit took too long)"
  pass "$name (program exit code 1 propagated)"
}

# Chinese application output must survive the real uv/Python/stdout chain intact (UTF-8,
# unbuffered) on both stdout and stderr. The log is the product under test here.
scenario_console_chinese_logs() {
  local name="${PREFIX}-$$-chinese"
  local cache ws log
  new_volume chinese-cache; cache="$CREATED_VOLUME"
  new_volume chinese-ws; ws="$CREATED_VOLUME"
  prep_dir "$cache" /python-cache
  prep_workspace "$ws" console
  dc_t 120 run --rm --user 0 -v "${ws}:/workspace" "$IMAGE" \
    sh -c 'printf "%s\n" \
      "import sys" \
      "print(\"中文日志：你好，Manao 运行时\")" \
      "print(\"错误信息：中文输出到 stderr\", file=sys.stderr)" \
      > /workspace/main.py && chown 10001:10001 /workspace/main.py' >/dev/null 2>&1
  start_console_task "$name" "$cache" "$ws"
  local code; code="$(wait_halt "$name" 180)"
  [ "$code" = "0" ] || { fail "$name (exit=$code, want 0)"; return 0; }
  log="/tmp/${PREFIX}-chinese.log"
  docker logs "$name" >"$log" 2>&1
  if grep -qF '中文日志：你好，Manao 运行时' "$log" \
     && grep -qF '错误信息：中文输出到 stderr' "$log"; then
    pass "$name (Chinese stdout and stderr intact)"
  else
    fail "$name (Chinese log output was mangled or lost)"
  fi
}

# TERM to a console run whose derived Python child ignores SIGTERM. Kernel PID-1
# semantics keep the exec'd program on the default SIGTERM disposition (signals with the
# default disposition are not delivered to PID 1 — the same reason manao-maven traps TERM
# during its copy phase), so docker stop's grace period elapses and the forced kill ends
# PID 1; the namespace teardown then reaps the ignoring child with it. The container must
# end within the stop grace plus a bounded margin, and the evidence volume must prove
# both processes really ran.
scenario_console_term_reaps_term_ignoring_child() {
  local name="${PREFIX}-$$-term"
  local cache ws childvol evidence code
  new_volume term-cache; cache="$CREATED_VOLUME"
  new_volume term-ws; ws="$CREATED_VOLUME"
  new_volume term-child; childvol="$CREATED_VOLUME"
  prep_dir "$cache" /python-cache
  prep_dir "$childvol" /childout
  prep_workspace "$ws" console
  local child_b64
  child_b64="$(base64 -w0 < "$(dirname "$0")/fixtures/child_process.py")"
  dc_t 120 run --rm --user 0 -v "${ws}:/workspace" "$IMAGE" \
    sh -c 'printf %s "$1" | base64 -d > /workspace/child_process.py && chown 10001:10001 /workspace/child_process.py' \
    shim "$child_b64" >/dev/null 2>&1
  dc_t 120 run --rm --user 0 -v "${ws}:/workspace" "$IMAGE" \
    sh -c 'printf "%s\n" \
      "import os, subprocess, sys, time" \
      "with open(os.environ[\"MANAO_TEST_EVIDENCE\"], \"a\", encoding=\"utf-8\") as handle:" \
      "    handle.write(\"parent-started\\n\")" \
      "    handle.flush()" \
      "child = subprocess.Popen([sys.executable, \"-u\", \"child_process.py\"])" \
      "assert child.pid > 0" \
      "while True:" \
      "    time.sleep(3600)" \
      > /workspace/main.py && chown 10001:10001 /workspace/main.py' >/dev/null 2>&1
  EXTRA_RUN_ARGS=(-v "${childvol}:/childout")
  start_console_task "$name" "$cache" "$ws" MANAO_TEST_EVIDENCE=/childout/evidence.log
  EXTRA_RUN_ARGS=()
  # Wait until the evidence file proves both parent and TERM-ignoring child are running.
  local waited=0
  evidence="/tmp/${PREFIX}-term-evidence.log"
  rm -f "$evidence"
  while [ "$waited" -lt 120 ]; do
    copy_out "$name" /childout/evidence.log "$evidence" \
      && grep -q '^parent-started$' "$evidence" && grep -q '^child-started$' "$evidence" && break
    sleep 1
    waited=$((waited+1))
  done
  if ! grep -q '^child-started$' "$evidence" 2>/dev/null; then
    fail "$name (the derived Python child never started)"
    return 0
  fi
  docker stop -t 10 "$name" >/dev/null
  code="$(wait_halt "$name" 30)"
  [ "$code" = "137" ] || { fail "$name (exit=$code, want 137: the stop grace ends in the forced kill of PID 1)"; return 0; }
  local secs; secs="$(runtime_seconds "$name")"
  [ "$secs" -le 40 ] \
    || { fail "$name (container lived ${secs}s after TERM; derived process was not reaped)"; return 0; }
  pass "$name (forced stop ended PID 1 and the ignoring child was reaped with the container)"
}

# The full supervised FastAPI chain: readiness via the fixed python-fastapi-web profile,
# business traffic, READY receipt with claim before it, a probe must reject a dead port,
# and a manual stop (TERM) ends the run with USER_STOPPED and exit 0.
scenario_fastapi_ready_demo_stop() {
  local name="${PREFIX}-$$-web-stop"
  local cache ws control rc code
  new_volume webstop-cache; cache="$CREATED_VOLUME"
  new_volume webstop-ws; ws="$CREATED_VOLUME"
  new_volume webstop-control; control="$CREATED_VOLUME"
  prep_dir "$cache" /python-cache
  prep_dir "$control" /run-control
  prep_workspace "$ws" web
  start_supervised "$name" "$cache" "$ws" "$control" \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-web-stop MANAO_POD_UID=pod-web-stop \
    MANAO_SERVICE_LIFETIME_SECONDS=180 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)" \
    -- run python-fastapi-web
  wait_probe_ready "$name" 240 || { fail "$name (FastAPI never became ready)"; return 0; }
  if probe_exec "$name" -e MANAO_PRIMARY_PORT=59999; then
    fail "$name (probe accepted a dead port)"; return 0
  fi
  request_demo "$name" 18080 \
    || { fail "$name (/api/demo did not serve the template business response)"; return 0; }
  rc="/tmp/${PREFIX}-receipt-webstop.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "READY" ] || { fail "$name (receipt state=$(field_of "$rc" state), want READY)"; return 0; }
  [ -n "$(field_of "$rc" firstReadyAt)" ] || { fail "$name (receipt lacks firstReadyAt)"; return 0; }
  if ! dc run --rm --network none -v "${control}:/run-control" "$IMAGE" \
         sh -c 'test -d /run-control/claim' >/dev/null 2>&1; then
    fail "$name (no claim in the control directory)"
    return 0
  fi
  docker stop -t 30 "$name" >/dev/null
  code="$(wait_halt "$name" 45)"
  [ "$code" = "0" ] || { fail "$name (exit=$code after stop, want 0)"; return 0; }
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (final receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "EXITED" ] && [ "$(field_of "$rc" reason)" = "USER_STOPPED" ] \
    || { fail "$name (final receipt state/reason wrong)"; return 0; }
  pass "$name (ready, business OK, claim present, TERM stop with USER_STOPPED)"
}

# While the package preparation blocks (test-only delayed cp shim on the seed copy), the
# startup deadline must end the run with STARTUP_TIMED_OUT, kill the launcher, and never
# start the application. The claim must exist (preparation happens after the claim), the
# receipt must carry no firstReadyAt, and the interrupted seed must have left no marker.
scenario_fastapi_install_blocked_startup_timeout() {
  local name="${PREFIX}-$$-install-block"
  local cache ws control shim rc code
  new_volume install-block-cache; cache="$CREATED_VOLUME"
  new_volume install-block-ws; ws="$CREATED_VOLUME"
  new_volume install-block-control; control="$CREATED_VOLUME"
  new_volume install-block-shim; shim="$CREATED_VOLUME"
  prep_dir "$cache" /python-cache
  prep_dir "$control" /run-control
  prep_workspace "$ws" web
  write_delayed_cp_shim "$shim"
  local image_path
  image_path="$(dc run --rm --entrypoint /bin/sh "$IMAGE" -c 'printf %s "$PATH"')"
  [ -n "$image_path" ] || { echo "runtime-lifecycle: cannot read the image PATH" >&2; exit 1; }
  EXTRA_RUN_ARGS=(-v "${shim}:/shim" -e "PATH=/shim:${image_path}" -e "MANAO_TEST_CP_DELAY=120")
  start_supervised "$name" "$cache" "$ws" "$control" \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-install-block MANAO_POD_UID=pod-install-block \
    MANAO_SERVICE_LIFETIME_SECONDS=120 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 12)" \
    -- run python-fastapi-web
  EXTRA_RUN_ARGS=()
  # Prove the shim is engaged before drawing any conclusion from the exit code. The exec
  # must wait for the container to actually run (docker run -d can return while the
  # container is still being created).
  local engaged="" tries=0
  while [ "$tries" -lt 15 ]; do
    engaged="$(dc_t 30 exec "$name" sh -c 'command -v cp' 2>/dev/null)" && [ -n "$engaged" ] && break
    sleep 1
    tries=$((tries+1))
  done
  if [ "$engaged" != "/shim/cp" ]; then
    # Bounded diagnostics on stdout for the report: what the exec saw, what PATH the
    # container was configured with, and what the shim volume actually holds.
    local cpath shim_ls
    cpath="$(docker inspect "$name" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null | grep '^PATH=' || true)"
    shim_ls="$(dc run --rm --network none -v "${shim}:/shim" "$IMAGE" sh -c 'ls -la /shim; head -c 40 /shim/cp 2>/dev/null' 2>&1 || true)"
    printf 'install-block diagnostics: exec-output=%s\ncontainer-env: %s\nshim-volume:\n%s\n' \
      "${engaged:-<empty>}" "${cpath:-<none>}" "${shim_ls:-<none>}"
    fail "$name (test cp shim not engaged; PATH override failed)"
    return 0
  fi
  code="$(wait_halt "$name" 90)"
  [ "$code" = "126" ] || { fail "$name (exit=$code, want 126)"; return 0; }
  [ "$(runtime_seconds "$name")" -le 45 ] || fail "$name (startup rejection took too long)"
  rc="/tmp/${PREFIX}-receipt-install-block.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "STARTUP_TIMED_OUT" ] \
    && [ "$(field_of "$rc" reason)" = "STARTUP_TIME_LIMIT_EXCEEDED" ] \
    || { fail "$name (receipt state/reason wrong)"; return 0; }
  [ -z "$(field_of "$rc" firstReadyAt)" ] \
    || { fail "$name (receipt carries firstReadyAt; the application started)"; return 0; }
  if ! dc run --rm --network none -v "${control}:/run-control" "$IMAGE" \
         sh -c 'test -d /run-control/claim' >/dev/null 2>&1; then
    fail "$name (no claim in the control directory)"
    return 0
  fi
  SEED_ID="$(seed_id_of_image)"
  if dc run --rm --network none -v "${cache}:/python-cache" "$IMAGE" \
       sh -c "test ! -e /python-cache/seeded-$SEED_ID && test ! -d /python-cache/uv-cache" >/dev/null 2>&1; then
    pass "$name (startup deadline enforced during blocked install; no marker, no app)"
  else
    fail "$name (interrupted seed published a marker or a cache directory)"
  fi
}

# The real FastAPI process must honour the service lifetime: expiry is measured from
# firstReadyAt, the run ends with TIMED_OUT close to expiresAt, and the termination
# message is written.
scenario_fastapi_short_expiry() {
  local name="${PREFIX}-$$-expiry"
  local cache ws control rc tm code drift
  new_volume expiry-cache; cache="$CREATED_VOLUME"
  new_volume expiry-ws; ws="$CREATED_VOLUME"
  new_volume expiry-control; control="$CREATED_VOLUME"
  prep_dir "$cache" /python-cache
  prep_dir "$control" /run-control
  prep_workspace "$ws" web
  start_supervised "$name" "$cache" "$ws" "$control" \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-expiry MANAO_POD_UID=pod-expiry \
    MANAO_SERVICE_LIFETIME_SECONDS=6 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)" \
    -- run python-fastapi-web
  wait_probe_ready "$name" 240 || { fail "$name (FastAPI never became ready)"; return 0; }
  code="$(wait_halt "$name" 60)"
  [ "$code" = "124" ] || { fail "$name (exit=$code, want 124)"; return 0; }
  rc="/tmp/${PREFIX}-receipt-expiry.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "TIMED_OUT" ] || { fail "$name (final receipt state=$(field_of "$rc" state), want TIMED_OUT)"; return 0; }
  local ready exp
  ready="$(field_of "$rc" firstReadyAt)"; exp="$(field_of "$rc" expiresAt)"
  [ -n "$ready" ] && [ -n "$exp" ] || { fail "$name (receipt lacks ready/expiry)"; return 0; }
  [ $(( $(epoch_of "$exp") - $(epoch_of "$ready") )) -eq 6 ] \
    || { fail "$name (expiresAt-firstReadyAt != 6s)"; return 0; }
  drift=$(( $(epoch_of "$(docker inspect -f '{{.State.FinishedAt}}' "$name")") - $(epoch_of "$exp") ))
  [ "$drift" -ge -6 ] && [ "$drift" -le 6 ] \
    || { fail "$name (container exit drift from expiresAt: ${drift}s)"; return 0; }
  tm="/tmp/${PREFIX}-term-expiry.log"
  copy_out "$name" /tmp/manao-termination.log "$tm" \
    && [ "$(field_of "$tm" state)" = "TIMED_OUT" ] \
    || { fail "$name (termination message missing/wrong)"; return 0; }
  pass "$name (short expiry honoured with the real FastAPI process)"
}

# The fixed launcher must serve the low port 80 under the safe low-port sysctl the Job
# sets (net.ipv4.ip_unprivileged_port_start=0), readiness and business traffic included.
scenario_fastapi_low_port_80() {
  local name="${PREFIX}-$$-port80"
  local cache ws control rc code
  new_volume port80-cache; cache="$CREATED_VOLUME"
  new_volume port80-ws; ws="$CREATED_VOLUME"
  new_volume port80-control; control="$CREATED_VOLUME"
  prep_dir "$cache" /python-cache
  prep_dir "$control" /run-control
  prep_workspace "$ws" web
  EXTRA_RUN_ARGS=(--sysctl net.ipv4.ip_unprivileged_port_start=0)
  start_supervised "$name" "$cache" "$ws" "$control" \
    MANAO_PROJECT_ID=proj-a MANAO_PRIMARY_PORT=80 \
    MANAO_RUN_ID=run-port80 MANAO_POD_UID=pod-port80 \
    MANAO_SERVICE_LIFETIME_SECONDS=120 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)" \
    -- run python-fastapi-web
  EXTRA_RUN_ARGS=()
  wait_probe_ready "$name" 240 || { fail "$name (FastAPI never became ready on port 80)"; return 0; }
  request_demo "$name" 80 \
    || { fail "$name (/api/demo did not answer on low port 80)"; return 0; }
  rc="/tmp/${PREFIX}-receipt-port80.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "READY" ] || { fail "$name (receipt state=$(field_of "$rc" state), want READY)"; return 0; }
  docker stop -t 30 "$name" >/dev/null
  code="$(wait_halt "$name" 45)"
  [ "$code" = "0" ] || { fail "$name (exit=$code after stop, want 0)"; return 0; }
  pass "$name (low port 80 readiness and business traffic)"
}

seed_id_of_image() {
  dc_t 60 run --rm --network none --entrypoint /bin/sh "$IMAGE" -c 'tr -d "[:space:]" < /opt/manao-python-seed/seed-id'
}

# One-time image materialization: the first container start of a freshly built image can
# take longer than the per-scenario budgets, so warm the image before any scenario.
echo "runtime-lifecycle: warming up (first container start materializes the image)"
dc run --rm --network none "$IMAGE" sh -c 'command -v uv >/dev/null && command -v java >/dev/null && command -v python3 >/dev/null' \
  || { echo "runtime-lifecycle: image warmup failed (uv/java/python3 missing)" >&2; exit 1; }

scenario_launcher_mode_discipline
scenario_console_task_exit_0
scenario_console_task_exit_1
scenario_console_chinese_logs
scenario_console_term_reaps_term_ignoring_child
scenario_fastapi_ready_demo_stop
scenario_fastapi_install_blocked_startup_timeout
scenario_fastapi_short_expiry
scenario_fastapi_low_port_80

echo
echo "runtime-lifecycle: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0

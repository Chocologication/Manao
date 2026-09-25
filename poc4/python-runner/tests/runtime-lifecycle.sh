#!/bin/bash
# Real-container lifecycle tests for the Python runner image and the fixed manao-python
# launcher (python runtime plan, task 4).
#
# Usage (needs a Docker CLI talking to a Linux-container daemon):
#   bash poc4/python-runner/tests/runtime-lifecycle.sh <runtime-test-image> [prefix]
#
# Covers only the real uv/Python launch chain, in the production container shape
# (UID/GID 10001, read-only rootfs, writable per-container /tmp like the Job's
# emptyDir, per-project cache volume):
#   - launcher mode discipline: exactly console|web, exit 2 before any cache or venv work
#   - console TASK exit 0 and exit 1 through the real locked install
#   - Chinese (UTF-8) application logs through the real stdout/stderr pipe
#   - FastAPI readiness over the supervisor profile, business traffic, manual stop (TERM)
#   - install blocking past the startup deadline (test-only delayed cp shim in a test
#     volume) ends the run with STARTUP_TIMED_OUT and never starts the application
#   - short expiry honours the service lifetime with the real FastAPI process
#   - TERM to a console run whose derived Python child ignores SIGTERM is reaped with
#     the container (forced namespace teardown)
#   - low port 80 under the safe low-port sysctl
# The shared supervisor state machine (claim, receipt write failures, duplicate claim,
# clocks) is NOT re-tested here — maven-runner/tests/runtime-lifecycle.sh keeps that
# matrix; this script only adds the Python-profile-specific launch chain.
#
# Docker ownership (names, registration, volume identity, registry, cleanup) is shared
# with python-cache.sh via tests/lib.sh — the hardened Task 3 pattern. Assertions use
# docker wait/inspect state, exit codes, timestamps, receipts and files copied out of
# containers — never log text matching alone. The one deliberate exception is the
# Chinese-log scenario, where the application log itself is the product under test.
set -euo pipefail

IMAGE="${1:?usage: runtime-lifecycle.sh <runtime-test-image> [prefix]}"
PREFIX="${2:-manao-py-rt-$$}"
HARNESS_NAME="runtime-lifecycle"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "runtime-lifecycle: image '$IMAGE' does not exist; build it first (task 4 step 2)" >&2
  exit 2
fi

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$SOURCE_DIR/lib.sh"

harness_init

# Writes the fixed main.py of the TERM fixture into the workspace volume: spawns the
# TERM-ignoring child fixture and sleeps forever (content travels as a base64 argument,
# never over stdin).
write_term_parent_fixture() { # WS_VOL
  dc_t 120 run --rm --user 0 -v "${1}:/workspace" "$IMAGE" \
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
}

COMMON_ENV=(MANAO_PROJECT_ID=proj-a MANAO_PRIMARY_PORT=18080)

# The launcher is the only accepted entry and must reject everything else with exit 2
# before any cache, venv or install work — proven by runs that mount no cache and no
# workspace at all (a launcher that did cache or install work could not exit 2 here).
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
    acquire_volume "${name}-tmp"
    local tmpv="$CREATED_VOLUME"
    start_detached "$name" \
      --user 10001:10001 --read-only --network none \
      -v "${tmpv}:/tmp" \
      "$IMAGE" /usr/local/bin/manao-python $argv
    code="$(wait_halt "$name" 30)"
    [ "$code" = "2" ] || { fail "$name (argv='$argv': exit=$code, want 2)"; continue; }
    [ "$(runtime_seconds "$name")" -le 10 ] || { fail "$name (argv='$argv': rejection took too long)"; continue; }
    # The rejection proof is the exit code itself: these containers mount no cache and
    # no workspace, so any cache, venv or install work could not have exited 2 here.
    pass "$name (argv='$argv' rejected with no venv work)"
  done
}

# Console TASK through the real chain: cold cache, no network, seed + locked install and
# the template's fixed output. Exit 0 is itself the venv proof — the launcher execs the
# fixed path /tmp/manao-python/.venv/bin/python, so a missing venv could never exit 0.
# The per-run /tmp volume dies with the one-shot container, so the venv is not copied
# out post-exit (the cache script inspects venv contents on running containers instead).
scenario_console_task_exit_0() {
  local name="${PREFIX}-$$-console0"
  local cache ws marker
  new_volume console0-cache; cache="$CREATED_VOLUME"
  new_volume console0-ws; ws="$CREATED_VOLUME"
  prep_dir "$cache" /python-cache
  prep_workspace "$ws" console
  start_console_task "$name" "$cache" "$ws" none
  local code; code="$(wait_halt "$name" 180)"
  [ "$code" = "0" ] || { fail "$name (exit=$code, want 0)"; return 0; }
  [ "$(runtime_seconds "$name")" -le 120 ] || fail "$name (console TASK took too long)"
  local seed_id; seed_id="$(seed_id_of_image)" || { fail "$name (cannot read the image seed-id)"; return 0; }
  marker="${TMPDIR:-/tmp}/${PREFIX}-console0-marker"
  rm -f "$marker"
  copy_out "$name" "/python-cache/seeded-$seed_id" "$marker" \
    || { fail "$name (cache completion marker missing after the run)"; return 0; }
  # The workspace must not be polluted by the install (no bytecode, no venv redirect).
  if dc_t 120 run --rm --network none -v "${ws}:/workspace" "$IMAGE" \
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
  start_console_task "$name" "$cache" "$ws" none
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
  start_console_task "$name" "$cache" "$ws" none
  local code; code="$(wait_halt "$name" 180)"
  [ "$code" = "0" ] || { fail "$name (exit=$code, want 0)"; return 0; }
  log="${TMPDIR:-/tmp}/${PREFIX}-chinese.log"
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
  child_b64="$(base64 -w0 < "$SOURCE_DIR/fixtures/child_process.py")"
  dc_t 120 run --rm --user 0 -v "${ws}:/workspace" "$IMAGE" \
    sh -c 'printf %s "$1" | base64 -d > /workspace/child_process.py && chown 10001:10001 /workspace/child_process.py' \
    shim "$child_b64" >/dev/null 2>&1
  write_term_parent_fixture "$ws"
  EXTRA_RUN_ARGS=(-v "${childvol}:/childout")
  start_console_task "$name" "$cache" "$ws" none MANAO_TEST_EVIDENCE=/childout/evidence.log
  EXTRA_RUN_ARGS=()
  # Wait until the evidence file proves both parent and TERM-ignoring child are running.
  local waited=0
  evidence="${TMPDIR:-/tmp}/${PREFIX}-term-evidence.log"
  rm -f "$evidence"
  while [ "$waited" -lt 120 ]; do
    if copy_out "$name" /childout/evidence.log "$evidence" \
       && grep -q '^parent-started$' "$evidence" \
       && grep -q '^child-started$' "$evidence"; then
      break
    fi
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
  start_supervised_web "$name" "$cache" "$ws" "$control" none \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-web-stop MANAO_POD_UID=pod-web-stop \
    MANAO_SERVICE_LIFETIME_SECONDS=180 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)"
  wait_probe_ready "$name" 240 || { fail "$name (FastAPI never became ready)"; return 0; }
  if probe_exec "$name" -e MANAO_PRIMARY_PORT=59999; then
    fail "$name (probe accepted a dead port)"; return 0
  fi
  request_demo "$name" 18080 \
    || { fail "$name (/api/demo did not serve the template business response)"; return 0; }
  rc="${TMPDIR:-/tmp}/${PREFIX}-receipt-webstop.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "READY" ] || { fail "$name (receipt state=$(field_of "$rc" state), want READY)"; return 0; }
  [ -n "$(field_of "$rc" firstReadyAt)" ] || { fail "$name (receipt lacks firstReadyAt)"; return 0; }
  if ! dc_t 60 run --rm --network none -v "${control}:/run-control" "$IMAGE" \
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
# start the application. Evidence chain: the shim is on PATH, the seed staging directory
# the launcher creates right before the copy appears while the container is still
# running (so the shim-executed copy actually started), the container terminates with
# the supervisor's startup-expiry status, the claim exists (preparation happens after
# the claim), the receipt carries no firstReadyAt, and the interrupted seed left no
# marker.
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
  write_delayed_cp_shim "$shim" block
  local image_path
  image_path="$(dc_t 60 run --rm --entrypoint /bin/sh "$IMAGE" -c 'printf %s "$PATH"')" || { echo "$HARNESS_NAME: cannot read the image PATH" >&2; exit 1; }

  EXTRA_RUN_ARGS=(-v "${shim}:/shim" -e "PATH=/shim:${image_path}" -e "MANAO_TEST_CP_DELAY=120")
  start_supervised_web "$name" "$cache" "$ws" "$control" none \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-install-block MANAO_POD_UID=pod-install-block \
    MANAO_SERVICE_LIFETIME_SECONDS=120 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 20)" \
    -- run python-fastapi-web
  EXTRA_RUN_ARGS=()
  # The staging directory is created immediately before the (blocked) seed copy: seeing
  # it while the container runs proves the shim-executed copy actually started.
  local observed="" tries=0
  while [ "$tries" -lt 15 ]; do
    if dc_t 25 run --rm --network none -v "${cache}:/python-cache" "$IMAGE" \
         sh -c 'test -d /python-cache/.manao-seed.*' >/dev/null 2>&1; then
      observed="started"
      break
    fi
    sleep 1
    tries=$((tries+1))
  done
  if [ -z "$observed" ]; then
    fail "$name (the blocked seed copy never started; shim not exercised)"
    return 0
  fi
  code="$(wait_halt "$name" 90)"
  [ "$code" = "126" ] || { fail "$name (exit=$code, want 126)"; return 0; }
  [ "$(docker inspect -f '{{.State.Status}}' "$name")" = "exited" ] \
    || { fail "$name (container did not terminate)"; return 0; }
  [ "$(runtime_seconds "$name")" -le 45 ] || fail "$name (startup rejection took too long)"
  rc="${TMPDIR:-/tmp}/${PREFIX}-receipt-install-block.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "STARTUP_TIMED_OUT" ] \
    && [ "$(field_of "$rc" reason)" = "STARTUP_TIME_LIMIT_EXCEEDED" ] \
    || { fail "$name (receipt state/reason wrong)"; return 0; }
  [ -z "$(field_of "$rc" firstReadyAt)" ] \
    || { fail "$name (receipt carries firstReadyAt; the application started)"; return 0; }
  if ! dc_t 60 run --rm --network none -v "${control}:/run-control" "$IMAGE" \
         sh -c 'test -d /run-control/claim' >/dev/null 2>&1; then
    fail "$name (no claim in the control directory)"
    return 0
  fi
  local seed_id; seed_id="$(seed_id_of_image)" || { fail "$name (cannot read the image seed-id)"; return 0; }
  if dc_t 60 run --rm --network none -v "${cache}:/python-cache" "$IMAGE" \
       sh -c "test ! -e /python-cache/seeded-$seed_id && test ! -d /python-cache/uv-cache" >/dev/null 2>&1; then
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
  start_supervised_web "$name" "$cache" "$ws" "$control" none \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-expiry MANAO_POD_UID=pod-expiry \
    MANAO_SERVICE_LIFETIME_SECONDS=6 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)" \
    -- run python-fastapi-web
  wait_probe_ready "$name" 240 || { fail "$name (FastAPI never became ready)"; return 0; }
  code="$(wait_halt "$name" 60)"
  [ "$code" = "124" ] || { fail "$name (exit=$code, want 124)"; return 0; }
  rc="${TMPDIR:-/tmp}/${PREFIX}-receipt-expiry.properties"
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
  tm="${TMPDIR:-/tmp}/${PREFIX}-term-expiry.log"
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
  start_supervised_web "$name" "$cache" "$ws" "$control" none \
    MANAO_PROJECT_ID=proj-a MANAO_PRIMARY_PORT=80 \
    MANAO_RUN_ID=run-port80 MANAO_POD_UID=pod-port80 \
    MANAO_SERVICE_LIFETIME_SECONDS=120 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)" \
    -- run python-fastapi-web
  EXTRA_RUN_ARGS=()
  wait_probe_ready "$name" 240 || { fail "$name (FastAPI never became ready on port 80)"; return 0; }
  request_demo "$name" 80 \
    || { fail "$name (/api/demo did not answer on low port 80)"; return 0; }
  rc="${TMPDIR:-/tmp}/${PREFIX}-receipt-port80.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "READY" ] || { fail "$name (receipt state=$(field_of "$rc" state), want READY)"; return 0; }
  docker stop -t 30 "$name" >/dev/null
  code="$(wait_halt "$name" 45)"
  [ "$code" = "0" ] || { fail "$name (exit=$code after stop, want 0)"; return 0; }
  pass "$name (low port 80 readiness and business traffic)"
}

harness_warmup

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

#!/bin/bash
# Real-container lifecycle tests for the single-run web supervisor (Task 5).
#
# Usage (needs a Docker CLI talking to a Linux-container daemon):
#   bash poc4/maven-runner/tests/runtime-lifecycle.sh <runtime-test-image> [prefix]
#
# Every container and volume is created under a per-invocation prefix and removed by
# exact name on exit. Shared docker resources are never touched. Assertions use docker
# wait/inspect state, exit codes, timestamps and files copied out of containers
# (receipts, termination message, child markers) — never log text matching.
set -u

IMAGE="${1:?usage: runtime-lifecycle.sh <runtime-test-image> [prefix]}"
PREFIX="${2:-manao-rt-$$}"

CONTAINERS=()
VOLUMES=()
PASS=0
FAIL=0

cleanup() {
  local c v
  for c in "${CONTAINERS[@]:-}"; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1
  done
  for v in "${VOLUMES[@]:-}"; do
    [ -n "$v" ] && docker volume rm "$v" >/dev/null 2>&1
  done
}
trap cleanup EXIT

pass() { PASS=$((PASS+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

new_volume() {
  local v="${PREFIX}-vol-$1"
  docker volume create "$v" >/dev/null
  VOLUMES+=("$v")
  echo "$v"
}

# Make /run-control (fresh volume mount, root-owned) writable for the runner user.
# The chown runs via sh -c so container-absolute paths are never direct docker arguments
# (MSYS/Git Bash would path-mangle them).
prep_control_dir() {
  docker run --rm --user 0 -v "$1:/run-control" "$IMAGE" \
    sh -c 'chown 1001:1001 /run-control' >/dev/null 2>&1
}

# Make the child-evidence volume writable for the runner user and its children.
prep_child_dir() {
  docker run --rm --user 0 -v "$1:/childout" "$IMAGE" \
    sh -c 'chown 1001:1001 /childout' >/dev/null 2>&1
}

# Pre-create receipt.properties as a DIRECTORY so every receipt rename fails.
prep_broken_receipt_dir() {
  docker run --rm --user 0 -v "$1:/run-control" "$IMAGE" \
    sh -c 'chown 1001:1001 /run-control && mkdir /run-control/receipt.properties' >/dev/null 2>&1
}

# Java inside containers is always launched through `sh -c 'exec java ...'` so that
# container-absolute classpaths and internal env values are never passed as direct docker
# arguments (MSYS/Git Bash would path-mangle `-cp /x` and `-e K=/x` values) and so that
# exec replaces sh, keeping java as PID 1. Values without a leading slash are passed
# normally via -e.
RUN_CMD='export MANAO_RUN_CONTROL_DIR=/run-control; exec java -cp /opt/manao-runner/classes com.manao.runtime.WebRunSupervisor "$@"'
FIXTURE_CMD='export MANAO_RUN_CONTROL_DIR=/run-control MANAO_TEST_CHILD_LOG=/childout/starts.log; exec java -cp /opt/manao-runner/classes:/opt/manao-runner/test-classes com.manao.runtime.RuntimeFixtureMain "$@"'

# start_run NAME CONTROL_VOLUME CHILD_VOLUME KIND [K=V ...]
# KIND is a fixture scenario name or the literal "run" for the production main.
start_run() {
  local name="$1" control="$2" childvol="$3" kind="$4"
  shift 4
  local -a args=(run -d --name "$name" -v "${control}:/run-control")
  [ -n "$childvol" ] && args+=(-v "${childvol}:/childout")
  local kv
  for kv in "$@"; do args+=(-e "$kv"); done
  if [ "$kind" = "run" ]; then
    args+=("$IMAGE" sh -c "$RUN_CMD" supervisor run)
  else
    args+=("$IMAGE" sh -c "$FIXTURE_CMD" fixture "$kind")
  fi
  CONTAINERS+=("$name")
  docker "${args[@]}" >/dev/null
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

copy_out() { # NAME PATH DEST -> docker cp status
  docker cp "$1:$2" "$3" >/dev/null 2>&1
}

field_of() { # FILE KEY -> last value
  sed -n "s/^$2=//p" "$1" | tail -n 1
}

epoch_of() { date -u -d "$1" +%s; }

future_utc() { date -u -d "+$1 seconds" +%Y-%m-%dT%H:%M:%SZ; }

probe_exec() { # NAME [extra docker exec args...] -> probe exit status
  local name="$1"; shift
  docker exec "$@" "$name" sh -c "$RUN_CMD" supervisor probe >/dev/null 2>&1
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

COMMON_ENV=(MANAO_PROJECT_ID=proj-a MANAO_PRIMARY_PORT=18080)

scenario_run_deadline_rules() {
  if docker run --rm "$IMAGE" sh -c 'exec java -cp /opt/manao-runner/classes:/opt/manao-runner/test-classes com.manao.runtime.RunDeadlineTestMain' >/dev/null 2>&1; then
    pass "run-deadline-rules"
  else
    fail "run-deadline-rules"
  fi
}

scenario_readiness_gates_lifetime() {
  local name="${PREFIX}-readiness"
  local vol childvol rc tm starts ready exp state reason fin drift
  vol="$(new_volume readiness)"; childvol="$(new_volume readiness-child)"
  prep_control_dir "$vol"; prep_child_dir "$childvol"
  start_run "$name" "$vol" "$childvol" ready-server \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-readiness MANAO_POD_UID=pod-readiness \
    MANAO_SERVICE_LIFETIME_SECONDS=15 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)"
  wait_probe_ready "$name" 45 || { fail "$name (probe never became ready)"; return 0; }
  if probe_exec "$name" -e MANAO_PRIMARY_PORT=59999; then
    fail "$name (probe accepted a dead port)"; return 0
  fi
  local code; code="$(wait_halt "$name" 60)"
  [ "$code" = "124" ] || { fail "$name (exit=$code, want 124)"; return 0; }
  rc="/tmp/${PREFIX}-receipt-readiness.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  ready="$(field_of "$rc" firstReadyAt)"; exp="$(field_of "$rc" expiresAt)"
  state="$(field_of "$rc" state)"; reason="$(field_of "$rc" reason)"
  [ "$state" = "TIMED_OUT" ] || { fail "$name (final receipt state=$state, want TIMED_OUT)"; return 0; }
  [ "$reason" = "TIME_LIMIT_EXCEEDED" ] || { fail "$name (reason=$reason)"; return 0; }
  [ -n "$ready" ] && [ -n "$exp" ] || { fail "$name (receipt lacks ready/expiry)"; return 0; }
  [ $(( $(epoch_of "$exp") - $(epoch_of "$ready") )) -eq 15 ] \
    || { fail "$name (expiresAt-firstReadyAt != 15s)"; return 0; }
  fin="$(epoch_of "$(docker inspect -f '{{.State.FinishedAt}}' "$name")")"
  drift=$(( fin - $(epoch_of "$exp") ))
  [ "$drift" -ge -6 ] && [ "$drift" -le 6 ] \
    || { fail "$name (container exit drift from expiresAt: ${drift}s)"; return 0; }
  tm="/tmp/${PREFIX}-term-readiness.log"
  copy_out "$name" /tmp/manao-termination.log "$tm" \
    && [ "$(field_of "$tm" state)" = "TIMED_OUT" ] \
    || { fail "$name (termination message missing/wrong)"; return 0; }
  starts="/tmp/${PREFIX}-starts-readiness.log"
  copy_out "$name" /childout/starts.log "$starts" && grep -q '^start$' "$starts" \
    || { fail "$name (child never started)"; return 0; }
  pass "$name"
}

scenario_derived_dies_with_pid1() {
  local name="${PREFIX}-pid1"
  local vol childvol starts code secs
  vol="$(new_volume pid1)"; childvol="$(new_volume pid1-child)"
  prep_control_dir "$vol"; prep_child_dir "$childvol"
  start_run "$name" "$vol" "$childvol" ready-ignore-term \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-pid1 MANAO_POD_UID=pod-pid1 \
    MANAO_SERVICE_LIFETIME_SECONDS=6 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)"
  code="$(wait_halt "$name" 60)"
  [ "$code" = "124" ] || { fail "$name (exit=$code, want 124)"; return 0; }
  secs="$(runtime_seconds "$name")"
  [ "$secs" -le 40 ] || { fail "$name (container lived ${secs}s; derived process was not reaped)"; return 0; }
  starts="/tmp/${PREFIX}-starts-pid1.log"
  copy_out "$name" /childout/starts.log "$starts" || { fail "$name (child log missing)"; return 0; }
  grep -q '^start$' "$starts" || { fail "$name (child never started)"; return 0; }
  if grep -q '^natural-exit$' "$starts"; then
    fail "$name (child finished naturally; PID 1 did not reap it)"
  else
    pass "$name"
  fi
}

scenario_early_exit_no_rerun() {
  local exitcase="$1"
  local name="${PREFIX}-early$exitcase"
  local vol childvol starts rc code secs
  vol="$(new_volume "early$exitcase")"; childvol="$(new_volume "early$exitcase-child")"
  prep_control_dir "$vol"; prep_child_dir "$childvol"
  start_run "$name" "$vol" "$childvol" "early-exit-$exitcase" \
    "${COMMON_ENV[@]}" MANAO_RUN_ID="run-early$exitcase" MANAO_POD_UID="pod-early$exitcase" \
    MANAO_SERVICE_LIFETIME_SECONDS=60 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 120)"
  code="$(wait_halt "$name" 30)"
  [ "$code" = "1" ] || { fail "$name (exit=$code, want 1)"; return 0; }
  secs="$(runtime_seconds "$name")"
  [ "$secs" -le 15 ] || { fail "$name (container lived ${secs}s; rerun suspected)"; return 0; }
  starts="/tmp/${PREFIX}-starts-early$exitcase.log"
  copy_out "$name" /childout/starts.log "$starts" || { fail "$name (child log missing)"; return 0; }
  [ "$(grep -c '^start$' "$starts")" = "1" ] || { fail "$name (child started more than once)"; return 0; }
  rc="/tmp/${PREFIX}-receipt-early$exitcase.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "EXITED" ] && [ "$(field_of "$rc" reason)" = "APPLICATION_EXITED" ] \
    || { fail "$name (receipt state/reason wrong)"; return 0; }
  pass "$name"
}

scenario_duplicate_claim_denied() {
  local a="${PREFIX}-claim-a" b="${PREFIX}-claim-b"
  local vol childvol owner rc tm code
  vol="$(new_volume claim)"; childvol="$(new_volume claim-child)"
  prep_control_dir "$vol"; prep_child_dir "$childvol"
  start_run "$a" "$vol" "$childvol" ready-server \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-claim MANAO_POD_UID=pod-claim-a \
    MANAO_SERVICE_LIFETIME_SECONDS=40 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)"
  wait_probe_ready "$a" 45 || { fail "$a (owner never became ready)"; return 0; }
  start_run "$b" "$vol" "" run \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-claim MANAO_POD_UID=pod-claim-b \
    MANAO_SERVICE_LIFETIME_SECONDS=40 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)"
  code="$(wait_halt "$b" 30)"
  [ "$code" = "125" ] || { fail "$b (exit=$code, want 125)"; return 0; }
  [ "$(runtime_seconds "$b")" -le 15 ] || fail "$b (denial took too long)"
  container_running "$a" || { fail "$a (owner was disturbed by the denied container)"; return 0; }
  owner="/tmp/${PREFIX}-claim-owner.txt"
  copy_out "$b" /run-control/claim/owner "$owner" || { fail "$b (claim owner record missing)"; return 0; }
  [ "$(tr -d '[:space:]' < "$owner")" = "pod-claim-a" ] \
    || { fail "$b (claim owner is not the original pod)"; return 0; }
  rc="/tmp/${PREFIX}-receipt-claim.properties"
  copy_out "$b" /run-control/receipt.properties "$rc" || { fail "$b (shared receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "READY" ] && [ "$(field_of "$rc" podUid)" = "pod-claim-a" ] \
    || { fail "$b (denied container clobbered the owner receipt)"; return 0; }
  tm="/tmp/${PREFIX}-term-claim-b.log"
  copy_out "$b" /tmp/manao-termination.log "$tm" \
    && [ "$(field_of "$tm" state)" = "DENIED" ] \
    || { fail "$b (DENIED termination message missing/wrong)"; return 0; }
  pass "$b (owner $a undisturbed, claim and receipt intact)"
}

scenario_startup_too_late() {
  local name="${PREFIX}-startup"
  local vol childvol starts rc code
  vol="$(new_volume startup)"; childvol="$(new_volume startup-child)"
  prep_control_dir "$vol"; prep_child_dir "$childvol"
  start_run "$name" "$vol" "$childvol" run \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-startup MANAO_POD_UID=pod-startup \
    MANAO_SERVICE_LIFETIME_SECONDS=60 MANAO_RUN_STARTUP_DEADLINE=2026-01-01T00:00:00Z
  code="$(wait_halt "$name" 30)"
  [ "$code" = "126" ] || { fail "$name (exit=$code, want 126)"; return 0; }
  [ "$(runtime_seconds "$name")" -le 15 ] || fail "$name (startup rejection took too long)"
  starts="/tmp/${PREFIX}-starts-startup.log"
  if copy_out "$name" /childout/starts.log "$starts"; then
    fail "$name (child log exists; user code was started despite expired budget)"
    return 0
  fi
  rc="/tmp/${PREFIX}-receipt-startup.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "STARTUP_TIMED_OUT" ] \
    && [ "$(field_of "$rc" reason)" = "STARTUP_TIME_LIMIT_EXCEEDED" ] \
    || { fail "$name (receipt state/reason wrong)"; return 0; }
  pass "$name"
}

scenario_backend_unavailable() {
  local name="${PREFIX}-nobackend"
  local vol childvol rc ready exp fin drift code
  vol="$(new_volume nobackend)"; childvol="$(new_volume nobackend-child)"
  prep_control_dir "$vol"; prep_child_dir "$childvol"
  start_run "$name" "$vol" "$childvol" ready-server \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-nobackend MANAO_POD_UID=pod-nobackend \
    MANAO_MYSQL_HOST=203.0.113.1 MANAO_MYSQL_PORT=3306 MANAO_MYSQL_DATABASE=db \
    MANAO_MYSQL_USERNAME=u MANAO_MYSQL_PASSWORD=p \
    MANAO_REDIS_HOST=203.0.113.1 MANAO_REDIS_PORT=6379 \
    MANAO_SERVICE_LIFETIME_SECONDS=6 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)"
  code="$(wait_halt "$name" 60)"
  [ "$code" = "124" ] || { fail "$name (exit=$code, want 124)"; return 0; }
  rc="/tmp/${PREFIX}-receipt-nobackend.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  ready="$(field_of "$rc" firstReadyAt)"; exp="$(field_of "$rc" expiresAt)"
  [ $(( $(epoch_of "$exp") - $(epoch_of "$ready") )) -eq 6 ] \
    || { fail "$name (lifetime != 6s without backend)"; return 0; }
  fin="$(epoch_of "$(docker inspect -f '{{.State.FinishedAt}}' "$name")")"
  drift=$(( fin - $(epoch_of "$exp") ))
  [ "$drift" -ge -6 ] && [ "$drift" -le 6 ] \
    || { fail "$name (expiry not honored without backend: drift ${drift}s)"; return 0; }
  pass "$name"
}

scenario_receipt_broken_at_claim() {
  local name="${PREFIX}-broken1"
  local vol childvol starts tm code
  vol="$(new_volume broken1)"; childvol="$(new_volume broken1-child)"
  prep_broken_receipt_dir "$vol"
  start_run "$name" "$vol" "$childvol" ready-server \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-broken1 MANAO_POD_UID=pod-broken1 \
    MANAO_SERVICE_LIFETIME_SECONDS=60 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)"
  code="$(wait_halt "$name" 30)"
  [ "$code" = "3" ] || { fail "$name (exit=$code, want 3)"; return 0; }
  [ "$(runtime_seconds "$name")" -le 15 ] || fail "$name (did not end within budget)"
  starts="/tmp/${PREFIX}-starts-broken1.log"
  if copy_out "$name" /childout/starts.log "$starts"; then
    fail "$name (user code started despite failed persistence)"
    return 0
  fi
  tm="/tmp/${PREFIX}-term-broken1.log"
  copy_out "$name" /tmp/manao-termination.log "$tm" \
    && [ "$(field_of "$tm" state)" = "EXITED" ] \
    && [ "$(field_of "$tm" reason)" = "RECEIPT_WRITE_FAILED" ] \
    || { fail "$name (termination message missing/wrong)"; return 0; }
  pass "$name"
}

scenario_receipt_broken_after_claim() {
  local name="${PREFIX}-broken2"
  local vol childvol starts tm code
  vol="$(new_volume broken2)"; childvol="$(new_volume broken2-child)"
  prep_control_dir "$vol"; prep_child_dir "$childvol"
  start_run "$name" "$vol" "$childvol" receipt-fails-after-claim \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-broken2 MANAO_POD_UID=pod-broken2 \
    MANAO_SERVICE_LIFETIME_SECONDS=60 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)"
  code="$(wait_halt "$name" 45)"
  [ "$code" = "3" ] || { fail "$name (exit=$code, want 3)"; return 0; }
  [ "$(runtime_seconds "$name")" -le 30 ] || fail "$name (did not end within budget)"
  starts="/tmp/${PREFIX}-starts-broken2.log"
  copy_out "$name" /childout/starts.log "$starts" || { fail "$name (child log missing)"; return 0; }
  [ "$(grep -c '^start$' "$starts")" = "1" ] \
    || { fail "$name (child should have started exactly once before termination)"; return 0; }
  tm="/tmp/${PREFIX}-term-broken2.log"
  copy_out "$name" /tmp/manao-termination.log "$tm" \
    && [ "$(field_of "$tm" state)" = "EXITED" ] \
    && [ "$(field_of "$tm" reason)" = "RECEIPT_WRITE_FAILED" ] \
    || { fail "$name (termination message missing/wrong)"; return 0; }
  pass "$name"
}

scenario_manual_stop() {
  local name="${PREFIX}-stop"
  local vol childvol starts rc code
  vol="$(new_volume stop)"; childvol="$(new_volume stop-child)"
  prep_control_dir "$vol"; prep_child_dir "$childvol"
  start_run "$name" "$vol" "$childvol" ready-server \
    "${COMMON_ENV[@]}" MANAO_RUN_ID=run-stop MANAO_POD_UID=pod-stop \
    MANAO_SERVICE_LIFETIME_SECONDS=120 MANAO_RUN_STARTUP_DEADLINE="$(future_utc 300)"
  wait_probe_ready "$name" 45 || { fail "$name (probe never became ready)"; return 0; }
  docker stop -t 30 "$name" >/dev/null
  code="$(wait_halt "$name" 45)"
  [ "$code" = "0" ] || { fail "$name (exit=$code, want 0)"; return 0; }
  rc="/tmp/${PREFIX}-receipt-stop.properties"
  copy_out "$name" /run-control/receipt.properties "$rc" || { fail "$name (receipt missing)"; return 0; }
  [ "$(field_of "$rc" state)" = "EXITED" ] && [ "$(field_of "$rc" reason)" = "USER_STOPPED" ] \
    || { fail "$name (receipt state/reason wrong)"; return 0; }
  starts="/tmp/${PREFIX}-starts-stop.log"
  copy_out "$name" /childout/starts.log "$starts" \
    && [ "$(grep -c '^start$' "$starts")" = "1" ] \
    || { fail "$name (child started wrong number of times)"; return 0; }
  pass "$name"
}

scenario_run_deadline_rules
scenario_readiness_gates_lifetime
scenario_derived_dies_with_pid1
scenario_early_exit_no_rerun 0
scenario_early_exit_no_rerun 1
scenario_duplicate_claim_denied
scenario_startup_too_late
scenario_backend_unavailable
scenario_receipt_broken_at_claim
scenario_receipt_broken_after_claim
scenario_manual_stop

echo
echo "runtime-lifecycle: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0

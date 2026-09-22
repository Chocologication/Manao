#!/bin/bash
# Seed/cache verification for the Maven runner image (maven-cache supplement plan).
#
# Usage (needs a Docker CLI talking to a Linux-container daemon):
#   bash poc4/maven-runner/tests/maven-cache.sh <image> <exported-templates-dir> <mode>
# Modes:
#   seed      - plan C1 gate. The image must carry a non-empty read-only seed repository
#               (/opt/manao-maven-seed) built from the exported real templates, and fresh
#               --network none containers must compile the console and four web template
#               variants and start the no-database web template with the original goal,
#               confirming readiness and business traffic over in-container HTTP before a
#               normal stop. The original unseeded image FAILS this mode because it has no
#               /opt/manao-maven-seed content; passing never relies on a host .m2 or any
#               online repository (network is disabled at the container level and Maven is
#               run with -o, so a missing artifact can only fail, never download).
#   lifecycle - delegate to the existing runtime-lifecycle.sh (needs the runtime-test image).
#   all       - seed + lifecycle.
#
# Every container and volume is created under a per-invocation prefix and removed by exact
# name on exit. Shared docker resources are never touched. Assertions use container exit
# codes and files read back over HTTP inside the containers — never log text matching.
# Following the runtime-lifecycle.sh convention, container-absolute paths are only ever used
# inside `sh -c` script strings, never as direct docker arguments (MSYS/Git Bash would
# path-mangle them).
set -u

IMAGE="${1:?usage: maven-cache.sh <image> <templates-dir> <seed|lifecycle|all>}"
TEMPLATES="${2:?usage: maven-cache.sh <image> <templates-dir> <seed|lifecycle|all>}"
MODE="${3:?usage: maven-cache.sh <image> <templates-dir> <seed|lifecycle|all>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PREFIX="manao-mc-$$"
VARIANTS="console web web-mysql web-redis web-mysql-redis"
SEED_ROOT="/opt/manao-maven-seed" # container path; only used inside sh -c strings

CONTAINERS=()
VOLUMES=()
LOGS=()
PASS=0
FAIL=0
CASE_EXIT=""
TEMPLATES_VOL=""
LIFECYCLE_FAILED=0

cleanup() {
  local c v l
  for c in "${CONTAINERS[@]:-}"; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1
  done
  for v in "${VOLUMES[@]:-}"; do
    [ -n "$v" ] && docker volume rm "$v" >/dev/null 2>&1
  done
  for l in "${LOGS[@]:-}"; do
    [ -n "$l" ] && rm -f "$l"
  done
}
trap cleanup EXIT

pass() { PASS=$((PASS+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

# Wait for a container to exit: sets CASE_EXIT to the exit code, or TIMEOUT.
wait_case() {
  local name="$1" budget="$2" waited=0 st
  while [ "$waited" -lt "$budget" ]; do
    st="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
    if [ "$st" = "exited" ]; then
      CASE_EXIT="$(docker inspect -f '{{.State.ExitCode}}' "$name")"
      return 0
    fi
    sleep 2
    waited=$((waited+2))
  done
  CASE_EXIT="TIMEOUT"
}

# Logs of a container into a temp file (removed by the cleanup trap); prints the path.
log_of() {
  local f
  f="$(mktemp "${TMPDIR:-/tmp}/${PREFIX}-log.XXXXXX")" || return 1
  docker logs "$1" >"$f" 2>&1
  LOGS+=("$f")
  echo "$f"
}

# run_case NAME SCRIPT -> starts a detached --network none container with the templates
# volume mounted read-only at /seed-projects; sets CASE_EXIT via wait_case.
run_case() {
  local name="$1" script="$2"
  docker run -d --network none --name "$name" \
    -v "$TEMPLATES_VOL:/seed-projects:ro" "$IMAGE" sh -c "$script" >/dev/null
  CONTAINERS+=("$name")
}

require_templates() {
  [ -d "$TEMPLATES" ] || { echo "templates directory not found: $TEMPLATES" >&2; exit 2; }
  local variant
  for variant in $VARIANTS; do
    [ -f "$TEMPLATES/$variant/pom.xml" ] \
      || { echo "templates directory lacks the exported '$variant' variant (run the MavenSeedTemplateExporter first)" >&2; exit 2; }
  done
}

# Copies the exported templates into a per-invocation volume via a short-lived loader
# container, so test containers read them read-only without any host bind mount.
seed_templates_volume() {
  TEMPLATES_VOL="${PREFIX}-templates"
  docker volume create "$TEMPLATES_VOL" >/dev/null
  VOLUMES+=("$TEMPLATES_VOL")
  local loader="${PREFIX}-templates-loader"
  docker run -d --name "$loader" -v "$TEMPLATES_VOL:/seed-projects" "$IMAGE" sleep 60 >/dev/null
  CONTAINERS+=("$loader")
  docker cp "$TEMPLATES/." "$loader:/seed-projects/" \
    || { echo "cannot copy templates into $TEMPLATES_VOL" >&2; exit 2; }
  docker rm -f "$loader" >/dev/null
}

# The writable repository copy uses only container-builtin tools (cp/chmod); no test tool
# is ever installed at run time. -o plus --network none makes any missing artifact fail.
compile_script() { # VARIANT
  cat <<EOF
set -eu
[ -d $SEED_ROOT/repository ] || { echo "no seed repository in image" >&2; exit 37; }
cp -r $SEED_ROOT/repository /tmp/repo
chmod -R u+w /tmp/repo
cp -r /seed-projects/$1 /tmp/project
cd /tmp/project
mvn -B -ntp -o -Dmaven.repo.local=/tmp/repo -DskipTests compile
echo "SEED-COMPILE-OK $1"
EOF
}

web_run_script() {
  cat <<'EOF'
set -eu
[ -d /opt/manao-maven-seed/repository ] || { echo "no seed repository in image" >&2; exit 37; }
cp -r /opt/manao-maven-seed/repository /tmp/repo
chmod -R u+w /tmp/repo
cp -r /seed-projects/web /tmp/project
cd /tmp/project
mvn -B -ntp -o -Dmaven.repo.local=/tmp/repo -DskipTests spring-boot:run >/tmp/app.log 2>&1 &
MVN_PID=$!
READY=""
i=0
while [ "$i" -lt 240 ]; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/actuator/health/readiness || true)"
  if [ "$CODE" = "200" ]; then READY=1; break; fi
  if ! kill -0 "$MVN_PID" 2>/dev/null; then break; fi
  sleep 2
  i=$((i+2))
done
if [ -z "$READY" ]; then
  echo "web app never became ready" >&2
  tail -n 50 /tmp/app.log >&2
  kill -9 "$MVN_PID" 2>/dev/null || true
  exit 38
fi
echo "SEED-READINESS-OK"
curl -s http://127.0.0.1:8080/api/demo >/tmp/demo.json || { echo "business request failed" >&2; exit 39; }
grep -q 'Hello from Manao' /tmp/demo.json || { echo "unexpected business response: $(cat /tmp/demo.json)" >&2; exit 39; }
echo "SEED-BUSINESS-OK"
# Normal stop: SIGTERM to the maven run, finite wait, then verify the listener is gone
# (the spring-boot:run fork dies with its maven parent).
kill "$MVN_PID" 2>/dev/null || true
i=0
while [ "$i" -lt 30 ]; do
  kill -0 "$MVN_PID" 2>/dev/null || break
  sleep 1
  i=$((i+1))
done
if kill -0 "$MVN_PID" 2>/dev/null; then
  echo "maven did not stop on SIGTERM" >&2
  kill -9 "$MVN_PID" 2>/dev/null || true
  exit 40
fi
wait "$MVN_PID" || true
STOPPED=""
i=0
while [ "$i" -lt 10 ]; do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:8080/actuator/health/readiness || true)"
  if [ "$CODE" != "200" ]; then STOPPED=1; break; fi
  sleep 1
  i=$((i+1))
done
[ -n "$STOPPED" ] || { echo "app still serving after maven stop" >&2; exit 41; }
echo "SEED-STOP-OK"
echo "SEED-WEB-RUN-OK"
EOF
}

scenario_seed_content() {
  local name="${PREFIX}-seed-content" log
  run_case "$name" 'set -eu
[ -f /opt/manao-maven-seed/seed-id ] || { echo "seed-id missing" >&2; exit 31; }
[ -n "$(cat /opt/manao-maven-seed/seed-id)" ] || { echo "seed-id is empty" >&2; exit 31; }
[ -n "$(find /opt/manao-maven-seed/repository -type f -print -quit)" ] || { echo "seed repository is empty" >&2; exit 32; }
extra="$(find /opt/manao-maven-seed -mindepth 1 -maxdepth 1 ! -name repository ! -name seed-id)"
[ -z "$extra" ] || { echo "unexpected seed content: $extra" >&2; exit 33; }
[ -z "$(find /opt/manao-maven-seed -name "*.java" -print -quit)" ] || { echo "java sources inside seed content" >&2; exit 33; }
if touch /opt/manao-maven-seed/repository/.seed-write-probe 2>/dev/null; then
  rm -f /opt/manao-maven-seed/repository/.seed-write-probe
  echo "seed repository is writable by the runtime user" >&2
  exit 34
fi
echo "SEED-PRESENT-OK seed-id=$(cat /opt/manao-maven-seed/seed-id)"
'
  wait_case "$name" 60
  if [ "$CASE_EXIT" = "0" ]; then
    log="$(log_of "$name")"
    grep 'SEED-PRESENT-OK' "$log" || true
    pass "$name"
  else
    log="$(log_of "$name")"
    tail -n 20 "$log" || true
    fail "$name (exit=$CASE_EXIT)"
  fi
}

scenario_offline_compile() { # VARIANT
  local variant="$1" name="${PREFIX}-compile-$1" log
  run_case "$name" "$(compile_script "$variant")"
  wait_case "$name" 300
  if [ "$CASE_EXIT" = "0" ]; then
    log="$(log_of "$name")"
    grep 'SEED-COMPILE-OK' "$log" || true
    pass "$name"
  else
    log="$(log_of "$name")"
    tail -n 30 "$log" || true
    fail "$name (exit=$CASE_EXIT)"
  fi
}

scenario_offline_web_run() {
  local name="${PREFIX}-web-run" log
  run_case "$name" "$(web_run_script)"
  wait_case "$name" 480
  if [ "$CASE_EXIT" = "0" ]; then
    log="$(log_of "$name")"
    grep -E 'SEED-(READINESS|BUSINESS|STOP|WEB-RUN)-OK' "$log" || true
    pass "$name"
  else
    log="$(log_of "$name")"
    tail -n 40 "$log" || true
    fail "$name (exit=$CASE_EXIT)"
  fi
}

run_seed() {
  require_templates
  seed_templates_volume
  scenario_seed_content
  local variant
  for variant in $VARIANTS; do
    scenario_offline_compile "$variant"
  done
  scenario_offline_web_run
}

run_lifecycle() {
  echo "delegating to runtime-lifecycle.sh (lifecycle mode needs the runtime-test image)"
  bash "$SCRIPT_DIR/runtime-lifecycle.sh" "$IMAGE" "$PREFIX-rl"
}

case "$MODE" in
  seed)
    run_seed
    ;;
  lifecycle)
    run_lifecycle
    exit $?
    ;;
  all)
    run_seed
    if ! run_lifecycle; then
      LIFECYCLE_FAILED=1
    fi
    ;;
  *)
    echo "unknown mode: $MODE (want seed, lifecycle or all)" >&2
    exit 2
    ;;
esac

echo
echo "maven-cache: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ] || [ "$LIFECYCLE_FAILED" = "1" ]; then
  exit 1
fi
exit 0

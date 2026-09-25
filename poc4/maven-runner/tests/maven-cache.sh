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
#   lifecycle - plan C2 gate. Real per-project cache lifecycle under the cluster identity
#               (UID/GID 10001, read-only root filesystem, writable tmpfs /tmp, persistent
#               per-project cache volumes): the first run copies the seed into the project
#               cache and downloads + really calls a fixed dependency the seed lacks
#               (org.apache.commons:commons-text:1.13.0); a second container reuses the same
#               cache fully offline and provably re-copies nothing; a killed copy leaves no
#               half artifact and no marker and is repaired by the next explicit run; a
#               changed seed version fills gaps without overwriting user files; read-only
#               and size-limited (tmpfs) cache volumes fail closed with no temporary
#               repository fallback. Failure injection is controlled by the harness only
#               (ro mount, size-limited test volume, test-only throttled cp shim in a test
#               volume); the wrapper itself reads no environment. Afterwards the mode
#               delegates the supervisor regression to runtime-lifecycle.sh - it needs the
#               runtime-test fixture classes, so the given image is used when it has them,
#               otherwise the documented -test pair tag is used when available, otherwise
#               the delegation is reported as an explicit SKIPPED (never a silent pass).
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
LC_SEED_ID=""
IMAGE_PATH=""
SHIM_DELAY="${SHIM_DELAY:-0.02}"

# docker with MSYS/Git Bash path conversion disabled: several lifecycle docker arguments
# carry container-absolute paths (--tmpfs /tmp, -e PATH=/shim:...). On Linux the variable
# is simply unknown to docker and changes nothing; no host paths are ever passed here.
dc() { MSYS_NO_PATHCONV=1 docker "$@"; }

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

# --------------------------------------------------------------------------
# lifecycle mode (plan C2): real per-project cache lifecycle with the cluster identity.
# The docker volumes play the roles of the cluster storage: the "cache" volume is the
# .manao-cache/maven subPath mounted at /maven-cache, the "workspace" volume is the code
# directory mounted at /workspace. Volume preparation (chown to 10001) mirrors what the
# workspace initializer and the Job's prepare-maven-cache init container do in the cluster.
# --------------------------------------------------------------------------

new_volume() {
  local v="${PREFIX}-$1"
  docker volume create "$v" >/dev/null
  VOLUMES+=("$v")
  echo "$v"
}

image_seed_id() {
  # --entrypoint skips the base image's maven-entrypoint.sh, whose /root warnings pollute
  # captured stdout and would corrupt the id (exit codes stay meaningful in every case).
  dc run --rm --network none --entrypoint /bin/sh "$IMAGE" -c 'tr -d "[:space:]" < /opt/manao-maven-seed/seed-id'
}

# Makes a cache-mount volume writable by the real cluster identity (what the Job init
# container achieves for the .manao-cache/maven subPath of a workspace PVC).
lc_prep_cache() {
  dc run --rm --user 0 -v "$1:/maven-cache" "$IMAGE" \
    sh -c 'chown 10001:10001 /maven-cache && chmod 0775 /maven-cache' >/dev/null 2>&1
}

# Loads a console template copy into a fresh "project directory" volume and, when asked,
# adds the fixed seed-absent dependency (commons-text 1.13.0) and rewrites App to really
# call it (StringEscapeUtils.escapeJava) - the application output is the download evidence.
lc_prep_workspace() { # WS_VOL with-commons-text?
  local ws="$1" commons="${2:-}"
  dc run --rm --user 0 -v "$ws:/workspace" -v "$TEMPLATES_VOL:/seed-projects:ro" "$IMAGE" \
    sh -c "cp -r /seed-projects/console/. /workspace/ && chown -R 10001:10001 /workspace" >/dev/null 2>&1
  if [ "$commons" = "with-commons-text" ]; then
    dc run --rm --user 0 -v "$ws:/workspace" "$IMAGE" bash -c "$COMMONS_TEXT_PROJECT_SCRIPT" >/dev/null 2>&1
  fi
}

COMMONS_TEXT_PROJECT_SCRIPT="$(cat <<'EOF'
set -eu
sed -i 's#<dependencies>#<dependencies><dependency><groupId>org.apache.commons</groupId><artifactId>commons-text</artifactId><version>1.13.0</version></dependency>#' /workspace/pom.xml
grep -q 'commons-text' /workspace/pom.xml
printf '%s\n' \
  'package com.example.app;' \
  '' \
  'import org.apache.commons.text.StringEscapeUtils;' \
  '' \
  'public final class App {' \
  '    public static void main(String[] args) {' \
  '        System.out.println("CACHE-CALL " + StringEscapeUtils.escapeJava("quote\"end"));' \
  '    }' \
  '}' > /workspace/src/main/java/com/example/app/App.java
chown -R 10001:10001 /workspace
EOF
)"

# lc_run NAME SCRIPT NETWORK-OFFLINE? VOLUME_MOUNT... -> run container for the wrapper.
# Every run container mirrors the production security context: the real cluster identity
# (UID/GID 10001, never the image's 1001), a read-only root filesystem and a writable
# tmpfs /tmp. Assertions live inside the scripts (exit codes), not in log matching.
lc_run() { # NAME SCRIPT NET(none|bridge) [VOLUME_MOUNT ...]
  local name="$1" script="$2" net="$3"; shift 3
  local -a args=(run -d --name "$name" --user 10001:10001 --read-only --tmpfs /tmp)
  [ "$net" = "none" ] && args+=(--network none)
  local mount
  for mount in "$@"; do args+=(-v "$mount"); done
  args+=("$IMAGE" bash -c "$script")
  CONTAINERS+=("$name")
  dc "${args[@]}" >/dev/null
}

# Observable state of a project cache: completion marker identity, repository file count
# and the new dependency's content hash. Equal outputs before/after a run prove that the
# run re-copied nothing and preserved user artifacts. (--entrypoint keeps the captured
# output free of the base image's /root entrypoint warnings.)
lc_cache_state() { # CACHE_VOL
  dc run --rm --network none --user 10001:10001 -v "$1:/maven-cache" --entrypoint /bin/sh "$IMAGE" -c '
    stat -c "marker %i %Y %s" /maven-cache/seeded-* 2>/dev/null || echo "marker none"
    echo "files $(find /maven-cache/repository -type f | wc -l)"
    if [ -f /maven-cache/repository/org/apache/commons/commons-text/1.13.0/commons-text-1.13.0.jar ]; then
      sha256sum /maven-cache/repository/org/apache/commons/commons-text/1.13.0/commons-text-1.13.0.jar | cut -d" " -f1 | sed "s/^/dep /"
    else
      echo "dep none"
    fi'
}

write_copy_shim() { # VOLUME -> test-only throttled cp (runtime fixture, never in an image)
  dc run --rm -i --user 0 -v "$1:/shim" "$IMAGE" \
    sh -c 'cat > /shim/cp && chmod 0555 /shim/cp' <<'SHIM_EOF'
#!/bin/sh
# Test-only throttled copy for the interrupted-copy scenario. It lives in a per-run test
# volume and is activated only by the test's PATH override; images contain no such file
# and the manao-maven wrapper reads no environment, so production cannot be influenced.
set -eu
if [ "${1:-}" = "--" ]; then shift; fi
delay="${MANAO_TEST_COPY_DELAY:-0}"
[ "$delay" = "0" ] && exec /usr/bin/cp "$@"
src="$1"; dst="$2"
if [ "$(wc -c < "$src")" -lt 65536 ]; then exec /usr/bin/cp -- "$src" "$dst"; fi
total="$(wc -c < "$src")"
: > "$dst"
i=0
while [ $((i * 8192)) -lt "$total" ]; do
  dd if="$src" of="$dst" bs=8192 count=1 skip="$i" seek="$i" conv=notrunc status=none
  i=$((i + 1))
  sleep "$delay"
done
SHIM_EOF
}

LC_FIRST_RUN_SCRIPT="$(cat <<'EOF'
set -eu
[ "$(id -u)" = "10001" ] && [ "$(id -g)" = "10001" ] || { echo "unexpected identity $(id -u):$(id -g)" >&2; exit 42; }
cd /workspace
/usr/local/bin/manao-maven -B -ntp -q -DskipTests compile exec:java >/tmp/manao-run.out 2>&1 \
  || { echo "first run failed" >&2; tail -n 30 /tmp/manao-run.out >&2; exit 43; }
grep -F 'CACHE-CALL quote\"end' /tmp/manao-run.out >/dev/null \
  || { echo "commons-text was not called by the application" >&2; exit 44; }
SEED_ID="$(tr -d '[:space:]' < /opt/manao-maven-seed/seed-id)"
[ -f "/maven-cache/seeded-$SEED_ID" ] || { echo "no completion marker after the first run" >&2; exit 45; }
[ -f /maven-cache/repository/org/apache/commons/commons-text/1.13.0/commons-text-1.13.0.jar ] \
  || { echo "the new dependency is not in the project cache" >&2; exit 46; }
echo "LC-FIRST-OK"
EOF
)"

LC_SECOND_RUN_SCRIPT="$(cat <<'EOF'
set -eu
[ "$(id -u)" = "10001" ] && [ "$(id -g)" = "10001" ] || { echo "unexpected identity $(id -u):$(id -g)" >&2; exit 42; }
cd /workspace
# -o plus --network none: any missing artifact can only fail, never download again.
/usr/local/bin/manao-maven -B -ntp -q -o -DskipTests compile exec:java >/tmp/manao-run.out 2>&1 \
  || { echo "offline second run failed" >&2; tail -n 30 /tmp/manao-run.out >&2; exit 43; }
grep -F 'CACHE-CALL quote\"end' /tmp/manao-run.out >/dev/null \
  || { echo "commons-text was not called in the offline run" >&2; exit 44; }
echo "LC-SECOND-OK"
EOF
)"

LC_INTERRUPT_RUN_SCRIPT="$(cat <<'EOF'
set -eu
[ "$(id -u)" = "10001" ] && [ "$(id -g)" = "10001" ] || { echo "unexpected identity $(id -u):$(id -g)" >&2; exit 42; }
cd /workspace
exec /usr/local/bin/manao-maven -B -ntp -q -o -DskipTests compile
EOF
)"

LC_INTERRUPT_CHECK_SCRIPT="$(cat <<'EOF'
set -eu
SEED_ID="$(tr -d '[:space:]' < /opt/manao-maven-seed/seed-id)"
[ ! -e "/maven-cache/seeded-$SEED_ID" ] \
  || { echo "completion marker written despite the interrupted copy" >&2; exit 47; }
published=0
while IFS= read -r -d '' f; do
  case "$f" in *.manao-tmp.*) continue ;; esac
  published=$((published + 1))
  cmp -s "$f" "/opt/manao-maven-seed/repository/${f#/maven-cache/repository/}" \
    || { echo "incomplete artifact in the cache: $f" >&2; exit 48; }
done < <(find /maven-cache/repository -type f -print0)
[ "$published" -ge 1 ] || { echo "nothing was published before the interruption" >&2; exit 49; }
echo "INTERRUPTED-CACHE-CLEAN published=$published"
EOF
)"

LC_REPAIR_SCRIPT="$(cat <<'EOF'
set -eu
[ "$(id -u)" = "10001" ] && [ "$(id -g)" = "10001" ] || { echo "unexpected identity $(id -u):$(id -g)" >&2; exit 42; }
cd /workspace
/usr/local/bin/manao-maven -B -ntp -q -o -DskipTests compile >/tmp/manao-run.out 2>&1 \
  || { echo "repair run failed" >&2; tail -n 30 /tmp/manao-run.out >&2; exit 43; }
SEED_ID="$(tr -d '[:space:]' < /opt/manao-maven-seed/seed-id)"
[ -f "/maven-cache/seeded-$SEED_ID" ] || { echo "repair did not publish the completion marker" >&2; exit 45; }
leftover="$(find /maven-cache/repository -name '*.manao-tmp.*' -type f | head -n 1)"
[ -z "$leftover" ] || { echo "temporary file was not cleaned up: $leftover" >&2; exit 50; }
while IFS= read -r -d '' f; do
  cmp -s "$f" "/maven-cache/repository/${f#/opt/manao-maven-seed/repository/}" \
    || { echo "seed file missing after repair: $f" >&2; exit 51; }
done < <(find /opt/manao-maven-seed/repository -type f -print0)
echo "LC-REPAIR-OK"
EOF
)"

LC_UPDATE_BASELINE_SCRIPT="$(cat <<'EOF'
set -eu
[ "$(id -u)" = "10001" ] && [ "$(id -g)" = "10001" ] || { echo "unexpected identity $(id -u):$(id -g)" >&2; exit 42; }
/usr/local/bin/manao-maven -v >/tmp/manao-run.out 2>&1 \
  || { echo "initial cache run failed" >&2; tail -n 30 /tmp/manao-run.out >&2; exit 43; }
SEED_ID="$(tr -d '[:space:]' < /opt/manao-maven-seed/seed-id)"
[ -f "/maven-cache/seeded-$SEED_ID" ] || { echo "initial run did not publish the marker" >&2; exit 45; }
echo "LC-UPDATE-BASELINE-OK"
EOF
)"

LC_UPDATE_SECOND_SCRIPT="$(cat <<'EOF'
set -eu
[ "$(id -u)" = "10001" ] && [ "$(id -g)" = "10001" ] || { echo "unexpected identity $(id -u):$(id -g)" >&2; exit 42; }
/usr/local/bin/manao-maven -v >/tmp/manao-run.out 2>&1 \
  || { echo "seed update run failed" >&2; tail -n 30 /tmp/manao-run.out >&2; exit 43; }
[ "$(cat /maven-cache/repository/com/example/userlib/1.0/userlib-1.0.jar)" = "USER-ARTIFACT-V1" ] \
  || { echo "the seed update overwrote an existing project file" >&2; exit 52; }
[ "$(cat /maven-cache/repository/com/example/newlib/2.0/newlib-2.0.jar)" = "NEW-SEED-CONTENT" ] \
  || { echo "the seed update did not add the new seed file" >&2; exit 53; }
NEW_ID="$(tr -d '[:space:]' < /opt/manao-maven-seed/seed-id)"
[ -f "/maven-cache/seeded-$NEW_ID" ] || { echo "the new seed version did not publish its marker" >&2; exit 54; }
echo "LC-UPDATE-OK"
EOF
)"

LC_READONLY_SCRIPT="$(cat <<'EOF'
set -eu
[ "$(id -u)" = "10001" ] && [ "$(id -g)" = "10001" ] || { echo "unexpected identity $(id -u):$(id -g)" >&2; exit 42; }
set +e
/usr/local/bin/manao-maven -v >/tmp/manao-run.out 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "the wrapper succeeded although the cache is read-only" >&2; exit 55; }
[ -z "$(find /tmp -maxdepth 2 -type d -name repository 2>/dev/null)" ] \
  || { echo "the wrapper fell back to a temporary repository" >&2; exit 56; }
echo "LC-READONLY-FAILS-OK"
EOF
)"

LC_EXHAUSTED_SCRIPT="$(cat <<'EOF'
set -eu
[ "$(id -u)" = "10001" ] && [ "$(id -g)" = "10001" ] || { echo "unexpected identity $(id -u):$(id -g)" >&2; exit 42; }
set +e
/usr/local/bin/manao-maven -B -ntp -q -o -DskipTests compile >/tmp/manao-run.out 2>&1
rc=$?
set -e
[ "$rc" -ne 0 ] || { echo "the wrapper succeeded although the cache volume is exhausted" >&2; exit 57; }
[ -z "$(find /tmp -maxdepth 2 -type d -name repository 2>/dev/null)" ] \
  || { echo "the wrapper fell back to a temporary repository" >&2; exit 56; }
echo "LC-EXHAUSTED-FAILS-OK"
EOF
)"

scenario_lc_first_run_seeds_and_downloads() {
  local name="${PREFIX}-lc-first" cache ws log
  cache="$(new_volume lc-cache-main)"; ws="$(new_volume lc-ws-main)"
  lc_prep_cache "$cache"
  lc_prep_workspace "$ws" with-commons-text
  lc_run "$name" "$LC_FIRST_RUN_SCRIPT" bridge "$cache:/maven-cache" "$ws:/workspace"
  wait_case "$name" 600
  if [ "$CASE_EXIT" = "0" ]; then
    log="$(log_of "$name")"
    grep 'LC-FIRST-OK' "$log" || true
    pass "$name"
  else
    log="$(log_of "$name")"
    tail -n 30 "$log" || true
    fail "$name (exit=$CASE_EXIT)"
  fi
}

scenario_lc_second_run_offline_reuses() {
  local name="${PREFIX}-lc-second" cache ws before after log
  cache="${PREFIX}-lc-cache-main"; ws="${PREFIX}-lc-ws-main"
  before="$(lc_cache_state "$cache")"
  lc_run "$name" "$LC_SECOND_RUN_SCRIPT" none "$cache:/maven-cache" "$ws:/workspace"
  wait_case "$name" 600
  if [ "$CASE_EXIT" != "0" ]; then
    log="$(log_of "$name")"
    tail -n 30 "$log" || true
    fail "$name (exit=$CASE_EXIT)"
    return 0
  fi
  after="$(lc_cache_state "$cache")"
  if [ "$before" != "$after" ]; then
    printf 'cache state changed during the reuse run:\nbefore:\n%s\nafter:\n%s\n' "$before" "$after"
    fail "$name (the same-seed run rewrote the cache)"
    return 0
  fi
  log="$(log_of "$name")"
  grep 'LC-SECOND-OK' "$log" || true
  pass "$name (offline reuse, no re-copy, user artifact preserved)"
}

scenario_lc_interrupted_copy_is_repaired() {
  local name="${PREFIX}-lc-interrupted" verify repair cache ws shim log
  local waited=0 fired=0 st
  cache="$(new_volume lc-cache-int)"; ws="$(new_volume lc-ws-int)"; shim="$(new_volume lc-shim)"
  lc_prep_cache "$cache"
  lc_prep_workspace "$ws"
  write_copy_shim "$shim"
  local -a run_args=(run -d --name "$name" --user 10001:10001 --read-only --tmpfs /tmp
                     --network none
                     -v "${cache}:/maven-cache" -v "${ws}:/workspace"
                     -v "${shim}:/shim"
                     -e "PATH=/shim:${IMAGE_PATH}"
                     -e "MANAO_TEST_COPY_DELAY=${SHIM_DELAY}")
  CONTAINERS+=("$name")
  dc "${run_args[@]}" "$IMAGE" bash -c "$LC_INTERRUPT_RUN_SCRIPT" >/dev/null
  # Kill the wrapper while a copy is provably in flight (the throttled cp keeps temp
  # files visible); SIGKILL to PID 1 mirrors the hardest possible stop.
  while [ "$waited" -lt 120 ]; do
    st="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
    [ "$st" = "running" ] || break
    if dc exec "$name" sh -c 'find /maven-cache/repository -name "*.manao-tmp.*" -type f 2>/dev/null | head -n 1' | grep -q .; then
      fired=1
      break
    fi
    sleep 1
    waited=$((waited+1))
  done
  if [ "$fired" != "1" ]; then
    log="$(log_of "$name")"
    tail -n 30 "$log" || true
    fail "$name (the copy was never observed in progress)"
    return 0
  fi
  docker kill "$name" >/dev/null
  wait_case "$name" 60
  verify="${PREFIX}-lc-interrupted-check"
  CONTAINERS+=("$verify")
  dc run --name "$verify" --network none -v "${cache}:/maven-cache" "$IMAGE" \
    bash -c "$LC_INTERRUPT_CHECK_SCRIPT" >/dev/null 2>&1
  wait_case "$verify" 120
  if [ "$CASE_EXIT" != "0" ]; then
    log="$(log_of "$verify")"
    tail -n 20 "$log" || true
    fail "$verify (exit=$CASE_EXIT)"
    return 0
  fi
  pass "$verify"
  # The next explicit run must repair the cache: complete the copy, sweep the temp files
  # and publish the marker - and the repaired cache must then work fully offline.
  repair="${PREFIX}-lc-repair"
  lc_run "$repair" "$LC_REPAIR_SCRIPT" none "$cache:/maven-cache" "$ws:/workspace"
  wait_case "$repair" 600
  if [ "$CASE_EXIT" = "0" ]; then
    log="$(log_of "$repair")"
    grep 'LC-REPAIR-OK' "$log" || true
    pass "$repair"
  else
    log="$(log_of "$repair")"
    tail -n 30 "$log" || true
    fail "$repair (exit=$CASE_EXIT)"
  fi
}

scenario_lc_seed_update_fills_gaps_without_overwrite() {
  local first second cache fake log
  first="${PREFIX}-lc-update-baseline"
  second="${PREFIX}-lc-update-second"
  cache="$(new_volume lc-cache-upd)"; fake="$(new_volume lc-fakeseed)"
  lc_prep_cache "$cache"
  lc_run "$first" "$LC_UPDATE_BASELINE_SCRIPT" none "$cache:/maven-cache"
  wait_case "$first" 600
  if [ "$CASE_EXIT" != "0" ]; then
    log="$(log_of "$first")"
    tail -n 30 "$log" || true
    fail "$first (exit=$CASE_EXIT)"
    return 0
  fi
  pass "$first"
  # A file the user added to the project cache (same path as one of the new seed's files)
  # plus a fake "updated seed" (new content version, one overlapping + one new file).
  dc run --rm --user 0 -v "${cache}:/maven-cache" "$IMAGE" sh -c 'mkdir -p /maven-cache/repository/com/example/userlib/1.0 && printf "USER-ARTIFACT-V1" > /maven-cache/repository/com/example/userlib/1.0/userlib-1.0.jar && chown -R 10001:10001 /maven-cache/repository/com' >/dev/null 2>&1
  dc run --rm --user 0 -v "${fake}:/seed" "$IMAGE" sh -c 'mkdir -p /seed/repository/com/example/userlib/1.0 /seed/repository/com/example/newlib/2.0 && printf "f%.0s" $(seq 1 64) > /seed/seed-id && printf %s "SEED-UPDATE-CONTENT" > /seed/repository/com/example/userlib/1.0/userlib-1.0.jar && printf %s "NEW-SEED-CONTENT" > /seed/repository/com/example/newlib/2.0/newlib-2.0.jar' >/dev/null 2>&1
  lc_run "$second" "$LC_UPDATE_SECOND_SCRIPT" none "$cache:/maven-cache" "${fake}:/opt/manao-maven-seed:ro"
  wait_case "$second" 300
  if [ "$CASE_EXIT" != "0" ]; then
    log="$(log_of "$second")"
    tail -n 30 "$log" || true
    fail "$second (exit=$CASE_EXIT)"
    return 0
  fi
  # The previous version's marker must survive alongside the new one.
  if ! dc run --rm --network none -v "${cache}:/maven-cache" "$IMAGE" \
        sh -c "test -f /maven-cache/seeded-$LC_SEED_ID" >/dev/null 2>&1; then
    fail "$second (the previous seed version's marker disappeared)"
    return 0
  fi
  log="$(log_of "$second")"
  grep 'LC-UPDATE-OK' "$log" || true
  pass "$second (new version filled the gap, user file untouched)"
}

scenario_lc_readonly_cache_fails_closed() {
  local name="${PREFIX}-lc-readonly" cache log
  cache="$(new_volume lc-cache-ro)"
  lc_prep_cache "$cache"
  name="${PREFIX}-lc-readonly-run"
  lc_run "$name" "$LC_READONLY_SCRIPT" none "${cache}:/maven-cache:ro"
  wait_case "$name" 120
  if [ "$CASE_EXIT" = "0" ]; then
    log="$(log_of "$name")"
    grep 'LC-READONLY-FAILS-OK' "$log" || true
    if dc run --rm --network none -v "${cache}:/maven-cache" "$IMAGE" \
          sh -c '[ -z "$(ls /maven-cache/seeded-* 2>/dev/null)" ]' >/dev/null 2>&1; then
      pass "$name"
    else
      fail "$name (a marker appeared on the read-only cache)"
    fi
  else
    log="$(log_of "$name")"
    tail -n 20 "$log" || true
    fail "$name (exit=$CASE_EXIT, want a fail-closed run)"
  fi
}

scenario_lc_exhausted_cache_fails_closed() {
  local name="${PREFIX}-lc-full" cache log v
  v="${PREFIX}-lc-cache-full"
  # A real size-limited volume: the local driver's tmpfs backend, so the ENOSPC happens
  # inside the test's own 64 MiB volume and never fills the host or a project store.
  docker volume create --driver local --opt type=tmpfs --opt device=tmpfs --opt "o=size=64m" "$v" >/dev/null
  VOLUMES+=("$v")
  lc_prep_cache "$v"
  name="${PREFIX}-lc-full-run"
  lc_run "$name" "$LC_EXHAUSTED_SCRIPT" none "${v}:/maven-cache"
  wait_case "$name" 120
  if [ "$CASE_EXIT" = "0" ]; then
    log="$(log_of "$name")"
    grep 'LC-EXHAUSTED-FAILS-OK' "$log" || true
    if dc run --rm --network none -v "${v}:/maven-cache" "$IMAGE" \
          sh -c '[ -z "$(ls /maven-cache/seeded-* 2>/dev/null)" ]' >/dev/null 2>&1; then
      pass "$name"
    else
      fail "$name (a marker appeared despite the copy failure)"
    fi
  else
    log="$(log_of "$name")"
    tail -n 20 "$log" || true
    fail "$name (exit=$CASE_EXIT, want a fail-closed run)"
  fi
}

# The supervisor regression needs the runtime-test fixture classes. Use the given image
# when it has them, otherwise the documented -test pair tag when it exists; without any
# capable image the delegation is an explicit SKIPPED, never a silent pass or a hard fail.
lifecycle_image() {
  if dc run --rm --network none --user 10001:10001 "$IMAGE" \
       sh -c 'test -d /opt/manao-runner/test-classes' >/dev/null 2>&1; then
    echo "$IMAGE"
    return 0
  fi
  if docker image inspect "${IMAGE}-test" >/dev/null 2>&1 \
     && dc run --rm --network none --user 10001:10001 "${IMAGE}-test" \
          sh -c 'test -d /opt/manao-runner/test-classes' >/dev/null 2>&1; then
    echo "${IMAGE}-test"
    return 0
  fi
  return 1
}

run_lifecycle() {
  local pass_at_start=$PASS fail_at_start=$FAIL
  echo "lifecycle: verifying the per-project maven cache (real cluster identity UID/GID 10001)"
  require_templates
  seed_templates_volume
  LC_SEED_ID="$(image_seed_id)"
  [ -n "$LC_SEED_ID" ] || { echo "image has no usable seed-id" >&2; return 2; }
  IMAGE_PATH="$(dc run --rm --entrypoint /bin/sh "$IMAGE" -c 'printf %s "$PATH"')"
  scenario_lc_first_run_seeds_and_downloads
  scenario_lc_second_run_offline_reuses
  scenario_lc_interrupted_copy_is_repaired
  scenario_lc_seed_update_fills_gaps_without_overwrite
  scenario_lc_readonly_cache_fails_closed
  scenario_lc_exhausted_cache_fails_closed
  local regression_image="" delegation_rc=0
  if regression_image="$(lifecycle_image)"; then
    echo
    echo "delegating the supervisor regression to runtime-lifecycle.sh ($regression_image)"
    bash "$SCRIPT_DIR/runtime-lifecycle.sh" "$regression_image" "$PREFIX-rl" || delegation_rc=1
  else
    echo
    echo "SKIPPED: runtime-lifecycle delegation needs a runtime-test image (fixture classes);"
    echo "         run it explicitly: bash poc4/maven-runner/tests/runtime-lifecycle.sh <runtime-test-image>"
  fi
  echo
  echo "maven-cache lifecycle: $((PASS - pass_at_start)) passed, $((FAIL - fail_at_start)) failed"
  [ "$FAIL" -eq 0 ] && [ "$delegation_rc" -eq 0 ] || return 1
  return 0
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

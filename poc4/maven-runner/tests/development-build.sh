#!/bin/bash
# Development-build verification for the stage-one isolated Maven build (design section 5).
#
# Usage (needs a Docker CLI talking to a Linux-container daemon):
#   bash poc4/maven-runner/tests/development-build.sh <image> <exported-templates-dir>
#
# Every development-build security claim is exercised against REAL containers with the real
# cluster identity (UID/GID 10001), a read-only root filesystem and a writable tmp volume
# mounted at /tmp (the production emptyDir shape, review fix I4):
#   copy phase   - the launcher copies the read-only mounted source into a scratch directory,
#                  excluding every .manao*, .git and target directory, and refuses symlinks;
#                  the read-only source mount is proven by a real failed write (EROFS), never
#                  by chmod.
#   run phase    - the fixed `manao-dev-build run test` fails with the real exit code 1 on a
#                  deliberately broken greeting, then passes fully offline (exit 0) after the
#                  source is updated externally and re-copied into a fresh scratch; the report
#                  markers carry the Surefire XML tail both times.
#   isolation    - the main-container shape mounts no source at all; scratch writes never
#                  touch the source; the project maven cache is initialized once and reused
#                  fully offline by the second run.
# Sources, scratch spaces and the project cache live in per-invocation host temporary
# directories bind-mounted into the containers (a real read-only mount for /source); the
# symlink-rejection scenario uses its own per-invocation docker volume because a Windows host
# bind cannot hold a Linux symlink. Every container, volume and directory carries the unique
# invocation prefix and is removed by exact name/path on exit; shared docker resources are
# never touched. Assertions use container exit codes, the real EROFS failure and the launcher's
# own marker protocol — the markers are the executor's contract, so their presence and content
# are part of the assertions.
set -u

IMAGE="${1:?usage: development-build.sh <image> <exported-templates-dir>}"
TEMPLATES="${2:?usage: development-build.sh <image> <exported-templates-dir>}"

PREFIX="manao-dbuild-$$"
TEMPLATES_VOL=""
WORK_DIR=""
LAUNCHER="/usr/local/bin/manao-dev-build"
REPORT_BEGIN="MANAO-SUREFIRE-REPORT-BEGIN"

CONTAINERS=()
VOLUMES=()
LOGS=()
LAST_LOG=""
PASS=0
FAIL=0
CASE_EXIT=""
SEED_ID=""

# docker with MSYS/Git Bash path conversion disabled (same convention as maven-cache.sh);
# host paths are converted explicitly where a bind mount needs them — and only on an MSYS/MINGW
# host, so a Linux/WSL host passes its paths through unchanged.
dc() { MSYS_NO_PATHCONV=1 docker "$@"; }
host_path() {
  case "$(uname -s)" in
    MSYS*|MINGW*|CYGWIN*) cygpath -w "$1" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

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
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

pass() { PASS=$((PASS+1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

fail_case() { # NAME LOG_FILE [MAX]
  local name="$1" log="$2" max="${3:-30}"
  tail -n "$max" "$log" || true
  fail "$name (exit=$CASE_EXIT)"
}

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

# Logs of a container into a temp file (removed by the cleanup trap); sets LAST_LOG to the
# path — a command substitution would run in a subshell and lose the LOGS bookkeeping.
log_of() { # NAME
  local f
  f="$(mktemp "${TMPDIR:-/tmp}/${PREFIX}-log.XXXXXX")" || { LAST_LOG=""; return 1; }
  docker logs "$1" >"$f" 2>&1
  LOGS+=("$f")
  LAST_LOG="$f"
}

require_templates() {
  [ -d "$TEMPLATES" ] || { echo "templates directory not found: $TEMPLATES" >&2; exit 2; }
  [ -f "$TEMPLATES/console/pom.xml" ] \
    || { echo "templates directory lacks the exported 'console' variant (run the MavenSeedTemplateExporter first)" >&2; exit 2; }
}

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

image_seed_id() {
  dc run --rm --network none --entrypoint /bin/sh "$IMAGE" -c 'tr -d "[:space:]" < /opt/manao-maven-seed/seed-id'
}

# Loads the console template into a per-invocation host source directory (the project source
# PVC analog) with repository-internal noise the copy must exclude, and the given App.greeting
# value (broken first, fixed after the external update).
load_source() { # SOURCE_DIR greeting
  local source="$1" greeting="$2"
  cp -r "$TEMPLATES/console/." "$source/"
  mkdir -p "$source/.git" "$source/target" "$source/.manao-receipts"
  echo 'ref: noise' > "$source/.git/HEAD"
  echo 'stale' > "$source/target/stale.class"
  echo 'receipt' > "$source/.manao-receipts/op.json"
  sed -i "s/Hello from Manao/$greeting/" "$source/src/main/java/com/example/app/App.java"
  grep -q "$greeting" "$source/src/main/java/com/example/app/App.java" \
    || { echo "cannot prepare the source greeting in $source" >&2; exit 2; }
}

# The copy container mirrors the development job's init shape (review fix I4): cluster
# identity, read-only root filesystem, a WRITABLE tmp volume mounted at /tmp — the same
# emptyDir shape the production pod mounts for both the copy init container and the run
# container — source bound read-only, scratch bound writable.
dc_copy() { # NAME SOURCE_SPEC SCRATCH_DIR  (SOURCE_SPEC is a full -v argument value)
  local name="$1" source_spec="$2" scratch="$3"
  local tmp_vol="${name}-tmp"
  VOLUMES+=("$tmp_vol")
  docker volume create "$tmp_vol" >/dev/null
  CONTAINERS+=("$name")
  dc run -d --name "$name" --user 10001:10001 --read-only --network none \
    -v "$tmp_vol:/tmp" \
    -v "$source_spec" -v "$(host_path "$scratch"):/workspace" \
    --entrypoint /bin/bash "$IMAGE" "$LAUNCHER" copy >/dev/null
}

bind_ro() { # HOST_DIR CONTAINER_PATH -> -v argument value
  echo "$(host_path "$1"):$2:ro"
}

# The run container mirrors the development job's main shape: exactly the scratch, the project
# maven cache and a writable tmp volume — never the source.
dc_run_build() { # NAME SCRATCH_DIR CACHE_DIR NETWORK(none|bridge)
  local name="$1" scratch="$2" cache="$3" net="$4"
  local tmp_vol="${name}-tmp"
  VOLUMES+=("$tmp_vol")
  docker volume create "$tmp_vol" >/dev/null
  local -a args=(run -d --name "$name" --user 10001:10001 --read-only
                 -v "$tmp_vol:/tmp"
                 -v "$(host_path "$scratch"):/workspace" -v "$(host_path "$cache"):/maven-cache")
  [ "$net" = "none" ] && args+=(--network none)
  args+=(--entrypoint /bin/bash "$IMAGE" "$LAUNCHER" run test)
  CONTAINERS+=("$name")
  dc "${args[@]}" >/dev/null
}

# Observable state of the project cache: marker identity and repository file count.
cache_state() { # CACHE_DIR
  dc run --rm --network none --user 10001:10001 -v "$(host_path "$1"):/maven-cache" \
    --entrypoint /bin/sh "$IMAGE" -c '
    stat -c "marker %i %Y %s" /maven-cache/seeded-* 2>/dev/null || echo "marker none"
    echo "files $(find /maven-cache/repository -type f 2>/dev/null | wc -l)"'
}

source_fingerprint() { # SOURCE_SPEC (-v argument value)
  dc run --rm --network none --user 10001:10001 -v "$1" --entrypoint /bin/sh "$IMAGE" -c \
    'find /source -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d" " -f1'
}

scenario_the_copy_excludes_internals_and_copies_sources() {
  local scratch verify log
  scratch="$WORK_DIR/scratch-ok"
  mkdir -p "$scratch"
  dc_copy "${PREFIX}-copy-ok" "$(bind_ro "$SOURCE_DIR" /source)" "$scratch"
  wait_case "${PREFIX}-copy-ok" 120
  if [ "$CASE_EXIT" != "0" ]; then
    log_of "${PREFIX}-copy-ok"
    fail_case "${PREFIX}-copy-ok" "$LAST_LOG"
    return 0
  fi
  log_of "${PREFIX}-copy-ok"
  log="$LAST_LOG"
  verify="${PREFIX}-copy-verify"
  CONTAINERS+=("$verify")
  CASE_EXIT="$(dc run --rm --name "$verify" --network none --user 10001:10001 \
    -v "$(host_path "$scratch"):/workspace" --entrypoint /bin/sh "$IMAGE" -c '
    set -e
    test -f /workspace/pom.xml
    test -f /workspace/src/main/java/com/example/app/App.java
    test -f /workspace/src/test/java/com/example/app/AppTest.java
    test -f /workspace/README.md
    [ ! -e /workspace/.git ]
    [ ! -e /workspace/target ]
    [ ! -e /workspace/.manao-receipts ]
    grep -q "Broken from Manao" /workspace/src/main/java/com/example/app/App.java' >/dev/null 2>&1; echo $?)"
  if [ "$CASE_EXIT" = "0" ]; then
    pass "${PREFIX}-copy-ok (sources copied, .git/target/.manao* excluded)"
  else
    fail "${PREFIX}-copy-ok (scratch content wrong, verify exit=$CASE_EXIT)"
  fi
}

scenario_the_copy_refuses_symlinks() {
  local name="${PREFIX}-copy-symlink" source_vol scratch log
  source_vol="${PREFIX}-source-symlink"
  scratch="$WORK_DIR/scratch-symlink"
  mkdir -p "$scratch"
  docker volume create "$source_vol" >/dev/null
  VOLUMES+=("$source_vol")
  dc run --rm --user 0 -v "${source_vol}:/source" -v "$TEMPLATES_VOL:/seed-projects:ro" "$IMAGE" \
    sh -c 'cp -r /seed-projects/console/. /source/ && ln -s /etc/hostname /source/src/main/java/com/example/app/outside.txt' >/dev/null 2>&1
  dc_copy "$name" "${source_vol}:/source:ro" "$scratch"
  wait_case "$name" 120
  log_of "$name"
  log="$LAST_LOG"
  if [ "$CASE_EXIT" != "0" ] && grep -q "refusing non-regular source entry" "$log"; then
    pass "$name (symlink in the source is rejected)"
  else
    fail_case "$name" "$log"
  fi
}

scenario_the_source_mount_is_really_read_only() {
  local name="${PREFIX}-source-ro" out rc
  # Foreground run with output captured: the probe echoes a marker, then records the touch's
  # OWN exit status on its own line. The assertions require all of: the container reached its
  # test step (PROBE-RAN), docker did not fail at the daemon layer (rc=0 — a 125-class
  # failure is a FAIL even if its text mentioned a read-only filesystem), the touch step
  # itself failed with a non-zero rc (TOUCH-FAILED), and the error text is a real read-only
  # filesystem error.
  rc=0
  out="$(dc run --rm --name "$name" --user 10001:10001 --read-only --tmpfs /tmp --network none \
    -v "$(bind_ro "$SOURCE_DIR" /source)" --entrypoint /bin/sh "$IMAGE" \
    -c 'echo PROBE-RAN
        touch /source/manao-write-probe || echo "TOUCH-FAILED rc=$?"' 2>&1)" || rc=$?
  if ! printf '%s\n' "$out" | grep -qx 'PROBE-RAN'; then
    fail "$name (the probe container never reached its test step, rc=$rc: $out)"
  elif [ "$rc" != "0" ]; then
    fail "$name (docker failed at the daemon layer after the probe started, rc=$rc: $out)"
  elif ! printf '%s\n' "$out" | grep -qE '^TOUCH-FAILED rc=[1-9][0-9]*$'; then
    fail "$name (the touch step did not fail on its own, probe output: $out)"
  elif ! printf '%s\n' "$out" | grep -qiE 'read-only file system|EROFS'; then
    fail "$name (the write failed without a read-only filesystem error, touch output: $out)"
  else
    pass "$name (writing to the read-only source mount fails with a real EROFS error)"
  fi
}

scenario_the_main_shape_mounts_no_source() {
  local name="${PREFIX}-main-shape"
  CONTAINERS+=("$name")
  CASE_EXIT="$(dc run --rm --name "$name" --user 10001:10001 --read-only --tmpfs /tmp --network none \
    -v "$(host_path "$SCRATCH_OK"):/workspace" -v "$(host_path "$CACHE_DIR"):/maven-cache" \
    --entrypoint /bin/sh "$IMAGE" -c '[ ! -e /source ]' >/dev/null 2>&1; echo $?)"
  if [ "$CASE_EXIT" = "0" ]; then
    pass "$name (main-container shape has no /source)"
  else
    fail "$name (/source is visible in the main-container shape)"
  fi
}

scenario_the_failing_test_returns_the_real_exit_1() {
  local name="${PREFIX}-run-fail" scratch log source_spec fingerprint_before fingerprint_after
  scratch="$WORK_DIR/scratch-fail"
  mkdir -p "$scratch"
  source_spec="$(bind_ro "$SOURCE_DIR" /source)"
  fingerprint_before="$(source_fingerprint "$source_spec")"
  dc_copy "${PREFIX}-copy-fail" "$source_spec" "$scratch"
  wait_case "${PREFIX}-copy-fail" 120
  if [ "$CASE_EXIT" != "0" ]; then
    log_of "${PREFIX}-copy-fail"
    fail_case "${PREFIX}-copy-fail" "$LAST_LOG"
    return 0
  fi
  dc_run_build "$name" "$scratch" "$CACHE_DIR" bridge
  wait_case "$name" 900
  log_of "$name"
  log="$LAST_LOG"
  fingerprint_after="$(source_fingerprint "$source_spec")"
  if [ "$CASE_EXIT" = "1" ] \
      && grep -q "$REPORT_BEGIN" "$log" \
      && grep -q "REPORT-END truncated=0 files=1" "$log" \
      && grep -q "<failure" "$log"; then
    pass "$name (broken greeting: real exit 1 with a failing Surefire report)"
  else
    fail_case "$name" "$log" 40
  fi
  if [ -n "$fingerprint_after" ] && [ "$fingerprint_after" = "$fingerprint_before" ]; then
    pass "$name (the failing scratch build left the source untouched)"
  else
    fail "$name (the source changed during the failing build)"
  fi
}

scenario_the_updated_source_builds_offline_and_reuses_the_cache() {
  local name="${PREFIX}-run-fixed" scratch log before after source_spec fingerprint_before fingerprint_after
  before="$(cache_state "$CACHE_DIR")"
  load_source "$SOURCE_DIR" "Hello from Manao"
  source_spec="$(bind_ro "$SOURCE_DIR" /source)"
  fingerprint_before="$(source_fingerprint "$source_spec")"
  scratch="$WORK_DIR/scratch-fixed"
  mkdir -p "$scratch"
  dc_copy "${PREFIX}-copy-fixed" "$source_spec" "$scratch"
  wait_case "${PREFIX}-copy-fixed" 120
  if [ "$CASE_EXIT" != "0" ]; then
    log_of "${PREFIX}-copy-fixed"
    fail_case "${PREFIX}-copy-fixed" "$LAST_LOG"
    return 0
  fi
  # Fully offline: every missing artifact can only fail, so the passing run proves the
  # per-project maven cache was reused, never re-downloaded.
  dc_run_build "$name" "$scratch" "$CACHE_DIR" none
  wait_case "$name" 900
  log_of "$name"
  log="$LAST_LOG"
  if [ "$CASE_EXIT" != "0" ]; then
    fail_case "$name" "$log" 40
    return 0
  fi
  after="$(cache_state "$CACHE_DIR")"
  fingerprint_after="$(source_fingerprint "$source_spec")"
  if [ "$before" != "$after" ]; then
    printf 'cache state changed during the offline run:\nbefore:\n%s\nafter:\n%s\n' "$before" "$after"
    fail "$name (the offline run rewrote the cache)"
    return 0
  fi
  if [ -z "$fingerprint_after" ] || [ "$fingerprint_after" != "$fingerprint_before" ]; then
    fail "$name (the source changed during the fixed build)"
    return 0
  fi
  if grep -q "REPORT-END truncated=0 files=1" "$log" && ! grep -q "<failure" "$log"; then
    pass "$name (fixed greeting: offline exit 0, passing report, cache reused untouched, source untouched)"
  else
    fail "$name (exit 0 but the report tail is wrong)"
  fi
}

require_templates
seed_templates_volume
SEED_ID="$(image_seed_id)"
[ -n "$SEED_ID" ] || { echo "image has no usable seed-id" >&2; exit 2; }

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${PREFIX}-work.XXXXXX")"
SOURCE_DIR="$WORK_DIR/source"
CACHE_DIR="$WORK_DIR/cache"
SCRATCH_OK="$WORK_DIR/scratch-shape"
mkdir -p "$SOURCE_DIR" "$CACHE_DIR" "$SCRATCH_OK"
load_source "$SOURCE_DIR" "Broken from Manao"

scenario_the_source_mount_is_really_read_only
scenario_the_main_shape_mounts_no_source
scenario_the_copy_excludes_internals_and_copies_sources
scenario_the_copy_refuses_symlinks
scenario_the_failing_test_returns_the_real_exit_1
scenario_the_updated_source_builds_offline_and_reuses_the_cache

echo
echo "development-build: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0

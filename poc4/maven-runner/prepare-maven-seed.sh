#!/bin/bash
# Seeds the read-only Maven repository of the runner image (maven-cache supplement plan, C1).
# Runs inside the seed-build Docker stage: root, with network access for the first downloads.
#
# Usage: prepare-maven-seed.sh <exported-templates-dir> <seed-output-dir>
# Produces:
#   <seed-output-dir>/repository  Maven local repository covering the five fixed template
#                                 variants (console, web, web-mysql, web-redis, web-mysql-redis)
#   <seed-output-dir>/seed-id     one-line content version: sha256 over the tool versions and
#                                 the sorted contents of every seeded file
#
# The script only seeds template dependencies and plugins (dependency:go-offline) and then
# proves real resolution by test-compiling every variant with the repository: the Web run
# goal forks the lifecycle up to test-compile, so the template's test-scope dependencies
# must be seeded too (go-offline alone misses transitive ones, e.g. byte-buddy via mockito).
# It never touches user projects and never reads a host .m2. go-offline success alone is
# not completeness: the no-database web template is therefore really started with the
# original goal in offline mode (-o; tests/maven-cache.sh later repeats this under
# --network none), must serve readiness and business traffic, and is stopped cleanly before
# the build may continue.
set -eu

TEMPLATES="${1:?usage: prepare-maven-seed.sh <templates-dir> <seed-output-dir>}"
OUTPUT="${2:?usage: prepare-maven-seed.sh <templates-dir> <seed-output-dir>}"
REPOSITORY="$OUTPUT/repository"
SEED_ID_FILE="$OUTPUT/seed-id"
VARIANTS="console web web-mysql web-redis web-mysql-redis"

for variant in $VARIANTS; do
  [ -f "$TEMPLATES/$variant/pom.xml" ] \
    || { echo "seed: missing exported template '$variant' under $TEMPLATES" >&2; exit 2; }
done

MVN_FLAGS=(-B -ntp -DskipTests -Dmaven.repo.local="$REPOSITORY")
mkdir -p "$REPOSITORY"

for variant in $VARIANTS; do
  echo "seed: prefetching dependencies/plugins for $variant"
  mvn "${MVN_FLAGS[@]}" -f "$TEMPLATES/$variant/pom.xml" dependency:go-offline
  echo "seed: test-compiling $variant"
  mvn "${MVN_FLAGS[@]}" -f "$TEMPLATES/$variant/pom.xml" test-compile
done

# Real verification: the no-database web template must start from the seed repository alone.
WORK="$(mktemp -d)"
cleanup_work() { rm -rf "$WORK"; }
trap cleanup_work EXIT
cp -r "$TEMPLATES/web" "$WORK/project"
cd "$WORK/project"

mvn "${MVN_FLAGS[@]}" -o spring-boot:run >/tmp/seed-web-run.log 2>&1 &
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
  echo "seed: web template never became ready" >&2
  tail -n 60 /tmp/seed-web-run.log >&2
  kill -9 "$MVN_PID" 2>/dev/null || true
  exit 3
fi
echo "seed: web template listener ready"
DEMO="$(curl -s http://127.0.0.1:8080/api/demo || true)"
case "$DEMO" in
  *'Hello from Manao'*) ;;
  *)
    echo "seed: unexpected business response: $DEMO" >&2
    kill -9 "$MVN_PID" 2>/dev/null || true
    exit 4
    ;;
esac
echo "seed: business endpoint verified"

# Normal stop: SIGTERM to the maven run (its forked app dies with it), finite wait, and the
# listener must stop answering.
kill "$MVN_PID" 2>/dev/null || true
i=0
while [ "$i" -lt 30 ]; do
  kill -0 "$MVN_PID" 2>/dev/null || break
  sleep 1
  i=$((i+1))
done
if kill -0 "$MVN_PID" 2>/dev/null; then
  echo "seed: maven did not stop on SIGTERM" >&2
  kill -9 "$MVN_PID" 2>/dev/null || true
  exit 5
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
[ -n "$STOPPED" ] || { echo "seed: app still serving after maven stopped" >&2; exit 6; }
echo "seed: web template stopped cleanly"

[ -n "$(find "$REPOSITORY" -type f -print -quit)" ] || { echo "seed: repository is empty" >&2; exit 7; }
cd "$REPOSITORY"
{
  mvn -v | sed -n '1,3p'
  find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
} | sha256sum | cut -d' ' -f1 > "$SEED_ID_FILE"

echo "seed: repository holds $(find . -type f | wc -l) files, seed-id $(cat "$SEED_ID_FILE")"

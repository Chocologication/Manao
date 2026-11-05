#!/bin/bash
# Shared fixed runtime/test environment. Sourcing this file performs no work.
manao_environment_die() { echo "python-environment: $1" >&2; exit 1; }

manao_prepare_python_environment() {
  local mode="${1:-}"
  case "$mode" in runtime|test) ;; *) echo 'python-environment: mode must be runtime or test' >&2; return 2 ;; esac
  local -a groups=()
  if [[ "$mode" == test ]]; then
    local has_test
    has_test="$(/usr/local/bin/python3 /opt/manao-python/python-check.py has-test-group)" || return 1
    [[ "$has_test" != true ]] || groups+=(--group test)
  fi

# 2. Fixed toolchain environment: the venv is per-Run, the cache private per project,
# the interpreter is the image's own, and nothing is downloaded from outside the cache
# when the locked dependencies are already there.
export UV_PROJECT_ENVIRONMENT=/tmp/manao-python/.venv
export UV_CACHE_DIR=/python-cache/uv-cache
export UV_LINK_MODE=copy
export UV_PYTHON_DOWNLOADS=never
export PYTHONUNBUFFERED=1
export PYTHONDONTWRITEBYTECODE=1

# 3. Server-controlled extras: only the two fixed booleans exist; they pin the --extra
# arguments, never an arbitrary array.
extras=()
if [[ "${MANAO_PYTHON_MYSQL:-false}" == true ]]; then extras+=(--extra mysql); fi
if [[ "${MANAO_PYTHON_REDIS:-false}" == true ]]; then extras+=(--extra redis); fi

# 4. Seed identity and private cache usability (fail-closed, bounded, credential-free
# diagnostics).
SEED_ROOT="/opt/manao-python-seed"
CACHE_ROOT="/python-cache"
[ -d "$SEED_ROOT/uv-cache" ] || manao_environment_die "image seed cache is missing"
[ -r "$SEED_ROOT/seed-id" ] || manao_environment_die "image seed version file is missing"
SEED_ID="$(tr -d '[:space:]' < "$SEED_ROOT/seed-id")"
case "$SEED_ID" in
  *[!0-9a-f]*|'') manao_environment_die "image seed version has an unexpected format" ;;
esac
[ "${#SEED_ID}" -eq 64 ] || manao_environment_die "image seed version has an unexpected length"
[ -d "$CACHE_ROOT" ] || manao_environment_die "project cache directory is not mounted"
if ! : > "$CACHE_ROOT/.manao-write-probe.$$" 2>/dev/null; then
  manao_environment_die "project cache directory is not writable"
fi
rm -f "$CACHE_ROOT/.manao-write-probe.$$"

# 5. One-time whole-seed initialization keyed on the TARGET CACHE DIRECTORY's existence:
# a missing directory (first Run, or a subPath whose contents were lost) is seeded afresh
# — even when a stale completion marker survived — and this seed's marker is published
# last (overwriting any stale copy of it). A cache directory that DOES exist is never
# copied over: uv manages it from there, whatever seed id produced it.
MARKER="$CACHE_ROOT/seeded-$SEED_ID"
if [ ! -d "$CACHE_ROOT/uv-cache" ]; then
  rm -rf "$CACHE_ROOT"/.manao-seed.* 2>/dev/null || true
  seed_tmp="$CACHE_ROOT/.manao-seed.$$"
  mkdir "$seed_tmp" 2>/dev/null || manao_environment_die "cannot create the seed staging directory"
  if ! cp -R "$SEED_ROOT/uv-cache/." "$seed_tmp/"; then
    rm -rf "$seed_tmp"
    manao_environment_die "cannot initialize the project cache from the image seed"
  fi
  mv "$seed_tmp" "$CACHE_ROOT/uv-cache" || {
    rm -rf "$seed_tmp"
    manao_environment_die "cannot publish the project cache directory"
  }
  marker_tmp="$CACHE_ROOT/.manao-marker.$$"
  printf '%s\n' "$SEED_ID" > "$marker_tmp" || manao_environment_die "cannot write the cache completion marker"
  mv "$marker_tmp" "$MARKER" || {
    rm -f "$marker_tmp"
    manao_environment_die "cannot publish the cache completion marker"
  }
fi

# 6. Install the locked dependencies into the per-Run venv. Offline first: the locked argv
# runs with --offline first, so a seed/project cache that fully covers the lock serves a
# network-less start (the seed compatibility proof is unconditional, design section 6) even
# when the mirror's freshness policy has aged the cached HTTP entries; the online retry with
# the same fixed argv (minus --offline) covers artifacts the cache genuinely lacks (e.g.
# dependencies added after the seed was built). The lock pins exact artifacts and hashes, so
# stale cached index metadata cannot corrupt a locked install. A preparation failure in BOTH
# attempts exits non-zero here — the application must never start with an uninstalled or
# mismatched environment. uv's own diagnostics are the only output; they carry no
# credentials. Both attempts share the startup budget.
if ! uv sync --offline --locked --no-dev --no-default-groups --no-build --no-config --python /usr/local/bin/python3 "${extras[@]}" "${groups[@]}"; then
  echo "manao-python: offline package preparation failed; retrying with network" >&2
  if ! uv sync --locked --no-dev --no-default-groups --no-build --no-config --python /usr/local/bin/python3 "${extras[@]}" "${groups[@]}"; then
    echo "manao-python: package preparation failed; the application will not start" >&2
    exit 1
  fi
fi

}

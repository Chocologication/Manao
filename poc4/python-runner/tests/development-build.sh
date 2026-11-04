#!/bin/bash
# Black-box checks of the fixed development commands, using real production-shaped
# containers. Every fixture is disposable; only exact registered resources are removed.
set -euo pipefail
IMAGE="${1:?usage: development-build.sh IMAGE [PREFIX]}"
PREFIX="${2:-manao-py-dev-$$}"
HARNESS_NAME=development-build
source "$(dirname "$0")/lib.sh"
harness_init
if ! dc_t 120 run --rm --network none --user 10001:10001 --read-only \
  --entrypoint /bin/sh "$IMAGE" -c 'test -x /usr/local/bin/manao-python-dev-build'; then
  fail 'fixed development launcher is missing'
  exit 1
fi
pass 'fixed development launcher exists'
if dc_t 120 run --rm --network none --user 10001:10001 --read-only "$IMAGE" \
  bash -ec 'source /usr/local/bin/python-environment.sh; test ! -d /tmp/manao-python; test ! -d /python-cache/uv-cache; if manao_prepare_python_environment invalid; then exit 1; else test "$?" -eq 2; fi'; then
  pass 'shared environment source is inert and rejects invalid mode'
else
  fail 'shared environment source is inert and rejects invalid mode'
fi

new_volume cache; CACHE="$CREATED_VOLUME"; prep_dir "$CACHE" /python-cache
new_volume source; SOURCE="$CREATED_VOLUME"
SEQ=0
fixture() { # Python code runs only in a fixture writer, never through the launcher.
  dc_t 120 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" \
    python3 -c 'import pathlib, shutil, sys; p=pathlib.Path("/source");
for c in p.iterdir():
 if c.is_dir() and not c.is_symlink(): shutil.rmtree(c)
 else: c.unlink()
exec(sys.argv[1]);
for c in p.rglob("*"):
 if not c.is_symlink(): c.chmod(0o777 if c.is_dir() else 0o666)' "$1"
}
run_dev() { # MODE [SHELL_AFTER_COPY] [NETWORK]
  SEQ=$((SEQ+1)); NAME="$PREFIX-$$-case-$SEQ"
  new_volume "work-$SEQ"; WORK="$CREATED_VOLUME"; prep_dir "$WORK" /workspace
  new_run_tmp "$NAME"; TMP="$CREATED_VOLUME"; prep_dir "$TMP" /tmp
  local script='manao-python-dev-build copy && exec manao-python-dev-build "$1"'
  [ -z "${2:-}" ] || script="$2"
  start_detached "$NAME" --user 10001:10001 --read-only --network "${3:-none}" \
    -e PYTEST_ADDOPTS=--invalid-inherited-option \
    -e UV_PROJECT_ENVIRONMENT=/source/evil-venv -e UV_CACHE_DIR=/source/evil-cache \
    -v "$SOURCE:/source:ro" --mount "type=volume,source=$WORK,target=/workspace,volume-nocopy" \
    -v "$CACHE:/python-cache" \
    -v "$TMP:/tmp" "$IMAGE" sh -c "$script" runner "$1"
  if [ "${STOP_CASE:-false}" = true ]; then
    local ready=false
    for ((i=0; i<60; i++)); do
      if dc_t 10 exec "$NAME" test -f /tmp/pytest-started; then ready=true; break; fi
      sleep 1
    done
    [ "$ready" = true ] || { fail 'pytest did not reach stop barrier'; exit 1; }
    dc_t 10 kill --signal TERM "$NAME" >/dev/null
  fi
  wait_case "$NAME" 90
  LOG="$(dc logs "$NAME" 2>&1)"
}
check() { local label="$1"; shift; if "$@"; then pass "$label"; else fail "$label (exit=$CASE_EXIT)"; printf '%s\n' "$LOG" | tail -n 12; fi; }
has() { [[ "$LOG" == *"$1"* ]]; }
exit_is() { [ "$CASE_EXIT" = "$1" ]; }

fixture 'p.joinpath("side_effect.py").write_text("raise RuntimeError(\"MUST_NOT_IMPORT\")\n")'
run_dev compile
check 'syntax compile does not execute modules' exit_is 0
check 'syntax reports actual file count' has '"filesChecked":1'
check 'syntax does not write source or pyc' dc_t 60 run --rm -v "$SOURCE:/source:ro" -v "$WORK:/workspace:ro" "$IMAGE" sh -c 'test ! -e /source/__pycache__ && test ! -e /workspace/__pycache__ && cmp /source/side_effect.py /workspace/side_effect.py'

fixture 'p.joinpath("bad.py").write_text("def broken(:\n")'
run_dev compile; check 'syntax errors fail' exit_is 1; check 'syntax error includes relative path' has 'bad.py'
fixture 'p.joinpath("readme.md").write_text("no Python")'
run_dev compile; check 'empty syntax selection is NO_SOURCE' has '"verificationStatus":"NO_SOURCE"'; check 'NO_SOURCE is not success' exit_is 1
fixture 'p.joinpath("ok.py").write_text("x=1\n"); p.joinpath(".venv").mkdir(); p.joinpath(".venv/bad.py").write_text("bad syntax ?"); p.joinpath(".env").write_text("SECRET"); p.joinpath("private.pem").write_text("SECRET"); p.joinpath(".git").mkdir(); p.joinpath(".git/token").write_text("SECRET")'
run_dev compile
check 'copy excludes venv, credentials and internal files' dc_t 60 run --rm -v "$WORK:/workspace:ro" "$IMAGE" sh -c 'test -f /workspace/ok.py && test ! -e /workspace/.venv && test ! -e /workspace/.env && test ! -e /workspace/private.pem && test ! -e /workspace/.git'
fixture 'p.joinpath("link.py").symlink_to("/etc/passwd")'
run_dev compile; check 'symlink copy is rejected' exit_is 1
fixture 'import os; os.mkfifo(p/"fifo")'
run_dev compile; check 'special file copy is rejected' exit_is 1
fixture '[(p/f"file{i}.txt").write_text("x") for i in range(1001)]'
run_dev compile; check '1001 files rejected' exit_is 1
fixture '[(p/f"file{i}.txt").write_text("x") for i in range(1000)]'
run_dev copy 'exec manao-python-dev-build copy'; check '1000 files accepted' exit_is 0
fixture 'p.joinpath("large.bin").write_bytes(b"x"*(20*1024*1024+1))'
run_dev compile; check 'over 20 MiB rejected' exit_is 1
fixture 'p.joinpath("large.bin").write_bytes(b"x"*(20*1024*1024))'
run_dev copy 'exec manao-python-dev-build copy'; check 'exactly 20 MiB accepted' exit_is 0
fixture '[(p/("long_source_name_"+str(i)+".py")).write_text("def broken(:\n") for i in range(1000)]'
run_dev compile; check 'oversized syntax report is UNKNOWN' has '"verificationStatus":"UNKNOWN"'
check 'syntax JSON output is bounded' test "${#LOG}" -lt 65536

# The test group and lock are generated by the pinned real uv, never hand-written.
fixture 'p.joinpath("pyproject.toml").write_text("[project]\nname=\"runner-test\"\nversion=\"0.1.0\"\nrequires-python=\"==3.13.*\"\ndependencies=[]\n"); p.joinpath("test_total.py").write_text("def test_total():\n    assert 2 + 2 == 4\n")'
dc_t 180 run --rm --user 0 -v "$SOURCE:/workspace" -w /workspace "$IMAGE" \
  uv --no-config --no-python-downloads add --group test pytest --no-sync --no-build \
  --python /usr/local/bin/python3 --default-index https://mirrors.aliyun.com/pypi/simple/
dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; p=Path("/source/pyproject.toml"); p.write_text(p.read_text()+"\n[tool.uv]\ndefault-groups=[\"test\"]\n")'
run_dev test '' bridge
check 'pytest test group is installed and inherited addopts cleared' exit_is 0
check 'pytest complete report exported' has 'MANAO-PYTEST-REPORT-END state=complete'
check 'pytest pass count is real JUnit' has 'tests="1"'
check 'test leaves original manifests byte-identical' dc_t 60 run --rm -v "$SOURCE:/source:ro" -v "$WORK:/workspace:ro" "$IMAGE" sh -c 'cmp /source/uv.lock /workspace/uv.lock && cmp /source/pyproject.toml /workspace/pyproject.toml && test ! -e /source/__pycache__'

dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; Path("/source/main.py").write_text("import importlib.util\nassert importlib.util.find_spec(\"pytest\") is None\nprint(\"RUNTIME_TEST_EXCLUDED\")\n")'
run_dev test 'manao-python-dev-build copy && exec manao-python console'
check 'runtime excludes test even when default-groups contains test' exit_is 0
check 'runtime main executed after isolation check' has RUNTIME_TEST_EXCLUDED

dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; Path("/source/test_total.py").write_text("def test_total():\n    assert 2 + 2 == 5\n")'
run_dev test; check 'pytest assertion retains exit 1' exit_is 1; check 'failed test still exports report' has 'failures="1"'
dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" sh -c 'rm /source/test_total.py'
run_dev test; check 'no tests retains pytest exit 5' exit_is 5; check 'no tests count retained' has 'tests="0"'
dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; Path("/source/test_skip.py").write_text("import pytest\n@pytest.mark.skip\ndef test_skip(): pass\n")'
run_dev test; check 'all skipped retains pytest exit 0' exit_is 0; check 'skipped count exported for caller classification' has 'skipped="1"'

dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; Path("/source/conftest.py").write_text("import atexit\nfrom pathlib import Path\natexit.register(lambda: Path(\"/tmp/manao-python-tests.xml\").unlink(missing_ok=True))\n")'
run_dev test; check 'missing report is explicit' has 'MANAO-PYTEST-REPORT-END state=missing'; check 'missing report does not replace actual exit' exit_is 0
dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; Path("/source/test_fail.py").write_text("def test_fail(): assert False\n")'
run_dev test; check 'missing report cannot replace failing pytest exit' exit_is 1
dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; Path("/source/conftest.py").write_text("import atexit\nfrom pathlib import Path\natexit.register(lambda: Path(\"/tmp/manao-python-tests.xml\").write_bytes(b\"x\"*70000))\n")'
run_dev test; check 'oversized report explicitly truncated' has 'MANAO-PYTEST-REPORT-END state=truncated bytes=65536'
check 'truncation cannot replace failing pytest exit' exit_is 1

dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; Path("/source/conftest.py").unlink(); Path("/source/test_fail.py").write_text("import os, signal\ndef test_cancel():\n    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n    os.kill(os.getppid(), signal.SIGTERM)\n    assert True\n")'
run_dev test
check 'cancellation wins over a TERM-ignoring successful child' exit_is 143
check 'cancel race cannot export complete report' bash -c '[[ "$1" != *"MANAO-PYTEST-REPORT-END state=complete"* ]]' check "$LOG"

dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; Path("/source/test_fail.py").write_text("import time\nfrom pathlib import Path\ndef test_wait():\n    Path(\"/tmp/pytest-started\").touch()\n    time.sleep(60)\n")'
STOP_CASE=true run_dev test
check 'TERM during pytest returns 143' exit_is 143
check 'canceled pytest never exports a complete report' bash -c '[[ "$1" != *"MANAO-PYTEST-REPORT-END state=complete"* ]]' check "$LOG"
run_dev test 'manao-python-dev-build copy && exec timeout --signal=TERM --kill-after=5 3 manao-python-dev-build test'
check 'deadline returns 124 rather than success' exit_is 124

dc_t 60 run --rm --user 0 -v "$SOURCE:/source" "$IMAGE" python3 -c 'from pathlib import Path; p=Path("/source/pyproject.toml"); p.write_text(p.read_text().replace("dependencies=[]", "dependencies=[\"httpx\"]"))'
run_dev test; check 'mismatched lock fails closed' exit_is 1
fixture 'p.joinpath("pyproject.toml").write_text("[project]\nname=\"missing-test\"\nversion=\"0.1.0\"\nrequires-python=\"==3.13.*\"\ndependencies=[]\n")'
dc_t 60 run --rm --user 0 -v "$SOURCE:/workspace" -w /workspace "$IMAGE" uv --no-config lock --python /usr/local/bin/python3
run_dev test; check 'missing pytest is explicit' has PYTEST_DEPENDENCY_MISSING; check 'missing pytest is failure' exit_is 1

# Source itself cannot execute through copy, including over a mounted destination.
fixture 'p.joinpath("ok.py").write_text("x=1\n")'
run_dev compile 'manao-python-dev-build copy && manao-python-dev-build copy && exec manao-python-dev-build compile'
check 'second copy never erases mounted workspace content' exit_is 1

echo "development-build: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

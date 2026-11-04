#!/usr/local/bin/python3
"""Image-owned bounded source/syntax/report operations; no project imports."""
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import tokenize
import tomllib

SOURCE = Path("/source")
WORKSPACE = Path("/workspace")
REPORT = Path("/tmp/manao-python-tests.xml")
MAX_FILES = 1000
MAX_SOURCE_BYTES = 20 * 1024 * 1024
MAX_REPORT_BYTES = 64 * 1024
EXCLUDED = {
    ".git", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
    ".ruff_cache", ".cache", "node_modules", "target", "dist", "build",
    ".ssh", ".aws", ".kube", ".docker", ".gnupg", ".idea",
    ".netrc", ".npmrc", ".pypirc", "credentials", "credentials.json",
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
}


def excluded(name):
    lowered = name.lower()
    return (lowered in EXCLUDED or lowered.startswith((".manao", ".env"))
            or lowered.endswith((".pem", ".key", ".p12", ".pfx", ".jks", ".keystore")))


def source_files(root):
    """Bound the snapshot before writing; never traverse a symlink or special entry."""
    if root.is_symlink() or not root.is_dir():
        raise ValueError("source directory is missing or unsafe")
    files, total, directories = [], 0, 0
    def scan_error(error):
        raise error
    for current, dirs, names in os.walk(root, topdown=True, followlinks=False, onerror=scan_error):
        dirs[:] = sorted(name for name in dirs if not excluded(name))
        for name in dirs:
            if not stat.S_ISDIR((Path(current) / name).lstat().st_mode):
                raise ValueError("non-regular source entry")
        directories += len(dirs)
        if directories > MAX_FILES:
            raise ValueError("source exceeds directory budget")
        for name in sorted(names):
            if excluded(name):
                continue
            path = Path(current) / name
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode):
                raise ValueError("non-regular source entry")
            files.append((path, info))
            total += info.st_size
            if len(files) > MAX_FILES or total > MAX_SOURCE_BYTES:
                raise ValueError("source exceeds 1000 files or 20 MiB")
    return files


def open_source(root_fd, relative):
    """Resolve every component against retained directory descriptors, never links."""
    parent_fd = os.dup(root_fd)
    try:
        for component in relative.parts[:-1]:
            child_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                               dir_fd=parent_fd)
            os.close(parent_fd)
            parent_fd = child_fd
        return os.open(relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                       dir_fd=parent_fd)
    finally:
        os.close(parent_fd)


def same_source(expected, actual):
    return (stat.S_ISREG(actual.st_mode)
            and (expected.st_dev, expected.st_ino, expected.st_size, expected.st_mtime_ns)
            == (actual.st_dev, actual.st_ino, actual.st_size, actual.st_mtime_ns))


def copy_source():
    # /workspace is an emptyDir mount root: never rmtree/unlink the mount itself.
    if WORKSPACE.is_symlink() or not WORKSPACE.is_dir() or any(WORKSPACE.iterdir()):
        raise ValueError("workspace must be an empty directory")
    root_fd = os.open(SOURCE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        files = source_files(SOURCE)
        total = 0
        for path, expected in files:
            relative = path.relative_to(SOURCE)
            target = WORKSPACE / relative
            with os.fdopen(open_source(root_fd, relative), "rb") as source:
                if not same_source(expected, os.fstat(source.fileno())):
                    raise ValueError("source changed after enumeration")
                total += expected.st_size
                if total > MAX_SOURCE_BYTES:
                    raise ValueError("source exceeds 20 MiB")
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as destination:
                    remaining = expected.st_size
                    while remaining:
                        chunk = source.read(min(65536, remaining))
                        if not chunk:
                            raise ValueError("source changed during copy")
                        destination.write(chunk)
                        remaining -= len(chunk)
                    if source.read(1) or not same_source(expected, os.fstat(source.fileno())):
                        raise ValueError("source changed during copy")
    finally:
        os.close(root_fd)
    print(f"manao-python-dev-build: copied {len(files)} files ({total} bytes)")
    return 0


def syntax_result(status, checked, errors):
    return {"language": "python", "checkKind": "syntax", "verificationStatus": status,
            "filesChecked": checked, "errors": errors}


def compile_sources():
    errors, checked = [], 0
    for path, _ in source_files(WORKSPACE):
        if path.suffix != ".py":
            continue
        checked += 1
        relative = path.relative_to(WORKSPACE).as_posix()
        try:
            with tokenize.open(path) as source:
                compile(source.read(), relative, "exec")
        except (OSError, SyntaxError, UnicodeError, ValueError) as error:
            errors.append({"path": relative, "message": str(error)[:1024]})
    result = syntax_result("NO_SOURCE" if not checked else "FAILED" if errors else "PASS", checked, errors)
    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) + 1 > MAX_REPORT_BYTES:
        result = syntax_result("UNKNOWN", checked, [{"message": "syntax report exceeded 64 KiB"}])
        encoded = json.dumps(result, separators=(",", ":")).encode("utf-8")
    sys.stdout.buffer.write(encoded + b"\n")
    return 0 if result["verificationStatus"] == "PASS" else 1


def has_test_group():
    with (WORKSPACE / "pyproject.toml").open("rb") as manifest:
        project = tomllib.load(manifest)
    print("true" if "test" in project.get("dependency-groups", {}) else "false")
    return 0


def emit_report():
    state, payload = "missing", b""
    try:
        # A user-controlled report must not redirect collection to another file/FIFO.
        with os.fdopen(os.open(REPORT, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb") as report:
            if not stat.S_ISREG(os.fstat(report.fileno()).st_mode):
                raise ValueError("report is not a regular file")
            payload = report.read(MAX_REPORT_BYTES + 1)
        state = "truncated" if len(payload) > MAX_REPORT_BYTES else "complete"
        payload = payload[:MAX_REPORT_BYTES]
    except (OSError, ValueError):
        pass
    sys.stdout.buffer.write(b"\nMANAO-PYTEST-REPORT-BEGIN\n" + payload
                            + f"\nMANAO-PYTEST-REPORT-END state={state} bytes={len(payload)}\n".encode())
    sys.stdout.buffer.flush()


def run_tests():
    # Both uv preparation and pytest live in a process group. TERM forwards to that
    # entire group, followed by bounded KILL/reap; a canceled run cannot report success.
    stopped = 0
    process = None
    def stop(signum, frame):
        nonlocal stopped
        stopped = signum
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    REPORT.unlink(missing_ok=True)
    command = '''set -euo pipefail
source /usr/local/bin/python-environment.sh
manao_prepare_python_environment test
if ! /tmp/manao-python/.venv/bin/python -c 'import importlib.util; raise SystemExit(importlib.util.find_spec("pytest") is None)'; then
  echo PYTEST_DEPENDENCY_MISSING >&2
  exit 1
fi
unset PYTEST_ADDOPTS
exec /tmp/manao-python/.venv/bin/python -m pytest -q -o addopts= --junitxml=/tmp/manao-python-tests.xml
'''
    process = subprocess.Popen(["/bin/bash", "-c", command], cwd=WORKSPACE, start_new_session=True)
    while True:
        if stopped:
            try:
                os.killpg(process.pid, signal.SIGTERM)
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            except ProcessLookupError:
                process.wait()
            # Descendants may outlive the group leader (e.g. a TERM-ignoring child).
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            return 128 + stopped
        try:
            result = process.wait(timeout=0.1)
            if stopped:
                continue
            break
        except subprocess.TimeoutExpired:
            continue
    try:
        emit_report()
    except OSError:
        # Report collection/output failure never changes pytest's actual exit code.
        pass
    return 128 + stopped if stopped else result if result >= 0 else 128 - result


def main():
    if len(sys.argv) != 2:
        return 2
    # Python is PID 1 after the launcher exec. Explicit handlers are required even
    # for copy/compile: the kernel ignores PID 1's untrapped default TERM action.
    def interrupted(signum, frame):
        raise SystemExit(128 + signum)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        return {"copy": copy_source, "compile": compile_sources, "test": run_tests,
                "has-test-group": has_test_group}[sys.argv[1]]()
    except (OSError, ValueError, KeyError, tomllib.TOMLDecodeError) as error:
        print(f"manao-python-dev-build: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

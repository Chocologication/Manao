"""Root-owned dependency helper for the Manao workspace agent (python runtime design 6.2/6.3).

Launched by the agent exactly as:

    /usr/local/bin/python3 -I /opt/manao-python/dependency_helper.py SCRATCH ACTION PACKAGE VERSION BUDGET

- SCRATCH is a fresh agent-created directory holding the copied pyproject.toml and (optional)
  uv.lock; the workspace sources are never touched here.
- ACTION is ADD or REMOVE, PACKAGE is the already-normalized lowercase name, VERSION is an
  exact version or empty, BUDGET is the resolution budget in seconds.
- Standard library only; isolated mode (-I) plus the absolute script path guarantee it can
  never import management code from a user project; no shell is ever spawned; the agent
  starts it with a minimal environment, so no capability material or project secret is in
  scope.
- A prepare is the fixed add/remove run PLUS a fixed installability verification: after a
  successful `uv add/remove --no-sync ...` in the scratch, the same scratch is verified with
  the production install shape minus the out-of-scope extras (ruling R3):
  `uv sync --locked --no-dev --no-build --no-config --no-python-downloads --python
  /usr/local/bin/python3 --dry-run` — without `--no-sync`, because the point is to prove the
  resolved lock installs. A universal lock can resolve a distribution whose wheels exist only
  for other platforms (e.g. pywin32), which would otherwise stage a PREPARED journal for a
  project whose production `uv sync` can never succeed; the dry-run verification fails such
  a request BEFORE any journal exists, leaving the workspace sources untouched.
- ONE monotonic deadline, taken once at start and spanning BOTH invocations: whichever phase
  exhausts BUDGET fails PYTHON_DEPENDENCY_TIMEOUT, so the helper's total wall clock stays
  within the budget the agent's outer wait (BUDGET + 2 s, strictly below the backend's
  BUDGET + 10 s request timeout) assumes (ruling R4).
- Checks the first-version support scope with tomllib: the scratch pyproject must parse and
  declare [project], must NOT declare a build backend, and the only [tool.uv] configuration
  it may carry is an index declaration for the pinned public index (uv add itself persists
  --default-index into the file that way; anything else - sources, private indexes, overrides
  - is rejected). Every dependency declaration ([project] dependencies, optional-dependencies
  and [dependency-groups]) must be a plain public-PyPI requirement: a PEP 508 name with
  optional extras, optional PEP 440 specifiers and a conservative environment marker. Direct
  URLs (`name @ ...`), git+/file:/http(s) references and paths can aim uv at sources beyond
  the pinned index even with --no-sources, so they are rejected BEFORE uv runs - for the
  requested change and for pre-existing declarations alike. uv runs with the fixed argv
  --no-sync --no-build --no-sources --no-config --no-python-downloads against the pinned
  interpreter and the public index, so user build backends and user sources can never execute
  inside the management agent.
- stdout carries only a fixed failure token (PYTHON_DEPENDENCY_UNSUPPORTED |
  PYTHON_DEPENDENCY_TIMEOUT | PYTHON_DEPENDENCY_NO_WHEEL |
  PYTHON_DEPENDENCY_RESOLUTION_FAILED). Diagnostics are capped at 64 KiB and go to stderr for
  the agent log only - never back to the client.
"""
import os
import re
import signal
import subprocess
import sys
import threading
import time
import tomllib

OUTPUT_LIMIT = 64 * 1024
DEFAULT_INDEX_URL = "https://pypi.org/simple"
PACKAGE_NAME = re.compile(r"^[a-z0-9]([a-z0-9-]{0,126}[a-z0-9])?$")
EXACT_VERSION = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+!-]{0,127}$")

# First-version support scope (design 6.3): every dependency declaration must be a plain
# public-PyPI requirement - a PEP 508 name with optional extras, optional PEP 440 version
# specifiers and an optional PEP 508 environment-marker expression. Direct URLs (`name @
# ...`), git+/file:/http(s) references and absolute or relative paths can direct uv to
# sources beyond the pinned index even with --no-sources, so anything outside this grammar
# is rejected BEFORE uv runs - for the requested change and for pre-existing declarations.
_PEP508_NAME = r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?"
_PEP440_VERSION = r"[0-9A-Za-z][0-9A-Za-z.*+!\-_]*"
_VERSION_SPECIFIER = r"(?:===|==|!=|<=|>=|~=|<|>)\s*%s" % _PEP440_VERSION
_MARKER_VAR = r"[A-Za-z_][A-Za-z0-9_.]*"
_MARKER_OP = r"(?:===|==|!=|<=|>=|~=|<|>|in|not\s+in)"
_MARKER_VALUE = r"(?:'[^']*'|\"[^\"]*\"|[0-9A-Za-z][0-9A-Za-z._+\-]*)"
_MARKER_TERM = r"\(?%s\s*%s\s*%s\)?" % (_MARKER_VAR, _MARKER_OP, _MARKER_VALUE)
_MARKER_EXPR = r"%s(?:\s+(?:and|or)\s+%s)*" % (_MARKER_TERM, _MARKER_TERM)
PLAIN_REQUIREMENT = re.compile(
    r"^(?:%s)(?:\[(?:%s(?:,%s)*)?\])?"
    r"(?:\s*%s(?:\s*,\s*%s)*)?"
    r"(?:\s*;\s*%s)?\s*$"
    % (_PEP508_NAME, _PEP508_NAME, _PEP508_NAME,
       _VERSION_SPECIFIER, _VERSION_SPECIFIER, _MARKER_EXPR))

# Fixed uv argv: project discovery stays in SCRATCH (cwd), the interpreter and index are
# pinned, and every relaxation that could execute user code or read user configuration is off.
UV_ARGV_PREFIX = [
    "uv",
    "--no-sync",
    "--no-build",
    "--no-sources",
    "--no-config",
    "--no-python-downloads",
    "--python", "/usr/local/bin/python3",
    "--default-index", "https://pypi.org/simple",
]

# Fixed installability-verification argv (ruling R3): the production install shape minus the
# selected extras. It runs in the SCRATCH after a successful add/remove and proves the
# resolved lock installs for the pinned target interpreter/platform; `--dry-run` touches
# nothing (no .venv is created, the staged files are unchanged).
VERIFY_ARGV = [
    "uv",
    "sync",
    "--locked",
    "--no-dev",
    "--no-build",
    "--no-config",
    "--no-python-downloads",
    "--python", "/usr/local/bin/python3",
    "--dry-run",
]

EXIT_UNSUPPORTED = 3
EXIT_TIMEOUT = 4
EXIT_RESOLUTION_FAILED = 5
EXIT_NO_WHEEL = 6

# uv 0.11.6 emits these fixed phrases when the pinned public registry cannot satisfy the
# request at all: the package does not exist, the exact version does not exist, no usable
# wheel exists and building is disabled by --no-build, or the resolved distribution has no
# binary distribution for the target platform while building is disabled (observed verbatim
# for pywin32: "can't be installed because it is marked as `--no-build` but has no binary
# distribution"). Those form the design's fixed safe "no wheel" category; every other uv
# failure stays a generic resolution failure.
NO_WHEEL_MARKERS = (
    "has no usable wheels",
    "was not found in the package registry",
    "there is no version of",
    "has no binary distribution",
)


def fail(token, exit_code, message):
    sys.stderr.write(message[:OUTPUT_LIMIT] + "\n")
    print(token)
    sys.exit(exit_code)


def unsupported(message):
    fail("PYTHON_DEPENDENCY_UNSUPPORTED", EXIT_UNSUPPORTED, message)


def resolution_failed(message):
    fail("PYTHON_DEPENDENCY_RESOLUTION_FAILED", EXIT_RESOLUTION_FAILED, message)


def no_wheel(message):
    fail("PYTHON_DEPENDENCY_NO_WHEEL", EXIT_NO_WHEEL, message)


def drain(stream, sink):
    """Read a child stream to EOF, retaining at most OUTPUT_LIMIT bytes."""
    while True:
        chunk = stream.read(8192)
        if not chunk:
            return
        room = OUTPUT_LIMIT - len(sink["data"])
        if room > 0:
            sink["data"] += chunk[:room]


def check_supported_scope(scratch):
    path = os.path.join(scratch, "pyproject.toml")
    if not os.path.isfile(path):
        unsupported("pyproject.toml is missing in the scratch directory")
    try:
        with open(path, "rb") as handle:
            data = tomllib.load(handle)
    except tomllib.TOMLDecodeError as ex:
        unsupported("pyproject.toml is not valid TOML: %s" % ex)
    project = data.get("project")
    if not isinstance(project, dict):
        unsupported("pyproject.toml declares no [project] table")
    if "build-system" in data:
        unsupported("build backend execution is outside the supported scope")
    tool = data.get("tool")
    if isinstance(tool, dict) and "uv" in tool:
        uv_table = tool["uv"]
        if not isinstance(uv_table, dict) or set(uv_table) != {"index"}:
            unsupported("[tool.uv] configuration beyond an index declaration is outside the supported scope")
        entries = uv_table["index"]
        if not isinstance(entries, list):
            unsupported("[tool.uv] index must be a list of index declarations")
        for entry in entries:
            if not isinstance(entry, dict) or entry.get("url") != DEFAULT_INDEX_URL \
                    or not set(entry) <= {"url", "default", "explicit"}:
                unsupported("only the pinned public PyPI index (%s) is supported" % DEFAULT_INDEX_URL)
    check_dependency_declarations(data, project)


def check_dependency_declarations(data, project):
    """Rejects any dependency declaration that could aim uv beyond the pinned public index."""
    declarations = []
    dependencies = project.get("dependencies")
    if dependencies is not None:
        if not isinstance(dependencies, list):
            unsupported("[project] dependencies must be a list of requirement strings")
        declarations.append(("[project] dependencies", dependencies))
    optional = project.get("optional-dependencies")
    if optional is not None:
        if not isinstance(optional, dict):
            unsupported("[project] optional-dependencies must be a table of requirement lists")
        for group, entries in optional.items():
            if not isinstance(entries, list):
                unsupported("[project.optional-dependencies] groups must be lists of requirement strings")
            declarations.append(("[project.optional-dependencies.%s]" % group, entries))
    groups = data.get("dependency-groups")
    if groups is not None:
        if not isinstance(groups, dict):
            unsupported("[dependency-groups] must be a table of requirement lists")
        for group, entries in groups.items():
            if not isinstance(entries, list):
                unsupported("[dependency-groups] groups must be lists of requirement strings")
            declarations.append(("[dependency-groups.%s]" % group, entries))
    for table, entries in declarations:
        for entry in entries:
            if not isinstance(entry, str) or not PLAIN_REQUIREMENT.match(entry):
                unsupported(
                    "%s declares a dependency outside the plain public-PyPI requirement form; "
                    "direct URLs, git and path sources are outside the supported scope: %r" % (table, entry))


def classify_resolution_failure(code, output):
    """Maps one non-zero uv run onto the fixed safe failure categories."""
    # uv wraps its messages across lines, so the markers are matched against
    # whitespace-collapsed text.
    collapsed = " ".join(output.split())
    if any(marker in collapsed for marker in NO_WHEEL_MARKERS):
        no_wheel("the pinned registry cannot provide a usable wheel for the request: %s" % output)
    resolution_failed("uv failed (%d): %s" % (code, output))


def run_uv(argv, scratch, deadline, phase):
    """Runs one fixed-argv uv invocation in the scratch and returns (returncode, output).

    The wait draws the REMAINING time from the ONE monotonic deadline shared by the
    add/remove and verification phases (ruling R4): a deadline exhausted before the phase
    starts or during its run kills the whole uv tree and fails PYTHON_DEPENDENCY_TIMEOUT.
    """
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        fail("PYTHON_DEPENDENCY_TIMEOUT", EXIT_TIMEOUT,
             "uv exceeded the resolution budget before the %s phase" % phase)
    try:
        process = subprocess.Popen(
            argv,
            cwd=scratch,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # Own process group so a budget overrun kills the whole uv tree, not just the shell.
            start_new_session=True,
        )
    except OSError as ex:
        resolution_failed("cannot start uv: %s" % ex)

    stdout_sink, stderr_sink = {"data": b""}, {"data": b""}
    threads = [
        threading.Thread(target=drain, args=(process.stdout, stdout_sink), daemon=True),
        threading.Thread(target=drain, args=(process.stderr, stderr_sink), daemon=True),
    ]
    for thread in threads:
        thread.start()
    try:
        process.wait(timeout=remaining)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            process.kill()
        process.wait()
        fail("PYTHON_DEPENDENCY_TIMEOUT", EXIT_TIMEOUT,
             "uv exceeded the resolution budget during the %s phase: %s"
             % (phase, stderr_sink["data"].decode("utf-8", "replace")))
    for thread in threads:
        # The phase's process has exited and closed its pipes, so EOF is immediate; the join
        # only collects the concurrent drains and stays bounded by the same deadline.
        thread.join(timeout=max(0.0, deadline - time.monotonic()))
    return process.returncode, (stdout_sink["data"] + stderr_sink["data"]).decode("utf-8", "replace")


def main(argv):
    if len(argv) != 6:
        resolution_failed("usage: dependency_helper.py SCRATCH ACTION PACKAGE VERSION BUDGET")
    scratch, action, package, version, budget_text = argv[1], argv[2], argv[3], argv[4], argv[5]
    if action not in ("ADD", "REMOVE"):
        resolution_failed("unsupported action: %r" % action)
    if not PACKAGE_NAME.match(package or ""):
        resolution_failed("unsupported package name")
    if action == "REMOVE":
        if version:
            resolution_failed("remove must not carry a version")
        spec = package
    else:
        if version and not EXACT_VERSION.match(version):
            resolution_failed("only exact versions are supported")
        spec = "%s==%s" % (package, version) if version else package
    try:
        budget = int(budget_text)
    except ValueError:
        resolution_failed("invalid resolution budget: %r" % budget_text)
    if budget < 1:
        resolution_failed("invalid resolution budget: %d" % budget)

    check_supported_scope(scratch)

    # ONE deadline for the whole prepare: the add/remove run AND the installability
    # verification draw from it, so the helper's total stays within BUDGET (ruling R4).
    deadline = time.monotonic() + budget

    argv = UV_ARGV_PREFIX.copy()
    argv.insert(1, action.lower())
    argv.append(spec)
    code, output = run_uv(argv, scratch, deadline, "%s run" % action.lower())
    if code != 0:
        classify_resolution_failure(code, output)
    # The add/remove succeeded, but a universal lock can still resolve a distribution that
    # has no wheel for THIS platform (e.g. pywin32); the dry-run installability verification
    # in the same scratch fails such a request before any journal can exist (design 6.3).
    code, output = run_uv(VERIFY_ARGV, scratch, deadline, "installability verification")
    if code != 0:
        classify_resolution_failure(code, output)
    sys.exit(0)


if __name__ == "__main__":
    main(sys.argv)

"""Deterministic real-filesystem races at the snapshot enumeration/open boundary.

Run inside the runner image, UID 10001 and read-only root, with writable disposable
/source, /workspace and /outside mounts. The timing injection changes actual files;
enumeration, validation and copying all execute the image's production helper.
"""
import importlib.util
from pathlib import Path
import shutil

spec = importlib.util.spec_from_file_location("runner_check", "/opt/manao-python/python-check.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
enumerate_source = runner.source_files
failed = 0


def clean(root):
    for child in root.iterdir():
        if child.is_symlink() or not child.is_dir():
            child.unlink()
        else:
            shutil.rmtree(child)


for race in ("ancestor-symlink", "file-replacement"):
    for root in (Path("/source"), Path("/workspace"), Path("/outside")):
        clean(root)
    package = Path("/source/package")
    package.mkdir()
    package.joinpath("module.py").write_text("SAFE_PROJECT_SOURCE\n")
    Path("/outside/module.py").write_text("EXTERNAL_BYTES_MUST_NOT_BE_COPIED\n")

    def replace_after_enumeration(*args, **kwargs):
        entries = enumerate_source(*args, **kwargs)
        if race == "ancestor-symlink":
            package.rename("/source/original-package")
            package.symlink_to("/outside", target_is_directory=True)
        else:
            replacement = Path("/source/replacement.py")
            replacement.write_text("EXTERNAL_BYTES_MUST_NOT_BE_COPIED\n")
            replacement.replace(package / "module.py")
        return entries

    runner.source_files = replace_after_enumeration
    rejected = False
    try:
        runner.copy_source()
    except (OSError, ValueError):
        rejected = True
    leaked = any(b"EXTERNAL_BYTES_MUST_NOT_BE_COPIED" in path.read_bytes()
                 for path in Path("/workspace").rglob("*") if path.is_file())
    if rejected and not leaked:
        print(f"PASS: {race} rejected without external bytes")
    else:
        print(f"FAIL: {race}: rejected={rejected}, externalBytes={leaked}")
        failed += 1

raise SystemExit(1 if failed else 0)

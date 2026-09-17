"""Stage or package only the files needed to deploy Minimal Home."""

import argparse
import contextlib
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

try:
    from tools import make_ipk
except ModuleNotFoundError:  # Direct execution adds tools/, not the repository root.
    import make_ipk

ROOT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = (
    "launcher-app/appinfo.json",
    "launcher-app/config.json",
    "launcher-app/icon.png",
    "launcher-app/index.html",
    "launcher-service/config.json",
    "launcher-service/constants.js",
    "launcher-service/model.js",
    "launcher-service/storage.js",
    "launcher-service/json-stream.js",
    "launcher-service/package.json",
    "launcher-service/service.js",
    "launcher-service/services.json",
    "launcher-service/start-watcher.sh",
    "launcher-service/watcher.js",
)
RELEASE_FILES = RUNTIME_FILES + (
    "LICENSE",
    "docs/INSTALL.md",
    "tools/install.cmd",
    "tools/install.sh",
    "tools/make_ipk.py",
    "tools/merge_config.py",
)


def stage(destination, root=ROOT):
    """Copy the runtime allowlist into a fresh directory, excluding TV state."""
    for name in RUNTIME_FILES:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / name, target)


def add_release_entry(archive, root, name):
    data = (root / name).read_bytes()
    entry = tarfile.TarInfo(name)
    entry.size = len(data)
    entry.mode = 0o755 if name == "tools/install.sh" else 0o644
    archive.addfile(entry, io.BytesIO(data))


def package(destination, root=ROOT):
    """Normalize archive metadata so identical input bytes produce identical output."""
    with contextlib.ExitStack() as stack:
        raw = stack.enter_context(destination.open("wb"))
        compressed = stack.enter_context(
            gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0))
        archive = stack.enter_context(
            tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT))
        for name in sorted(RELEASE_FILES):
            add_release_entry(archive, root, name)
    write_checksum(destination)


def write_checksum(destination):
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_name(destination.name + ".sha256").write_text(
        "%s  %s\n" % (digest, destination.name), encoding="utf-8", newline="\n"
    )


def read_version():
    config = json.loads((ROOT / "launcher-app/config.json").read_text(encoding="utf-8"))
    version = config["version"]
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("version must be MAJOR.MINOR.PATCH")
    return version


def check_tag(tag, version):
    if tag is not None and tag != "v" + version:
        raise ValueError("tag %s does not match config version v%s" % (tag, version))


def stage_empty(directory):
    if directory.exists():
        if not directory.is_dir():
            raise ValueError("staging path must be a directory")
        if any(directory.iterdir()):
            raise ValueError("staging directory must be empty")
    stage(directory)
    print("Staged runtime files in %s" % directory)


def build_release(output_dir, version):
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / ("minimal-home-v%s.tar.gz" % version)
    package(destination)
    with tempfile.TemporaryDirectory() as temp:
        staged = Path(temp)
        stage(staged)
        ipk = output_dir / ("org.minimal.home_%s_all.ipk" % version)
        make_ipk.build(staged, ipk)
        write_checksum(ipk)
    print("Packaged %s and %s (SHA-256 sidecars written)" % (destination, ipk))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", type=Path, help="stage runtime files for the installer")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "dist")
    parser.add_argument("--tag", help="require a release tag matching the configured version")
    args = parser.parse_args(argv)
    try:
        version = read_version()
        check_tag(args.tag, version)
        subprocess.run([sys.executable, str(ROOT / "build_launcher.py"), "--check"],
                       cwd=ROOT, check=True, timeout=60)
        if args.stage:
            stage_empty(args.stage)
        else:
            build_release(args.output_dir, version)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        parser.exit(1, "error: %s\n" % exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())

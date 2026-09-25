"""Build a deterministic webOS IPK from an allowlisted staged runtime tree."""

import argparse
import gzip
import io
import json
from pathlib import Path
import re
import tarfile

APP_ID = "org.minimal.home"
SERVICE_ID = "org.minimal.home.service"


def validate_version(version):
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("version must be MAJOR.MINOR.PATCH")
    return version


def tar_gzip(entries):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, data, mode in sorted(entries):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = mode
            info.mtime = 0
            info.uid = 0
            info.gid = 0
            info.uname = "root"
            info.gname = "root"
            archive.addfile(info, io.BytesIO(data))
    compressed = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=compressed, mtime=0) as stream:
        stream.write(raw.getvalue())
    return compressed.getvalue()


def tree_entries(source, prefix):
    return [
        (prefix + "/" + path.relative_to(source).as_posix(), path.read_bytes(),
         0o755 if path.name == "start-watcher.sh" else 0o644)
        for path in source.rglob("*") if path.is_file()
    ]


def ar_member(name, data):
    header = "%-16s%-12d%-6d%-6d%-8o%-10d`\n" % (
        name + "/", 0, 0, 0, 0o100644, len(data)
    )
    result = header.encode("ascii") + data
    return result + (b"\n" if len(data) % 2 else b"")


def build(staged, destination):
    appinfo = json.loads((staged / "launcher-app/appinfo.json").read_text(encoding="utf-8"))
    version = validate_version(appinfo["version"])
    package_info = json.dumps({
        "id": APP_ID,
        "version": version,
        "app": APP_ID,
        "services": [SERVICE_ID],
    }, indent=2).encode() + b"\n"
    entries = tree_entries(staged / "launcher-app", "usr/palm/applications/" + APP_ID)
    entries += tree_entries(staged / "launcher-service", "usr/palm/services/" + SERVICE_ID)
    entries.append(("usr/palm/packages/%s/packageinfo.json" % APP_ID, package_info, 0o644))
    installed_size = sum(len(data) for _, data, _ in entries)
    control = (
        "Package: %s\nVersion: %s\nSection: misc\nPriority: optional\n"
        "Architecture: all\nInstalled-Size: %d\nMaintainer: Minimal Home contributors\n"
        "Description: Minimal Home launcher for rooted LG webOS TVs\n"
        "webOS-Package-Format-Version: 2\n" % (APP_ID, version, installed_size)
    ).encode()
    control_archive = tar_gzip([("control", control, 0o644)])
    data_archive = tar_gzip(entries)
    payload = b"!<arch>\n"
    payload += ar_member("debian-binary", b"2.0\n")
    payload += ar_member("control.tar.gz", control_archive)
    payload += ar_member("data.tar.gz", data_archive)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)
    return destination


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("staged", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args(argv)
    try:
        build(args.staged, args.output)
    except (OSError, ValueError, KeyError) as exc:
        parser.exit(1, "error: %s\n" % exc)
    print("Built %s" % args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

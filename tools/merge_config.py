"""Merge an installed TV configuration onto a new release configuration."""

import argparse
import json
from pathlib import Path
import re
import sys


ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _validate_header(header):
    if header is None:
        return
    if not isinstance(header, dict):
        raise ValueError("installed config header must contain an object")
    for key in ("text", "brand"):
        if key in header and not isinstance(header[key], str):
            raise ValueError("installed config header.%s must be a string" % key)


def _validate_ui(ui):
    if ui is None:
        return
    if not isinstance(ui, dict):
        raise ValueError("installed config ui must contain an object")
    for key in ("system", "appsPriority"):
        if key in ui and (not isinstance(ui[key], list) or
                          not all(isinstance(value, str) for value in ui[key])):
            raise ValueError("installed config ui.%s must be an array of strings" % key)
        if key in ui and not all(ID_RE.match(value) for value in ui[key]):
            raise ValueError("installed config ui.%s contains an invalid app id" % key)


def _validate_custom_config(config):
    if not isinstance(config, dict):
        raise ValueError("installed config must contain an object")
    _validate_header(config.get("header"))
    _validate_ui(config.get("ui"))


def _merge(new, installed, top_level=False):
    result = dict(new)
    for key, value in installed.items():
        # The manifest and visible build version belong to the new release.
        if top_level and key == "version":
            continue
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


def merge_configs(new, installed):
    if not isinstance(new, dict):
        raise ValueError("new config must contain an object")
    _validate_custom_config(installed)
    return _merge(new, installed, top_level=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("new", type=Path)
    parser.add_argument("installed", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args(argv)
    try:
        new = json.loads(args.new.read_text(encoding="utf-8"))
        installed = json.loads(args.installed.read_text(encoding="utf-8"))
        merged = merge_configs(new, installed)
        args.output.write_text(json.dumps(merged, indent=4) + "\n", encoding="utf-8", newline="\n")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, "error: cannot preserve installed config: %s\n" % exc)
    return 0


if __name__ == "__main__":
    sys.exit(main())

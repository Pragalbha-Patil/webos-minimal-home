"""Run the same offline checks locally and in CI; never connect to a TV."""

import argparse
import ast
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def run(command):
    print("+ " + " ".join(map(str, command)), flush=True)
    subprocess.run(command, cwd=ROOT, check=True, timeout=180)


def find_shell():
    if os.environ.get("SH"):
        return os.environ["SH"]
    shell = shutil.which("sh")
    if shell:
        return shell
    git = shutil.which("git")
    if git:
        shell = Path(git).resolve().parents[1] / "usr/bin/sh.exe"
        if shell.is_file():
            return str(shell)
    return None


class InlineScripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.scripts = []
        self.active = False

    def handle_starttag(self, tag, attrs):
        if tag == "script":
            attrs = dict(attrs)
            self.active = "src" not in attrs and attrs.get("type", "text/javascript") in (
                "text/javascript", "application/javascript"
            )
            if self.active:
                self.scripts.append("")

    def handle_data(self, data):
        if self.active:
            self.scripts[-1] += data

    def handle_endtag(self, tag):
        if tag == "script":
            self.active = False


def check_json(name, path, errors):
    try:
        json.loads(path.read_text(encoding="utf-8"))
    except ValueError as exc:
        errors.append("%s: %s" % (name, exc))


def check_python(name, path, errors):
    try:
        compile(path.read_bytes(), name, "exec")
    except SyntaxError as exc:
        errors.append("%s: %s" % (name, exc))


def check_shell(name, path, errors):
    if b"\r" in path.read_bytes():
        errors.append("%s: shell scripts must use LF line endings" % name)


def check_link(name, path, target, errors):
    target = target.strip()
    if target.startswith("<"):
        target = target.strip("<>")
    else:
        target = target.split(" ", 1)[0]
    url = urlsplit(target)
    if url.scheme or url.netloc or not url.path:
        return
    if not (path.parent / unquote(url.path)).exists():
        errors.append("%s: missing link target %s" % (name, target))


def check_markdown(name, path, errors):
    # Check inline file links, not remote URLs or heading fragments.
    body = re.sub(r"```.*?```", "", path.read_text(encoding="utf-8"), flags=re.S)
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", body):
        check_link(name, path, target, errors)


def check_source(name, errors):
    path = ROOT / name
    if not path.is_file():
        return
    if path.suffix == ".json":
        check_json(name, path, errors)
    elif path.suffix == ".py":
        check_python(name, path, errors)
    elif path.suffix == ".sh":
        check_shell(name, path, errors)
    elif path.suffix == ".md":
        check_markdown(name, path, errors)


def check_sources(paths):
    errors = []
    for name in paths:
        check_source(name, errors)
    if errors:
        raise ValueError("\n".join(errors))


NESTED_BLOCKS = (ast.If, ast.For, ast.While, ast.With, ast.Try)


def _is_elif(node, parent):
    return (isinstance(node, ast.If) and isinstance(parent, ast.If)
            and len(parent.orelse) == 1 and parent.orelse[0] is node)


def _walk_depth(node, parent, depth, violations, name):
    for child in ast.iter_child_nodes(node):
        nested = isinstance(child, NESTED_BLOCKS) and not _is_elif(child, node)
        child_depth = depth + (1 if nested else 0)
        if nested and child_depth > 2:
            violations.append("%s:%d: blocks nested too deeply" % (name, child.lineno))
        _walk_depth(child, node, child_depth, violations, name)


def check_python_depth():
    violations = []
    shipped = [ROOT / "build_launcher.py"] + sorted((ROOT / "tools").glob("*.py"))
    for path in shipped:
        tree = ast.parse(path.read_bytes(), str(path))
        _walk_depth(tree, None, 0, violations, path.name)
    if violations:
        raise ValueError("\n".join(violations))


def check_js_syntax(node, paths):
    for name in paths:
        if name.endswith(".js") and (ROOT / name).is_file():
            run([node, "--check", name])


def check_shell_syntax(paths, shell):
    for name in paths:
        if name.endswith(".sh") and (ROOT / name).is_file():
            run([shell, "-n", name])


def check_inline_script(node, temp, index, source):
    path = Path(temp) / ("inline-%d.js" % index)
    path.write_text(source, encoding="utf-8")
    run([node, "--check", str(path)])


def check_inline_scripts(node, scripts):
    with tempfile.TemporaryDirectory(prefix="minimal-home-check-") as temp:
        for index, source in enumerate(scripts):
            check_inline_script(node, temp, index, source)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-shell", action="store_true", help="fail if POSIX sh is unavailable")
    args = parser.parse_args(argv)
    try:
        node = shutil.which("node")
        if not node:
            raise ValueError("Node.js is required: runtime regression tests must not silently skip")
        if not (ROOT / "node_modules/eslint/bin/eslint.js").is_file():
            raise ValueError("Run npm ci --ignore-scripts to install host-only development tools")
        shell = find_shell()
        if not shell and args.require_shell:
            raise ValueError("POSIX sh is required; install Git Bash/WSL or set SH")
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=ROOT, check=True, capture_output=True,
        )
        paths = sorted(set(result.stdout.decode("utf-8").strip("\0").split("\0")))
        forbidden = [name for name in paths if name.startswith(("private/", "launcher-app/icons/")) or name in (
            "launcher-app/usage.json", "launcher-service/usage.json",
            "launcher-service/prefs.json", "launcher-service/.noredirect",
        )]
        if forbidden:
            raise ValueError("private/runtime files must not be tracked: " + ", ".join(forbidden))
        check_sources(paths)
        check_python_depth()
        run([sys.executable, "build_launcher.py", "--check"])
        run([node, "node_modules/eslint/bin/eslint.js", "launcher-app/src", "launcher-service", "tests/js"])
        run([node, "node_modules/prettier/bin/prettier.cjs", "--check",
             "launcher-app/src/*.js", "launcher-app/src/*.css", "launcher-service/*.js"])
        check_js_syntax(node, paths)
        scripts = InlineScripts()
        scripts.feed((ROOT / "launcher-app/index.html").read_text(encoding="utf-8"))
        if not scripts.scripts:
            raise ValueError("generated page has no inline JavaScript to check")
        with tempfile.TemporaryDirectory(prefix="minimal-home-check-") as temp:
            check_inline_scripts(node, scripts.scripts)
        if shell:
            check_shell_syntax(paths, shell)
        else:
            print("SKIP: shell syntax and installer tests need POSIX sh (required in Linux CI)")
        run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"])
        run(["git", "diff", "--check"])
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        parser.exit(1, "error: %s\n" % exc)
    print("All repository checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

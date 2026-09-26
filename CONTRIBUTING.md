# Contributing to Minimal Home

Contributions can be code, documentation, tests, accessibility improvements, or
device reports. You do not need a TV to improve the build tools or regression
suite. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before you start

Search [existing issues](https://github.com/Pragalbha-Patil/webos-minimal-home/issues)
for related work. Open a feature proposal before a large change so the scope and
device constraints can be discussed. Small fixes can go straight to a pull request.

Use the bug report form for reproducible problems. Include the TV model,
firmware/webOS version, installation method, expected behavior, and redacted
logs. Security vulnerabilities belong in the [private reporting process](SECURITY.md).

## Local setup

Install Git, Python 3.10+, and Node.js 22.22.2+ (22.x) or 24.15+ (24.x).
A POSIX shell is needed to test the installer; Git Bash or WSL works on Windows.
Install host-only lint, formatting, DOM, and coverage tools from the npm lockfile.
No pip packages are needed. The `webos-service` module belongs to the TV runtime
and is mocked locally. In PowerShell, use `npm.cmd` if script policy blocks `npm`.

```sh
git clone https://github.com/YOUR-USERNAME/webos-minimal-home.git
cd webos-minimal-home
git switch -c fix/describe-the-change
npm ci --ignore-scripts
python build_launcher.py
python tools/check.py
```

CI tests Python 3.10/Node 22 and Python 3.14/Node 24 on Linux, plus
Python 3.14/Node 24 on Windows. These are host-tool versions, not a claim about
the TV's Node version.

## Make a change

1. Find the source in the [architecture guide](docs/ARCHITECTURE.md).
2. Follow the [coding standards](docs/CODING_STANDARDS.md) and existing conventions
   in the file you touch.
3. For frontend changes, edit `launcher-app/src/`. Run `npm run format`, then
   `python build_launcher.py`. Commit generated files together with their sources.
   Shared validation changes in `launcher-service/model.js` also require a rebuild.
4. Add a regression test for a behavior change or bug fix. Keep fixtures synthetic;
   never include device credentials, private snapshots, or session logs.
5. Run `python tools/check.py` and review `git diff` and `git status --short`.
6. Open a focused pull request explaining the problem, resulting behavior, and
   validation. State which device checks you could or could not perform.

The check command verifies generated artifacts, ESLint, Prettier, Python/JavaScript
syntax, JSON, local Markdown file links, shell syntax when available, regression
tests, JavaScript coverage thresholds, and diff whitespace. Node and npm development
tools are mandatory so runtime tests cannot silently skip.
Use `python tools/check.py --require-shell` for the Linux CI gate. Set `SH` to a
POSIX shell executable if automatic detection fails.
The [full CI checklist](docs/TESTING.md#full-ci-checklist) also includes packaging
and Linux ShellCheck. POSIX sh and ShellCheck are separate prerequisites.

For a focused test while iterating:

```sh
npm test
npm run coverage
python -m unittest discover -s tests -p test_build_launcher.py -v
```

See [testing and coverage](docs/TESTING.md) for individual suites, report locations,
coverage scope, and the limits of desktop tests.

Do not hand-edit `launcher-app/index.html` or `launcher-service/config.json`.
The generator also owns the version in `launcher-app/appinfo.json`.
Use `launcher-app/config.json` for the source version.

## Review expectations

Keep unrelated refactors out of a bug fix. Explain webOS-specific workarounds
and preserve their regression coverage. Include screenshots for visible changes
when possible, and report actual validation rather than assumed compatibility.
You are responsible for understanding and verifying all submitted code,
including changes prepared with an AI assistant.

Commit messages should describe the result, for example
`installer: report failed Luna launch requests`. No special commit signing,
DCO, or title format is required by the tooling in this repository.

## Device testing

Use the [installation guide](docs/INSTALL.md). For changes involving launch or
navigation, exercise cold launch, return from another app, D-pad/OK/Back,
input switching, and the LG Home bypass. For preferences, check persistence
after relaunch. For watcher changes, check recovery after a Luna subscription
disconnect and ensure only one watcher is running.

Report the model and firmware tested. Local VM tests use mocked platform APIs;
they cannot replace on-device checks.

## Releases

Maintainers should follow [RELEASING.md](docs/RELEASING.md). Contributors do not
need to bump the version for every patch.

## Guide design

This guide uses the clear setup, change, and review structure found in
[Node.js's contribution guide](https://github.com/nodejs/node/blob/main/CONTRIBUTING.md)
and [GitHub Docs' contribution guide](https://github.com/github/docs/blob/main/.github/CONTRIBUTING.md).

## Pull request scope

Keep each pull request focused on one behavior or documentation improvement. Include a regression test when changing runtime behavior.

Project-specific requirements here are intentionally small.

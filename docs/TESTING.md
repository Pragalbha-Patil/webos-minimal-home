# Testing and coverage

## Setup and commands

Use Python 3.10+ and Node.js 22.22.2+ (22.x) or 24.15+ (24.x). Install the
host-only JavaScript tools with `npm ci --ignore-scripts`. The lockfile fixes
dependency versions; none of these packages are shipped to the TV. PowerShell
users can invoke `npm.cmd` if their script policy blocks `npm`.

```sh
npm run format
python build_launcher.py
python tools/check.py --require-shell
```

The shared check runs ESLint, Prettier, generated-output checks, syntax/link
checks, Python regressions, and JavaScript tests with coverage. CI runs this
same command on Linux and Windows. Omit `--require-shell` locally if POSIX sh
is unavailable; installer regressions then skip explicitly.

For faster iteration:

```sh
npm run lint
npm test
npm run coverage
node --test tests/js/service.test.cjs
python -m unittest discover -s tests -p test_build_launcher.py -v
```

## Full CI checklist

Formatting and generation above **write files**. The checks below do not change
tracked sources, although coverage/package checks create local `dist/` output.

| Gate | Local command | Requirements / CI hosts |
| --- | --- | --- |
| Shared validation | `python tools/check.py --require-shell` | Python, supported Node, npm dev tools, POSIX sh; Linux and Windows |
| Runtime packaging | `python tools/package.py` | Python, Git checkout and current generated output; creates source archive and IPK |
| Installer shell lint | `shellcheck tools/install.sh` | ShellCheck executable; Linux CI only |

`--require-shell` requires **POSIX sh**, not ShellCheck. It enables `sh -n`
syntax checks and installer tests; it does not run the separate ShellCheck gate.
Install ShellCheck separately and use Linux/WSL to reproduce that gate when it
is not available on your native host. A green shared checker alone does not
establish that every workflow step passed. See `.github/workflows/ci.yml` for
the authoritative matrix and `.github/workflows/release.yml` for release gates.

## Coverage contract

[c8](https://github.com/bcoe/c8) collects
[V8 coverage](https://nodejs.org/api/cli.html#node_v8_coveragedir) for every
JavaScript source in `launcher-app/src/` and `launcher-service/`, including files
not loaded by tests. `.c8rc.json` enforces these minimums **for each file**:

| Metric | Minimum |
| --- | --- |
| Lines | 100% |
| Statements | 100% |
| Functions | 100% |
| Branches | 85% |

The HTML report is written to `dist/coverage/index.html`; machine-readable totals
are in `dist/coverage/coverage-summary.json`. These are local build artifacts.
The generated page embeds the same frontend/shared sources and is not counted
again. HTML, CSS, Python tooling, platform-provided modules, and development
dependencies are outside this JavaScript coverage measurement.

Do not suppress runtime files or add ignore comments to make the numbers pass.
Add behavior-level tests for uncovered paths. Full line coverage does not imply
all branch combinations or device behavior are tested; inspect the branch report
when modifying conditional logic.

## Test boundaries

| Suite | Exercises |
| --- | --- |
| `tests/js/frontend.test.cjs` | Complete frontend in jsdom: remote input, focus, overlays, search, preferences, rendering, request races, and fallbacks |
| `tests/js/service.test.cjs` | Registered Luna methods, validation, timeouts, launch parameters, atomic preferences, recency, bypass, and stats |
| `tests/js/watcher.test.cjs` | Foreground events, reconnects, cooldown/retry timers, icon copying, and metric sampling |
| `tests/js/model.test.cjs` | Shared schemas, sorting, bounded stream parsing, atomic writes, and logging |
| `tests/js/runtime.test.cjs` | Runtime loading and API smoke checks |
| `tests/test_*.py` | Generator/configuration contracts, Python/JavaScript input parity, date formatting, packaging, and installer behavior |

`tests/js/helpers.cjs` isolates files, clocks, child processes, Luna calls, and DOM
state for each test. The full suite runs without test-process isolation so host
sandbox process restrictions do not prevent coverage collection. Individual
scripts and DOMs still get fresh environments and are cleaned up after each test.
The runner uses `--experimental-test-isolation=none`, the spelling supported by
both Node 22 and 24; the unprefixed flag is unavailable on Node 22.

No local test contacts a TV. Desktop tests cannot verify Luna authorization,
service jailing, the TV's browser/Node compatibility, real input switching,
remote key delivery, layout, or actual CPU/memory overhead. Use the
[device checklist](../CONTRIBUTING.md#device-testing) and report the model and

## Focused local checks

Run `npm test -- --runInBand`, `python -m unittest discover -s tests`, and `python tools/check.py` before submitting changes.

firmware tested when validating those behaviors.

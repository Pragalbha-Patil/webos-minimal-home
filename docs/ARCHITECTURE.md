# Architecture

## Build and runtime boundaries

`build_launcher.py` runs on the contributor's computer. It reads
`launcher-app/config.json` and renders a loading state. Apps, inputs, and system
app tiles appear only after the TV returns live launch points. Failed discovery retries a bounded number
of times before showing a Retry control. LG Home remains a launcher-provided bypass
action after discovery. Refresh failures preserve the last successfully fetched
tiles. The TV does not run Python to start the launcher.

The web app (`org.minimal.home`) runs in a webOS webview. It calls the Node relay
(`org.minimal.home.service`) over Luna for live tiles, launches, preferences,
the LG Home bypass, and system statistics. The root watcher is a separate,
long-running process: it subscribes to foreground changes, launches Minimal Home
when stock Home appears, provisions icons, and samples system statistics.

## Sources and generated files

| Source | Output or consumer |
| --- | --- |
| `launcher-app/src/` + `launcher-service/model.js` | Self-contained `launcher-app/index.html`, assembled by `build_launcher.py` |
| `launcher-app/config.json` | Generated `launcher-service/config.json` |
| Config version | `appinfo.json` version and embedded build string |
| `launcher-app/tiles.json` | Sample tiles for explicit `--preview` builds only |
| Explicit `--preview --usage PATH` | Optional personal preview ordering |
| `launcher-service/constants.js` | Shared service/watcher IDs and paths |

The generated page and service config are committed. The manifest is maintained
directly except for its generated version. `python build_launcher.py --check`
reports drift without writing files. Default builds read neither sample tiles nor
local usage snapshots. Use
`python build_launcher.py --preview` for a desktop sample, and restore the default
build with `python build_launcher.py` before committing or packaging.

## Runtime responsibilities

| Component | Responsibilities |
| --- | --- |
| Frontend | Rendering, focus, search, menus, refresh, and Luna requests |
| `service.js` | `getTiles`, `launchApp`, `openLGHome`, `getPrefs`, `setPrefs`, `getSystemStats` (see the [Luna reference](LUNA.md)) |
| `watcher.js` | Foreground subscription/reconnects, redirect retries, icon copies, stats sampling |
| `constants.js` | App/service IDs, install locations, state and log paths |
| `model.js` | Pure validation, preferences, input classification, launch parameters, and sorting; shared with the frontend |
| `storage.js` | Safe JSON reads, atomic state replacement, and bounded logs |
| `json-stream.js` | Incremental, bounded parsing of chunked Luna subscription output |

Home detection is event-driven. Other watcher work is periodic: icons refresh
every five minutes and system statistics are sampled every five seconds when
enabled. The watcher is not a zero-work idle process. Repeated Home notifications
retain a redirect cooldown, but a confirmed transition to another app clears it
so the next return to Home redirects immediately. Failed launches retain bounded
backoff. Reconnections discard stale stream data and timers. Icons are size-checked
before reading and identical bytes are not rewritten. Invalid large icons fall
back to ordinary icons; transient source errors preserve last-known-good bytes.
Cache pruning runs only after confirmed successful discovery, preserving the
special Settings icon and unrelated files. Luna requests have deadlines
and completion guards; the frontend retains only pending requests. Unchanged live
tile results preserve existing DOM nodes, icon fallbacks, and focus rather than
rebuilding the rows. Failed icon slots retry once per discovery refresh; successful
images and focus are preserved. No icon-only polling loop is added. The normal startup/foreground request uses the preferences
bundled with `getTiles`, applying them before rendering; `getPrefs` is a
compatibility fallback for responses without preferences. Responses requested
before or during a local preference save cannot replace the local edits.
Each discovery request rereads the service-local `config.json`. Its response
includes the current system-row IDs and Settings action as well as the greeting,
so TV config edits apply at startup or foreground refresh without rebuilding.
Older relay responses without config retain the frontend's embedded defaults.

The frontend clock schedules one update at the next minute boundary, or second
boundary for formats showing seconds. It stops while backgrounded, updates on
foreground return, and leaves unchanged clock markup intact.

## Persistence

The service directory stores `usage.json`, `prefs.json`, and `.noredirect`.
Usage is a relative launch sequence, renumbered and capped at 60 entries, used
for **recency**, not launch frequency. Pinned/hidden preferences are bounded.
The saved header brand is bounded to 40 characters; a separate completion marker
prevents the default-brand first-run dialog from returning after updates.
JSON state writes use a temporary file and rename; failed writes preserve the
previous file. Preference updates are serialized in the frontend so rapid edits
cannot arrive at the service out of order.
The bypass stores an expiry timestamp for ten minutes.

The installer downloads and validates the service-local `config.json` before an
update, merges its custom values over the new schema while retaining the new build
version, and places only the merged result in its allowlisted IPK. Unshipped
preferences, usage, bypass, and icon files remain in place.

The watcher writes icons inside the app's `icons/` directory and a temporary
statistics sample at `/tmp/minhome-stats.json`. Logs are
`/tmp/minhome-svc.log` and `/tmp/minhome-watch.log`. Files under `/tmp` are
ephemeral across reboot. Deployment excludes all of this device state.

## webOS constraints

These constraints come from project device observations, including webOS
10.3.1. Treat them as evidence for that environment, not universal platform guarantees.

- A file-based webview cannot load arbitrary absolute icon paths. The root
  watcher copies icons into the app, and the relay returns relative paths.
- The dev-mode service jailer cannot reliably read files in the app directory.
  The generated service-local config is intentional.
- Background webviews can be purged after a short delay. Refresh on foreground
  return and webOS relaunch events; do not assume in-memory state survived another
  app.
- On webOS 10.3.1, a focused foreground webview can still report
  `document.hidden === true`. Background work checks also use `document.hasFocus()`
  so this stale visibility flag does not prevent live tiles or statistics.
- `disableBackHistoryAPI: true` lets the app handle Back rather than delegating
  it to a platform exit/history dialog.
- The physical Exit button is handled by the platform without delivering an app
  event, according to [LG support](https://forum.webostv.developer.lge.com/t/lgtv-remote-controller-exit-button-behavior/9272).
  The frontend cannot cancel it. Recovery depends on the root watcher seeing stock
  Home become foreground; the intentional LG Home bypass still takes precedence.
- Input tiles come from launch points and bookmark metadata. Preserve
  `PhysicalAddress`/`value` and other allowed per-port parameters, while
  preventing bookmark `params.id` from replacing the target app ID.
- The foreground subscription uses
  `com.webos.applicationManager/getForegroundAppInfo`, not `getForegroundApp`.
- The installer uses `luna-send-pub` for developer IPK installation. Some root
  SSH sessions lack Luna preload variables, so final launch reuses the running
  Minimal Home watcher's bounded environment when available.
- The jailed relay must create runtime state beside its service files. The
  installer gives that directory shared-write permissions (package installs
  leave state root-owned while the relay runs under a dynamic service user),
  preserving atomic preference and bypass writes.
- Changed files do not necessarily replace already-running webview, relay, or
  watcher processes. See [installation](INSTALL.md) for verification.

The input classifier exists in Python and JavaScript because both the optional
desktop preview and live tiles need it. Keep their behavior aligned through regression
tests when changing classification.

## Test boundary

Python unit tests cover configuration, rendering, and packaging. Node VM harnesses
execute the relay, watcher, and shared modules with mocked platform APIs. jsdom
runs the complete frontend script against its HTML template with keyboard,
focus, visibility, and service events. The [testing guide](TESTING.md) describes
the enforced coverage gates. These checks need neither root nor a TV. Desktop preview
cannot verify Luna authorization, service jailing, input switching, or remote
key delivery; those need device evidence.

## Change boundaries

Build-time validation belongs in `build_launcher.py` and `tools/check.py`; runtime validation belongs in `launcher-service/model.js` and service entry points.

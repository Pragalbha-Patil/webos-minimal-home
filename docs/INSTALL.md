# Installation and recovery

Minimal Home requires an already rooted LG webOS TV with SSH access. It does not
include a root exploit. The [webOS Homebrew project](https://www.webosbrew.org)
provides information about rooting and the Homebrew environment.

## What the installer does

`tools/install.sh` performs a complete first install or update. It builds an
allowlisted `.ipk`, asks webOS's developer install service to install and register
the app and Node relay, installs an idempotent watcher hook under
`/var/lib/webosbrew/init.d/`, applies Homebrew service elevation, starts the
watcher, restarts any already-running Minimal Home relay, and launches a fresh
Minimal Home webview.

The package manifest requests the application-manager permissions used by the
relay. IPK installation creates the base Luna registration, then Homebrew's
`elevate-service` supplies legacy TV permissions that manifests do not install
consistently. The installer does not write version-specific Luna files by hand.

On the TV, check the relay:

```sh
luna-send -n 1 luna://org.minimal.home.service/getTiles '{}'
```

After installation this should return `returnValue: true`. A missing-service or
denied-method response is a registration/permissions problem, not a reason to
broaden all app permissions.

## Upload from a source checkout

Build on your computer with Python 3.10+. On Windows run these from the
repository root in Git Bash, WSL, or Command Prompt (`tools\install.cmd`
finds a POSIX shell for you); elsewhere use any POSIX shell with SSH/SCP
installed. One command does everything — pass your TV's SSH alias, hostname,
or IPv4 address (use an alias for IPv6) directly:

```sh
sh tools/install.sh mytv
```

On Windows Command Prompt instead:

```bat
tools\install.cmd mytv
```

`TV_HOST=mytv` also works in place of the argument, and an interactive shell
asks for the address when neither is given. A normal run first repeats the
read-only prerequisite check below, then builds, checks generated-file
freshness, stages the runtime allowlist, preserves the
installed configuration and runtime state, builds and uploads an IPK, installs
it, replaces only the Minimal Home watcher and relay processes, and requests a
fresh launch. To verify prerequisites without changing anything:

```sh
sh tools/install.sh mytv --check
```
SSH/SCP failures and unsuccessful Luna launch replies produce a nonzero exit.
The service directory receives shared-write permissions (like Homebrew's own
service directory) so the jailed relay can atomically maintain preferences and
its temporary Home-bypass marker even though package installs leave runtime
state root-owned while the relay runs under a dynamic service user. If relay
writes ever fail with permission errors, rerunning the installer repairs them.
The installer uses the public Luna client for IPK installation. On rooted builds
whose SSH sessions omit Luna preload variables, it reuses the running Minimal Home
watcher's environment for final launch.

| Variable/option | Purpose |
| --- | --- |
| `TV_HOST` | SSH alias, hostname, or IPv4 address; use an alias for IPv6. Set as `TV_HOST=mytv` or pass as the first argument (`sh tools/install.sh mytv`, which wins) |
| `TV_USER` | SSH user, default `root` |
| `PYTHON` | Python executable, default `python`; set `python3` if needed |
| `--check` | Check remote first-install prerequisites without modifying them (a normal run checks automatically) |
| `--no-build` | Skip generation; still require up-to-date generated files |

App and service IDs are fixed in manifests and code. Environment overrides to
different IDs are rejected. The helper can run from any current directory.
It preserves TV preferences, usage history, and icons by packaging only shipped
files and backing up runtime state to `/tmp` during the package transaction. If a
service-local `config.json` exists, the helper reads and validates it
before uploading anything, then merges its custom values onto the new schema.
New fields and the release version are retained automatically. A malformed existing
config stops the update before TV files change. The helper replaces its own boot
hook and restarts only its own watcher and relay so updated code and permissions
take effect.

## Upload a release archive

Releases contain both an installable IPK and a source archive with the complete
installer. On your computer, extract `minimal-home-vVERSION.tar.gz` into an empty
directory. If a checksum file was downloaded alongside either artifact, verify it
before extraction. The verification and extraction are chained so a mismatch
stops the recipe; do not continue after a failed verification:

```sh
sha256sum -c minimal-home-vVERSION.tar.gz.sha256 &&
    tar -xzf minimal-home-vVERSION.tar.gz
```

In the extracted directory, replace `mytv` with your SSH alias and run the bundled
installer. It provides the same automatic configuration preservation as a source
checkout:

```sh
sh tools/install.sh mytv
```

The archive contains only allowlisted files, not personal runtime state. Its
installer builds the same IPK locally after merging any installed configuration.

You may instead install the release IPK directly with webOS Dev Manager or the
official CLI:

```sh
ares-install --device mytv org.minimal.home_VERSION_all.ipk
```

Direct IPK installation registers the app and relay, but does not install or start
the root watcher. Run the bundled installer for Home-button redirection, icon
provisioning, and system statistics.

## Watcher startup

The full installer adds `/var/lib/webosbrew/init.d/50-minimal-home` and starts it
immediately. The hook is idempotent, so it will not create duplicate watcher
processes. To start it manually:

```sh
/var/lib/webosbrew/init.d/50-minimal-home
```

## Updating and verifying

The installer restarts its watcher and any already-running relay. The
install/launch sequence refreshes the app. Broad platform restarts
can interrupt other apps and are not performed.

Verify app launch, return from another app, D-pad/OK/Back, preferences after
relaunch, input switching, and the ten-minute LG Home bypass. Confirm the
watcher is running only once. Icon provisioning starts immediately and repeats
every five minutes. The installer briefly waits for that first pass before launch.

## Dry-run path check

Use `./tools/install.sh --check` to validate configured TV paths without building or uploading files.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Relay missing or Luna denied | App/service registration and client permissions |
| Uploaded UI looks unchanged | Running webview may still contain old code |
| Header/config missing | Deploy both app and generated service config |
| Blank/missing icons | Root watcher running; icons copied into the app's directory |
| Home button still opens LG Home | Watcher subscription and bypass expiry |
| Input opens to a black screen | Live launch-point parameters and input regression tests |
| System stats unavailable | Watcher running, stats enabled, and readable device counters |

Service logs are at `/tmp/minhome-svc.log`; watcher logs are at
`/tmp/minhome-watch.log`. They disappear on reboot. Redact identifying information
before sharing logs. A browser-only preview cannot validate these platform behaviors.
The [Luna reference](LUNA.md) documents every relay method, the persisted
preferences, and live diagnostic queries.

## Return to stock Home

Use the LG Home tile after successful discovery. If the grid never loads or the
UI is unusable, but the relay is registered and can launch Home, this
**state-changing command on the TV** requests the same temporary bypass:

```sh
luna-send -n 1 luna://org.minimal.home.service/openLGHome '{}'
```

Require `returnValue: true`. A failed Home launch removes the bypass marker and
reports an error. If the relay is missing or denied, do not widen permissions;
use the targeted watcher/boot-hook recovery below.

The bypass stores a wall-clock expiry for ten minutes. It suppresses redirects,
not a timer that forcibly switches the screen at expiry. A later relevant
foreground event can resume redirection. Restarting only the webview does not
cancel the persisted bypass. Stopping the watcher suppresses redirects until
it is started again; disabling its boot hook also prevents startup on reboot.

For a lasting rollback, disable
the watcher boot hook you installed and stop its specific process, then launch
stock Home:

```sh
luna-send -n 1 luna://com.webos.applicationManager/launch '{"id":"com.webos.app.home"}'
```

Once stock Home works, remove Minimal Home app/service registrations using the
same mechanism that created them. Keep a backup of preferences if needed before
removing the app/service directories. Do not delete unrelated LS2 registrations.

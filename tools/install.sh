#!/usr/bin/env sh
# Package and install Minimal Home on a rooted webOS TV over SSH.
set -eu

fail() {
    echo "error: $*" >&2
    exit 1
}

DO_BUILD=1
MODE=deploy
TV_HOST=${TV_HOST:-}
HOST_FROM_ARG=
for arg in "$@"; do
    case "$arg" in
        --check) MODE=check ;;
        --no-build) DO_BUILD=0 ;;
        --help|-h)
            echo "usage: sh tools/install.sh [TV_HOST] [--check] [--no-build]"
            echo "   or: TV_HOST=mytv sh tools/install.sh [--check] [--no-build]"
            echo "env: TV_HOST (SSH alias or hostname), TV_USER (default root), PYTHON (default python)"
            echo "A host argument overrides TV_HOST. Without a host, an interactive"
            echo "shell is asked for one. A normal run checks prerequisites first,"
            echo "then builds and installs the app/service IPK, preserves config,"
            echo "installs the watcher hook, and launches."
            exit 0
            ;;
        -*) fail "unknown option: $arg" ;;
        *)
            if [ -n "$HOST_FROM_ARG" ]; then
                fail "unexpected extra argument: $arg"
            fi
            TV_HOST=$arg
            HOST_FROM_ARG=1
            ;;
    esac
done

TV_USER=${TV_USER:-root}
TV_HOST=${TV_HOST:-}
PYTHON=${PYTHON:-python}
if [ -z "$TV_HOST" ]; then
    if [ -t 0 ]; then
        printf 'TV address (SSH alias, hostname, or IPv4 address): '
        read -r TV_HOST || fail "no TV address given"
    else
        fail "set TV_HOST to an SSH alias, hostname, or IPv4 address, or pass it: sh tools/install.sh mytv"
    fi
fi
case "$TV_HOST" in
    ''|-*|*[!a-zA-Z0-9._-]*) fail "set TV_HOST to an SSH alias, hostname, or IPv4 address (use an alias for IPv6)" ;;
esac
case "$TV_USER" in
    ''|-*|*[!a-zA-Z0-9_-]*) fail "invalid TV_USER" ;;
esac
# IDs are embedded in the manifests, generated frontend, and runtime constants.
[ "${APP_ID:-org.minimal.home}" = org.minimal.home ] || fail "APP_ID overrides are unsupported"
[ "${SVC_ID:-org.minimal.home.service}" = org.minimal.home.service ] || fail "SVC_ID overrides are unsupported"
APP_DIR=/media/developer/apps/usr/palm/applications/org.minimal.home
SVC_DIR=/media/developer/apps/usr/palm/services/org.minimal.home.service
ELEVATE=/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service
REMOTE=${TV_USER}@${TV_HOST}

command -v ssh >/dev/null 2>&1 || fail "ssh is required"
if [ "$MODE" = check ]; then
    echo "Checking install prerequisites on $TV_HOST"
    # shellcheck disable=SC2029
    ssh "$REMOTE" "test \"\$(id -u)\" = 0 && command -v luna-send-pub >/dev/null && command -v node >/dev/null && command -v setsid >/dev/null && test -x '$ELEVATE'"
    echo "Root SSH, Luna installer access, Node.js, and Homebrew service elevation are available."
    exit 0
fi
# A normal run repeats the read-only prerequisite check before changing
# anything, so a separate --check invocation is optional.
echo "Checking install prerequisites on $TV_HOST"
# shellcheck disable=SC2029
ssh "$REMOTE" "test \"\$(id -u)\" = 0 && command -v luna-send-pub >/dev/null && command -v node >/dev/null && command -v setsid >/dev/null && test -x '$ELEVATE'" \
    || fail "prerequisite check failed on $TV_HOST (need root SSH, Luna installer access, Node.js, and Homebrew service elevation)"
command -v scp >/dev/null 2>&1 || fail "scp is required"
command -v "$PYTHON" >/dev/null 2>&1 || fail "Python is required; set PYTHON to its executable"
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR/.."
if [ "$DO_BUILD" -eq 1 ] && [ -f build_launcher.py ]; then
    "$PYTHON" build_launcher.py
fi

STAGE_DIR=$(mktemp -d)
trap 'rm -rf -- "$STAGE_DIR"' EXIT
trap 'exit 1' HUP INT TERM
if [ -f build_launcher.py ]; then
    # package.py verifies generated output even with --no-build. Stage only
    # shipped files so local state or credentials never overwrite TV state.
    "$PYTHON" tools/package.py --stage "$STAGE_DIR"
else
    # Release archives already contain only the deployment allowlist.
    if [ ! -f launcher-app/appinfo.json ] || [ ! -f launcher-service/config.json ]; then
        fail "run the bundled installer from the extracted release directory"
    fi
    cp -R launcher-app launcher-service "$STAGE_DIR/"
fi

MAKE_IPK=$SCRIPT_DIR/make_ipk.py
[ -f "$MAKE_IPK" ] || fail "tools/make_ipk.py is missing"

# Fetch the installed config before changing any TV files. An empty result means
# this is a first install. A malformed config aborts before upload; otherwise its
# custom values are merged over the new schema while the release version wins.
FETCHED_CONFIG=$STAGE_DIR/config.fetched
INSTALLED_CONFIG=$STAGE_DIR/config.installed.json
MERGED_CONFIG=$STAGE_DIR/config.merged.json
# Paths are fixed local constants; expand them before sending the command.
# shellcheck disable=SC2029
ssh "$REMOTE" "if test -f '$SVC_DIR/config.json'; then printf '%s\\n' MINIMAL_HOME_CONFIG_PRESENT; cat '$SVC_DIR/config.json'; fi" > "$FETCHED_CONFIG"
if [ -s "$FETCHED_CONFIG" ]; then
    [ "$(sed -n '1p' "$FETCHED_CONFIG")" = MINIMAL_HOME_CONFIG_PRESENT ] ||
        fail "unexpected response while reading installed config"
    sed '1d' "$FETCHED_CONFIG" > "$INSTALLED_CONFIG"
    "$PYTHON" tools/merge_config.py \
        "$STAGE_DIR/launcher-service/config.json" "$INSTALLED_CONFIG" "$MERGED_CONFIG"
    cp "$MERGED_CONFIG" "$STAGE_DIR/launcher-service/config.json"
    echo "Preserved installed Minimal Home configuration."
fi
IPK=$STAGE_DIR/org.minimal.home.ipk
"$PYTHON" "$MAKE_IPK" "$STAGE_DIR" "$IPK"
REMOTE_IPK=/tmp/org.minimal.home.ipk
REMOTE_STATE=/tmp/org.minimal.home-install-state
# App installation may replace whole package-owned directories. Save bounded
# runtime state outside them and restore it after the package transaction.
# shellcheck disable=SC2029
ssh "$REMOTE" "rm -rf '$REMOTE_STATE'; mkdir -p '$REMOTE_STATE/service' '$REMOTE_STATE/app'; for name in usage.json prefs.json .noredirect; do if test -f '$SVC_DIR/'\"\$name\"; then cp -p '$SVC_DIR/'\"\$name\" '$REMOTE_STATE/service/'; fi; done; if test -d '$APP_DIR/icons'; then cp -Rp '$APP_DIR/icons' '$REMOTE_STATE/app/'; fi"
scp "$IPK" "$REMOTE:$REMOTE_IPK"

# An open webview can start the freshly installed relay before Homebrew has
# applied its Luna permissions, leaving that process with the old identity.
# Close our app before the package transaction; absence is harmless on a first
# install and a fresh webview is launched after elevation below.
# shellcheck disable=SC2029
ssh "$REMOTE" "luna-send-pub -n 1 luna://com.webos.applicationManager/close '{\"id\":\"org.minimal.home\"}' >/dev/null 2>&1 || true"

echo "Installing Minimal Home app and service"
# The install API streams progress. awk exits successfully only after the
# terminal installed state, and fails on an explicit rejection or timeout.
# Slow TVs need up to ten minutes from verification to installation; the
# stream stays open after that, so awk leaves as soon as it sees the state.
# shellcheck disable=SC2029
INSTALL_RESPONSE=$(ssh "$REMOTE" "luna-send-pub -w 600000 -i 'luna://com.webos.appInstallService/dev/install' '{\"id\":\"com.ares.defaultName\",\"ipkUrl\":\"$REMOTE_IPK\",\"subscribe\":true}' | awk '/\"state\"[[:space:]]*:[[:space:]]*\"installed\"/{print; ok=1; exit} /\"returnValue\"[[:space:]]*:[[:space:]]*false|\"state\"[[:space:]]*:[[:space:]]*\"[^\"]*failed[^\"]*\"/{print; exit 1} END {if (!ok) exit 1}'")
printf '%s\n' "$INSTALL_RESPONSE"

echo "Applying Homebrew Luna permissions to the relay"
# Homebrew elevation supplies the legacy TV permissions that app manifests alone
# do not install consistently. It also refreshes Luna's service configuration.
# shellcheck disable=SC2029
ssh "$REMOTE" "'$ELEVATE' org.minimal.home.service"

# elevate-service rescans Luna metadata but does not stop an already-running
# relay. Terminate only this exact service process so the post-install launch
# starts it with the refreshed permissions.
# shellcheck disable=SC2029
ssh "$REMOTE" "relay=\$(ps -eo pid,args | awk '\$2 == \"org.minimal.home.service\" {print \$1; exit}'); if test -n \"\$relay\"; then kill \"\$relay\"; fi"

echo "Installing and starting the watcher boot hook"
# Stop only the old Minimal Home watcher so updated code is loaded, then install
# the packaged idempotent hook and run it once for the current boot.
# The service directory stays world-writable (like Homebrew's own service):
# package installs leave runtime state root-owned while the relay runs under a
# dynamic service user, so only a permission without sticky semantics keeps the
# relay's atomic preference writes working after every install.
# shellcheck disable=SC2029
ssh "$REMOTE" "chmod 0777 '$SVC_DIR'; for name in usage.json prefs.json .noredirect; do source='$REMOTE_STATE/service/'\"\$name\"; target='$SVC_DIR/'\"\$name\"; if test -f \"\$source\"; then cp -p \"\$source\" \"\$target\" || cmp -s \"\$source\" \"\$target\"; fi; done; if test -d '$REMOTE_STATE/app/icons'; then mkdir -p '$APP_DIR/icons'; cp -Rp '$REMOTE_STATE/app/icons/.' '$APP_DIR/icons/'; fi; rm -rf '$REMOTE_STATE'; rm -f '$REMOTE_IPK'; mkdir -p /var/lib/webosbrew/init.d; cp '$SVC_DIR/start-watcher.sh' /var/lib/webosbrew/init.d/50-minimal-home; chmod 755 /var/lib/webosbrew/init.d/50-minimal-home; watcher=\$(ps -eo pid,args | awk '\$2 == \"node\" && \$3 == \"$SVC_DIR/watcher.js\" {print \$1; exit}'); if test -n \"\$watcher\"; then kill \"\$watcher\"; fi; /var/lib/webosbrew/init.d/50-minimal-home; count=0; while test \"\$count\" -lt 20 && ! test -s '$APP_DIR/icons/com.palm.app.settings.png'; do sleep 1; count=\$((count + 1)); done"

echo "Requesting launch of Minimal Home"
# Root SSH lacks Luna preload variables on some TVs. Reuse the environment of
# the watcher we just confirmed or started, with the public client as fallback.
# shellcheck disable=SC2029
RESPONSE=$(ssh "$REMOTE" "watcher=\$(ps -eo pid,args | awk '\$2 == \"node\" && \$3 == \"$SVC_DIR/watcher.js\" {print \$1; exit}'); if test -n \"\$watcher\" && test -r \"/proc/\$watcher/environ\"; then xargs -0 env < \"/proc/\$watcher/environ\" luna-send -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"org.minimal.home\"}'; else luna-send-pub -n 1 luna://com.webos.applicationManager/launch '{\"id\":\"org.minimal.home\"}'; fi")
printf '%s\n' "$RESPONSE"
printf '%s\n' "$RESPONSE" | "$PYTHON" -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("returnValue") is True else 1)'
echo "Minimal Home app, service, and watcher installed successfully."

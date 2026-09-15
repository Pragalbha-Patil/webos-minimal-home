"""Assemble the Minimal Home frontend sources and optional preview tiles.

Run `python build_launcher.py` to regenerate the page, manifest version, and service config.
Use `--check` to verify tracked outputs are up to date (CI gate).
"""
import argparse
import copy
import json
import os
import re
import sys
import html as htmllib

BASE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.join(BASE, "launcher-app")
SVC_DIR = os.path.join(BASE, "launcher-service")
SELF = "org.minimal.home"
SETTINGS_ID = "com.palm.app.settings"
SETTINGS_ICON = "icons/com.palm.app.settings.png"
LG_HOME_ID = "__LGHOME__"

DEFAULTS = {
    "version": "1.0.0",
    "header": {"text": "Welcome", "brand": "Minimal Home"},
    "ui": {
        "system": [
            "com.webos.app.discovery",
            "com.webos.app.mediadiscovery",
            SETTINGS_ID,
        ],
        "appsPriority": [
            "youtube.leanback.v4", "netflix", "amazon", "hotstar",
            "com.zee5.app", "com.apple.appletv", "io.strem.tv",
            "org.mariotaku.ihsplay", "org.litefin.app",
        ],
    },
}

# Input ports are NOT hardcoded per device: the TV publishes a launch point
# for every connected input (bookmarks like com.webos.app.hdmi2 carry the
# per-port PhysicalAddress/value params) plus the built-in com.webos.app.livetv.
# This regex only recognises the OS's fixed input-app id namespace; which ports
# actually exist comes from the system live (ps5 unplugged now, replug later)
# and the same classifier lives in launcher-service/model.js.
MH_INPUT_RE = re.compile(r"^com\.webos\.app\.(livetv|hdmi\d+|av\d+|scart|dp\d+|usbc\d+)$")


def is_input_id(i):
    return bool(i and MH_INPUT_RE.match(i))


def load_config():
    cfg = copy.deepcopy(DEFAULTS)
    p = os.path.join(APP_DIR, "config.json")
    try:
        with open(p, encoding="utf-8") as f:
            user = json.load(f)
    except FileNotFoundError:
        return cfg
    if not isinstance(user, dict):
        raise ValueError("config.json must contain an object")
    if "version" in user:
        if not isinstance(user["version"], str) or not re.fullmatch(r"\d+\.\d+\.\d+", user["version"]):
            raise ValueError("config.json version must be MAJOR.MINOR.PATCH")
        cfg["version"] = user["version"]
    for section in ("header", "ui"):
        if section not in user:
            continue
        if not isinstance(user[section], dict):
            raise ValueError("config.json %s must contain an object" % section)
        cfg[section].update(user[section])
    for key in ("text", "brand"):
        if not isinstance(cfg["header"][key], str):
            raise ValueError("config.json header.%s must be a string" % key)
    for key in ("system", "appsPriority"):
        value = cfg["ui"][key]
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise ValueError("config.json ui.%s must be an array of strings" % key)
    return cfg


def load_tiles():
    with open(os.path.join(APP_DIR, "tiles.json"), encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("tiles.json must contain an object")
    launch_points = data.get("launchPoints", [])
    if not isinstance(launch_points, list):
        raise ValueError("tiles.json launchPoints must contain an array")
    return launch_points


def load_usage(path=None):
    # Personal runtime state must never silently affect a public build.
    if path is None:
        return {}
    with open(path, encoding="utf-8") as f:
        usage = json.load(f)
    if not isinstance(usage, dict) or not all(
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
        for value in usage.values()
    ):
        raise ValueError("usage must be an object mapping app IDs to nonnegative integers")
    return usage


def classify(tiles, cfg):
    sys_ids = {s for s in cfg["ui"]["system"] if s}
    apps, inputs, sysrow = [], [], []
    seen = set()
    for lp in tiles:
        if not isinstance(lp, dict):
            continue
        i = lp.get("id", "")
        if (not isinstance(i, str) or not re.fullmatch(r"[a-zA-Z0-9_][a-zA-Z0-9._-]{0,255}", i)
                or i == SELF or lp.get("hidden") or i in seen):
            continue
        seen.add(i)
        is_sys = bool(lp.get("systemApp"))
        if is_input_id(i) or lp.get("lptype") == "bookmark":
            inputs.append(tile_dict(lp))
            continue
        if i in sys_ids and (i == SETTINGS_ID or is_sys):
            sysrow.append(tile_dict(lp))
            continue
        if is_sys or i in sys_ids or i == SETTINGS_ID:
            continue
        apps.append(tile_dict(lp))
    if SETTINGS_ID in sys_ids and not any(t["id"] == SETTINGS_ID for t in sysrow):
        sysrow.append({"id": SETTINGS_ID, "title": "Settings",
                       "icon": SETTINGS_ICON, "params": None})
    sysrow.append({"id": LG_HOME_ID, "title": "LG Home", "icon": "", "params": None})
    return apps, inputs, sysrow


def tile_dict(lp):
    return {
        "id": lp.get("id", ""),
        "title": lp["title"] if isinstance(lp.get("title"), str) and lp["title"] else lp.get("id", ""),
        "icon": lp.get("largeIcon") or lp.get("icon") or "",
        "params": (lp.get("params")
                   if isinstance(lp.get("params"), dict) and lp.get("params") else None),
    }


def sort_key(t, usage, priority):
    if t["id"] in usage:
        return (-1, -usage[t["id"]])
    try:
        return (0, priority.index(t["id"]))
    except ValueError:
        return (1, t["title"].lower())


def tile_html(t):
    if t.get("icon"):
        # Bake the app-relative icons/<id>.png path (same mechanism the live
        # getTiles response and the watcher use): the file:// webview blocks
        # absolute paths, and the watcher owns every file under icons/.
        icon = "icons/" + t["id"].replace("/", "_").replace("\\", "_") + ".png"
        art = ('<img src="%s" alt="" data-title="%s" onerror="this.style.display=\'none\'">'
               % (htmllib.escape(icon, quote=True), htmllib.escape(t["title"], quote=True)))
    else:
        art = '<div class="initial">%s</div>' % htmllib.escape((t["title"] or "?").strip()[:1].upper())
    return ('<div class="tile" tabindex="0" role="button" data-id="%s" data-params="%s">'
            '<div class="art">%s</div><div class="label">%s</div></div>'
            % (htmllib.escape(t["id"]), htmllib.escape(json.dumps(t["params"]) if t["params"] else ""),
               art, htmllib.escape(t["title"])))


def section_html(tiles, usage, priority, sort=False):
    ts = sorted(tiles, key=lambda t: sort_key(t, usage, priority)) if sort else tiles
    return "\n".join(tile_html(t) for t in ts)


def load_template():
    source = os.path.join(BASE, "launcher-app", "src")
    def read(name):
        with open(os.path.join(source, name), encoding="utf-8") as f:
            return f.read()
    with open(os.path.join(BASE, "launcher-service", "model.js"), encoding="utf-8") as f:
        shared = f.read()
    return (read("index.html").replace("__MH_SHARED__", shared).replace("__MH_CSS__", read("launcher.css"))
            .replace("__MH_JS__", read("launcher.js")))



def build(version=None, usage_path=None, preview=False):
    cfg = load_config()
    if usage_path and not preview:
        raise ValueError("--usage requires --preview")
    usage = load_usage(usage_path)
    apps, inputs, sysrow = classify(load_tiles(), cfg) if preview else ([], [], [])
    version = version or cfg.get("version") or "1.0.0"
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("version must be MAJOR.MINOR.PATCH")
    cfg["version"] = version

    # Banner is baked from DEFAULTS so committed index.html stays generic;
    # the per-TV greeting comes from config.json at runtime (getTiles.header).
    header_text = (DEFAULTS.get("header", {}).get("text") or "Welcome").upper()
    header_brand = DEFAULTS.get("header", {}).get("brand") or "Minimal Home"
    sys_ids = [s for s in cfg["ui"]["system"] if s]
    settings_tile = {"id": SETTINGS_ID, "title": "Settings",
                     "icon": SETTINGS_ICON, "params": None}

    inject = {
        "__MH_CONFIG__": json.dumps({"version": "v" + version, "system": sys_ids,
                                     "settingsTile": settings_tile if SETTINGS_ID in sys_ids else None}).replace("<", "\\u003c"),
        "__LOADING_DISPLAY__": "none" if preview else "flex",
        "__MH_TITLE__": htmllib.escape(header_brand),
        "__WELCOME_TEXT__": htmllib.escape(header_text),
        "__WELCOME_BRAND__": htmllib.escape(header_brand),
    }

    priority = [p for p in cfg["ui"]["appsPriority"] if p]
    html = load_template()
    html = (html.replace("__APPS__", section_html(apps, usage, priority, sort=True))
                .replace("__INPUTS__", section_html(inputs, usage, priority))
                .replace("__SYS__", section_html(sysrow, usage, priority))
                .replace("__TAG__", "i"))
    for key, value in inject.items():
        html = html.replace(key, value)
    if "__MH_" in html or "__WELCOME_" in html or "__APPS__" in html:
        raise RuntimeError("unresolved template placeholders in index.html")

    with open(os.path.join(APP_DIR, "appinfo.json"), encoding="utf-8") as f:
        appinfo = json.load(f)
    appinfo["version"] = version

    out = {
        "launcher-app/index.html": html,
        "launcher-app/appinfo.json": json.dumps(appinfo, indent=2) + "\n",
        # Runtime copy for the service: the dev-mode service jailer can't read
        # the app-dir config.json (ENOENT), so the build stamps an identical
        # config.json into the service dir. Single git source: launcher-app/config.json.
        "launcher-service/config.json": json.dumps(cfg, indent=4) + "\n",
    }
    return out, (len(apps), len(inputs), len(sysrow)), usage


def read_current(rel):
    try:
        with open(os.path.join(BASE, rel), encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def write_output(rel, content):
    with open(os.path.join(BASE, rel), "w", encoding="utf-8", newline="\n") as f:
        f.write(content)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build Minimal Home launcher")
    ap.add_argument("--check", action="store_true",
                    help="verify committed build output is up to date (no writes)")
    ap.add_argument("--version", default=None, help="override version")
    ap.add_argument("--preview", action="store_true", help="include sample tiles for desktop preview only")
    ap.add_argument("--usage", metavar="PATH", help="bake a personal usage snapshot (local builds only)")
    args = ap.parse_args(argv)

    try:
        out, (na, ni, ns), usage = build(args.version, args.usage, args.preview)
    except (OSError, ValueError) as exc:
        ap.exit(1, "error: %s\n" % exc)

    diffs = [rel for rel, content in out.items() if read_current(rel) != content]
    if not args.check:
        for rel in diffs:
            write_output(rel, out[rel])

    print("preview apps=%d inputs=%d sys=%d" % (na, ni, ns))
    if usage:
        print("baking MRU order for %d apps" % len(usage))
    if args.check:
        if diffs:
            print("STALE OUTPUT: " + ", ".join(diffs) + " (run python build_launcher.py)")
            return 1
        print("up-to-date")
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())

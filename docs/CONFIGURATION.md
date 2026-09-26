# Configuration

## Source configuration

Edit `launcher-app/config.json`, then run `python build_launcher.py` and deploy
both app and service files. The generated service-local copy is necessary
because the service cannot reliably read the app directory.

| Field | Meaning |
| --- | --- |
| `version` | Three-part app version, such as `1.3.2` |
| `header.text` | Small greeting text |
| `header.brand` | Emphasized greeting text |
| `ui.system` | System apps exposed as tiles; includes optional TV Settings |
| `ui.appsPriority` | App IDs used to break ties after recent usage |

Example greeting:

```json
{
  "header": {
    "text": "Welcome",
    "brand": "Minimal Home"
  }
}
```

Missing fields inherit defaults. Invalid JSON, wrong field types, and invalid
version strings fail the build. The committed startup banner remains generic;
the live relay supplies the configured greeting.

When the live `header.brand` is still the default `Minimal Home`, a first-run
dialog explains that the brand is the bold name after `WELCOME` in the upper-left
header. Select its text field with the TV remote to use the webOS on-screen
keyboard. Saving or keeping the default records setup in TV preferences, so an
update does not ask again. A non-default configured brand skips the dialog.

Inputs are discovered from the TV's launch points. Do not add a fixed HDMI list
to config. The system allowlist is explicit: an empty list hides all system
apps, including the Settings tile. The header gear still opens launcher preferences,
and the LG Home bypass tile appears after successful discovery. If discovery
fails, use the relay/SSH [recovery procedure](INSTALL.md#return-to-stock-home).

## On-TV configuration

The runtime file is
`/media/developer/apps/usr/palm/services/org.minimal.home.service/config.json`.
The relay rereads it for every `getTiles` request, including startup, return to
foreground, and relaunch. The frontend applies the greeting, system-row IDs,
and Settings action from that response; app priority sorting happens in the relay.
This works on the next TV boot without rebuilding. Editing the app directory's
copy has no runtime effect.

Follow the [README commands](../README.md#change-configuration-on-the-tv) to edit
and refresh while the TV is running. A direct `getTiles` call can inspect the
configuration response but does not itself refresh the visible page. No continuous
config polling is performed.

Use strings for both header fields and arrays of app ID strings for both `ui`
fields. Retain all fields when editing: runtime reads do not merge build defaults.
An empty `ui.system` hides system apps, including the Settings tile, while the
header gear remains available. The LG Home tile requires successful discovery;
the relay/SSH recovery path does not require a loaded grid. IDs only expose apps returned
by live discovery. `ui.appsPriority` breaks ordering ties after pins and recent
usage; alphabetical sorting ignores it.

`version` remains build metadata: changing it on the TV does not update the
installed manifest or displayed build version. Appearance and clock options
belong to launcher preferences below.

The initial feature installation needs updated app and relay files and a restart
of their existing processes; subsequent config edits do not. The bundled installer
preserves valid TV customizations automatically during updates, merges them with
new configuration fields, and retains the new release version. Invalid JSON or
invalid field types stop an installer update before upload; when editing directly,
they can leave the greeting blank or system apps hidden until corrected.

## Launcher preferences

Open the Settings tile or header gear. Left/Right cycles options; OK activates a
row; Back closes the panel.

Preferences include the header brand name, accent color, tile size, labels, clock
options, date format, sort mode, and system statistics. A brand saved through the
launcher takes precedence over `header.brand` and can be edited again from the
Brand name row. Use the per-tile menu to pin/unpin or hide an app; pinned apps
can be reordered from the same menu with Move (unavailable under Alphabetical
sorting, which ignores pin ordering). Restore hidden apps from Settings. The
Status row reports the running build, tile and stats health, and relay
reachability, with manual refresh and LG Home actions. App labels affects tile captions only, not
CPU/RAM/temperature captions; tiles retain accessible names when captions are hidden.
Reset all restores defaults.

Preferences live in `prefs.json` next to the service on the TV, not in the build
config. The installer preserves these files. See the [Luna reference](LUNA.md)
for keys, defaults, limits, and partial-update rules. Recently used sorts by launch recency,
with pinned apps first and configured priority as a fallback. Pinned first ignores
recency and uses configured priority/title after pins. Alphabetical ignores pin
ordering. Pin badges remain visible in every mode.

## Desktop preview tiles and personal usage

`launcher-app/tiles.json` is a public sample snapshot used only with `--preview`.
Normal builds start with a loading indicator and populate the rows from the TV.
System app IDs in the config filter live results; they do not create tiles.
Missing desktop icons are expected because the watcher provisions app-local icons on the device.

Default builds use only public inputs. To bake a personal recent-app ordering:

```sh
python build_launcher.py --preview --usage private/usage.json
```

Supply a JSON object mapping app IDs to nonnegative integer launch sequence
values. There is no automatic lookup of `usage.json` in app or service directories.

Sample and personal output are for local desktop preview.
The installer and release packager require the default reproducible build and
will reject a personalized page that differs. Before opening a PR, restore it:

```sh
python build_launcher.py
python tools/check.py
```


## Validation

Run `python tools/check.py` after editing JSON so malformed configuration is caught before packaging.

Keep personal snapshots and credentials in the ignored `private/` directory.

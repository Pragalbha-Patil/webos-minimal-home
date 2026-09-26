# Luna service and persisted-preferences reference

Diagnostic reference for SSH troubleshooting on an already rooted TV. This is
not a promise of a public stable API: method names and shapes follow the
checked-in `launcher-service/service.js` and `launcher-service/model.js`, and
the tables below are verified against them by `tests/test_luna_reference.py`.

Service ID: `org.minimal.home.service`. Every method answers exactly once with
`returnValue: true` on success or `returnValue: false` plus `errorText` on
failure. Each application-manager call has its own 15-second deadline; a
`launchApp` call that resolves input parameters uses two sequential calls, so
there is no single end-to-end timeout.

## Methods

| Method | Changes state | Description |
| --- | --- | --- |
| `getTiles` | no | Live apps/inputs, bundled prefs, config, and header |
| `getPrefs` | no | Stored preferences |
| `setPrefs` | yes | Merges supplied keys into stored preferences |
| `getSystemStats` | no | Last watcher sample, possibly stale or unknown |
| `launchApp` | yes | Launches an app and records usage |
| `openLGHome` | yes | Stores a bypass marker, then opens stock Home |

### `getTiles`

Reads the platform launch points over Luna and returns live tiles plus the
data the frontend boots from. Read-only: it never writes TV state.

```json
{ "returnValue": true, "tiles": [], "inputs": [], "prefs": {}, "config": {}, "header": {} }
```

- `tiles`/`inputs` carry `id`, `title`, `icon` (app-relative path), nullable
  `params`, and `pinned`/`hidden` flags. Hidden, duplicate, malformed, and
  unlisted system entries are filtered; the launcher itself never appears.
- `prefs` is the stored preferences object described below.
- `config.system`/`config.settingsTile` and `header.text`/`header.brand` come
  from the service-local `config.json`; missing values fall back to embedded
  defaults. Unknown failures reply `returnValue: false`.

### `getPrefs`

```json
{ "returnValue": true, "prefs": {} }
```

Returns the stored preferences object. Missing or corrupt files fall back to
defaults.

### `setPrefs`

Merges each supplied, validated key into the stored preferences and replies
with the merged object. Supplied arrays **replace** their previous contents;
omitted keys are untouched. Unknown keys and invalid values are filtered out.

```sh
luna-send -n 1 luna://org.minimal.home.service/setPrefs '{"labels":false}'
```

Partial updates are the norm: send only the keys being changed instead of
resending unrelated fields.

### `getSystemStats`

```json
{ "returnValue": true, "cpu": 12, "ram": 60, "temp": 41 }
```

Each field is a number or `null` when unknown. Samples older than 20 seconds
read back as `null`; CPU/RAM outside 0–100 and temperatures outside −100–200
are rejected as `null`.

### `launchApp`

```json
{ "id": "youtube.leanback.v4", "params": { "value": 4 } }
```

Requires a valid app id. Only these launch parameter keys survive, as strings,
booleans, or finite numbers: `PhysicalAddress`, `uniqueId`, `value`,
`displayId`. The target id is always forced to the requested id and the caller
to `org.minimal.home`; a bookmark's parameters can never redirect the launch
elsewhere. Input launches first re-read the live launch points so per-port
parameters stay fresh. Every successful launch records usage (see below).

### `openLGHome`

Stores a ten-minute bypass marker, then opens stock Home. If Home fails to
open, the marker is removed again so the launcher is never stranded in a
bypass. The frontend's temporary bypass after a failed Home launch behaves the
same way.

## Preferences

| Key | Default | Allowed values |
| --- | --- | --- |
| `accent` | `"steel"` | `["steel", "emerald", "violet", "amber", "crimson"]` |
| `tileSize` | `"standard"` | `["compact", "standard", "large"]` |
| `labels` | `true` | boolean |
| `clock24` | `false` | boolean, accepted but unused |
| `sort` | `"mru"` | `["mru", "alpha", "pinned"]` |
| `pinned` | `[]` | up to 30 app ids, replaces previous list |
| `hidden` | `[]` | up to 60 app ids, replaces previous list |
| `showSystemStats` | `true` | boolean |
| `dateFormat` | `"HH:mm"` | `["HH:mm", "h:mm A", "HH:mm:ss", "h:mm:ss A", "MMM D, HH:mm", "MMM D, h:mm A", "YYYY-MM-DD HH:mm", "DD/MM/YYYY HH:mm"]` |
| `brand` | `""` | empty string, or 1–40 characters |
| `brandConfigured` | `false` | boolean |

`pinned`/`hidden` entries must be valid app ids; anything else is dropped.
Reset preferences writes these defaults through `setPrefs` but never clears
usage history (`usage.json`) or the service-local `config.json`. Usage keeps
at most 60 launch entries, renumbered by recency.

## Files and live queries

Runtime state lives next to the service (`prefs.json`, `usage.json`,
`.noredirect` bypass marker, `config.json`) because the service jailer cannot
reliably read the app directory. Logs are bounded (`/tmp/minhome-svc.log`,
`/tmp/minhome-watch.log`).

```sh
luna-send -n 1 luna://org.minimal.home.service/getTiles '{}'
luna-send -n 1 luna://org.minimal.home.service/getPrefs '{}'
```

A missing-service or denied-method reply is a registration/permissions
problem; see [installation and recovery](INSTALL.md#troubleshooting). The
[architecture](ARCHITECTURE.md) and [configuration](CONFIGURATION.md) guides

## Streaming responses

Subscription endpoints can emit multiple JSON objects in one stdout read. Frame complete objects before parsing them.

link here for the full contract.

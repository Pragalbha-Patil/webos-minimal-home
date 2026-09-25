#!/usr/bin/env node
// Minimal Home redirect watcher (EVENT-DRIVEN v2).
// Subscribes to foreground-app changes; when LG Home comes up, opens
// Minimal Home instead (unless bypassed via the LG Home tile).
// Home detection is event-driven; icons and statistics refresh periodically.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const C = require('./constants');
const { BYPASS_FILE, HOME_ID, SELF_ID, APP_DIR, SETTINGS_ID, SETTINGS_ICON } =
    C;
const M = require('./model');
const store = require('./storage')(fs);
const createJsonStream = require('./json-stream');
const { StringDecoder } = require('string_decoder');
const log = store.logger(C.WATCH_LOG, C.LOG_MAX_BYTES);

const ICON_DIR = path.join(APP_DIR, 'icons');
const ICON_MAX_BYTES = 300000;
const FIRSTUSE = C.FIRSTUSE_FILE;
const STATS_FILE = C.STATS_FILE;

let fails = 0;
let lastRedirect = 0;
let foregroundApp = null;
let retryTimer = null;
let redirecting = false;

function lunaLaunch(id) {
    return new Promise((resolve) => {
        execFile(
            'luna-send',
            [
                '-n',
                '1',
                'luna://com.webos.applicationManager/launch',
                JSON.stringify({ id })
            ],
            { timeout: 15000 },
            (err, stdout) => {
                if (err) return resolve(null);
                try {
                    resolve(JSON.parse(stdout));
                } catch (e) {
                    resolve(null);
                }
            }
        );
    });
}

function listLaunchPoints() {
    return new Promise((resolve) => {
        execFile(
            'luna-send',
            [
                '-n',
                '1',
                'luna://com.webos.applicationManager/listLaunchPoints',
                '{}'
            ],
            { timeout: 20000 },
            (err, stdout) => {
                if (err) return resolve(null);
                try {
                    const p = JSON.parse(stdout);
                    resolve(
                        p &&
                            p.returnValue === true &&
                            Array.isArray(p.launchPoints)
                            ? p.launchPoints
                            : null
                    );
                } catch (e) {
                    resolve(null);
                }
            }
        );
    });
}

function copyIcon(source, destination) {
    if (typeof source !== 'string' || !source) return false;
    const size = fs.statSync(source).size;
    if (size === 0 || size > ICON_MAX_BYTES) return false;
    const bytes = fs.readFileSync(source);
    try {
        if (fs.readFileSync(destination).equals(bytes)) return true;
    } catch (error) {
        /* First copy or a previously unreadable destination. */
    }
    fs.writeFileSync(destination, bytes);
    return true;
}

function tryCopyIcon(source, destination) {
    try {
        return copyIcon(source, destination);
    } catch (error) {
        log({ iconCopy: String(error) });
        return false;
    }
}

function provisionPoint(point, keep) {
    // Returns null for records without a usable id, otherwise whether an
    // icon candidate was copied. Every valid point joins the keep set even
    // when its sources fail, so pruning never removes a known app.
    if (!point || !M.validId(point.id)) return null;
    const destination = path.join(ICON_DIR, point.id + '.png');
    keep.add(point.id + '.png');
    const candidates = [point.largeIcon, point.icon];
    for (const source of new Set(candidates)) {
        if (tryCopyIcon(source, destination)) return true;
    }
    return false;
}

function pruneIcon(name, keep) {
    if (
        !name.endsWith('.png') ||
        !M.validId(name.slice(0, -4)) ||
        keep.has(name)
    )
        return;
    try {
        fs.unlinkSync(path.join(ICON_DIR, name));
    } catch (error) {
        log({ iconCleanup: String(error) });
    }
}

function provisionIcons(points) {
    if (!Array.isArray(points)) return;
    let copied = 0,
        total = 0;
    const keep = new Set([SETTINGS_ID + '.png']);
    try {
        fs.mkdirSync(ICON_DIR, { recursive: true });
    } catch (error) {
        log({ iconDirectory: String(error) });
    }
    points.forEach((point) => {
        const provisioned = provisionPoint(point, keep);
        if (provisioned === null) return;
        total++;
        if (provisioned) copied++;
        // A temporary source error must not delete last-known-good bytes.
    });
    try {
        fs.readdirSync(ICON_DIR).forEach((name) => {
            pruneIcon(name, keep);
        });
    } catch (error) {
        log({ iconPrune: String(error) });
    }
    log({ method: 'icon-provision', total, copied });
}

function provisionSettingsIcon() {
    try {
        fs.mkdirSync(ICON_DIR, { recursive: true });
        copyIcon(SETTINGS_ICON, path.join(ICON_DIR, SETTINGS_ID + '.png'));
    } catch (error) {
        log({ settingsIcon: String(error) });
    }
}

var lastCpuTotal = null;
var lastCpuIdle = null;

function statsVisible() {
    try {
        var prefs = JSON.parse(fs.readFileSync(C.PREFS_FILE, 'utf8'));
        return prefs.showSystemStats !== false;
    } catch (e) {
        return true;
    }
}

function readCpuUsage() {
    try {
        var stat = fs.readFileSync('/proc/stat', 'utf8');
        var m = stat.match(/^cpu\s+([^\n]+)/);
        if (!m) return null;
        // Guest time is already included in user/nice; count only the first eight fields.
        var fields = m[1].trim().split(/\s+/).slice(0, 8).map(Number);
        var idle = fields[3] + (fields[4] || 0);
        var total = fields.reduce(function (sum, value) {
            return sum + value;
        }, 0);
        var usage = null;
        if (typeof lastCpuTotal === 'number' && total > lastCpuTotal) {
            var diffTotal = total - lastCpuTotal;
            var diffIdle = idle - (lastCpuIdle || 0);
            usage = Math.max(
                0,
                Math.min(
                    100,
                    Math.round((100 * (diffTotal - diffIdle)) / diffTotal)
                )
            );
        }
        lastCpuTotal = total;
        lastCpuIdle = idle;
        return usage;
    } catch (e) {
        log({ cpuErr: String((e && e.message) || e) });
        return null;
    }
}

function readRamUsage() {
    try {
        var mem = fs.readFileSync('/proc/meminfo', 'utf8');
        var memoryTotal = parseInt(
            (mem.match(/MemTotal:\s+(\d+)/) || [])[1] || '0',
            10
        );
        var avail = parseInt(
            (mem.match(/MemAvailable:\s+(\d+)/) || [])[1] || '0',
            10
        );
        if (memoryTotal <= 0 || !/MemAvailable:/.test(mem)) return null;
        return M.metric(
            Math.round((100 * (memoryTotal - avail)) / memoryTotal),
            0,
            100
        );
    } catch (e) {
        log({ ramErr: String((e && e.message) || e) });
        return null;
    }
}

function readZoneTemp(tz) {
    if (!/^thermal_zone\d+$/.test(tz)) return null;
    var t;
    try {
        t = fs
            .readFileSync('/sys/class/thermal/' + tz + '/temp', 'utf8')
            .trim();
    } catch (error) {
        return null;
    }
    return M.metric(Math.round(parseInt(t, 10) / 1000), -100, 200);
}

function firstZoneTemp(zones) {
    for (var i = 0; i < zones.length; i++) {
        var tempC = readZoneTemp(zones[i]);
        if (tempC !== null) return tempC;
    }
    return null;
}

function readTempC() {
    try {
        return firstZoneTemp(fs.readdirSync('/sys/class/thermal'));
    } catch (e) {
        log({ tempErr: String((e && e.message) || e) });
        return null;
    }
}

function collectSystemStats() {
    try {
        if (!statsVisible()) {
            lastCpuTotal = null;
            lastCpuIdle = null;
            return;
        }
        store.writeJson(STATS_FILE, {
            cpu: M.metric(readCpuUsage(), 0, 100),
            ram: readRamUsage(),
            temp: readTempC(),
            timestamp: Date.now()
        });
    } catch (e) {
        log({ statsErr: String((e && e.message) || e) });
    }
}

async function runProvision() {
    try {
        const lps = await listLaunchPoints();
        provisionIcons(lps);
        provisionSettingsIcon();
        collectSystemStats();
    } catch (e) {
        log({ provErr: String((e && e.message) || e) });
    }
}

function redirectFailed() {
    if (foregroundApp !== HOME_ID) return;
    fails++;
    const backoff =
        fails < 5
            ? 2000
            : Math.min(5 * 60 * 1000, 30000 * Math.pow(2, fails - 5));
    log({ redirectFail: true, fails, retryInMs: backoff });
    scheduleRetry(backoff);
}

async function redirectLoop() {
    if (foregroundApp !== HOME_ID || redirecting) return;
    try {
        if (
            fs.existsSync(BYPASS_FILE) &&
            Date.now() < parseInt(fs.readFileSync(BYPASS_FILE, 'utf8'), 10)
        )
            return;
        if (Date.now() - lastRedirect < 8000) {
            scheduleRetry(8000 - (Date.now() - lastRedirect));
            return;
        }
        redirecting = true;
        const r = await lunaLaunch(SELF_ID);
        if (r && r.returnValue) {
            fails = 0;
            lastRedirect = foregroundApp === HOME_ID ? Date.now() : 0;
            log({ redirect: true });
        } else {
            redirectFailed();
        }
    } catch (e) {
        log({ tickErr: String((e && e.message) || e) });
    } finally {
        redirecting = false;
    }
}

function bypassActive() {
    // True while a stored bypass pauses Home redirection; removes the file
    // once it expires. Filesystem failures fail open toward redirecting.
    try {
        if (!fs.existsSync(BYPASS_FILE)) return false;
        if (Date.now() < parseInt(fs.readFileSync(BYPASS_FILE, 'utf8'), 10))
            return true;
        try {
            fs.unlinkSync(BYPASS_FILE);
        } catch (e) {}
    } catch (e) {}
    return false;
}

async function onForeground(appId) {
    foregroundApp = appId;
    // A confirmed transition ends the previous Home redirect burst. Exit or
    // Home from a running app must not inherit its eight-second cooldown.
    if (appId && appId !== HOME_ID) lastRedirect = 0;
    if (appId !== HOME_ID && retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
    }
    try {
        if (!appId) return;
        if (appId !== HOME_ID) {
            fails = 0;
            return;
        }
        if (!fs.existsSync(FIRSTUSE)) return;
        if (bypassActive()) {
            fails = 0;
            return;
        }
        if (retryTimer === null) redirectLoop();
    } catch (e) {
        log({ tickErr: String((e && e.message) || e) });
    }
}

function scheduleRetry(delay) {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
        retryTimer = null;
        redirectLoop();
    }, delay);
}

function watch() {
    log({ watcherStart: true });
    let child;
    try {
        child = spawn('luna-send', [
            '-n',
            '1000000',
            'luna://com.webos.applicationManager/getForegroundAppInfo',
            '{"subscribe":true}'
        ]);
    } catch (error) {
        log({ spawnErr: String(error) });
        setTimeout(watch, 5000);
        return;
    }
    const parse = createJsonStream(65536);
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (chunk) => {
        if (reconnecting) return;
        for (const message of parse(decoder.write(chunk))) {
            if (typeof message.appId === 'string') onForeground(message.appId);
        }
    });
    let reconnecting = false;
    const reconnect = (why) => {
        // spawn failure fires both 'error' and 'close'; one reconnect per child
        if (reconnecting) return;
        reconnecting = true;
        foregroundApp = null;
        fails = 0;
        if (retryTimer !== null) {
            clearTimeout(retryTimer);
            retryTimer = null;
        }
        log({ resubscribe: why });
        try {
            child.kill();
        } catch (e) {}
        setTimeout(watch, 3000);
    };
    child.on('error', () => reconnect('error'));
    child.on('close', (code) => reconnect('close:' + code));
    child.stderr.on('data', (d) => {
        log({ childStderr: ('' + d).slice(0, 200) });
    });
}

// Schedule immediately so a first install has icons before its webview loads.
// A zero-delay timer lets the foreground subscription initialize first.
setTimeout(runProvision, 0);
setInterval(runProvision, 5 * 60 * 1000);

// System stats collection every 5s (watcher runs as root, can read /sys/class/thermal)
collectSystemStats();
setInterval(collectSystemStats, 5000);

watch();

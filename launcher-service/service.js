'use strict';

var Service = require('webos-service');
var fs = require('fs');
var C = require('./constants');
var M = require('./model');
var store = require('./storage')(fs);
var log = store.logger(C.SVC_LOG, C.LOG_MAX_BYTES);
var service = new Service(C.SELF_ID + '.service');
var TITLE_MAX = 120;

function failure(error) {
    return {
        returnValue: false,
        errorText: String(
            (error && (error.errorText || error.message)) || error
        )
    };
}

function register(name, handler) {
    service.register(name, function (message) {
        var answered = false;
        function reply(result) {
            if (answered) return;
            answered = true;
            log({
                method: name,
                ok: result.returnValue,
                errorText: result.errorText
            });
            message.respond(result);
        }
        try {
            handler(M.record(message.payload) ? message.payload : {}, reply);
        } catch (error) {
            reply(failure(error));
        }
    });
}

function callLuna(method, payload, reply, onSuccess) {
    var complete = false;
    var timer = setTimeout(function () {
        finish(failure('Luna request timed out: ' + method));
    }, C.LUNA_TIMEOUT_MS);
    function finish(result) {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        try {
            if (!M.record(result) || result.returnValue !== true) {
                reply(
                    failure(
                        (result && result.errorText) ||
                            'Invalid Luna response: ' + method
                    )
                );
            } else onSuccess(result);
        } catch (error) {
            reply(failure(error));
        }
    }
    try {
        service.call(
            'luna://com.webos.applicationManager/' + method,
            payload,
            function (response) {
                finish(response && response.payload);
            }
        );
    } catch (error) {
        finish(failure(error));
    }
}

function loadPrefs() {
    return M.preferences(store.readJson(C.PREFS_FILE));
}

function loadConfig() {
    var config = store.readJson(C.CONFIG_FILE);
    return M.record(config) ? config : {};
}

function recordLaunch(id) {
    var usage = M.usage(store.readJson(C.USAGE_FILE));
    var keys = Object.keys(usage).sort(function (a, b) {
        return usage[a] - usage[b];
    });
    // Renumbering preserves recency and avoids precision loss in long-lived stores.
    var next = 0;
    keys.forEach(function (key) {
        usage[key] = ++next;
    });
    usage[id] = ++next;
    keys = Object.keys(usage).sort(function (a, b) {
        return usage[b] - usage[a];
    });
    keys.slice(60).forEach(function (key) {
        delete usage[key];
    });
    try {
        store.writeJson(C.USAGE_FILE, usage);
    } catch (error) {
        log({ method: 'recordLaunch', errorText: String(error) });
    }
}

register('getTiles', function (payload, reply) {
    callLuna('listLaunchPoints', {}, reply, function (response) {
        if (!Array.isArray(response.launchPoints))
            throw new Error('Invalid launch-point response');
        var config = loadConfig();
        var ui = M.record(config.ui) ? config.ui : {};
        var allowed = M.ids(ui.system, 1000);
        var priority = M.ids(ui.appsPriority, 1000);
        var prefs = loadPrefs();
        var usage = M.usage(store.readJson(C.USAGE_FILE));
        var tiles = [],
            inputs = [],
            seen = Object.create(null);
        response.launchPoints.forEach(function (lp) {
            if (
                !M.record(lp) ||
                !M.validId(lp.id) ||
                lp.hidden ||
                lp.id === C.SELF_ID ||
                seen[lp.id]
            )
                return;
            var input = M.input(lp);
            if (
                !input &&
                (lp.systemApp || lp.id === C.SETTINGS_ID) &&
                allowed.indexOf(lp.id) < 0
            )
                return;
            seen[lp.id] = true;
            var title =
                typeof lp.title === 'string' &&
                lp.title.length > 0 &&
                lp.title.length <= TITLE_MAX
                    ? lp.title
                    : lp.id;
            var tile = {
                id: lp.id,
                title: title,
                icon: 'icons/' + lp.id + '.png',
                params: M.record(lp.params) ? lp.params : null,
                pinned: prefs.pinned.indexOf(lp.id) >= 0,
                hidden: prefs.hidden.indexOf(lp.id) >= 0
            };
            (input ? inputs : tiles).push(tile);
        });
        var header = M.record(config.header) ? config.header : {};
        reply({
            returnValue: true,
            tiles: M.sortTiles(tiles, prefs, usage, priority),
            inputs: M.sortTiles(inputs, prefs, usage, []),
            prefs: prefs,
            config: {
                system: allowed,
                settingsTile:
                    allowed.indexOf(C.SETTINGS_ID) >= 0
                        ? { id: C.SETTINGS_ID }
                        : null
            },
            header: {
                text: typeof header.text === 'string' ? header.text : '',
                brand: typeof header.brand === 'string' ? header.brand : ''
            }
        });
    });
});

register('launchApp', function (payload, reply) {
    if (!M.validId(payload.id)) throw new Error('A valid app id is required');
    function launch(params) {
        var request = M.params(params);
        request.id = payload.id;
        request.callerId = C.SELF_ID;
        callLuna('launch', request, reply, function (response) {
            recordLaunch(payload.id);
            reply(response);
        });
    }
    // Bookmark inputs can have custom IDs outside the platform input namespace.
    if (
        !M.input({ id: payload.id }) &&
        !Object.keys(M.params(payload.params)).length
    ) {
        launch(payload.params);
        return;
    }
    callLuna('listLaunchPoints', {}, reply, function (response) {
        if (!Array.isArray(response.launchPoints))
            throw new Error('Invalid launch-point response');
        var match = response.launchPoints.filter(function (lp) {
            return M.record(lp) && lp.id === payload.id;
        })[0];
        launch(match && M.record(match.params) ? match.params : payload.params);
    });
});

register('openLGHome', function (payload, reply) {
    fs.writeFileSync(C.BYPASS_FILE, String(Date.now() + C.BYPASS_MS));
    callLuna(
        'launch',
        { id: C.HOME_ID },
        function (result) {
            // If Home did not open, do not strand the user in a ten-minute bypass.
            try {
                fs.unlinkSync(C.BYPASS_FILE);
            } catch (error) {
                log({ bypassCleanup: String(error) });
            }
            reply(result);
        },
        reply
    );
});

register('getPrefs', function (payload, reply) {
    reply({ returnValue: true, prefs: loadPrefs() });
});

register('setPrefs', function (payload, reply) {
    var prefs = loadPrefs();
    var update = M.cleanPrefs(payload);
    Object.keys(update).forEach(function (key) {
        prefs[key] = update[key];
    });
    store.writeJson(C.PREFS_FILE, prefs);
    reply({ returnValue: true, prefs: prefs });
});

register('getSystemStats', function (payload, reply) {
    var sample = store.readJson(C.STATS_FILE);
    var stats = { cpu: null, ram: null, temp: null };
    if (M.record(sample) && typeof sample.timestamp === 'number') {
        var age = Date.now() - sample.timestamp;
        if (age >= 0 && age < 20000) {
            stats.cpu = M.metric(sample.cpu, 0, 100);
            stats.ram = M.metric(sample.ram, 0, 100);
            stats.temp = M.metric(sample.temp, -100, 200);
        }
    }
    reply({
        returnValue: true,
        cpu: stats.cpu,
        ram: stats.ram,
        temp: stats.temp
    });
});

log({ method: 'service-start' });

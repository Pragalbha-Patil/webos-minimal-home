const assert = require('node:assert/strict');
const { test } = require('node:test');
const { browser, constants: C } = require('./helpers.cjs');

const video = { id: 'video', title: 'Video', icon: 'icons/video.png' };
const port = { id: 'com.webos.app.hdmi2', title: 'PlayStation', params: { id: 'wrong', value: 4, PhysicalAddress: '2000' } };
function appFor(t, options = {}) {
    const app = browser(options); t.after(() => app.close()); return app;
}
function ready(app, data = {}) { app.tiles({ tiles: [video], inputs: [port], prefs: {}, ...data }); }
function save(app) {
    const call = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    return app.respond('setPrefs', { returnValue: true, prefs: call.parameters });
}
function ids(app, section) { return [...app.document.querySelectorAll('#' + section + ' .tile')].map(el => el.dataset.id); }
function row(app, key) { return app.document.querySelector('#settingsRows [data-key="' + key + '"]'); }

test('live config replaces embedded system rows and Settings behavior on startup and relaunch', t => {
    const app = appFor(t, { settings: false });
    const settings = { id: C.SETTINGS_ID, title: 'Settings' };
    const config = { system: [video.id, settings.id], settingsTile: { id: settings.id } };
    ready(app, { tiles: [video, settings], config });
    assert.deepEqual(ids(app, 'grid'), []);
    assert.deepEqual(ids(app, 'sysrow'), [video.id, settings.id, '__LGHOME__']);
    app.click('[data-id="' + settings.id + '"]');
    assert.ok(row(app, 'tvsettings'));
    app.click('#settingsRows [data-key="tvsettings"]');
    assert.equal(app.calls.find(c => c.method === 'launchApp').parameters.id, settings.id);

    app.document.dispatchEvent(new app.window.Event('webOSRelaunch'));
    ready(app, { config: { system: [], settingsTile: null } });
    assert.deepEqual(ids(app, 'grid'), [video.id]);
    assert.deepEqual(ids(app, 'sysrow'), ['__LGHOME__']);
});

test('bundled and legacy preferences preserve inputs and sorting', t => {
    for (const order of ['bundled', 'legacy']) for (const size of ['compact', 'standard', 'large']) {
        for (const sort of ['mru', 'alpha', 'pinned']) {
            const app = appFor(t); const data = { tiles: [video], inputs: [port, { id: 'av', title: 'AV' }] };
            const prefs = { tileSize: size, sort, pinned: [port.id], hidden: [], labels: false, showSystemStats: false, dateFormat: 'HH:mm:ss' };
            if (order === 'bundled') app.tiles({ ...data, prefs }); else { app.tiles(data); app.prefs(prefs); }
            assert.deepEqual(ids(app, 'inputs'), sort === 'alpha' ? ['av', port.id] : [port.id, 'av']);
            assert.ok(app.document.body.classList.contains('density-' + size));
            assert.ok(app.document.body.classList.contains('no-labels'));
            assert.equal(app.document.querySelector('#sysStats').style.display, 'none');
            assert.ok(app.document.querySelector('[data-id="__LGHOME__"]'));
        }
    }
});

test('completed service requests are released, duplicate replies ignored, and expiry is bounded', async t => {
    const app = appFor(t); const first = app.tiles(); app.prefs();
    assert.equal(app.window.__mhKeep.length, 0);
    first.onSuccess({ returnValue: true, tiles: [video], inputs: [] });
    assert.deepEqual(ids(app, 'grid'), []);
    await app.clock.run(1000); assert.equal(app.window.__mhKeep.length, 1);
    await app.clock.run(15000); assert.equal(app.window.__mhKeep.length, 0);
    assert.equal(app.calls.find(c => c.method === 'getSystemStats').request.cancelled, true);
    app.window.__mhKeep = Array(32).fill({});
    await app.clock.run(5000); assert.equal(app.window.__mhKeep.length, 32);
});

test('Palm bridge fallback handles valid, failed, malformed, thrown and missing platform APIs', async t => {
    for (const options of [{ bridgeOnly: true }, { throwRequest: true }]) {
        const app = appFor(t, options);
        assert.equal(app.bridges.length, 1);
        app.bridges[0].onservicecallback(JSON.stringify({ returnValue: true, tiles: [video], inputs: [] }));
        app.bridges[1].onservicecallback('{bad');
        assert.deepEqual(ids(app, 'grid'), ['video']); assert.equal(app.window.__mhKeep.length, 0);
    }
    const failed = appFor(t, { bridgeOnly: true });
    failed.bridges[0].onservicecallback('{"returnValue":false}');
    assert.equal(failed.window.__mhKeep.length, 0);
    for (const options of [{ offline: true }, { bridgeOnly: true, throwBridge: true }, { bridgeOnly: true, throwBridgeCall: true }]) {
        const app = appFor(t, options); assert.equal(app.window.__mhKeep.length, 0);
    }
    const expired = appFor(t, { bridgeOnly: true, throwCancel: true });
    await expired.clock.run(15000); assert.equal(expired.window.__mhKeep.length, 0);
});

test('bad tile replies preserve the last grid and retries recover without overlapping requests', async t => {
    const app = appFor(t); ready(app); await app.clock.run(400);
    for (const response of [null, {}, { returnValue: false }, { returnValue: true, tiles: {}, inputs: [] }, { returnValue: true, tiles: [] }]) {
        app.window.dispatchEvent(new app.window.Event('focus')); app.respond('getTiles', response);
        assert.deepEqual(ids(app, 'grid'), ['video']); await app.clock.run(400);
    }
    await app.clock.run(2500); const count = app.calls.length;
    app.window.dispatchEvent(new app.window.Event('focus')); assert.equal(app.calls.length, count);
    app.tiles({ tiles: [], inputs: [] }); assert.deepEqual(ids(app, 'grid'), []);
    assert.ok(app.document.querySelector('[data-id="__LGHOME__"]'));
});

test('invalid live records are removed and optional Settings remains absent', t => {
    const app = appFor(t, { settings: false });
    app.tiles({ tiles: [null, {}, { id: 1 }, { id: '../bad' }, { id: C.SELF_ID }, { id: '__LGHOME__' }, video, video,
        { id: 'no-title', title: 3 }], inputs: [null, port] }); app.prefs();
    assert.deepEqual(ids(app, 'grid'), ['video', 'no-title']);
    assert.deepEqual(ids(app, 'sysrow'), ['__LGHOME__']);
    app.click('#settingsBtn'); app.click('[data-key="tvsettings"]');
    assert.equal(app.calls.filter(c => c.method === 'launchApp').length, 0);
});

test('tile icons fall back to initials and all app-provided menu/search text is escaped', t => {
    const app = appFor(t); const title = '<img src=x onerror="bad()"> & "Video"';
    ready(app, { tiles: [{ ...video, title }, { id: 'blank', title: '  ' }] });
    const tile = app.document.querySelector('#grid .tile');
    tile.querySelector('img').dispatchEvent(new app.window.Event('error'));
    assert.equal(tile.querySelector('.initial').textContent, '<');
    assert.equal(app.document.querySelector('[data-id="blank"] .initial').textContent, '?');
    tile.focus(); app.key(457);
    assert.equal(app.document.querySelector('#optionsPanel .panel-head small').textContent, title);
    assert.equal(app.document.querySelector('#optionsPanel .panel-head img'), null);
    app.key(461); app.key(86, 'keydown', { key: 'v' });
    assert.equal(app.document.querySelector('#searchRows .sl').textContent, title);
    assert.equal(app.document.querySelector('#searchRows img'), null);
});

test('settings cycle choices, toggles and accents; save errors are visible; action rows ignore arrows', t => {
    const app = appFor(t); ready(app); app.click('#settingsBtn');
    assert.equal(app.window.getComputedStyle(app.document.querySelector('#grid .label')).display, 'block');
    assert.equal(app.window.getComputedStyle(row(app, 'accent').querySelector('.val')).display, 'flex');
    for (const key of ['accent', 'tileSize', 'labels', 'showSystemStats', 'dateFormat', 'sort']) {
        row(app, key).focus(); app.key(39); save(app); app.key(37); save(app);
    }
    row(app, 'close').focus(); const count = app.calls.length; app.key(39); assert.equal(app.calls.length, count);
    app.click('[data-key="labels"]');
    const call = app.calls.find(c => c.method === 'setPrefs' && !c.answered); call.answered = true; call.onFailure({ errorText: 'disk full' });
    assert.match(app.document.querySelector('#err').textContent, /disk full/);
    app.click('[data-key="reset"]'); app.click('[data-key="reset-confirm"]');
    assert.equal(app.document.body.classList.contains('no-labels'), false);
    app.click('[data-key="close"]'); assert.equal(app.document.querySelector('#settingsPanel').classList.contains('show'), false);
});

test('default brand opens a remote-friendly first-run editor and saves the header name', t => {
    const app = appFor(t);
    app.tiles({ tiles: [video], inputs: [port], prefs: {},
        header: { text: 'Welcome', brand: 'Minimal Home' } });
    const panel = app.document.querySelector('#brandPanel');
    const input = app.document.querySelector('#brandInput');
    assert.ok(panel.classList.contains('show'));
    assert.equal(app.document.activeElement, input);
    assert.equal(input.value, 'Minimal Home');
    assert.match(panel.querySelector('.brand-help').textContent, /upper-left header/);
    assert.equal(app.key(13).defaultPrevented, false, 'OK on the field remains available to the TV keyboard');
    app.key(13, 'keyup');
    input.value = '   '; app.click('[data-key="brand-save"]');
    assert.match(app.document.querySelector('#brandError').textContent, /1 to 40/);
    assert.ok(panel.classList.contains('show'));
    input.value = 'Living Room'; input.dispatchEvent(new app.window.Event('input'));
    assert.equal(app.document.querySelector('#brandPreview').textContent, 'Living Room');
    app.key(40); app.key(40, 'keyup'); app.key(13); app.key(13, 'keyup');
    const call = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    assert.equal(call.parameters.brand, 'Living Room');
    assert.equal(call.parameters.brandConfigured, true);
    assert.equal(app.document.querySelector('#headBrand').textContent, 'Living Room');
    assert.equal(app.document.title, 'Living Room');
    save(app);
});

test('non-default configured brands skip setup and remain editable from Settings', t => {
    const app = appFor(t);
    app.tiles({ tiles: [video], inputs: [], prefs: {},
        header: { text: 'Hello', brand: 'Family TV' } });
    assert.equal(app.document.querySelector('#brandPanel.show'), null);
    assert.equal(app.document.querySelector('#headBrand').textContent, 'Family TV');
    app.click('#settingsBtn');
    assert.equal(row(app, 'brand').querySelector('.val').textContent, 'Family TV');
    app.click('[data-key="brand"]');
    assert.ok(app.document.querySelector('#brandPanel.show'));
    assert.equal(app.document.querySelector('#brandInput').value, 'Family TV');
    app.click('[data-key="brand-cancel"]');
    assert.ok(app.document.querySelector('#settingsPanel.show'));
    assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 0);
});

test('keeping the default brand records setup so updates do not ask again', t => {
    const app = appFor(t);
    const response = { tiles: [video], inputs: [], prefs: {},
        header: { text: 'Welcome', brand: 'Minimal Home' } };
    app.tiles(response);
    app.key(40); app.key(40, 'keyup'); app.key(40); app.key(40, 'keyup');
    assert.equal(app.document.activeElement.getAttribute('data-key'), 'brand-cancel');
    app.key(13); app.key(13, 'keyup');
    const call = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    assert.deepEqual(Object.keys(call.parameters), ['brandConfigured']);
    assert.equal(call.parameters.brandConfigured, true);
    save(app);
    const updated = appFor(t);
    updated.tiles({ ...response, prefs: { brandConfigured: true } });
    assert.equal(updated.document.querySelector('#brandPanel.show'), null);
});

test('back never closes the brand name editor', t => {
    const app = appFor(t);
    app.tiles({ tiles: [video], inputs: [], prefs: {},
        header: { text: 'Welcome', brand: 'Minimal Home' } });
    const panel = app.document.querySelector('#brandPanel');
    const input = app.document.querySelector('#brandInput');
    input.value = 'My TV';
    for (const code of [461, 27, 8]) {
        assert.equal(app.key(code).defaultPrevented, false, 'back reaches the field while typing ' + code);
        assert.ok(panel.classList.contains('show'), 'first-run editor stays open for back key ' + code);
    }
    assert.equal(input.value, 'My TV');
    app.key(40); app.key(40, 'keyup');
    assert.equal(app.document.activeElement.getAttribute('data-key'), 'brand-save');
    for (const code of [461, 27, 8]) {
        assert.equal(app.key(code).defaultPrevented, true, 'back off the field is swallowed ' + code);
        assert.ok(panel.classList.contains('show'), 'first-run editor stays open off the field ' + code);
    }
    assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 0);

    const settings = appFor(t);
    settings.tiles({ tiles: [video], inputs: [], prefs: {},
        header: { text: 'Hello', brand: 'Family TV' } });
    settings.click('#settingsBtn');
    settings.click('[data-key="brand"]');
    assert.ok(settings.document.querySelector('#brandPanel.show'));
    settings.key(40); settings.key(40, 'keyup');
    assert.equal(settings.document.activeElement.getAttribute('data-key'), 'brand-save');
    assert.equal(settings.key(461).defaultPrevented, true);
    assert.ok(settings.document.querySelector('#brandPanel.show'), 'settings editor stays open');
    assert.equal(settings.document.querySelector('#settingsPanel.show'), null);
    assert.equal(settings.calls.filter(c => c.method === 'setPrefs').length, 0);
});

test('clock format row shows friendly names with live previews', t => {
    const app = appFor(t); ready(app);
    app.click('#settingsBtn');
    const names = {
        'HH:mm': '24-hour',
        'h:mm A': '12-hour',
        'HH:mm:ss': '24-hour + seconds',
        'h:mm:ss A': '12-hour + seconds',
        'MMM D, HH:mm': 'Date + 24-hour',
        'MMM D, h:mm A': 'Date + 12-hour',
        'YYYY-MM-DD HH:mm': 'ISO date + time',
        'DD/MM/YYYY HH:mm': 'Day-first date + time'
    };
    assert.equal(row(app, 'dateFormat').querySelector('.sl').textContent, 'Clock format');
    for (const token of Object.keys(names)) {
        const val = row(app, 'dateFormat').querySelector('.val').textContent;
        assert.ok(val.startsWith(names[token]), token + ' shows a friendly name, got ' + val);
        assert.match(val, /\d/, token + ' shows a live preview');
        app.click('[data-key="dateFormat"]');
    }
    for (let i = 0; i < 8; i++) {
        if (!app.calls.some(c => c.method === 'setPrefs' && !c.answered)) break;
        save(app);
    }
});

test('reset asks first; cancel and back keep customization', t => {
    for (const dismiss of ['click', 'back']) {
        const app = appFor(t);
        ready(app, { prefs: { pinned: ['video'], labels: false } });
        app.click('#settingsBtn');
        app.click('[data-key="reset"]');
        assert.ok(app.document.querySelector('#confirmPanel.show'));
        assert.equal(app.document.querySelector('#settingsPanel.show'), null);
        assert.equal(app.document.activeElement.getAttribute('data-key'), 'reset-cancel');
        assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 0);
        if (dismiss === 'click') app.click('[data-key="reset-cancel"]');
        else app.key(461);
        assert.ok(app.document.querySelector('#settingsPanel.show'));
        assert.equal(app.document.querySelector('#confirmPanel.show'), null);
        assert.equal(app.document.activeElement.getAttribute('data-key'), 'reset');
        assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 0);
        assert.ok(app.document.body.classList.contains('no-labels'));
    }
});

test('a held OK cannot confirm the reset dialog', t => {
    const app = appFor(t); ready(app);
    app.click('#settingsBtn');
    app.click('[data-key="labels"]'); save(app);
    row(app, 'reset').focus();
    app.key(13);
    assert.ok(app.document.querySelector('#confirmPanel.show'));
    app.key(13);
    assert.ok(app.document.querySelector('#confirmPanel.show'));
    assert.equal(app.calls.filter(c => c.method === 'setPrefs' && !c.answered).length, 0);
    app.key(13, 'keyup');
    app.key(40); app.key(40, 'keyup');
    assert.equal(app.document.activeElement.getAttribute('data-key'), 'reset-confirm');
    app.key(13); app.key(13, 'keyup');
    const call = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    assert.equal(call.parameters.labels, true);
    save(app);
    assert.ok(app.document.querySelector('#settingsPanel.show'));
    assert.equal(app.document.activeElement.getAttribute('data-key'), 'reset');
});

test('reset failure stays visible with settings open', t => {
    const app = appFor(t); ready(app);
    app.click('#settingsBtn');
    app.click('[data-key="labels"]'); save(app);
    app.click('[data-key="reset"]');
    app.click('[data-key="reset-confirm"]');
    const call = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    call.answered = true; call.onFailure({ errorText: 'disk full' });
    assert.match(app.document.querySelector('#err').textContent, /disk full/);
    assert.ok(app.document.querySelector('#settingsPanel.show'));
});

test('status shows build, tile and relay health and refreshes on demand', async t => {
    const app = appFor(t); ready(app);
    await app.clock.run(1000); app.respond('getSystemStats', { returnValue: true, cpu: 0, ram: 60, temp: 65 });
    app.click('#settingsBtn');
    assert.equal(row(app, 'status').querySelector('.val').textContent, app.window.MH_CONFIG.version);
    app.click('[data-key="status"]');
    const panel = app.document.querySelector('#statusPanel');
    assert.ok(panel.classList.contains('show'));
    assert.match(panel.textContent, /Tiles/);
    assert.match(panel.textContent, /ok/);
    assert.match(panel.textContent, /fresh/);
    assert.match(panel.textContent, /reachable/);
    assert.match(panel.textContent, /Made by Pragalbha Patil/);
    const before = app.calls.filter(c => c.method === 'getTiles').length;
    app.click('[data-key="status-refresh"]');
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, before + 1);
    app.tiles({ tiles: [video], inputs: [port] });
    assert.ok(panel.classList.contains('show'), 'panel survives its own refresh');
    app.key(40); app.key(40, 'keyup');
    assert.ok(panel.classList.contains('show'));
    app.click('[data-key="status-close"]');
    assert.ok(app.document.querySelector('#settingsPanel.show'));
    assert.equal(app.document.activeElement.getAttribute('data-key'), 'status');
    assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 0);
});

test('status reports failed tiles, disabled and stale stats', async t => {
    const app = appFor(t);
    app.respond('getTiles', { returnValue: false });
    app.click('#settingsBtn');
    app.click('[data-key="status"]');
    assert.match(app.document.querySelector('#statusPanel').textContent, /failed/);
    assert.match(app.document.querySelector('#statusPanel').textContent, /unreachable/);
    const quiet = appFor(t);
    ready(quiet, { prefs: { showSystemStats: false } });
    quiet.click('#settingsBtn'); quiet.click('[data-key="status"]');
    assert.match(quiet.document.querySelector('#statusPanel').textContent, /disabled/);
    const stale = appFor(t); ready(stale);
    await stale.clock.run(1000);
    stale.respond('getSystemStats', { returnValue: true, cpu: 0, ram: 60, temp: 65 });
    stale.window.__mhHealth.statsAt -= 60000;
    stale.click('#settingsBtn'); stale.click('[data-key="status"]');
    assert.match(stale.document.querySelector('#statusPanel').textContent, /stale/);
});

test('status marks stats failed on older relay responses', async t => {
    const app = appFor(t); ready(app);
    await app.clock.run(1000); app.respond('getSystemStats', {});
    app.click('#settingsBtn'); app.click('[data-key="status"]');
    assert.match(app.document.querySelector('#statusPanel').textContent, /failed/);
});

test('status opens LG Home through the relay', t => {
    const app = appFor(t); ready(app);
    app.click('#settingsBtn'); app.click('[data-key="status"]');
    app.click('[data-key="status-lghome"]');
    assert.ok(app.calls.find(c => c.method === 'openLGHome'));
    assert.ok(app.document.querySelector('#statusPanel.show'), 'panel stays open');
    app.key(461);
    assert.ok(app.document.querySelector('#settingsPanel.show'));
    assert.equal(app.document.activeElement.getAttribute('data-key'), 'status');
});

test('grouped settings keep remote navigation on controls across section headings', t => {
    const app = appFor(t); ready(app); app.click('#settingsBtn');
    assert.deepEqual([...app.document.querySelectorAll('#settingsRows h2')].map(el => el.textContent),
        ['Header', 'TV', 'Clock & status', 'Appearance', 'Apps', 'Preferences']);
    const controls = [...app.document.querySelectorAll('#settingsRows .srow')];
    assert.equal(app.document.activeElement, controls[0]);
    for (let i = 1; i <= controls.length; i++) {
        app.key(40); app.key(40, 'keyup');
        assert.equal(app.document.activeElement, controls[i % controls.length]);
    }
    app.key(38); app.key(38, 'keyup');
    assert.equal(app.document.activeElement, row(app, 'close'));
    app.key(461);
    assert.equal(app.document.querySelector('#settingsPanel').classList.contains('show'), false);
});

test('late preference replies cannot overwrite a newer local edit', t => {
    const app = appFor(t); app.tiles({ tiles: [video], inputs: [] });
    app.click('#settingsBtn'); app.click('[data-key="labels"]');
    app.visible(false); app.visible(true);
    assert.equal(app.calls.filter(c => c.method === 'getPrefs').length, 1,
        'foreground reload must not fetch stale preferences while saving');
    app.prefs({ labels: true }); assert.equal(app.document.body.classList.contains('no-labels'), true);
    app.click('[data-key="labels"]');
    assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 1, 'writes must be serialized');
    // The first toggle was persisted, so reverting it requires a second write.
    save(app); assert.equal(app.document.body.classList.contains('no-labels'), false);
    assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 2);
    save(app);
});

test('options Launch and Close rows work and unrelated overlay keys are ignored', t => {
    const app = appFor(t); ready(app); app.document.querySelector('#grid .tile').focus();
    app.key(457); assert.equal(app.key(112, 'keydown', { key: 'F1' }).defaultPrevented, false);
    app.click('#optionsRows .optrow:nth-child(4)'); assert.equal(app.document.querySelector('#optionsPanel.show'), null);
    app.key(457); app.click('#optionsRows .optrow:nth-child(3)'); assert.equal(app.calls.at(-1).parameters.id, 'video');
    app.respond('launchApp', { returnValue: true });
});

test('Settings tile opens launcher preferences and TV settings action launches the platform settings', async t => {
    const app = appFor(t); ready(app, { tiles: [video, { id: C.SETTINGS_ID, title: 'Settings' }] });
    app.click('[data-id="' + C.SETTINGS_ID + '"]'); assert.ok(app.document.querySelector('#settingsPanel.show'));
    app.click('[data-key="tvsettings"]'); assert.equal(app.calls.at(-1).parameters.id, C.SETTINGS_ID);
    app.respond('launchApp', { returnValue: true }); await app.clock.run(250);
    app.click('[data-id="__LGHOME__"]'); app.respond('openLGHome', { returnValue: false, errorText: 'denied' });
    assert.match(app.document.querySelector('#err').textContent, /denied/);
});

test('long OK opens options without launching; pin, hide, restore, and close work', async t => {
    const app = appFor(t); ready(app); const tile = app.document.querySelector('#grid .tile'); tile.focus();
    app.key(13); app.key(13); await app.clock.run(700); app.key(13);
    assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 0);
    app.key(13, 'keyup');
    assert.equal(app.calls.filter(c => c.method === 'launchApp').length, 0);
    app.click('#optionsRows .optrow'); save(app); app.tiles({ tiles: [video], inputs: [port] });
    assert.ok(app.document.querySelector('#grid .pin'));
    app.document.querySelector('#grid .tile').focus(); app.key(412); app.click('#optionsRows .optrow'); save(app);
    app.tiles({ tiles: [video], inputs: [port] }); assert.equal(app.document.querySelector('#grid .pin'), null);
    app.document.querySelector('#grid .tile').focus(); app.key(457); app.click('#optionsRows .optrow:nth-child(2)'); save(app);
    app.tiles({ tiles: [video], inputs: [port] }); assert.deepEqual(ids(app, 'grid'), []);
    app.click('#settingsBtn'); app.click('[data-key="manage"]'); assert.match(app.document.querySelector('#optionsRows').textContent, /Video/);
    app.click('#optionsRows [data-id="video"]'); save(app); app.tiles({ tiles: [video], inputs: [port] }); assert.deepEqual(ids(app, 'grid'), ['video']);
    app.click('#settingsBtn'); app.click('[data-key="manage"]'); assert.match(app.document.querySelector('#optionsRows').textContent, /No hidden/);
    app.click('#optionsRows [data-key="close"]');
});

test('search ranks prefixes before substrings, caps results, edits only with Backspace and closes with Back', t => {
    const app = appFor(t); ready(app, { tiles: [{ id: 'prefix', title: 'App' }, { id: 'contains', title: 'My App' },
        ...Array.from({ length: 10 }, (_, i) => ({ id: 'app' + i, title: 'App ' + i }))] });
    app.key(65, 'keydown', { key: 'a' });
    assert.equal(app.document.querySelectorAll('#searchRows .srow').length, 8);
    assert.equal(app.document.querySelector('#searchRows .srow').dataset.id, 'prefix');
    assert.equal(app.document.activeElement, app.document.querySelector('#searchInput'));
    const input = app.document.querySelector('#searchInput');
    input.value = 'ap'; input.dispatchEvent(new app.window.Event('input'));
    assert.equal(input.value, 'ap');
    app.key(40); app.key(40, 'keyup');
    assert.equal(app.document.activeElement, app.document.querySelector('#searchRows .srow'));
    app.key(8);
    assert.equal(input.value, 'a');
    app.key(461); assert.equal(app.document.querySelector('#searchBox.show'), null);
    app.key(81, 'keydown', { key: 'q' });
    assert.match(app.document.querySelector('#searchRows').textContent, /No matches/);
    app.key(40); app.key(40, 'keyup');
    app.key(8);
    assert.equal(input.value, '');
    app.key(8); assert.equal(app.document.querySelector('#searchBox.show'), null);
    assert.equal(app.key(461).defaultPrevented, true);
});

test('search launches input parameters; double taps and stale launch completions cannot unlock a newer launch', async t => {
    const app = appFor(t); ready(app); app.key(80, 'keydown', { key: 'p' });
    app.key(40); app.key(40, 'keyup'); app.key(13);
    const first = app.calls.find(c => c.method === 'launchApp');
    assert.equal(first.parameters.id, port.id); assert.equal(first.parameters.params.value, 4);
    assert.equal(first.parameters.params.id, undefined);
    app.click('#grid .tile'); assert.equal(app.calls.filter(c => c.method === 'launchApp').length, 1);
    await app.clock.run(4000); app.click('#grid .tile');
    first.onSuccess({ returnValue: true }); await app.clock.run(250);
    app.click('#grid .tile'); assert.equal(app.calls.filter(c => c.method === 'launchApp').length, 2);
    first.onFailure({ errorText: 'late' });
    const second = app.calls.filter(c => c.method === 'launchApp')[1]; second.onFailure({ errorText: 'offline' });
    await app.clock.run(0); assert.match(app.document.querySelector('#err').textContent, /offline/);
});

test('move reorders pinned apps and saves on OK', t => {
    const alpha = { id: 'alpha', title: 'Alpha', icon: 'icons/alpha.png' };
    const app = appFor(t);
    ready(app, { tiles: [video, alpha], prefs: { pinned: ['video', 'alpha'] } });
    assert.deepEqual(ids(app, 'grid').slice(0, 2), ['video', 'alpha']);
    app.document.querySelector('#grid [data-id="video"]').focus(); app.key(457);
    const rows = [...app.document.querySelectorAll('#optionsRows .optrow')].map(r => r.textContent);
    assert.ok(rows.includes('Move'));
    app.click('#optionsRows .optrow:nth-child(3)');
    assert.equal(app.document.querySelector('#moveHint').style.display, 'block');
    let moved = app.document.querySelector('#grid [data-id="video"]');
    assert.equal(app.document.activeElement, moved);
    assert.ok(moved.classList.contains('moving'));
    app.key(37); app.key(37, 'keyup');
    assert.deepEqual(ids(app, 'grid').slice(0, 2), ['video', 'alpha']);
    app.key(39); app.key(39, 'keyup');
    assert.deepEqual(ids(app, 'grid').slice(0, 2), ['alpha', 'video']);
    assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 0);
    assert.equal(app.document.activeElement.getAttribute('data-id'), 'video');
    app.key(39); app.key(39, 'keyup');
    assert.deepEqual(ids(app, 'grid').slice(0, 2), ['alpha', 'video']);
    app.key(13); app.key(13, 'keyup');
    const call = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    assert.deepEqual([...call.parameters.pinned], ['alpha', 'video']);
    save(app);
    assert.equal(app.document.querySelector('#moveHint').style.display, 'none');
    assert.equal(app.document.querySelectorAll('#grid .tile.moving').length, 0);
    assert.deepEqual(ids(app, 'grid').slice(0, 2), ['alpha', 'video']);
    assert.equal(app.document.activeElement.getAttribute('data-id'), 'video');
});

test('back cancels a pin move without saving', t => {
    const alpha = { id: 'alpha', title: 'Alpha', icon: 'icons/alpha.png' };
    const app = appFor(t);
    ready(app, { tiles: [video, alpha], prefs: { pinned: ['video', 'alpha'] } });
    app.document.querySelector('#grid [data-id="video"]').focus(); app.key(457);
    app.click('#optionsRows .optrow:nth-child(3)');
    app.key(39); app.key(39, 'keyup');
    assert.deepEqual(ids(app, 'grid').slice(0, 2), ['alpha', 'video']);
    app.key(461);
    assert.deepEqual(ids(app, 'grid').slice(0, 2), ['video', 'alpha']);
    assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 0);
    assert.equal(app.document.querySelector('#moveHint').style.display, 'none');
    assert.equal(app.document.querySelectorAll('#grid .tile.moving').length, 0);
    assert.equal(app.document.querySelector('#optionsPanel.show'), null);
    assert.equal(app.document.activeElement.getAttribute('data-id'), 'video');
});

test('exiting move mode without changes clears the marker', t => {
    const alpha = { id: 'alpha', title: 'Alpha', icon: 'icons/alpha.png' };
    const app = appFor(t);
    ready(app, { tiles: [video, alpha], prefs: { pinned: ['video', 'alpha'] } });
    app.document.querySelector('#grid [data-id="video"]').focus(); app.key(457);
    app.click('#optionsRows .optrow:nth-child(3)');
    assert.ok(app.document.querySelector('#grid .tile.moving'));
    app.key(13); app.key(13, 'keyup');
    assert.equal(app.document.querySelectorAll('#grid .tile.moving').length, 0);
    assert.equal(app.document.querySelector('#moveHint').style.display, 'none');
});

test('move is hidden for single pins, unpinned tiles, and alphabetical sort', t => {
    const alpha = { id: 'alpha', title: 'Alpha', icon: 'icons/alpha.png' };
    const labels = () => [...app.document.querySelectorAll('#optionsRows .optrow')].map(r => r.textContent);
    const app = appFor(t);
    ready(app, { tiles: [video, alpha], prefs: { pinned: ['video'] } });
    app.document.querySelector('#grid [data-id="video"]').focus(); app.key(457);
    assert.ok(!labels().includes('Move'));
    app.key(461);
    app.document.querySelector('#grid [data-id="alpha"]').focus(); app.key(457);
    assert.ok(!labels().includes('Move'));
    app.key(461);
    const ordered = appFor(t);
    ready(ordered, { tiles: [video, alpha], prefs: { pinned: ['video', 'alpha'], sort: 'alpha' } });
    ordered.document.querySelector('#grid [data-id="video"]').focus(); ordered.key(457);
    assert.ok(![...ordered.document.querySelectorAll('#optionsRows .optrow')].map(r => r.textContent).includes('Move'));
});

test('search opens from the header button and launches with remote only', t => {
    const app = appFor(t); ready(app, { tiles: [video], inputs: [port] });
    app.click('#searchBtn');
    const input = app.document.querySelector('#searchInput');
    assert.ok(app.document.querySelector('#searchBox.show'));
    assert.equal(app.document.activeElement, input);
    assert.match(app.document.querySelector('#searchRows').textContent, /Type to search/);
    input.value = 'play'; input.dispatchEvent(new app.window.Event('input'));
    assert.equal(app.document.querySelector('#searchRows .srow').dataset.id, port.id);
    assert.equal(app.key(13).defaultPrevented, false, 'OK on the field remains available to the TV keyboard');
    app.key(13, 'keyup');
    app.key(40); app.key(40, 'keyup'); app.key(13); app.key(13, 'keyup');
    const launch = app.calls.find(c => c.method === 'launchApp');
    assert.equal(launch.parameters.id, port.id);
    assert.equal(launch.parameters.params.value, 4);
    assert.equal(app.document.querySelector('#searchBox.show'), null);
});

test('back from the search field leaves the field instead of closing', t => {
    const app = appFor(t); ready(app, { tiles: [video], inputs: [port] });
    const btn = app.document.querySelector('#searchBtn'); btn.focus();
    app.key(13); app.key(13, 'keyup');
    const input = app.document.querySelector('#searchInput');
    input.value = 'vid'; input.dispatchEvent(new app.window.Event('input'));
    assert.equal(app.key(8).defaultPrevented, false, 'Backspace reaches the field natively');
    assert.equal(input.value, 'vid');
    assert.ok(app.document.querySelector('#searchBox.show'));
    assert.equal(app.key(461).defaultPrevented, true);
    assert.ok(app.document.querySelector('#searchBox.show'), 'first Back leaves the field');
    assert.equal(app.document.activeElement, app.document.querySelector('#searchRows .srow'));
    assert.equal(input.value, 'vid');
    app.key(461);
    assert.equal(app.document.querySelector('#searchBox.show'), null);
    assert.equal(app.document.activeElement, btn);
});

test('typing from the result rows appends to the query', t => {
    const app = appFor(t); ready(app, { tiles: [video], inputs: [] });
    app.click('#searchBtn');
    const input = app.document.querySelector('#searchInput');
    input.value = 'vid'; input.dispatchEvent(new app.window.Event('input'));
    app.key(40); app.key(40, 'keyup');
    app.key(69, 'keydown', { key: 'e' });
    assert.equal(input.value, 'vide');
    assert.equal(app.document.activeElement, app.document.querySelector('#searchRows .srow'));
});

test('pin and unpin send the updated pinned list', t => {
    const alpha = { id: 'alpha', title: 'Alpha', icon: 'icons/alpha.png' };
    const app = appFor(t);
    app.tiles({ tiles: [video, alpha], inputs: [], prefs: { pinned: ['video'] } });
    app.document.querySelector('#grid [data-id="alpha"]').focus(); app.key(457);
    app.click('#optionsRows .optrow:nth-child(1)');
    let call = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    assert.deepEqual([...call.parameters.pinned], ['video', 'alpha']);
    save(app);
    app.document.querySelector('#grid [data-id="alpha"]').focus(); app.key(457);
    app.click('#optionsRows .optrow:nth-child(1)');
    call = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    assert.deepEqual([...call.parameters.pinned], ['video']);
    save(app);
    assert.ok(!app.document.querySelector('#grid [data-id="alpha"]').classList.contains('pinned'));
});

test('remote navigation, repeating arrows, focus restoration and overlays stay usable', async t => {
    const app = appFor(t); ready(app, { tiles: [video, { id: 'two', title: 'Two' }, { id: 'three', title: 'Three' }] });
    const tiles = [...app.document.querySelectorAll('.tile')];
    tiles.forEach((tile, i) => { tile.getBoundingClientRect = () => ({ left: i % 3 * 150, top: Math.floor(i / 3) * 150, width: 100, height: 100 }); });
    tiles[0].focus(); app.key(39); const focused = app.document.activeElement; app.key(39); assert.equal(app.document.activeElement, focused);
    await app.clock.run(450); await app.clock.run(150); await app.clock.run(150);
    for (let i = 0; i < 8; i++) await app.clock.run(90);
    await app.clock.run(55); app.key(39, 'keyup');
    for (const key of [37, 38, 40]) { app.key(key); app.key(key, 'keyup'); }
    app.click('#settingsBtn'); app.key(40); app.key(38); row(app, 'labels').focus(); app.key(13); app.key(13, 'keyup'); save(app);
    app.key(27); app.document.querySelector('#grid .tile').focus(); app.key(457); app.key(40); app.key(37); app.key(461);
    app.click('#settingsBtn'); app.click('[data-key="manage"]'); app.key(40); app.key(38); app.key(461);
    app.key(86, 'keydown', { key: 'v' }); app.key(40); app.key(38); app.key(461);
    app.document.querySelector('#grid .tile').focus(); app.key(13); app.key(13, 'keyup');
    assert.equal(app.calls.at(-1).method, 'launchApp');
});

test('blur/background cancels held keys and skips stats polling; foreground reloads preferences', async t => {
    const app = appFor(t); ready(app); app.document.querySelector('#grid .tile').focus();
    app.key(39); app.key(13); app.window.dispatchEvent(new app.window.Event('blur'));
    await app.clock.run(450); await app.clock.run(700); assert.equal(app.document.querySelector('#optionsPanel.show'), null);
    app.visible(false); await app.clock.run(1000);
    assert.equal(app.calls.filter(c => c.method === 'getSystemStats').length, 0);
    app.visible(true); app.tiles({ prefs: { showSystemStats: false } });
    await app.clock.run(5000); assert.equal(app.calls.filter(c => c.method === 'getSystemStats').length, 0);
});

test('webOS foreground focus overrides a stale hidden state for tiles and stats', async t => {
    const app = appFor(t, { hidden: true, focused: true });
    ready(app);
    assert.deepEqual(ids(app, 'grid'), ['video']);
    await app.clock.run(1000);
    assert.equal(app.calls.filter(c => c.method === 'getSystemStats').length, 1);
    app.visible(false);
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, 2);
});

test('stats render numbers and unknowns, and header updates use text rather than HTML', async t => {
    const app = appFor(t); app.tiles({ header: { text: '<hello>', brand: '<Brand>' } }); app.prefs();
    assert.equal(app.document.querySelector('#headText').textContent, '<HELLO>'); assert.equal(app.document.title, '<Brand>');
    await app.clock.run(1000); app.respond('getSystemStats', { returnValue: true, cpu: 0, ram: 60, temp: 65 });
    assert.equal(app.document.querySelector('#statCpu').textContent, '0%');
    await app.clock.run(5000); app.respond('getSystemStats', { returnValue: true });
    assert.equal(app.document.querySelector('#statTemp').textContent, '--°C');
    assert.ok(app.document.querySelector('#clock small').textContent.length);
});

test('live tiles handle malformed parameters and keyboard Settings works', async t => {
    const app = appFor(t);
    ready(app);
    app.document.querySelector('#grid .tile').dataset.params = '{broken';
    app.click('#grid .tile'); assert.deepEqual(Object.keys(app.calls.at(-1).parameters.params), []);
    app.respond('launchApp', { returnValue: true }); await app.clock.run(250);
    app.document.querySelector('#settingsBtn').focus(); app.key(13); app.key(13, 'keyup');
    assert.ok(app.document.querySelector('#settingsPanel.show'));
    app.key(461);
    app.document.activeElement.blur(); app.key(39); app.key(39, 'keyup');
    assert.ok(app.document.activeElement.classList.contains('tile'));
});

test('live system tiles remain unique, multiple pins keep their order, and unknown settings rows are inert', t => {
    const app = appFor(t);
    app.tiles({ tiles: [video, { id: 'two', title: 'Two' }, { id: C.SETTINGS_ID, title: 'Settings' }], inputs: [] });
    app.prefs({ pinned: ['two', 'video'] }); assert.deepEqual(ids(app, 'grid'), ['two', 'video']);
    assert.equal(ids(app, 'sysrow').filter(id => id === C.SETTINGS_ID).length, 1);
    app.click('#settingsBtn');
    const unknown = app.document.createElement('div'); unknown.className = 'srow'; unknown.dataset.key = 'removed-setting';
    app.document.querySelector('#settingsRows').appendChild(unknown);
    const count = app.calls.length; unknown.click(); assert.equal(app.calls.length, count);
});


test('startup waits for TV discovery and does not invent system apps', t => {
    const app = appFor(t);
    for (const row of ['grid', 'inputs', 'sysrow']) assert.deepEqual(ids(app, row), []);
    assert.equal(app.document.querySelector('#tileStatus').style.display, 'flex');
    assert.equal(app.calls.filter(c => c.method === 'getPrefs').length, 0);
    assert.deepEqual(ids(app, 'sysrow'), []);
    app.tiles({ prefs: {} });
    assert.equal(app.document.querySelector('#tileStatus').style.display, 'none');
    assert.deepEqual(ids(app, 'sysrow'), ['__LGHOME__']);
    assert.equal(app.document.activeElement.dataset.id, '__LGHOME__');
});

test('failed discovery stops spinning after bounded retries and Retry recovers', async t => {
    const app = appFor(t);
    for (let i = 0; i < 6; i++) {
        app.respond('getTiles', { returnValue: false });
        if (i < 5) await app.clock.run(2500);
    }
    assert.equal(app.document.querySelector('#tileSpinner').style.display, 'none');
    assert.equal(app.document.querySelector('#retryTiles').style.display, 'block');
    assert.deepEqual(ids(app, 'grid'), []);
    const settings = app.document.querySelector('#settingsBtn');
    const retry = app.document.querySelector('#retryTiles');
    settings.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 50 });
    retry.getBoundingClientRect = () => ({ left: 0, top: 100, width: 100, height: 50 });
    settings.focus(); app.key(40); app.key(40, 'keyup');
    assert.equal(app.document.activeElement, retry);
    app.click('#retryTiles');
    assert.equal(app.document.querySelector('#tileSpinner').style.display, 'block');
    app.tiles({ tiles: [video], inputs: [port] });
    assert.deepEqual(ids(app, 'grid'), ['video']);
    assert.deepEqual(ids(app, 'inputs'), [port.id]);
    assert.equal(app.document.querySelector('#tileStatus').style.display, 'none');
});


test('arrow navigation from the retry tile keeps focus when nothing wraps', async t => {
    const app = appFor(t);
    for (let i = 0; i < 6; i++) {
        app.respond('getTiles', { returnValue: false });
        if (i < 5) await app.clock.run(2500);
    }
    const retry = app.document.querySelector('#retryTiles');
    retry.focus();
    app.key(40); app.key(40, 'keyup');
    assert.equal(app.document.activeElement, retry);
});


test('explicit desktop preview tiles retain their click handlers', t => {
    const app = appFor(t, { prepare(window) {
        window.document.querySelector('#grid').innerHTML = '<div class="tile" tabindex="0" data-id="preview">Preview</div>';
    } });
    app.click('#grid .tile');
    assert.equal(app.calls.at(-1).parameters.id, 'preview');
});


test('unchanged discovery preserves tiles and focus but retries failed icons', async t => {
    const app = appFor(t); ready(app);
    const tile = app.document.querySelector('#grid .tile');
    tile.querySelector('img').dispatchEvent(new app.window.Event('error'));
    tile.focus();
    app.window.dispatchEvent(new app.window.Event('focus'));
    app.tiles({ tiles: [video], inputs: [port] });
    assert.equal(app.document.querySelector('#grid .tile'), tile);
    assert.ok(tile.querySelector('img'));
    const retry = tile.querySelector('img');
    assert.equal(app.document.activeElement, tile);
    await app.clock.run(400);
    app.visible(true); app.tiles({ tiles: [video], inputs: [port], prefs: {} });
    assert.equal(app.document.querySelector('#grid .tile'), tile);
    assert.equal(tile.querySelector('img'), retry, 'successful images are retained');
    await app.clock.run(400);
    app.window.dispatchEvent(new app.window.Event('focus'));
    app.tiles({ tiles: [{ ...video, title: 'Renamed' }], inputs: [port], prefs: {} });
    assert.equal(app.document.querySelector('#grid .label').textContent, 'Renamed');
});

test('relaunch refreshes live tiles and a background event cannot consume the foreground refresh', async t => {
    const app = appFor(t); ready(app);
    const before = app.calls.filter(c => c.method === 'getTiles').length;
    app.visible(false);
    app.document.dispatchEvent(new app.window.Event('webOSRelaunch'));
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, before);
    app.visible(true);
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, before + 1);
    app.tiles({ tiles: [video], inputs: [port] }); app.prefs();
    await app.clock.run(400);
    app.document.dispatchEvent(new app.window.Event('webOSRelaunch'));
    app.window.dispatchEvent(new app.window.Event('focus'));
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, before + 2);
});

test('foreground refresh during in-flight discovery runs one trailing refresh', async t => {
    const app = appFor(t);
    const stale = { id: 'stale', title: 'Stale' };
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, 1);
    app.visible(false); app.visible(true);
    await app.clock.run(400);
    app.tiles({ tiles: [stale], inputs: [] });
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, 2);
    app.tiles({ tiles: [video], inputs: [port] });
    assert.deepEqual(ids(app, 'grid'), ['video']);
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, 2);
});

test('failed discovery with a pending foreground refresh retries immediately', async t => {
    const app = appFor(t);
    app.visible(false); app.visible(true);
    await app.clock.run(400);
    app.tiles({ returnValue: false });
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, 2);
    app.tiles({ tiles: [video], inputs: [port] });
    assert.deepEqual(ids(app, 'grid'), ['video']);
});

test('empty runtime header strings fall back to the configured default', t => {
    const app = appFor(t);
    app.tiles({ tiles: [], inputs: [], prefs: {}, header: { text: '', brand: '' } });
    assert.equal(app.document.querySelector('#headText').textContent, '');
    assert.equal(app.document.querySelector('#headBrand').textContent, 'Minimal Home');
    assert.equal(app.document.title, 'Minimal Home');
    assert.equal(app.document.querySelector('#brandPanel.show'), null);
});

test('changed discovery does not steal focus from an open settings panel', t => {
    const app = appFor(t); ready(app); app.click('#settingsBtn');
    const focused = app.document.activeElement;
    app.window.dispatchEvent(new app.window.Event('focus'));
    app.tiles({ tiles: [{ ...video, title: 'Updated' }], inputs: [port] });
    assert.equal(app.document.activeElement, focused);
});


test('one startup response applies preferences before any visible tiles are inserted', t => {
    const app = appFor(t);
    assert.deepEqual(app.calls.map(c => c.method), ['getTiles']);
    const observer = new app.window.MutationObserver(() => {});
    observer.observe(app.document.querySelector('#grid'), { childList: true });
    app.tiles({ tiles: [video, { id: 'hidden', title: 'Hidden' }], inputs: [port],
        prefs: { hidden: ['hidden'], labels: false, tileSize: 'compact', showSystemStats: false } });
    assert.deepEqual(ids(app, 'grid'), ['video']);
    assert.ok(app.document.body.classList.contains('density-compact'));
    assert.ok(app.document.body.classList.contains('no-labels'));
    const added = observer.takeRecords().flatMap(r => [...r.addedNodes]).map(n => n.dataset?.id);
    assert.deepEqual(added, ['video']); observer.disconnect();
    assert.equal(app.calls.filter(c => c.method === 'getPrefs').length, 0);
    app.visible(false); app.visible(true);
    app.tiles({ tiles: [video], inputs: [port], prefs: { labels: true } });
    assert.equal(app.document.body.classList.contains('no-labels'), false);
    assert.equal(app.calls.filter(c => c.method === 'getPrefs').length, 0);
});

test('bundled preferences requested before an edit cannot overwrite it after saving', t => {
    const app = appFor(t);
    app.click('#settingsBtn'); app.click('[data-key="labels"]'); save(app);
    app.tiles({ tiles: [video], inputs: [], prefs: { labels: true } });
    assert.equal(app.document.body.classList.contains('no-labels'), true);
});

test('rapid sort and accent edits keep the sort refresh after both saves', t => {
    const app = appFor(t);
    const alpha = { id: 'alpha', title: 'Alpha', icon: 'icons/alpha.png' };
    ready(app, { tiles: [video, alpha] });
    assert.deepEqual(ids(app, 'grid'), ['video', 'alpha']);
    const before = app.calls.filter(c => c.method === 'getTiles').length;
    app.click('#settingsBtn');
    app.click('[data-key="sort"]');
    app.click('[data-key="accent"]');
    save(app);
    const second = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    assert.deepEqual(Object.keys(second.parameters), ['accent']);
    // The relay returns the full merged profile, not just the second patch.
    app.respond('setPrefs', { returnValue: true, prefs: { sort: 'alpha', accent: second.parameters.accent } });
    assert.equal(app.calls.filter(c => c.method === 'getTiles').length, before + 1);
    app.tiles({ tiles: [video, alpha], inputs: [port] });
    assert.deepEqual(ids(app, 'grid'), ['alpha', 'video']);
});

test('editing before discovery completes sends only the edited preference', t => {
    const app = appFor(t);
    app.click('#settingsBtn');
    app.click('[data-key="labels"]');
    const call = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    assert.deepEqual(Object.keys(call.parameters), ['labels']);
    assert.equal(call.parameters.labels, false);
    save(app);
    app.tiles({ tiles: [video], inputs: [port],
        prefs: { pinned: ['video'], hidden: [], accent: 'emerald', sort: 'alpha', labels: false } });
    assert.deepEqual(ids(app, 'grid'), ['video']);
    assert.ok(app.document.body.classList.contains('no-labels'));
});

test('reverting an edit after dispatch compensates for the first persisted write', t => {
    const app = appFor(t); ready(app);
    app.click('#settingsBtn');
    app.click('[data-key="labels"]');
    app.click('[data-key="labels"]');
    save(app);
    assert.equal(app.calls.filter(c => c.method === 'setPrefs').length, 2);
    const second = app.calls.find(c => c.method === 'setPrefs' && !c.answered);
    assert.equal(second.parameters.labels, true);
    save(app);
    assert.equal(app.document.body.classList.contains('no-labels'), false);
});

test('bundled preferences requested during a save cannot overwrite the saved value', t => {
    for (const finishFirst of [false, true]) {
        const app = appFor(t); ready(app);
        app.click('#settingsBtn'); app.click('[data-key="labels"]');
        app.visible(false); app.visible(true);
        if (finishFirst) save(app);
        app.tiles({ tiles: [video], inputs: [port], prefs: { labels: true } });
        assert.equal(app.document.body.classList.contains('no-labels'), true);
        assert.equal(app.calls.filter(c => c.method === 'getPrefs').length, 0);
        if (!finishFirst) save(app);
    }
});

test('a malformed legacy preference response leaves the rendered launcher usable', t => {
    const app = appFor(t); app.tiles({ tiles: [video] });
    app.respond('getPrefs', { returnValue: true, prefs: null });
    assert.deepEqual(ids(app, 'grid'), ['video']);
    app.click('#grid .tile'); assert.equal(app.calls.at(-1).parameters.id, 'video');
});

test('minute clock aligns to rollover, preserves unchanged DOM, and pauses in the background', async t => {
    let now = new Date(2026, 0, 1, 23, 59, 30, 250).getTime();
    const app = appFor(t, { prepare(window) {
        const NativeDate = window.Date;
        window.Date = class extends NativeDate {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
        };
    } });
    ready(app, { prefs: { dateFormat: 'HH:mm', showSystemStats: false } });
    const clock = app.document.querySelector('#clock');
    assert.equal(clock.firstChild.textContent, '23:59');
    assert.ok([...app.clock.pending.values()].some(timer => timer.delay === 29750));
    const small = clock.querySelector('small');
    app.window.dispatchEvent(new app.window.Event('focus'));
    assert.equal(clock.querySelector('small'), small);
    now += 29750; await app.clock.run(29750);
    assert.equal(clock.firstChild.textContent, '00:00');
    assert.match(clock.querySelector('small').textContent, /2 Jan/);
    assert.equal([...app.clock.pending.values()].filter(timer => timer.delay === 60000).length, 1);
    app.visible(false);
    assert.equal([...app.clock.pending.values()].filter(timer => timer.delay === 60000).length, 0);
    const paused = clock.innerHTML;
    now += 120000; await app.clock.run(60000);
    assert.equal(clock.innerHTML, paused);
    app.visible(true);
    assert.equal(clock.firstChild.textContent, '00:02');
    assert.equal([...app.clock.pending.values()].filter(timer => timer.delay === 60000).length, 1);
});

test('clock switches between second and minute cadence and honors focused webOS foreground', async t => {
    let now = new Date(2026, 0, 1, 12, 30, 10, 250).getTime();
    const app = appFor(t, { hidden: true, focused: true, prepare(window) {
        const NativeDate = window.Date;
        window.Date = class extends NativeDate {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
        };
    } });
    ready(app, { prefs: { dateFormat: 'HH:mm:ss', showSystemStats: false } });
    const clock = app.document.querySelector('#clock');
    assert.equal(clock.firstChild.textContent, '12:30:10');
    assert.ok([...app.clock.pending.values()].some(timer => timer.delay === 750));
    now += 750; await app.clock.run(750);
    assert.equal(clock.firstChild.textContent, '12:30:11');
    app.click('#settingsBtn'); row(app, 'dateFormat').focus(); app.key(37); save(app);
    assert.equal(clock.firstChild.textContent, '12:30 PM');
    assert.ok([...app.clock.pending.values()].some(timer => timer.delay === 49000));
    now += 1000; await app.clock.run(1000);
    assert.equal(clock.firstChild.textContent, '12:30 PM');
});

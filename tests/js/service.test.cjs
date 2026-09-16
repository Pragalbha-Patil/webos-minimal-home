const assert = require('node:assert/strict');
const { test } = require('node:test');
const { service, constants: C } = require('./helpers.cjs');

test('discovery validates data, filters duplicate/system IDs and preserves bookmark params', () => {
    const s = service();
    s.disk.files.set(C.PREFS_FILE, JSON.stringify({ pinned: ['z'], hidden: ['a'], dateFormat: '<bad>' }));
    const replies = s.request('getTiles');
    s.respond({ returnValue: true, launchPoints: [null, {}, { id: 4 }, { id: '../bad' }, { id: C.SELF_ID },
        { id: 'a', title: 'Alpha' }, { id: 'a' }, { id: 'z', title: 4 }, { id: 'hidden', hidden: true },
        { id: 'system', systemApp: true }, { id: C.SETTINGS_ID, systemApp: true },
        { id: 'port', lptype: 'bookmark', systemApp: true, params: { value: 4 } }] });
    assert.deepEqual(replies[0].tiles.map(t => t.id), ['z', 'a', C.SETTINGS_ID]);
    assert.equal(replies[0].tiles.find(t => t.id === 'a').hidden, true);
    assert.equal(replies[0].tiles[0].title, 'z');
    assert.deepEqual(replies[0].inputs[0].params, { value: 4 });
    assert.equal(replies[0].prefs.dateFormat, 'HH:mm');
});

test('config edits are reread without restarting the relay', () => {
    const s = service();
    const launchPoints = [{ id: 'a', title: 'Alpha' }, { id: 'z', title: 'Zulu' },
        { id: 'system', systemApp: true }, { id: C.SETTINGS_ID, systemApp: true }];
    function discover() {
        const replies = s.request('getTiles');
        s.respond({ returnValue: true, launchPoints });
        return replies[0];
    }
    assert.deepEqual(discover().config, { system: [C.SETTINGS_ID], settingsTile: { id: C.SETTINGS_ID } });
    s.disk.files.set(C.CONFIG_FILE, JSON.stringify({ header: { text: 'New', brand: 'Greeting' },
        ui: { system: ['system'], appsPriority: ['z'] } }));
    const updated = discover();
    assert.deepEqual(updated.header, { text: 'New', brand: 'Greeting' });
    assert.deepEqual(updated.config, { system: ['system'], settingsTile: null });
    assert.deepEqual(updated.tiles.map(tile => tile.id), ['z', 'a', 'system']);
    s.disk.files.set(C.CONFIG_FILE, JSON.stringify({ header: { text: 'New', brand: 'x'.repeat(41) } }));
    assert.deepEqual(discover().header, { text: 'New', brand: '' });
    s.disk.files.set(C.CONFIG_FILE, JSON.stringify({ ui: { system: [], appsPriority: ['a'] } }));
    assert.deepEqual(discover().tiles.map(tile => tile.id), ['a', 'z']);
});

test('empty or corrupt system allowlists never expose system apps', () => {
    for (const config of [[], null, { ui: [] }, { ui: { system: 'all' } }, { ui: { system: [] } },
        { header: { text: 'Hello', brand: 'Home' }, ui: {} }]) {
        const s = service(); s.disk.files.set(C.CONFIG_FILE, JSON.stringify(config));
        const replies = s.request('getTiles'); s.respond({ returnValue: true, launchPoints: [{ id: 'system', systemApp: true }] });
        assert.deepEqual(replies[0].tiles, []);
        if (config && config.header) assert.deepEqual(replies[0].header, config.header);
    }
});

test('missing, invalid, failed, thrown and timed-out Luna replies respond exactly once', async () => {
    for (const response of [null, {}, { returnValue: false, errorText: 'denied' }, { returnValue: true, launchPoints: {} }]) {
        const s = service(); const replies = s.request('getTiles'); const callback = s.pending[0];
        s.respond(response); callback({ payload: { returnValue: true, launchPoints: [] } });
        assert.equal(replies.length, 1); assert.equal(replies[0].returnValue, false);
    }
    const thrown = service({ throwCall: new Error('offline') });
    assert.match(thrown.request('getTiles')[0].errorText, /offline/);
    const s = service(); const replies = s.request('getTiles');
    await s.clock.run(C.LUNA_TIMEOUT_MS); s.respond({ returnValue: true, launchPoints: [] });
    assert.equal(replies.length, 1); assert.match(replies[0].errorText, /timed out/);
});

test('launch rejects invalid IDs and uses validated fresh parameters for namespace and custom inputs', () => {
    for (const id of [null, '', 1, '../bad']) assert.equal(service().request('launchApp', { id })[0].returnValue, false);
    for (const id of ['com.webos.app.hdmi2', 'custom.port']) {
        const s = service(); const replies = s.request('launchApp', { id, params: { id: 'wrong', value: 1 } });
        s.respond({ returnValue: true, launchPoints: [null, { id: 'unrelated' }, { id, params: { id: 'wrong', value: 4, PhysicalAddress: '2000', unknown: true } }] });
        assert.deepEqual(JSON.parse(JSON.stringify(s.calls[1].payload)), { value: 4, PhysicalAddress: '2000', id, callerId: C.SELF_ID });
        s.respond({ returnValue: true }); assert.equal(replies[0].returnValue, true);
        assert.ok(JSON.parse(s.disk.files.get(C.USAGE_FILE))[id] > 0);
    }
    for (const points of [[], [{ id: 'com.webos.app.hdmi1', params: null }]]) {
        const s = service(); s.request('launchApp', { id: 'com.webos.app.hdmi1', params: { value: 'fallback' } });
        s.respond({ returnValue: true, launchPoints: points }); assert.equal(s.calls[1].payload.value, 'fallback');
    }
    const bad = service(); const replies = bad.request('launchApp', { id: 'com.webos.app.hdmi1' });
    bad.respond({ returnValue: true, launchPoints: null }); assert.equal(replies[0].returnValue, false);
});

test('successful launch persists bounded recency and survives optional usage-storage failures', () => {
    const s = service();
    s.disk.files.set(C.USAGE_FILE, JSON.stringify(Object.fromEntries(Array.from({ length: 70 }, (_, i) => ['app' + i, i]))));
    const replies = s.request('launchApp', { id: 'video' }); s.respond({ returnValue: true });
    assert.equal(replies[0].returnValue, true);
    const counts = JSON.parse(s.disk.files.get(C.USAGE_FILE));
    assert.equal(Object.keys(counts).length, 60); assert.ok(counts.video > counts.app69); assert.equal(counts.app0, undefined);
    s.disk.errors.set('rename', new Error('full'));
    const second = s.request('launchApp', { id: 'video' }); s.respond({ returnValue: true }); assert.equal(second[0].returnValue, true);
    s.disk.files.set(C.USAGE_FILE, 'null');
    const third = s.request('launchApp', { id: '__proto__' }); s.respond({ returnValue: true }); assert.equal(third[0].returnValue, true);
});

test('preference updates preserve unrelated values, sanitize lists, and report failed writes', () => {
    const s = service(); s.disk.files.set(C.PREFS_FILE, JSON.stringify({ accent: 'amber', labels: false }));
    const result = s.request('setPrefs', { pinned: ['a', 'a'], labels: 'true', dateFormat: 'HH:mm:ss' })[0];
    assert.equal(result.prefs.accent, 'amber'); assert.equal(result.prefs.labels, false);
    assert.deepEqual(result.prefs.pinned, ['a']); assert.equal(result.prefs.dateFormat, 'HH:mm:ss');
    assert.equal(s.request('setPrefs', null)[0].returnValue, true);
    s.disk.errors.set('write', new Error('read-only')); assert.equal(s.request('setPrefs', {})[0].returnValue, false);
});

test('Home bypass persists on successful launch and is removed on failure or timeout', async () => {
    const ok = service(); const answer = ok.request('openLGHome');
    assert.ok(Number(ok.disk.files.get(C.BYPASS_FILE)) > Date.now());
    ok.respond({ returnValue: true }); assert.equal(answer[0].returnValue, true); assert.ok(ok.disk.files.has(C.BYPASS_FILE));
    for (const timeout of [false, true]) {
        const s = service(); const replies = s.request('openLGHome');
        if (timeout) await s.clock.run(C.LUNA_TIMEOUT_MS); else s.respond({ returnValue: false });
        assert.equal(replies[0].returnValue, false); assert.equal(s.disk.files.has(C.BYPASS_FILE), false);
    }
    const cleanup = service(); cleanup.disk.errors.set('unlink', new Error('blocked'));
    const failed = cleanup.request('openLGHome'); cleanup.respond({ returnValue: false }); assert.equal(failed[0].returnValue, false);
    const disk = service(); disk.disk.errors.set('write', new Error('full')); assert.equal(disk.request('openLGHome')[0].returnValue, false);
});

test('stats reject stale, future, malformed and out-of-range samples', () => {
    const s = service();
    for (const sample of [null, [], {}, { timestamp: Date.now() - 30000, cpu: 42 }, { timestamp: Date.now() + 60000, cpu: 42 }]) {
        s.disk.files.set(C.STATS_FILE, JSON.stringify(sample)); assert.equal(s.request('getSystemStats')[0].cpu, null);
    }
    s.disk.files.set(C.STATS_FILE, JSON.stringify({ timestamp: Date.now(), cpu: 40, ram: 60, temp: 70 }));
    assert.deepEqual(s.request('getSystemStats')[0], { returnValue: true, cpu: 40, ram: 60, temp: 70 });
    s.disk.files.set(C.STATS_FILE, JSON.stringify({ timestamp: Date.now(), cpu: 200, ram: 'bad', temp: -200 }));
    assert.equal(s.request('getSystemStats')[0].temp, null);
});

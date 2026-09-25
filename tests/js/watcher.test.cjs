const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { watcher, constants: C, memoryFs } = require('./helpers.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('watcher retries failed launches, coalesces repeated events and cancels on foreground change', async () => {
    const w = watcher(); w.context.onForeground(C.HOME_ID); w.context.onForeground(C.HOME_ID);
    assert.equal(w.calls.length, 1);
    w.respond({ returnValue: false }); await flush();
    w.context.onForeground(C.HOME_ID); assert.equal(w.calls.length, 1);
    await w.clock.run(2000); assert.equal(w.calls.length, 2);
    await w.context.onForeground('video'); w.respond({ returnValue: false }); await flush();
    assert.equal([...w.clock.pending.values()].filter(t => t.delay === 2000).length, 0);
    await w.context.redirectLoop(); assert.equal(w.calls.length, 2);
    w.context.onForeground(C.HOME_ID); w.respond({ returnValue: false }); await flush();
    await w.context.onForeground('video');
    assert.equal([...w.clock.pending.values()].filter(t => t.delay === 2000).length, 0);
});

test('successful redirects enforce a cooldown then retry if Home becomes foreground again', async () => {
    const w = watcher(); w.context.onForeground(C.HOME_ID); w.respond({ returnValue: true }); await flush();
    w.advance(1000); w.context.onForeground(C.HOME_ID); assert.equal(w.calls.length, 1);
    w.advance(7000); await w.clock.run(7000); assert.equal(w.calls.length, 2);
    w.respond({ returnValue: true }); await flush();
});

test('backoff grows to a bounded maximum and bypass prevents queued retries', async () => {
    const w = watcher(); w.context.onForeground(C.HOME_ID);
    for (const delay of [2000, 2000, 2000, 2000, 30000, 60000, 120000, 240000, 300000, 300000]) {
        w.respond({ returnValue: false }); await flush();
        assert.ok([...w.clock.pending.values()].some(t => t.delay === delay));
        w.advance(delay); await w.clock.run(delay);
    }
    w.respond({ returnValue: false }); await flush();
    w.disk.files.set(C.BYPASS_FILE, String(w.now() + 60000));
    const count = w.calls.length; await w.clock.run(300000); assert.equal(w.calls.length, count);
});

test('first-use, valid/expired/corrupt bypass files and filesystem errors are handled', async () => {
    const w = watcher(); w.disk.files.delete(C.FIRSTUSE_FILE);
    await w.context.onForeground(C.HOME_ID); assert.equal(w.calls.length, 0);
    w.disk.files.set(C.FIRSTUSE_FILE, ''); w.disk.files.set(C.BYPASS_FILE, String(w.now() + 60000));
    await w.context.onForeground(C.HOME_ID); assert.equal(w.calls.length, 0);
    w.disk.files.set(C.BYPASS_FILE, 'invalid');
    w.context.onForeground(C.HOME_ID); assert.equal(w.calls.length, 1); assert.equal(w.disk.files.has(C.BYPASS_FILE), false);
    w.respond({ returnValue: false }); await flush();
    const denied = watcher(); denied.disk.errors.set('exists', new Error('denied'));
    await denied.context.onForeground(C.HOME_ID); assert.equal(denied.calls.length, 0);
    const unlink = watcher(); unlink.disk.files.set(C.BYPASS_FILE, '0'); unlink.disk.errors.set('unlink', new Error('denied'));
    unlink.context.onForeground(C.HOME_ID); assert.equal(unlink.calls.length, 1);
    const read = watcher(); read.disk.files.set(C.BYPASS_FILE, '0'); read.disk.errors.set('read:' + C.BYPASS_FILE, new Error('denied'));
    await read.context.onForeground(C.HOME_ID); assert.equal(read.calls.length, 0);
});

test('subscription disconnect clears retry state and ignores data from the old child', async () => {
    const w = watcher(); const old = w.children[0];
    old.stdout.emit('data', Buffer.from('noise "ignored" {"appId":"' + C.HOME_ID + '"}'));
    w.respond({ returnValue: false }); await flush();
    old.emit('error', new Error('lost')); old.emit('close', 1);
    assert.equal([...w.clock.pending.values()].filter(t => t.delay === 3000).length, 1);
    assert.equal([...w.clock.pending.values()].filter(t => t.delay === 2000).length, 0);
    const count = w.calls.length; old.stdout.emit('data', Buffer.from('{"appId":"' + C.HOME_ID + '"}'));
    assert.equal(w.calls.length, count);
    await w.clock.run(3000); assert.equal(w.children.length, 2);
    w.children[1].stdout.emit('data', Buffer.from('{"appId":3}{"appId":"vi'));
    w.children[1].stdout.emit('data', Buffer.from('deo"}'));
    w.children[1].stderr.emit('data', Buffer.from('diagnostic'));
    w.children[1].emit('close', 0); await w.clock.run(3000); assert.equal(w.children.length, 3);
    const kill = watcher({ throwKill: true }); kill.children[0].emit('close', 1);
    assert.ok([...kill.clock.pending.values()].some(t => t.delay === 3000));
    const spawn = watcher({ throwSpawn: true }); await spawn.clock.run(5000);
    assert.ok([...spawn.clock.pending.values()].some(t => t.delay === 5000));
});

test('Luna subprocess failures and malformed discovery responses are recoverable', async () => {
    for (const value of ['bad json', 'null', '{}', '{"launchPoints":{}}', '{"returnValue":false}']) {
        const w = watcher(); const task = w.context.listLaunchPoints(); w.respond(value); assert.equal(await task, null);
    }
    const w = watcher(); const list = w.context.listLaunchPoints(); w.respond('', new Error('offline')); assert.equal(await list, null);
    const launch = w.context.lunaLaunch('video'); w.respond('bad'); assert.equal(await launch, null);
    const failed = w.context.lunaLaunch('video'); w.respond('', new Error('offline')); assert.equal(await failed, null);
    const thrown = watcher({ throwExec: true }); await thrown.context.redirectLoop();
    await thrown.context.onForeground(C.HOME_ID); await flush();
    const provision = thrown.context.runProvision(); await provision;
});

test('icon provisioning writes changes only and retains unavailable installed icons', () => {
    const w = watcher(); w.disk.files.set('/source/a', Buffer.from('first')); w.disk.files.set('/source/b', Buffer.from('second'));
    const icon = C.APP_DIR + '/icons/video.png';
    w.context.provisionIcons([null, { id: 4 }, { id: '../bad' }, { id: 'video', largeIcon: '/source/a' }]);
    assert.equal(w.disk.files.get(icon).toString(), 'first');
    const count = w.disk.writes.filter(p => p === icon).length;
    w.context.provisionIcons([{ id: 'video', icon: '/source/a' }]); assert.equal(w.disk.writes.filter(p => p === icon).length, count);
    w.context.provisionIcons([{ id: 'video', icon: '/source/b' }]); assert.equal(w.disk.files.get(icon).toString(), 'second');
    for (const source of ['', '/absent', '/empty', '/large']) {
        w.disk.files.set('/empty', ''); w.disk.files.set('/large', Buffer.alloc(300001));
        w.context.provisionIcons([{ id: 'video', icon: source }]); assert.equal(w.disk.files.has(icon), true);
    }
    w.disk.errors.set('mkdir', new Error('denied')); w.disk.errors.set('unlink', new Error('denied'));
    assert.doesNotThrow(() => w.context.provisionIcons([{ id: 'video' }]));
    w.disk.errors.set('write:' + icon, new Error('full'));
    assert.doesNotThrow(() => w.context.provisionIcons([{ id: 'video', icon: '/source/a' }]));
    w.context.provisionIcons(null);
});

test('settings icon is bounded, skipped when identical and retried after read failures', () => {
    const w = watcher(); w.context.provisionSettingsIcon();
    w.disk.files.set(C.SETTINGS_ICON, 'icon'); w.context.provisionSettingsIcon();
    const icon = C.APP_DIR + '/icons/' + C.SETTINGS_ID + '.png';
    assert.equal(w.disk.files.get(icon).toString(), 'icon');
    const count = w.disk.writes.length; w.context.provisionSettingsIcon(); assert.equal(w.disk.writes.length, count);
    w.disk.files.set(C.SETTINGS_ICON, 'changed'); w.context.provisionSettingsIcon();
    w.disk.files.set(C.SETTINGS_ICON, Buffer.alloc(300001)); w.context.provisionSettingsIcon();
    w.disk.files.set(C.SETTINGS_ICON, ''); w.context.provisionSettingsIcon();
    assert.equal(w.disk.files.get(icon).toString(), 'changed');
});

test('settings icon provisioning creates its destination directory', () => {
    const disk = memoryFs({
        [C.FIRSTUSE_FILE]: '',
        [C.SETTINGS_ICON]: 'icon',
        '/proc/stat': 'cpu  100 0 100 800 20 10 10 0',
        '/proc/meminfo': 'MemTotal: 1000\nMemAvailable: 400'
    });
    const mkdirs = new Set();
    const writeFileSync = disk.writeFileSync;
    disk.mkdirSync = filename => { mkdirs.add(filename); };
    disk.writeFileSync = (filename, value) => {
        if (path.posix.dirname(filename) === C.APP_DIR + '/icons' && !mkdirs.has(C.APP_DIR + '/icons'))
            throw new Error('ENOENT: icon directory missing');
        writeFileSync(filename, value);
    };
    const w = watcher({ disk });
    w.context.provisionSettingsIcon();
    assert.equal(disk.files.get(C.APP_DIR + '/icons/' + C.SETTINGS_ID + '.png').toString(), 'icon');
});

test('stats use CPU deltas, recover after disabled periods and skip unreadable thermal zones', () => {
    const w = watcher(); let sample = () => JSON.parse(w.disk.files.get(C.STATS_FILE));
    assert.equal(sample().cpu, null); assert.equal(sample().ram, 60);
    w.disk.files.set('/proc/stat', 'cpu  120 0 110 850 30 15 15 0 0 0');
    w.disk.files.set('/sys/class/thermal/thermal_zone0/temp', 'invalid');
    w.disk.files.set('/sys/class/thermal/thermal_zone1/temp', '65000');
    w.disk.errors.set('read:/sys/class/thermal/thermal_zone0/temp', new Error('denied'));
    w.context.collectSystemStats(); assert.equal(sample().cpu, 40); assert.equal(sample().temp, 65);
    w.disk.files.set(C.PREFS_FILE, '{"showSystemStats":false}'); const previous = w.disk.files.get(C.STATS_FILE);
    w.context.collectSystemStats(); assert.equal(w.disk.files.get(C.STATS_FILE), previous);
    w.disk.files.set(C.PREFS_FILE, '{"showSystemStats":true}'); w.context.collectSystemStats(); assert.equal(sample().cpu, null);
    w.disk.files.set('/proc/meminfo', 'MemTotal: 1000'); w.context.collectSystemStats(); assert.equal(sample().ram, null);
});

test('missing and malformed kernel counters produce unknown values without crashing', () => {
    const w = watcher();
    for (const cpu of ['bad', 'cpu  x', 'cpu  1 0 1 0', 'cpu  0 0 0 0']) {
        w.disk.files.set('/proc/stat', cpu); w.context.collectSystemStats();
        const sample = JSON.parse(w.disk.files.get(C.STATS_FILE)); assert.ok(sample.cpu === null || sample.cpu >= 0);
    }
    w.disk.files.set('/sys/class/thermal/not-a-zone/temp', '0');
    w.disk.files.set('/sys/class/thermal/thermal_zone0/temp', 'bad'); w.context.collectSystemStats();
    for (const operation of ['read:/proc/stat', 'read:/proc/meminfo', 'readdir', 'write:' + C.STATS_FILE + '.tmp']) {
        w.disk.errors.set(operation, new Error('denied')); assert.doesNotThrow(() => w.context.collectSystemStats());
    }
});

test('periodic provisioning requests launch points and copies the returned icons', async () => {
    const w = watcher(); w.disk.files.set('/icon', 'icon');
    const task = w.context.runProvision(); w.respond({ returnValue: true, launchPoints: [{ id: 'video', icon: '/icon' }] }); await task;
    assert.ok(w.disk.files.has(C.APP_DIR + '/icons/video.png'));
});

test('failed discovery preserves cached icons while confirmed discovery prunes', async () => {
    const w = watcher();
    const cached = C.APP_DIR + '/icons/video.png';
    const stale = C.APP_DIR + '/icons/stale.png';
    w.disk.files.set(cached, 'cached'); w.disk.files.set(stale, 'stale');
    const failed = w.context.runProvision(); w.respond('', new Error('offline')); await failed;
    assert.equal(w.disk.files.get(cached).toString(), 'cached');
    assert.equal(w.disk.files.get(stale).toString(), 'stale');
    const confirmed = w.context.runProvision();
    w.respond({ returnValue: true, launchPoints: [] }); await confirmed;
    assert.equal(w.disk.files.has(stale), false);
});


test('initial icon provisioning is scheduled immediately', async () => {
    const w = watcher(); w.disk.files.set('/icon', 'icon');
    const task = w.clock.run(0);
    w.respond({ returnValue: true, launchPoints: [{ id: 'video', icon: '/icon' }] });
    await task;
    assert.ok(w.disk.files.has(C.APP_DIR + '/icons/video.png'));
});


test('a real foreground transition permits immediate return without the old cooldown', async () => {
    for (const appId of [C.SELF_ID, 'video', 'com.webos.app.hdmi1']) {
        const w = watcher();
        w.context.onForeground(C.HOME_ID); w.respond({ returnValue: true }); await flush();
        await w.context.onForeground(appId);
        w.advance(100);
        w.context.onForeground(C.HOME_ID);
        assert.equal(w.calls.length, 2);
        w.respond({ returnValue: true }); await flush();
        w.context.onForeground(C.HOME_ID);
        assert.equal(w.calls.length, 2, 'duplicate Home events stay rate limited');
    }
});

test('late launch success cannot restore a cooldown after the launcher reached foreground', async () => {
    const w = watcher();
    w.context.onForeground(C.HOME_ID);
    await w.context.onForeground(C.SELF_ID);
    w.respond({ returnValue: true }); await flush();
    w.context.onForeground(C.HOME_ID);
    assert.equal(w.calls.length, 2);
});

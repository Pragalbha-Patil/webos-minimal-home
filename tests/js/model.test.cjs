const assert = require('node:assert/strict');
const { test } = require('node:test');
const M = require('../../launcher-service/model');
const stream = require('../../launcher-service/json-stream');
const storage = require('../../launcher-service/storage');
const { memoryFs } = require('./helpers.cjs');

test('preferences validate types, choices, own keys, IDs, bounds, and fresh defaults', () => {
    for (const value of [null, undefined, [], 'bad', 42]) assert.deepEqual(M.cleanPrefs(value), {});
    for (const key of Object.keys(M.choices)) {
        for (const value of M.choices[key]) assert.equal(M.preferences({ [key]: value })[key], value);
        assert.equal(M.preferences({ [key]: 'invalid' })[key], M.preferences()[key]);
    }
    const values = M.cleanPrefs({ labels: false, clock24: 'false', showSystemStats: true,
        pinned: ['a', 'a', '', 4, '../bad', 'b'], hidden: 'invalid', unknown: 1 });
    assert.deepEqual(values, { labels: false, showSystemStats: true, pinned: ['a', 'b'] });
    assert.deepEqual(M.cleanPrefs(Object.create({ labels: false })), {});
    assert.equal(M.preferences({ pinned: Array.from({ length: 100 }, (_, i) => 'app' + i) }).pinned.length, 30);
    assert.equal(M.preferences({ hidden: Array.from({ length: 100 }, (_, i) => 'app' + i) }).hidden.length, 60);
    const prefs = M.preferences(); prefs.hidden.push('local'); assert.deepEqual(M.preferences().hidden, []);
    assert.equal(M.brand('  Living Room  '), 'Living Room');
    assert.equal(M.brand(''), ''); assert.equal(M.brand('x'.repeat(41)), ''); assert.equal(M.brand(4), '');
    assert.deepEqual(M.cleanPrefs({ brand: '  My TV  ', brandConfigured: true }),
        { brand: 'My TV', brandConfigured: true });
    assert.deepEqual(M.ids(null, 10), []);
});

test('launch parameters preserve ports without allowing target or prototype overwrite', () => {
    for (const value of [null, [], true]) assert.deepEqual(M.params(value), {});
    assert.deepEqual(M.params({ id: 'wrong', PhysicalAddress: '2000', value: 4, displayId: false, uniqueId: {}, other: 1 }),
        { PhysicalAddress: '2000', value: 4, displayId: false });
    assert.deepEqual(M.params({ value: Infinity, displayId: NaN }), {});
    assert.deepEqual(M.params(Object.create({ value: 1 })), {});
    for (const id of ['com.webos.app.hdmi1', 'com.webos.app.scart', 'com.webos.app.livetv']) assert.ok(M.input({ id }));
    for (const value of [null, [], {}, { id: 'video' }, { id: 42 }]) assert.equal(M.input(value), false);
    assert.ok(M.input({ id: 'custom.port', lptype: 'bookmark' }));
});

test('usage ignores malformed counts and sorting is stable for identical values', () => {
    assert.deepEqual(Object.keys(M.usage(null)), []);
    const counts = M.usage(JSON.parse('{"__proto__":5,"video":3,"bad":-1,"text":"1","float":1.5,"../bad":4}'));
    assert.equal(Object.getPrototypeOf(counts), null);
    assert.deepEqual(Object.keys(counts), ['__proto__', 'video']);
    const a = { id: 'a', title: 'Same' }, b = { id: 'b', title: 'Same' }, z = { id: 'z', title: 'Zebra' };
    assert.equal(M.compareTitle(a, a), 0);
    assert.equal(M.compareTitle(a, b), -1);
    assert.equal(M.compareTitle(b, a), 1);
    assert.equal(M.compareTitle(z, a), 1);
    assert.equal(M.compareTitle({ id: 'a' }, { id: 'b' }), -1);
    const tiles = [z, b, a];
    assert.deepEqual(M.sortTiles(tiles, M.preferences({ sort: 'alpha', pinned: ['z'] }), {}, []), [a, b, z]);
    assert.deepEqual(M.sortTiles(tiles, M.preferences({ pinned: ['b', 'a'] }), { z: 10 }, []), [b, a, z]);
    assert.deepEqual(M.sortTiles(tiles, M.preferences(), { b: 3, a: 2 }, ['z']), [b, a, z]);
    assert.deepEqual(M.sortTiles(tiles, M.preferences({ sort: 'pinned' }), { z: 99 }, ['b', 'a']), [b, a, z]);
    assert.deepEqual(tiles, [z, b, a]);
    for (const value of [-1, 101, NaN, Infinity, '5', null]) assert.equal(M.metric(value, 0, 100), null);
    for (const value of [0, 50, 100]) assert.equal(M.metric(value, 0, 100), value);
});

test('JSON stream handles chunk boundaries, strings, noise, malformed frames and bounded memory', () => {
    const parse = stream(100);
    assert.deepEqual(parse('noise "quoted log" } {"a":'), []);
    assert.deepEqual(parse('{"text":"brace } and \\"'), []);
    assert.deepEqual(parse('"}}'), [{ a: { text: 'brace } and "' } }]);
    assert.deepEqual(parse('{bad}{"b":2}{"c":3}'), [{ b: 2 }, { c: 3 }]);
    assert.deepEqual(parse('{"huge":"' + 'x'.repeat(200)), []);
    assert.deepEqual(parse('{"recovered":true}'), [{ recovered: true }]);
    assert.deepEqual(stream(20)('{"huge":"' + 'x'.repeat(40) + '"}{"next":true}'), [{ next: true }]);
    const escaped = stream(100);
    const data = JSON.stringify({ value: 'quote" slash\\ }' });
    let objects = [];
    for (const character of data) objects = objects.concat(escaped(character));
    assert.deepEqual(objects, [{ value: 'quote" slash\\ }' }]);
});

test('atomic writes preserve old data when write or rename fails and clean temporary files', () => {
    const fs = memoryFs({ '/prefs': '{"old":true}' }); const store = storage(fs);
    assert.equal(store.readJson('/absent'), null);
    fs.files.set('/bad', '{'); assert.equal(store.readJson('/bad'), null);
    store.writeJson('/prefs', { value: 1 }); assert.deepEqual(store.readJson('/prefs'), { value: 1 });
    for (const operation of ['write:/prefs.tmp', 'rename:/prefs']) {
        fs.errors.set(operation, new Error('disk full'));
        assert.throws(() => store.writeJson('/prefs', { value: 2 }), /disk full/);
        assert.deepEqual(store.readJson('/prefs'), { value: 1 });
        assert.equal(fs.files.has('/prefs.tmp'), false); fs.errors.clear();
    }
    fs.errors.set('write', new Error('write')); fs.errors.set('unlink', new Error('cleanup'));
    assert.throws(() => store.writeJson('/prefs', {}), /write/);
});

test('logger respects existing size and UTF-8 byte limits without stat calls per event', () => {
    const fs = memoryFs({ '/log': 'x'.repeat(180) }); const log = storage(fs).logger('/log', 200);
    fs.errors.set('stat', new Error('must not stat again'));
    log({ text: '雪'.repeat(20) }); assert.ok(Buffer.byteLength(fs.files.get('/log')) <= 200);
    const previous = fs.files.get('/log');
    log({ text: 'x'.repeat(300) }); assert.equal(fs.files.get('/log'), previous);
    const fresh = storage(fs).logger('/new', 200);
    fresh({ message: 'first' }); assert.ok(fs.files.has('/new'));
    fs.errors.set('append', new Error('disk full')); assert.doesNotThrow(() => fresh({ message: 'ignored' }));
});

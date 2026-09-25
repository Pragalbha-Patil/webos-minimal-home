const assert = require('node:assert/strict');
const { test } = require('node:test');
const { browser, service, memoryFs, constants: C } = require('./helpers.cjs');

test('reverting an in-flight edit persists the final choice without overwriting unknown saved fields', t => {
    const app = browser(); t.after(() => app.close());
    const relay = service({ disk: memoryFs({
        [C.PREFS_FILE]: JSON.stringify({ labels: true, pinned: ['favorite'], accent: 'emerald' })
    }) });
    app.click('#settingsBtn');
    app.click('[data-key="labels"]');
    app.click('[data-key="labels"]');
    const pending = () => app.calls.filter(call => call.method === 'setPrefs' && !call.answered);
    const first = pending()[0];
    assert.equal(pending().length, 1);
    const reply = relay.request('setPrefs', first.parameters)[0];
    assert.equal(reply.prefs.labels, false);
    app.respond('setPrefs', reply);
    assert.equal(pending().length, 1, 'the final On choice must be sent after Off was persisted');
    const second = pending()[0];
    assert.deepEqual(JSON.parse(JSON.stringify(second.parameters)), { labels: true });
    app.respond('setPrefs', relay.request('setPrefs', second.parameters)[0]);
    const saved = relay.request('getPrefs')[0].prefs;
    assert.equal(saved.labels, true);
    assert.deepEqual(saved.pinned, ['favorite']);
    assert.equal(saved.accent, 'emerald');
    assert.equal(app.document.body.classList.contains('no-labels'), false);
});

test('a failed intermediate save does not require a compensating write for a reverted edit', t => {
    const app = browser(); t.after(() => app.close());
    app.tiles({ prefs: { brandSetupDone: true, labels: true } });
    app.click('#settingsBtn');
    app.click('[data-key="labels"]');
    app.click('[data-key="labels"]');
    app.respond('setPrefs', { returnValue: false, errorText: 'write failed' });
    assert.equal(app.calls.filter(call => call.method === 'setPrefs').length, 1);
    assert.equal(app.document.body.classList.contains('no-labels'), false);
});

test('pin then unpin keeps the dispatched array snapshot and sends a compensating empty list', t => {
    const app = browser(); t.after(() => app.close());
    const relay = service();
    app.tiles({ tiles: [{ id: 'video', title: 'Video' }], prefs: { brandSetupDone: true } });
    function togglePin() {
        app.document.querySelector('[data-id="video"]').focus();
        app.key(457);
        app.click('#optionsRows .optrow');
    }
    togglePin();
    const first = app.calls.find(call => call.method === 'setPrefs');
    togglePin();
    assert.deepEqual([...first.parameters.pinned], ['video']);
    app.respond('setPrefs', relay.request('setPrefs', first.parameters)[0]);
    const second = app.calls.find(call => call.method === 'setPrefs' && !call.answered);
    assert.ok(second);
    assert.deepEqual([...second.parameters.pinned], []);
    app.respond('setPrefs', relay.request('setPrefs', second.parameters)[0]);
    assert.deepEqual(relay.request('getPrefs')[0].prefs.pinned, []);
});

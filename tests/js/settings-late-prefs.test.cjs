const assert = require('node:assert/strict');
const { test } = require('node:test');
const { browser } = require('./helpers.cjs');

for (const legacy of [false, true]) {
    test('open Settings reflects late ' + (legacy ? 'legacy' : 'bundled') + ' preferences without losing focus', t => {
        const app = browser(); t.after(() => app.close());
        if (legacy) app.tiles();
        app.click('#settingsBtn');
        const row = app.document.querySelector('[data-key="labels"]');
        row.focus();
        const prefs = { labels: false, tileSize: 'large', sort: 'alpha', brandSetupDone: true };
        if (legacy) app.prefs(prefs);
        else app.tiles({ prefs });
        assert.equal(row.querySelector('.val').textContent, 'Off');
        assert.equal(app.document.querySelector('[data-key="tileSize"] .val').textContent, 'Large');
        assert.equal(app.document.querySelector('[data-key="sort"] .val').textContent, 'Alphabetical');
        assert.equal(app.document.activeElement, row);
        assert.equal(app.calls.filter(call => call.method === 'setPrefs').length, 0);
    });
}

/* Shared pure rules. Embedded into the web app by the Python build. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports)
        module.exports = factory();
    else root.MinimalHome = factory();
})(this, function () {
    'use strict';
    var defaults = {
        accent: 'steel',
        tileSize: 'standard',
        labels: true,
        clock24: false,
        sort: 'mru',
        pinned: [],
        hidden: [],
        showSystemStats: true,
        dateFormat: 'HH:mm',
        brand: '',
        brandConfigured: false
    };
    var choices = {
        accent: ['steel', 'emerald', 'violet', 'amber', 'crimson'],
        tileSize: ['compact', 'standard', 'large'],
        sort: ['mru', 'alpha', 'pinned'],
        dateFormat: [
            'HH:mm',
            'h:mm A',
            'HH:mm:ss',
            'h:mm:ss A',
            'MMM D, HH:mm',
            'MMM D, h:mm A',
            'YYYY-MM-DD HH:mm',
            'DD/MM/YYYY HH:mm'
        ]
    };
    function record(value) {
        return (
            value !== null && typeof value === 'object' && !Array.isArray(value)
        );
    }
    function has(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key);
    }
    function validId(value) {
        return (
            typeof value === 'string' &&
            /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,255}$/.test(value)
        );
    }
    function ids(value, limit) {
        var result = [];
        if (Array.isArray(value))
            value.forEach(function (id) {
                if (
                    validId(id) &&
                    result.indexOf(id) < 0 &&
                    result.length < limit
                )
                    result.push(id);
            });
        return result;
    }
    function brand(value) {
        if (typeof value !== 'string') return '';
        value = value.replace(/^\s+|\s+$/g, '');
        return value && value.length <= 40 ? value : '';
    }
    function cleanBrandField(result, key, item) {
        if (item === '') {
            result[key] = '';
            return;
        }
        var cleanedBrand = brand(item);
        if (cleanedBrand) result[key] = cleanedBrand;
    }
    function cleanPrefs(value) {
        var result = {};
        if (!record(value)) return result;
        Object.keys(defaults).forEach(function (key) {
            if (!has(value, key)) return;
            var item = value[key];
            if (has(choices, key)) {
                if (choices[key].indexOf(item) >= 0) result[key] = item;
            } else if (key === 'pinned' || key === 'hidden') {
                if (Array.isArray(item))
                    result[key] = ids(item, key === 'pinned' ? 30 : 60);
            } else if (key === 'brand') {
                cleanBrandField(result, key, item);
            } else if (typeof item === 'boolean') result[key] = item;
        });
        return result;
    }
    function preferences(value) {
        var result = cleanPrefs(value);
        Object.keys(defaults).forEach(function (key) {
            if (!has(result, key))
                result[key] = Array.isArray(defaults[key]) ? [] : defaults[key];
        });
        return result;
    }
    function input(lp) {
        return (
            record(lp) &&
            validId(lp.id) &&
            (lp.lptype === 'bookmark' ||
                /^com\.webos\.app\.(livetv|hdmi\d+|av\d+|scart|dp\d+|usbc\d+)$/.test(
                    lp.id
                ))
        );
    }
    function params(value) {
        var result = {};
        if (record(value))
            ['PhysicalAddress', 'uniqueId', 'value', 'displayId'].forEach(
                function (key) {
                    if (!has(value, key)) return;
                    var item = value[key];
                    if (
                        typeof item === 'string' ||
                        typeof item === 'boolean' ||
                        (typeof item === 'number' && isFinite(item))
                    )
                        result[key] = item;
                }
            );
        return result;
    }
    function usage(value) {
        var result = Object.create(null);
        if (record(value))
            Object.keys(value).forEach(function (id) {
                var count = value[id];
                if (
                    validId(id) &&
                    typeof count === 'number' &&
                    isFinite(count) &&
                    count >= 0 &&
                    Math.floor(count) === count &&
                    count <= Number.MAX_SAFE_INTEGER
                )
                    result[id] = count;
            });
        return result;
    }
    function compareTitle(a, b) {
        var left = String(a.title || a.id).toLowerCase();
        var right = String(b.title || b.id).toLowerCase();
        if (left !== right) return left < right ? -1 : 1;
        return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
    }
    function sortTiles(tiles, prefs, counts, priority) {
        return tiles.slice().sort(function (a, b) {
            if (prefs.sort === 'alpha') return compareTitle(a, b);
            var pa = prefs.pinned.indexOf(a.id),
                pb = prefs.pinned.indexOf(b.id);
            if (pa !== pb)
                return (pa < 0 ? Infinity : pa) - (pb < 0 ? Infinity : pb);
            var ua = counts[a.id] || 0,
                ub = counts[b.id] || 0;
            if (prefs.sort === 'mru' && ua !== ub) return ub - ua;
            var ia = priority.indexOf(a.id),
                ib = priority.indexOf(b.id);
            if (ia !== ib)
                return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
            return compareTitle(a, b);
        });
    }
    function metric(value, min, max) {
        return typeof value === 'number' &&
            isFinite(value) &&
            value >= min &&
            value <= max
            ? value
            : null;
    }
    return {
        choices: choices,
        record: record,
        has: has,
        validId: validId,
        ids: ids,
        brand: brand,
        cleanPrefs: cleanPrefs,
        preferences: preferences,
        input: input,
        params: params,
        usage: usage,
        sortTiles: sortTiles,
        compareTitle: compareTitle,
        metric: metric
    };
});

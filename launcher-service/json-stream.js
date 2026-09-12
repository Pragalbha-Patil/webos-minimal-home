'use strict';

// luna-send may split or combine pretty-printed JSON objects across chunks.
module.exports = function (limit) {
    var buffer = '',
        depth = 0,
        quoted = false,
        escaped = false;
    function reset() {
        buffer = '';
        depth = 0;
        quoted = false;
        escaped = false;
    }
    function scanBare(character) {
        if (character === '"') quoted = true;
        else if (character === '{') depth++;
        else if (character === '}') depth--;
    }
    function scan(character) {
        buffer += character;
        if (!quoted) return scanBare(character);
        if (escaped) {
            escaped = false;
            return;
        }
        if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
    }
    return function (chunk) {
        var objects = [];
        for (var i = 0; i < chunk.length; i++) {
            var character = chunk[i];
            if (depth === 0 && character !== '{') continue;
            scan(character);
            if (buffer.length > limit) {
                reset();
                continue;
            }
            if (depth !== 0) continue;
            try {
                objects.push(JSON.parse(buffer));
            } catch (ignored) {
                /* Skip malformed frames. */
            }
            buffer = '';
        }
        return objects;
    };
};

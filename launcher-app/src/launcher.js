(function () {
  "use strict";
  var M = window.MinimalHome;
  try {
    if (window.PalmSystem && window.PalmSystem.stageReady)
      window.PalmSystem.stageReady();
  } catch (e) {}

  var SVC = "luna://org.minimal.home.service";
  var BUILD = window.MH_CONFIG.version;
  window.__MHBUILD = BUILD;
  var SVC_LIST_M = "getTiles";
  var SVC_LAUNCH_M = "launchApp";
  function svcCall(uri, method, params, onOk, onErr) {
    var pending = (window.__mhKeep = window.__mhKeep || []);
    if (pending.length >= 32) {
      if (onErr) onErr({ errorText: "Too many pending requests" });
      return;
    }
    var entry = { request: null },
      complete = false;
    pending.push(entry);
    var timeout = setTimeout(function () {
      if (entry.request && typeof entry.request.cancel === "function") {
        try {
          entry.request.cancel();
        } catch (e) {
          /* Expiry still releases the request. */
        }
      }
      noteLuna(false, method + ": timed out");
      done(onErr, { errorText: "Service request timed out" });
    }, 15000);
    function done(callback, value) {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      pending.splice(pending.indexOf(entry), 1);
      if (typeof callback === "function") callback(value);
    }
    function success(value) {
      if (!value || value.returnValue !== true) {
        noteLuna(false, method + ": bad response");
        done(onErr, value || { errorText: "Invalid service response" });
      } else {
        noteLuna(true, method);
        done(onOk, value);
      }
    }
    try {
      if (navigator.service && navigator.service.request) {
        entry.request = navigator.service.request(uri, {
          method: method,
          parameters: params || {},
          subscribe: false,
          onSuccess: success,
          onFailure: function (error) {
            noteLuna(false, method + ": refused");
            done(onErr, error);
          }
        });
        return;
      }
    } catch (e) {
      if (complete) return;
    }
    try {
      var bridge = new PalmServiceBridge();
      entry.request = bridge;
      bridge.onservicecallback = function (message) {
        var value;
        try {
          value = JSON.parse(message);
        } catch (e) {
          noteLuna(false, method + ": bad response");
          done(onErr, { errorText: "Invalid service response" });
          return;
        }
        success(value);
      };
      bridge.call(uri + "/" + method, JSON.stringify(params || {}));
    } catch (e) {
      noteLuna(false, method + ": failed to start");
      done(onErr, { errorText: String(e) });
    }
  }
  var health = {
    tilesAt: 0,
    tilesOk: false,
    statsAt: 0,
    statsOk: false,
    lunaAt: 0,
    lunaOk: false,
    lunaDetail: "no requests yet"
  };
  window.__mhHealth = health;
  function noteLuna(ok, detail) {
    health.lunaOk = ok;
    health.lunaAt = Date.now();
    health.lunaDetail = detail;
  }
  var launchBusy = false,
    launchTimer = null,
    launchSequence = 0;
  function launch(id, params) {
    if (launchBusy || !M.validId(id)) return;
    launchBusy = true;
    var sequence = ++launchSequence;
    function release(delay) {
      if (sequence !== launchSequence) return;
      clearTimeout(launchTimer);
      launchTimer = setTimeout(function () {
        launchBusy = false;
        launchTimer = null;
      }, delay);
    }
    launchTimer = setTimeout(function () {
      launchBusy = false;
      launchTimer = null;
    }, 4000);
    svcCall(
      SVC,
      SVC_LAUNCH_M,
      { id: id, params: M.params(params) },
      function () {
        release(250);
      },
      function (error) {
        if (sequence !== launchSequence) return;
        release(0);
        showError(
          "Could not open app: " +
            ((error && error.errorText) || "unknown error")
        );
      }
    );
  }
  function showError(message) {
    var element = document.getElementById("err");
    element.style.display = "block";
    element.textContent = message;
  }
  function tileParams(el) {
    try {
      return JSON.parse(el.getAttribute("data-params") || "null");
    } catch (e) {
      return null;
    }
  }
  var SYS_IDS = window.MH_CONFIG.system;
  var SETTINGS_TILE = window.MH_CONFIG.settingsTile;
  var SELF_ID = "org.minimal.home";
  var SVC_PREFS_GET_M = "getPrefs";
  var SVC_PREFS_SET_M = "setPrefs";
  var SVC_LGHOME_M = "openLGHome";
  var SVC_STATS_M = "getSystemStats";

  var __mhTiles = [];
  window.__mhTiles = __mhTiles;
  var __mhInputs = [];
  var tilesLoaded = false;
  var renderedTiles = "";
  var PREFS = M.preferences();
  var lastSavedPrefs = M.preferences();
  var DEFAULT_BRAND = "Minimal Home";
  var configuredHeader = { text: "Welcome", brand: DEFAULT_BRAND };
  var headerLoaded = false;
  var brandFirstRun = false;
  var clockTimer = null,
    clockHTML = "";
  var prefsRevision = 0;
  var prefsSaving = false,
    prefsCompletions = [];
  var ACCENTS = {
    steel: { name: "Steel", main: "#8fb6ff", soft: "rgba(143,182,255,.35)" },
    emerald: { name: "Emerald", main: "#4ade9d", soft: "rgba(74,222,157,.35)" },
    violet: { name: "Violet", main: "#b79cff", soft: "rgba(183,156,255,.35)" },
    amber: { name: "Amber", main: "#ffc46b", soft: "rgba(255,196,107,.35)" },
    crimson: { name: "Crimson", main: "#ff7a8a", soft: "rgba(255,122,138,.35)" }
  };
  var BACK_KEYS = { 461: 1, 27: 1, 8: 1 };
  var overlay = { mode: null };
  var lastFocusEl = null;
  var holdTimer = null,
    holdDir = null,
    holdN = 0;

  function esc(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function tile4(id) {
    var els = document.querySelectorAll(".tile"),
      i;
    for (i = 0; i < els.length; i++)
      if (els[i].getAttribute("data-id") === id) return els[i];
    return null;
  }
  function dirOf(kc) {
    return kc === 37
      ? "left"
      : kc === 39
        ? "right"
        : kc === 38
          ? "up"
          : kc === 40
            ? "down"
            : null;
  }

  function formatDate(n, fmt) {
    var p = function (x) {
      return (x < 10 ? "0" : "") + x;
    };
    var months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec"
    ];
    var days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday"
    ];
    var h = n.getHours(),
      h12 = h % 12;
    if (h12 === 0) h12 = 12;
    var ap = h >= 12 ? "PM" : "AM";
    var Y = n.getFullYear(),
      M = n.getMonth() + 1,
      D = n.getDate();
    var m = n.getMinutes(),
      s = n.getSeconds();
    var dow = days[n.getDay()],
      mon = months[n.getMonth()];
    var fullMonths = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December"
    ];
    var tokens = {
      YYYY: Y,
      YY: String(Y).slice(-2),
      MMMM: fullMonths[n.getMonth()],
      MMM: mon,
      MM: p(M),
      M: M,
      DD: p(D),
      D: D,
      HH: p(h),
      H: h,
      hh: p(h12),
      h: h12,
      mm: p(m),
      m: m,
      ss: p(s),
      s: s,
      A: ap,
      a: ap.toLowerCase(),
      dddd: dow,
      ddd: dow.slice(0, 3),
      dd: p(n.getDay() + 1),
      d: n.getDay() + 1
    };
    // Replace original tokens once; never interpret letters in the resulting names.
    return fmt.replace(
      /YYYY|MMMM|dddd|MMM|ddd|YY|MM|DD|HH|hh|mm|ss|dd|M|D|H|h|m|s|A|a|d/g,
      function (token) {
        return tokens[token];
      }
    );
  }
  var DATE_FORMAT_NAMES = {
    "HH:mm": "24-hour",
    "h:mm A": "12-hour",
    "HH:mm:ss": "24-hour + seconds",
    "h:mm:ss A": "12-hour + seconds",
    "MMM D, HH:mm": "Date + 24-hour",
    "MMM D, h:mm A": "Date + 12-hour",
    "YYYY-MM-DD HH:mm": "ISO date + time",
    "DD/MM/YYYY HH:mm": "Day-first date + time"
  };
  function dateFormatName(fmt) {
    return DATE_FORMAT_NAMES[fmt] || fmt;
  }
  function tick() {
    clearTimeout(clockTimer);
    clockTimer = null;
    if (isBackground()) return;
    var n = new Date();
    var fmt = PREFS.dateFormat || "HH:mm";
    var html =
      esc(formatDate(n, fmt)) +
      "<small>" +
      formatDate(n, "ddd D MMM") +
      "</small>";
    if (html !== clockHTML) {
      document.getElementById("clock").innerHTML = html;
      clockHTML = html;
    }
    var interval = fmt.indexOf("s") >= 0 ? 1000 : 60000;
    clockTimer = setTimeout(tick, interval - (n.getTime() % interval));
  }
  function applyPrefs() {
    var b = document.body;
    b.classList.remove(
      "density-compact",
      "density-standard",
      "density-large",
      "no-labels"
    );
    b.classList.add(
      PREFS.tileSize === "compact"
        ? "density-compact"
        : PREFS.tileSize === "large"
          ? "density-large"
          : "density-standard"
    );
    if (!PREFS.labels) b.classList.add("no-labels");
    var a = ACCENTS[PREFS.accent] || ACCENTS.steel;
    b.style.setProperty("--accent", a.main);
    b.style.setProperty("--accent-soft", a.soft);
    var statsEl = document.getElementById("sysStats");
    if (statsEl)
      statsEl.style.display = PREFS.showSystemStats ? "flex" : "none";
    applyBrand();
    tick();
  }
  function persistFocus() {
    var el = document.activeElement;
    if (el && el.classList && el.classList.contains("tile")) {
      try {
        localStorage.setItem("mh.focus", el.getAttribute("data-id") || "");
      } catch (e) {}
    }
  }
  function restoreFocus() {
    var wanted = null,
      el;
    try {
      wanted = localStorage.getItem("mh.focus");
    } catch (e) {}
    el = wanted ? tile4(wanted) : null;
    el =
      el ||
      document.querySelector("#grid .tile") ||
      document.querySelector("#inputs .tile") ||
      document.querySelector("#sysrow .tile");
    try {
      if (el) el.focus();
    } catch (e) {}
  }

  function rebuild(tiles, liveInputs) {
    function validTiles(items) {
      var seen = Object.create(null);
      return items.filter(function (t) {
        if (
          !M.record(t) ||
          !M.validId(t.id) ||
          t.id === SELF_ID ||
          t.id === "__LGHOME__" ||
          seen[t.id]
        )
          return false;
        seen[t.id] = true;
        t.title = typeof t.title === "string" ? t.title : t.id;
        t.pinned = PREFS.pinned.indexOf(t.id) >= 0;
        return true;
      });
    }
    if (Array.isArray(tiles)) __mhTiles = validTiles(tiles);
    if (Array.isArray(liveInputs)) __mhInputs = validTiles(liveInputs);
    tilesLoaded = true;
    document.getElementById("retryTiles").className = "";
    document.getElementById("tileStatus").style.display = "none";
    window.__mhTiles = __mhTiles;
    var grid = document.getElementById("grid");
    var inputs = document.getElementById("inputs");
    var sysrow = document.getElementById("sysrow");
    var list = { grid: [], inputs: [], sys: [] };
    __mhTiles.forEach(function (t) {
      if (!t || !M.validId(t.id) || t.id === SELF_ID) return;
      if (PREFS.hidden.indexOf(t.id) >= 0) return;
      if (SYS_IDS.indexOf(t.id) >= 0) {
        list.sys.push(t);
      } else {
        list.grid.push(t);
      }
    });
    __mhInputs.forEach(function (t) {
      if (!t || !M.validId(t.id) || t.id === SELF_ID) return;
      if (PREFS.hidden.indexOf(t.id) >= 0) return;
      list.inputs.push(t);
    });
    list.sys.push({
      id: "__LGHOME__",
      title: "LG Home",
      icon: "",
      params: null
    });
    function reorder(arr) {
      if (PREFS.sort === "alpha") return arr.slice().sort(M.compareTitle);
      var pins = [],
        rest = [];
      arr.forEach(function (t) {
        t.pinned = PREFS.pinned.indexOf(t.id) >= 0;
        (t.pinned ? pins : rest).push(t);
      });
      pins.sort(function (a, b) {
        return PREFS.pinned.indexOf(a.id) - PREFS.pinned.indexOf(b.id);
      });
      return pins.concat(rest);
    }
    list.grid = reorder(list.grid);
    list.inputs = reorder(list.inputs);
    list.sys = reorder(list.sys);
    // Preserve DOM nodes, decoded icons and focus when discovery is unchanged.
    var signature = JSON.stringify(list);
    if (signature === renderedTiles) {
      list.grid.concat(list.inputs, list.sys).forEach(function (t) {
        var art = tile4(t.id).querySelector(".art[data-icon-failed]");
        if (art) tileArt(art, t);
      });
      return;
    }
    renderedTiles = signature;
    grid.innerHTML = "";
    inputs.innerHTML = "";
    sysrow.innerHTML = "";
    list.grid.forEach(function (t) {
      grid.appendChild(tileEl(t));
    });
    list.inputs.forEach(function (t) {
      inputs.appendChild(tileEl(t));
    });
    list.sys.forEach(function (t) {
      sysrow.appendChild(tileEl(t));
    });
    if (!overlay.mode) restoreFocus();
  }
  function tileEl(t) {
    var d = document.createElement("div");
    d.className = t.pinned ? "tile pinned" : "tile";
    d.tabIndex = 0;
    d.setAttribute("role", "button");
    d.setAttribute("aria-label", t.title || t.id);
    d.setAttribute("data-id", t.id);
    try {
      d.setAttribute("data-params", t.params ? JSON.stringify(t.params) : "");
    } catch (e) {}
    var art = document.createElement("div");
    art.className = "art";
    tileArt(art, t);
    d.appendChild(art);
    var s = document.createElement("div");
    s.className = "label";
    s.textContent = t.title || t.id;
    d.appendChild(s);
    if (t.pinned) {
      var pin = document.createElement("span");
      pin.className = "pin";
      pin.textContent = "★";
      d.appendChild(pin);
    }
    d.addEventListener("click", function () {
      doLaunch(d);
    });
    return d;
  }
  function tileArt(art, t) {
    art.innerHTML = "";
    art.removeAttribute("data-icon-failed");
    if (t.icon) {
      var img = document.createElement("img");
      img.src = t.icon;
      img.alt = "";
      img.setAttribute("data-title", t.title || t.id);
      img.addEventListener("error", function () {
        try {
          art.replaceChild(mkInitialEl(t.title), img);
          art.setAttribute("data-icon-failed", "true");
        } catch (e) {}
      });
      art.appendChild(img);
    } else {
      art.appendChild(mkInitialEl(t.title));
    }
  }
  function doLaunch(el) {
    if (el.id === "retryTiles") {
      tries = 0;
      refresh();
      return;
    }
    var id = el.getAttribute("data-id");
    if (SETTINGS_TILE && id === SETTINGS_TILE.id) {
      openSettingsPanel();
      return;
    }
    if (!id) return;
    if (id === "__LGHOME__") {
      launchLGHome();
      return;
    }
    launch(id, tileParams(el));
  }
  function launchLGHome() {
    svcCall(
      SVC,
      SVC_LGHOME_M,
      {},
      function () {},
      function (error) {
        showError((error && error.errorText) || "Could not open LG Home");
      }
    );
  }
  function launchFromId(id) {
    var t = null;
    __mhTiles.concat(__mhInputs).forEach(function (x) {
      if (x.id === id) t = x;
    });
    launch(id, (t && t.params) || null);
  }
  function mkInitialEl(title) {
    var d = document.createElement("div");
    d.className = "initial";
    d.textContent = ((title || "?").trim().charAt(0) || "?").toUpperCase();
    return d;
  }

  var SETTING_ROWS = [
    {
      key: "brand",
      group: "Header",
      label: "Brand name",
      type: "action",
      fmt: function () {
        return effectiveBrand();
      }
    },
    {
      key: "tvsettings",
      group: "TV",
      label: "TV settings",
      type: "action",
      fmt: function () {
        return "open";
      }
    },
    {
      key: "showSystemStats",
      group: "Clock & status",
      label: "System stats",
      type: "toggle",
      fmt: function (v) {
        return v ? "On" : "Off";
      }
    },
    {
      key: "dateFormat",
      label: "Clock format",
      type: "choice",
      opts: M.choices.dateFormat,
      fmt: function (v) {
        return esc(dateFormatName(v)) + " · " + esc(formatDate(new Date(), v));
      }
    },
    {
      key: "accent",
      group: "Appearance",
      label: "Accent color",
      type: "accent"
    },
    {
      key: "tileSize",
      label: "Tile size",
      type: "choice",
      opts: M.choices.tileSize,
      fmt: function (v) {
        return v.charAt(0).toUpperCase() + v.slice(1);
      }
    },
    {
      key: "labels",
      label: "App labels",
      type: "toggle",
      fmt: function (v) {
        return v ? "On" : "Off";
      }
    },
    {
      key: "sort",
      group: "Apps",
      label: "Sort order",
      type: "choice",
      opts: M.choices.sort,
      fmt: function (v) {
        return v === "mru"
          ? "Recently used"
          : v === "alpha"
            ? "Alphabetical"
            : "Pinned first";
      }
    },
    {
      key: "manage",
      label: "Hidden apps",
      type: "action",
      fmt: function () {
        return "open";
      }
    },
    {
      key: "status",
      group: "Preferences",
      label: "Status",
      type: "action",
      fmt: function () {
        return window.__MHBUILD || "";
      }
    },
    {
      key: "reset",
      label: "Reset preferences",
      type: "action",
      fmt: function () {
        return "reset";
      }
    },
    {
      key: "close",
      label: "Close panel",
      type: "action",
      fmt: function () {
        return "close";
      }
    }
  ];
  function findRow(key) {
    for (var i = 0; i < SETTING_ROWS.length; i++)
      if (SETTING_ROWS[i].key === key) return SETTING_ROWS[i];
    return null;
  }
  function commitPrefs(onDone) {
    prefsRevision++;
    if (onDone) prefsCompletions.push(onDone);
    if (!prefsSaving) savePrefs();
  }
  function runCompletions() {
    var completions = prefsCompletions;
    prefsCompletions = [];
    completions.forEach(function (completion) {
      completion();
    });
  }
  function diffPrefs(current, base) {
    // Edits send only keys that differ from the last saved snapshot, so an
    // edit made before initial discovery completes cannot overwrite saved
    // customization with startup defaults. The relay merges per key.
    var diff = {};
    Object.keys(current).forEach(function (key) {
      if (JSON.stringify(current[key]) !== JSON.stringify(base[key]))
        diff[key] = current[key];
    });
    return diff;
  }
  function savePrefs() {
    prefsSaving = true;
    var revision = prefsRevision;
    function finish(response, error) {
      prefsSaving = false;
      if (revision !== prefsRevision) {
        savePrefs();
        return;
      }
      if (error)
        showError(
          "Could not save settings: " + (error.errorText || "unknown error")
        );
      else {
        PREFS = M.preferences(response.prefs);
        lastSavedPrefs = M.preferences(response.prefs);
      }
      runCompletions();
    }
    var payload = diffPrefs(PREFS, lastSavedPrefs);
    if (Object.keys(payload).length === 0) {
      finish({ prefs: PREFS }, null);
      return;
    }
    svcCall(
      SVC,
      SVC_PREFS_SET_M,
      payload,
      function (response) {
        finish(response, null);
      },
      function (error) {
        finish(null, error || { errorText: "unknown error" });
      }
    );
  }
  function changeSetting(key, delta) {
    var r = findRow(key);
    if (!r || r.type === "action") return;
    if (r.type === "toggle") {
      PREFS[key] = !PREFS[key];
    } else if (r.type === "choice") {
      var i = r.opts.indexOf(PREFS[key]);
      PREFS[key] = r.opts[(i + delta + r.opts.length) % r.opts.length];
    } else if (r.type === "accent") {
      var ks = Object.keys(ACCENTS),
        j = ks.indexOf(PREFS[key]);
      PREFS[key] = ks[(j + delta + ks.length) % ks.length];
    }
    applyPrefs();
    updateRow(key);
    commitPrefs(function () {
      if (key === "sort") refresh();
    });
  }
  function updateRow(key) {
    var row = document.querySelector(
      '#settingsRows .srow[data-key="' + key + '"]'
    );
    if (!row) return;
    var r = findRow(key);
    if (!r) return;
    var val = row.querySelector(".val");
    if (!val) return;
    if (r.type === "accent") {
      val.innerHTML = accentDots();
    } else {
      val.textContent = r.fmt(PREFS[key]);
    }
  }
  function focusRow(key) {
    var r = document.querySelector(
      '#settingsRows .srow[data-key="' + key + '"]'
    );
    try {
      if (r) r.focus();
    } catch (e) {}
  }
  function accentDots() {
    return ["steel", "emerald", "violet", "amber", "crimson"]
      .map(function (name) {
        return (
          '<span class="dot' +
          (name === PREFS.accent ? " sel" : "") +
          '" data-name="' +
          name +
          '" style="background:' +
          ACCENTS[name].main +
          '"></span>'
        );
      })
      .join("");
  }
  function renderSettings() {
    var box = document.getElementById("settingsRows");
    var html = [],
      i,
      r,
      key;
    for (i = 0; i < SETTING_ROWS.length; i++) {
      r = SETTING_ROWS[i];
      key = PREFS[r.key];
      if (r.group) {
        html.push('<h2 class="settings-group">' + esc(r.group) + "</h2>");
      }
      if (r.type === "accent") {
        var dots = accentDots();
        html.push(
          '<div class="srow" tabindex="0" data-key="accent"><span class="sl">' +
            r.label +
            '</span><span class="val dots">' +
            dots +
            "</span></div>"
        );
      } else {
        html.push(
          '<div class="srow" tabindex="0" data-key="' +
            r.key +
            '"><span class="sl">' +
            r.label +
            '</span><span class="val">' +
            r.fmt(key) +
            "</span></div>"
        );
      }
    }
    box.innerHTML = html.join("");
  }
  function resetAll() {
    PREFS = M.preferences();
    applyPrefs();
    renderSettings();
    focusRow("reset");
    commitPrefs(function () {
      refresh();
    });
  }
  function acceptPrefs(prefs, revision) {
    if (prefsSaving || revision !== prefsRevision || !M.record(prefs)) return;
    var update = M.cleanPrefs(prefs);
    Object.keys(update).forEach(function (key) {
      PREFS[key] = update[key];
      // Arrays are shared by reference: pin/hide edits mutate PREFS in
      // place, so the snapshot needs its own copy to diff against.
      lastSavedPrefs[key] = Array.isArray(update[key])
        ? update[key].slice()
        : update[key];
    });
    applyPrefs();
    if (overlay.mode === "settings")
      SETTING_ROWS.forEach(function (row) {
        updateRow(row.key);
      });
  }
  function loadPrefs() {
    // Compatibility fallback for a relay that does not bundle preferences.
    var revision = prefsRevision;
    svcCall(
      SVC,
      SVC_PREFS_GET_M,
      {},
      function (response) {
        acceptPrefs(response && response.prefs, revision);
        if (tilesLoaded) rebuild(__mhTiles, __mhInputs);
      },
      function () {}
    );
  }

  function showOverlay(id) {
    stopHold();
    clearTimeout(enterHoldTimer);
    enterHoldTimer = null;
    document.getElementById("dim").classList.add("show");
    document.getElementById(id).classList.add("show");
  }
  function hideOverlay() {
    document.getElementById("dim").classList.remove("show");
    document.getElementById("settingsPanel").classList.remove("show");
    document.getElementById("brandPanel").classList.remove("show");
    document.getElementById("confirmPanel").classList.remove("show");
    document.getElementById("moveHint").style.display = "none";
    document.getElementById("statusPanel").classList.remove("show");
    moveState = null;
    document.getElementById("optionsPanel").classList.remove("show");
    document.getElementById("searchBox").classList.remove("show");
    overlay.mode = null;
    var el =
      lastFocusEl && document.body.contains(lastFocusEl)
        ? lastFocusEl
        : document.querySelector("#grid .tile");
    try {
      if (el) el.focus();
    } catch (e) {}
  }
  function focusFirst(sel) {
    var f = document.querySelector(sel);
    try {
      if (f) f.focus();
    } catch (e) {}
  }
  function openSettingsPanel() {
    lastFocusEl = document.activeElement;
    overlay.mode = "settings";
    renderSettings();
    showOverlay("settingsPanel");
    focusFirst("#settingsRows .srow");
  }
  function effectiveBrand() {
    return M.brand(PREFS.brand) || configuredHeader.brand || DEFAULT_BRAND;
  }
  function applyBrand() {
    var name = effectiveBrand();
    document.getElementById("headBrand").textContent = name;
    document.title = name;
  }
  function updateBrandPreview() {
    var value = M.brand(document.getElementById("brandInput").value);
    document.getElementById("brandPreview").textContent =
      value || effectiveBrand();
  }
  function openBrandEditor(firstRun) {
    if (firstRun) lastFocusEl = document.activeElement;
    else document.getElementById("settingsPanel").classList.remove("show");
    brandFirstRun = !!firstRun;
    document.getElementById("brandInput").value = effectiveBrand();
    document.getElementById("brandError").textContent = "";
    document.getElementById("brandCancelLabel").textContent = firstRun
      ? "Keep " + DEFAULT_BRAND
      : "Cancel";
    updateBrandPreview();
    overlay.mode = "brand";
    showOverlay("brandPanel");
    focusFirst("#brandInput");
  }
  function closeBrandEditor(save) {
    var firstRun = brandFirstRun;
    var changed = false;
    if (save) {
      var name = M.brand(document.getElementById("brandInput").value);
      if (!name) {
        document.getElementById("brandError").textContent =
          "Enter a name from 1 to 40 characters.";
        focusFirst("#brandInput");
        return;
      }
      PREFS.brand = name;
      PREFS.brandConfigured = true;
      changed = true;
    } else if (firstRun && !PREFS.brandConfigured) {
      PREFS.brandConfigured = true;
      changed = true;
    }
    brandFirstRun = false;
    applyBrand();
    document.getElementById("brandPanel").classList.remove("show");
    if (firstRun) {
      hideOverlay();
    } else {
      overlay.mode = "settings";
      renderSettings();
      document.getElementById("settingsPanel").classList.add("show");
      focusRow("brand");
    }
    if (changed) commitPrefs();
  }
  function openConfirmReset() {
    document.getElementById("settingsPanel").classList.remove("show");
    overlay.mode = "confirm";
    showOverlay("confirmPanel");
    focusFirst('[data-key="reset-cancel"]');
  }
  function closeConfirmReset(confirmed) {
    document.getElementById("confirmPanel").classList.remove("show");
    overlay.mode = "settings";
    renderSettings();
    document.getElementById("settingsPanel").classList.add("show");
    if (confirmed) resetAll();
    else focusRow("reset");
  }
  function maybePromptBrand() {
    if (
      !headerLoaded ||
      overlay.mode ||
      PREFS.brandConfigured ||
      M.brand(PREFS.brand) ||
      configuredHeader.brand !== DEFAULT_BRAND
    )
      return;
    openBrandEditor(true);
  }
  function statusTime(ts) {
    return formatDate(new Date(ts), "HH:mm:ss");
  }
  function statusTilesRow() {
    if (!health.tilesAt) return "waiting";
    return (
      (health.tilesOk ? "ok · " : "failed · ") + statusTime(health.tilesAt)
    );
  }
  function statusStatsRow() {
    if (!PREFS.showSystemStats) return "disabled";
    if (!health.statsAt) return "unavailable";
    if (!health.statsOk) return "failed · " + statusTime(health.statsAt);
    if (Date.now() - health.statsAt > 20000)
      return "stale · " + statusTime(health.statsAt);
    return "fresh · " + statusTime(health.statsAt);
  }
  function statusRelayRow() {
    if (!health.lunaAt) return "no requests yet";
    return (
      (health.lunaOk ? "reachable · " : "unreachable · ") +
      statusTime(health.lunaAt)
    );
  }
  function statusRow(label, value) {
    return (
      '<div class="srow" tabindex="0" data-key="none"><span class="sl">' +
      esc(label) +
      '</span><span class="val">' +
      esc(value) +
      "</span></div>"
    );
  }
  function statusActionRow(key, label, hint) {
    return (
      '<div class="srow" tabindex="0" data-key="' +
      key +
      '"><span class="sl">' +
      esc(label) +
      '</span><span class="val">' +
      esc(hint) +
      "</span></div>"
    );
  }
  function statusNote(text) {
    return (
      '<div class="srow" tabindex="0" data-key="none"><span class="small">' +
      esc(text) +
      "</span></div>"
    );
  }
  function renderStatus() {
    var focused =
      document.activeElement && document.activeElement.getAttribute
        ? document.activeElement.getAttribute("data-key")
        : null;
    document.getElementById("statusRows").innerHTML = [
      statusRow("Build", window.__MHBUILD || "unknown"),
      statusRow("Tiles", statusTilesRow()),
      statusRow("System stats", statusStatsRow()),
      statusRow("Relay", statusRelayRow()),
      statusActionRow("status-refresh", "Refresh now", "OK"),
      statusActionRow("status-lghome", "Open LG Home", "10-min bypass"),
      statusNote(
        "No tiles? Refresh now, then Retry on the home grid. Stats need the watcher hook; see INSTALL."
      ),
      statusActionRow("status-close", "Back to Settings", "OK")
    ].join("");
    var restore =
      (focused &&
        document.querySelector('#statusRows [data-key="' + focused + '"]')) ||
      document.querySelector("#statusRows .srow");
    try {
      if (restore) restore.focus();
    } catch (e) {}
  }
  function openStatus() {
    document.getElementById("settingsPanel").classList.remove("show");
    overlay.mode = "status";
    renderStatus();
    showOverlay("statusPanel");
    focusFirst("#statusRows .srow");
  }
  function closeStatus() {
    document.getElementById("statusPanel").classList.remove("show");
    overlay.mode = "settings";
    renderSettings();
    document.getElementById("settingsPanel").classList.add("show");
    focusRow("status");
  }
  function activateStatusRow(el) {
    var key = el.getAttribute("data-key");
    if (key === "status-refresh") refresh();
    else if (key === "status-lghome") launchLGHome();
    else if (key === "status-close") closeStatus();
  }
  function openOptions(el) {
    lastFocusEl = el;
    overlay.mode = "options";
    var id = el.getAttribute("data-id");
    var label =
      el.querySelector && el.querySelector(".label")
        ? el.querySelector(".label").textContent
        : id;
    var pinned = PREFS.pinned.indexOf(id) >= 0;
    var rows = ["Pin", "Hide app", "Launch", "Close"];
    if (pinned) rows[0] = "Unpin";
    if (pinned && PREFS.sort !== "alpha" && sectionPinnedIds(id).length > 1)
      rows.splice(2, 0, "Move");
    document.getElementById("optionsRows").innerHTML = rows
      .map(function (l) {
        return (
          '<div class="optrow" tabindex="0" data-id="' +
          esc(id) +
          '"><span class="sl">' +
          l +
          "</span></div>"
        );
      })
      .join("");
    document
      .getElementById("optionsPanel")
      .querySelector(".panel-head").innerHTML =
      "Options <small>" + esc(label) + "</small>";
    showOverlay("optionsPanel");
    focusFirst("#optionsRows .optrow");
  }
  function openManage() {
    overlay.mode = "manage";
    var hidden = [];
    __mhTiles.concat(__mhInputs).forEach(function (t) {
      if (PREFS.hidden.indexOf(t.id) >= 0) hidden.push(t);
    });
    var html = hidden.length
      ? hidden
          .map(function (t) {
            var pin = PREFS.pinned.indexOf(t.id) >= 0 ? " ★" : "";
            return (
              '<div class="optrow" tabindex="0" data-id="' +
              esc(t.id) +
              '"><span class="sl">' +
              esc(t.title || t.id) +
              pin +
              '</span><span class="small">' +
              esc(t.id) +
              "</span></div>"
            );
          })
          .join("")
      : '<div class="srow" tabindex="0" data-key="none"><span class="sl">No hidden apps</span></div>';
    html +=
      '<div class="optrow" tabindex="0" data-key="close"><span class="sl">Close</span></div>';
    document.getElementById("optionsRows").innerHTML = html;
    document
      .getElementById("optionsPanel")
      .querySelector(".panel-head").innerHTML =
      "Hidden apps <small>select to restore</small>";
    showOverlay("optionsPanel");
    focusFirst("#optionsRows .optrow, #optionsRows .srow");
  }
  function togglePin(id) {
    var i = PREFS.pinned.indexOf(id);
    if (i >= 0) PREFS.pinned.splice(i, 1);
    else if (PREFS.pinned.length < 30) PREFS.pinned.push(id);
    commitPrefs(function () {
      refresh();
    });
  }
  function hideApp(id) {
    if (PREFS.hidden.indexOf(id) < 0 && PREFS.hidden.length < 60)
      PREFS.hidden.push(id);
    try {
      localStorage.removeItem("mh.focus");
    } catch (e) {}
    commitPrefs(function () {
      refresh();
    });
  }
  function sectionPinnedIds(id) {
    var el = tile4(id);
    if (!el || !el.parentNode) return [];
    var found = [];
    var tiles = el.parentNode.querySelectorAll(".tile.pinned");
    for (var i = 0; i < tiles.length; i++)
      found.push(tiles[i].getAttribute("data-id"));
    return found;
  }
  function swapPinned(first, second) {
    var order = PREFS.pinned.slice();
    var a = order.indexOf(first);
    var b = order.indexOf(second);
    if (a < 0 || b < 0) return;
    order[a] = second;
    order[b] = first;
    PREFS.pinned = order;
  }
  var moveState = null;
  function markMovedTile() {
    var el = moveState && tile4(moveState.id);
    if (!el) return;
    el.focus();
    el.classList.add("moving");
  }
  function openMove(id) {
    moveState = { id: id, snapshot: PREFS.pinned.slice() };
    document.getElementById("optionsPanel").classList.remove("show");
    document.getElementById("moveHint").style.display = "block";
    overlay.mode = "move";
    markMovedTile();
  }
  function moveStep(dir) {
    if (!moveState) return;
    var neighbors = sectionPinnedIds(moveState.id);
    var at = neighbors.indexOf(moveState.id);
    var other = dir === "left" ? neighbors[at - 1] : neighbors[at + 1];
    if (at < 0 || !other) return;
    swapPinned(moveState.id, other);
    rebuild(__mhTiles, __mhInputs);
    markMovedTile();
  }
  function moveDirKey(dir) {
    if (dir === "left" || dir === "right") moveStep(dir);
    return true;
  }
  function unmarkMovedTiles() {
    Array.prototype.forEach.call(
      document.querySelectorAll(".tile.moving"),
      function (t) {
        t.classList.remove("moving");
      }
    );
  }
  function closeMove(save) {
    var id = moveState ? moveState.id : null;
    if (!save && moveState) PREFS.pinned = moveState.snapshot;
    if (save)
      commitPrefs(function () {
        refresh();
      });
    moveState = null;
    document.getElementById("moveHint").style.display = "none";
    unmarkMovedTiles();
    rebuild(__mhTiles, __mhInputs);
    var el = id && tile4(id);
    if (el) {
      el.focus();
      lastFocusEl = el;
    }
    hideOverlay();
  }
  function launchSearchRow(id) {
    hideOverlay();
    launchFromId(id);
  }
  var searchQ = "";
  function searchInput() {
    return document.getElementById("searchInput");
  }
  function openSearch(ch) {
    lastFocusEl = document.activeElement;
    overlay.mode = "search";
    searchQ = ch || "";
    renderSearch();
    showOverlay("searchBox");
    searchInput().value = searchQ;
    searchInput().focus();
  }
  function searchMatches() {
    var q = searchQ.toLowerCase();
    if (!q) return [];
    var starts = [],
      cont = [];
    __mhTiles.concat(__mhInputs).forEach(function (t) {
      if (PREFS.hidden.indexOf(t.id) >= 0) return;
      var title = (t.title || "").toLowerCase(),
        id = (t.id || "").toLowerCase();
      if (title.indexOf(q) === 0 || id.indexOf(q) === 0) starts.push(t);
      else if (title.indexOf(q) >= 0 || id.indexOf(q) >= 0) cont.push(t);
    });
    return starts.concat(cont).slice(0, 8);
  }
  function renderSearch() {
    var input = searchInput();
    if (document.activeElement !== input) input.value = searchQ;
    var list = searchMatches();
    var html;
    if (!searchQ) {
      html =
        '<div class="srow" tabindex="0" data-key="none"><span class="sl">Type to search installed apps</span></div>';
    } else if (list.length) {
      html = list
        .map(function (t) {
          return (
            '<div class="srow" tabindex="0" data-id="' +
            esc(t.id) +
            '"><span class="sl">' +
            esc(t.title || t.id) +
            '</span><span class="small">' +
            esc(t.id) +
            "</span></div>"
          );
        })
        .join("");
    } else {
      html =
        '<div class="srow" tabindex="0" data-key="none"><span class="sl">No matches</span></div>';
    }
    document.getElementById("searchRows").innerHTML = html;
  }
  function activateBrandRow(el) {
    var key = el.getAttribute("data-key");
    if (key === "brand-save") closeBrandEditor(true);
    else if (key === "brand-cancel") closeBrandEditor(false);
  }
  function activateSettingsRow(el) {
    var key = el.getAttribute("data-key");
    if (key === "brand") {
      openBrandEditor(false);
      return;
    }
    if (key === "tvsettings") {
      hideOverlay();
      if (SETTINGS_TILE) launch(SETTINGS_TILE.id, null);
      return;
    }
    if (key === "close") {
      hideOverlay();
      return;
    }
    if (key === "manage") {
      openManage();
      return;
    }
    if (key === "status") {
      openStatus();
      return;
    }
    if (key === "reset") {
      openConfirmReset();
      return;
    }
    if (key && findRow(key)) changeSetting(key, 1);
  }
  function activateManageRow(el) {
    if (el.getAttribute("data-key") === "close") {
      hideOverlay();
      return;
    }
    var id = el.getAttribute("data-id");
    if (!id) return;
    var i = PREFS.hidden.indexOf(id);
    if (i >= 0) PREFS.hidden.splice(i, 1);
    commitPrefs(function () {
      hideOverlay();
      refresh();
    });
  }
  function activateOptionsRow(el) {
    var label = el.querySelector(".sl")
      ? el.querySelector(".sl").textContent
      : "";
    var id = el.getAttribute("data-id");
    if (label === "Close") {
      hideOverlay();
      return;
    }
    if (label === "Move") {
      if (id) openMove(id);
      return;
    }
    hideOverlay();
    if (!id) return;
    if (label === "Pin" || label === "Unpin") togglePin(id);
    else if (label === "Hide app") hideApp(id);
    else if (lastFocusEl) doLaunch(lastFocusEl);
  }
  function activateSearchRow(el) {
    var id = el.getAttribute("data-id");
    if (id) launchSearchRow(id);
  }
  function activateConfirmRow(el) {
    var key = el.getAttribute("data-key");
    if (key === "reset-confirm") closeConfirmReset(true);
    else if (key === "reset-cancel") closeConfirmReset(false);
  }
  var ROW_ACTIVATORS = {
    brand: activateBrandRow,
    settings: activateSettingsRow,
    manage: activateManageRow,
    options: activateOptionsRow,
    search: activateSearchRow,
    confirm: activateConfirmRow,
    status: activateStatusRow
  };
  function activateRow(el) {
    if (!el) return;
    var activate = ROW_ACTIVATORS[overlay.mode];
    if (activate) activate(el);
  }
  function brandBackKey() {
    // The brand name is typed with the TV on-screen keyboard: Back and
    // Backspace must reach the field (or dismiss the keyboard), never
    // close the dialog and discard the typed name. The Save/Cancel rows
    // dismiss the editor explicitly; elsewhere Back is swallowed so the
    // webview never prompts to exit.
    if (document.activeElement === document.getElementById("brandInput"))
      return false;
    return true;
  }
  function searchBackKey(kc) {
    // While the field is focused the on-screen keyboard owns editing: Back
    // dismisses it by leaving the field, and only a later Back closes search.
    if (document.activeElement === searchInput()) {
      if (kc === 8) return false;
      searchInput().blur();
      focusFirst("#searchRows .srow");
      return true;
    }
    if (kc === 8 && searchQ) {
      searchQ = searchQ.slice(0, -1);
      renderSearch();
      focusFirst("#searchRows .srow");
      return true;
    }
    hideOverlay();
    return true;
  }
  function overlayBackKey(kc) {
    if (overlay.mode === "search") return searchBackKey(kc);
    if (overlay.mode === "brand") return brandBackKey();
    if (overlay.mode === "confirm") {
      closeConfirmReset(false);
      return true;
    }
    if (overlay.mode === "move") {
      closeMove(false);
      return true;
    }
    if (overlay.mode === "status") {
      closeStatus();
      return true;
    }
    hideOverlay();
    return true;
  }
  function brandDirKey(dir) {
    if (
      document.activeElement === document.getElementById("brandInput") &&
      (dir === "left" || dir === "right")
    )
      return false;
    moveFocusIn("#brandInput, #brandPanel .brand-actions .srow", dir);
    return true;
  }
  function settingsDirKey(dir) {
    if (dir !== "left" && dir !== "right") {
      moveFocusIn("#settingsRows .srow", dir);
      return true;
    }
    var row = document.activeElement;
    if (
      !row ||
      !row.className ||
      row.className.indexOf("srow") < 0 ||
      !row.getAttribute("data-key")
    )
      return true;
    changeSetting(row.getAttribute("data-key"), dir === "left" ? -1 : 1);
    return true;
  }
  function searchDirKey(dir) {
    if (
      document.activeElement === searchInput() &&
      (dir === "left" || dir === "right")
    )
      return false;
    moveFocusIn("#searchInput, #searchRows .srow", dir);
    return true;
  }
  function overlayDirKey(dir) {
    if (overlay.mode === "brand") return brandDirKey(dir);
    if (overlay.mode === "settings") return settingsDirKey(dir);
    if (overlay.mode === "search") return searchDirKey(dir);
    if (overlay.mode === "confirm") {
      moveFocusIn("#confirmPanel .srow", dir);
      return true;
    }
    if (overlay.mode === "status") {
      moveFocusIn("#statusRows .srow", dir);
      return true;
    }
    if (overlay.mode === "move") return moveDirKey(dir);
    var selectors = {
      options: "#optionsRows .optrow",
      manage: "#optionsRows .optrow, #optionsRows .srow"
    };
    moveFocusIn(selectors[overlay.mode], dir);
    return true;
  }
  function overlayKey(e) {
    var kc = e.keyCode;
    if (BACK_KEYS[kc]) return overlayBackKey(kc);
    var dir = dirOf(kc);
    if (dir) return overlayDirKey(dir);
    if (kc === 13) {
      if (
        (overlay.mode === "brand" &&
          document.activeElement === document.getElementById("brandInput")) ||
        (overlay.mode === "search" && document.activeElement === searchInput())
      )
        return false;
      if (overlay.mode === "move") {
        closeMove(true);
        return true;
      }
      e.preventDefault();
      var el = document.activeElement;
      activateRow(el);
      return true;
    }
    if (overlay.mode === "search") {
      if (document.activeElement === searchInput()) return false;
      if (
        e.key &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        searchQ.length < 100
      ) {
        searchQ += e.key;
        renderSearch();
        focusFirst("#searchRows .srow");
        return true;
      }
    }
    return false;
  }
  function moveFocusIn(sel, dir) {
    var els = Array.prototype.slice.call(document.querySelectorAll(sel));
    var cur = els.indexOf(document.activeElement);
    var next =
      dir === "down" || dir === "right"
        ? cur + 1 < els.length
          ? cur + 1
          : 0
        : cur - 1 >= 0
          ? cur - 1
          : els.length - 1;
    if (els[next]) {
      els[next].focus();
      try {
        els[next].scrollIntoView({ block: "nearest" });
      } catch (e) {}
    }
  }

  function mainRowTiles() {
    return Array.prototype.slice.call(
      document.querySelectorAll("#grid .tile, #inputs .tile, #sysrow .tile")
    );
  }
  function buildRows(els) {
    var rows = [],
      cur = -1;
    els.forEach(function (el) {
      var top = Math.round(el.getBoundingClientRect().top);
      var row = rows[cur];
      if (!row || Math.abs(row.top - top) > 12) {
        rows.push({ top: top, items: [el] });
        cur = rows.length - 1;
      } else {
        row.items.push(el);
      }
    });
    return rows;
  }
  function findTileColumn(items, cEl) {
    for (var ii = 0; ii < items.length; ii++) {
      if (items[ii] === cEl) return ii;
    }
    return -1;
  }
  function findTileCell(rows, cEl) {
    for (var ri = 0; ri < rows.length; ri++) {
      var col = findTileColumn(rows[ri].items, cEl);
      if (col >= 0) return { row: ri, col: col };
    }
    return null;
  }
  function wrapTile(cur, dir) {
    var main = mainRowTiles();
    var cEl = navTiles()[cur];
    var rows = buildRows(main);
    var cell = findTileCell(rows, cEl);
    if (!cell) return null;
    var ni =
      dir === "right" || dir === "down"
        ? (cell.row + 1) % rows.length
        : (cell.row - 1 + rows.length) % rows.length;
    var row = rows[ni];
    return row ? row.items[cell.col] || row.items[row.items.length - 1] : null;
  }
  function navTiles() {
    return Array.prototype.slice.call(document.querySelectorAll(".tile"));
  }
  function moveTile(dir) {
    var tiles = navTiles();
    var cur = tiles.indexOf(document.activeElement);
    if (cur < 0) {
      var g = document.querySelector("#grid .tile") || tiles[0];
      if (g && g !== document.activeElement) g.focus();
      persistFocus();
      return;
    }
    var r0 = tiles[cur].getBoundingClientRect();
    var cx0 = r0.left + r0.width / 2,
      cy0 = r0.top + r0.height / 2,
      best = -1,
      bestScore = Infinity,
      i,
      r,
      cx,
      cy,
      dx,
      dy,
      primary,
      secondary,
      score;
    for (i = 0; i < tiles.length; i++) {
      if (i === cur) continue;
      r = tiles[i].getBoundingClientRect();
      cx = r.left + r.width / 2;
      cy = r.top + r.height / 2;
      dx = cx - cx0;
      dy = cy - cy0;
      if (dir === "left" && dx >= -4) continue;
      if (dir === "right" && dx <= 4) continue;
      if (dir === "up" && dy >= -4) continue;
      if (dir === "down" && dy <= 4) continue;
      if (dir === "left" || dir === "right") {
        primary = Math.abs(dx);
        secondary = Math.abs(dy);
      } else {
        primary = Math.abs(dy);
        secondary = Math.abs(dx);
      }
      score = primary + secondary * 2.2;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    var target = best >= 0 ? tiles[best] : wrapTile(cur, dir);
    if (target && target !== document.activeElement) {
      target.focus();
      try {
        target.scrollIntoView({ block: "nearest" });
      } catch (e) {}
    }
    persistFocus();
  }
  function startHold(dir) {
    stopHold();
    holdDir = dir;
    holdN = 1;
    function step() {
      if (!holdDir) return;
      moveTile(holdDir);
      holdN++;
      var d = holdN < 4 ? 150 : holdN < 10 ? 90 : 55;
      holdTimer = setTimeout(step, d);
    }
    holdTimer = setTimeout(step, 450);
  }
  function stopHold() {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    holdDir = null;
    holdN = 0;
  }
  function enterKey() {
    var el0 = document.activeElement;
    if (!el0) return;
    if (el0.id === "settingsBtn") {
      openSettingsPanel();
      return;
    }
    if (el0.id === "searchBtn") {
      openSearch("");
      return;
    }
    if (el0.className && (" " + el0.className + " ").indexOf(" tile ") >= 0)
      doLaunch(el0);
  }
  var enterHoldTimer = null,
    enterPressed = false;
  function enterDown() {
    if (enterPressed) return;
    enterPressed = true;
    enterHoldTimer = setTimeout(function () {
      enterHoldTimer = null;
      var el0 = document.activeElement;
      if (
        el0 &&
        el0.className &&
        (" " + el0.className + " ").indexOf(" tile ") >= 0 &&
        el0.getAttribute("data-id")
      )
        openOptions(el0);
    }, 700);
  }
  function openOptionsKey() {
    var el0 = document.activeElement;
    if (
      el0 &&
      el0.className &&
      (" " + el0.className + " ").indexOf(" tile ") >= 0 &&
      el0.getAttribute("data-id")
    )
      openOptions(el0);
  }

  document.addEventListener("keydown", function (e) {
    if (overlay.mode) {
      if (e.keyCode === 13 && enterPressed) {
        // A held OK that opened this overlay must be released before
        // activation; swallow it without activating any row.
        e.preventDefault();
        return;
      }
      if (e.keyCode === 13) enterPressed = true;
      if (overlayKey(e)) e.preventDefault();
      return;
    }
    var kc = e.keyCode;
    if (kc === 13) {
      e.preventDefault();
      enterDown();
      return;
    }
    if (kc === 457 || kc === 412) {
      e.preventDefault();
      openOptionsKey();
      return;
    }
    var dir = dirOf(kc);
    if (dir) {
      e.preventDefault();
      if (holdDir !== dir) {
        moveTile(dir);
        startHold(dir);
      }
      return;
    }
    // Swallow Back everywhere on the grid: an unhandled back is what makes
    // WAM surface its "exit app?" dialog; this launcher is a home replacement
    // and never prompts to exit.
    if (BACK_KEYS[kc]) {
      e.preventDefault();
      return;
    }
    if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      openSearch(e.key.toLowerCase());
    }
  });
  document.addEventListener("keyup", function (e) {
    if (e.keyCode === 13) {
      enterPressed = false;
      if (enterHoldTimer) {
        clearTimeout(enterHoldTimer);
        enterHoldTimer = null;
        enterKey();
      }
      return;
    }
    if (dirOf(e.keyCode)) stopHold();
  });
  document.addEventListener("focusin", persistFocus);

  var sb = document.getElementById("settingsBtn");
  sb.addEventListener("click", function () {
    openSettingsPanel();
  });
  document.getElementById("searchBtn").addEventListener("click", function () {
    openSearch("");
  });
  searchInput().addEventListener("input", function () {
    searchQ = searchInput().value.slice(0, 100);
    renderSearch();
  });
  document.getElementById("brandInput").addEventListener("input", function () {
    document.getElementById("brandError").textContent = "";
    updateBrandPreview();
  });
  Array.prototype.forEach.call(
    document.querySelectorAll("#grid .tile, #inputs .tile, #sysrow .tile"),
    function (el) {
      el.addEventListener("click", function () {
        doLaunch(el);
      });
    }
  );
  document.addEventListener("click", function (e) {
    if (!overlay.mode) return;
    var t = e.target;
    while (
      t &&
      t !== document &&
      !(
        t.classList &&
        (t.classList.contains("srow") || t.classList.contains("optrow"))
      )
    )
      t = t.parentNode;
    if (!t || t === document) return;
    try {
      t.focus();
    } catch (e2) {}
    activateRow(t);
  });

  tick();
  var tries = 0,
    refreshRetry = null,
    refreshing = false,
    refreshRequested = false;
  function isBackground() {
    // webOS 10.3.1 can report hidden for a focused foreground webview.
    return document.hidden && !document.hasFocus();
  }
  function applyHeader(h) {
    if (!M.record(h)) return;
    if (typeof h.text === "string") {
      configuredHeader.text = h.text;
      document.getElementById("headText").textContent = String(
        h.text
      ).toUpperCase();
    }
    if (typeof h.brand === "string") configuredHeader.brand = h.brand;
    headerLoaded = true;
    applyBrand();
  }
  function noteTiles(ok) {
    health.tilesOk = ok;
    health.tilesAt = Date.now();
    if (overlay.mode === "status") renderStatus();
  }
  function tilesFailed() {
    refreshing = false;
    noteTiles(false);
    if (refreshRequested) {
      refreshRequested = false;
      refresh();
      return;
    }
    if (tries < 6) {
      refreshRetry = setTimeout(refresh, 2500);
    } else if (!tilesLoaded) {
      document.getElementById("tileSpinner").style.display = "none";
      document.getElementById("tileStatusText").textContent =
        "Could not load apps, inputs and system from TV.";
      document.getElementById("retryTiles").style.display = "block";
      document.getElementById("retryTiles").className = "tile";
    }
  }
  document.getElementById("retryTiles").addEventListener("click", function () {
    doLaunch(this);
  });
  function refresh() {
    if (refreshing || isBackground()) {
      // A refresh requested while a discovery is in flight must not be
      // dropped: run one trailing refresh afterwards so a stale snapshot can
      // never be the last word after returning to the foreground.
      if (refreshing) refreshRequested = true;
      return;
    }
    clearTimeout(refreshRetry);
    refreshRetry = null;
    refreshing = true;
    if (!tilesLoaded) {
      document.getElementById("tileSpinner").style.display = "block";
      document.getElementById("tileStatusText").textContent =
        "Loading apps, inputs and system from TV...";
      document.getElementById("retryTiles").style.display = "none";
      document.getElementById("retryTiles").className = "";
    }
    tries++;
    var revision = prefsSaving ? null : prefsRevision;
    svcCall(
      SVC,
      SVC_LIST_M,
      {},
      function (d) {
        refreshing = false;
        if (d && d.header) applyHeader(d.header);
        if (
          d &&
          d.returnValue === true &&
          Array.isArray(d.tiles) &&
          Array.isArray(d.inputs)
        ) {
          // a served grid means the retry budget is spent cleanly (no stale
          // tries leak into the next burst after a long foreground session)
          tries = 0;
          // Keep row placement and Settings actions in sync with the TV config.
          // Older relays omit config; retain the embedded defaults in that case.
          if (M.record(d.config) && Array.isArray(d.config.system)) {
            SYS_IDS = M.ids(d.config.system, 1000);
            SETTINGS_TILE =
              M.record(d.config.settingsTile) &&
              SYS_IDS.indexOf(d.config.settingsTile.id) >= 0
                ? { id: d.config.settingsTile.id }
                : null;
          }
          // Apply the same snapshot before rendering; never replace local edits
          // with a response requested before or during their save.
          if (M.record(d.prefs)) acceptPrefs(d.prefs, revision);
          else if (!prefsSaving && revision === prefsRevision) loadPrefs();
          rebuild(d.tiles, d.inputs);
          maybePromptBrand();
          noteTiles(true);
        } else {
          tilesFailed();
        }
        if (refreshRequested) {
          refreshRequested = false;
          refresh();
        }
      },
      tilesFailed
    );
  }
  var refreshTimer = null;
  function requestRefresh() {
    // WAM fires visibilitychange and focus back-to-back on every foreground;
    // coalesce both into one getTiles round-trip.
    if (isBackground() || refreshTimer !== null) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
    }, 400);
    refresh();
  }
  refresh();
  restoreFocus();
  document.addEventListener("visibilitychange", function () {
    tick();
    if (!isBackground()) {
      tries = 0;
      requestRefresh();
    } else {
      stopHold();
      clearTimeout(enterHoldTimer);
      enterHoldTimer = null;
      enterPressed = false;
      clearTimeout(refreshRetry);
      refreshRetry = null;
    }
  });
  document.addEventListener("webOSRelaunch", function () {
    tick();
    tries = 0;
    requestRefresh();
  });
  window.addEventListener("focus", function () {
    tick();
    tries = 0;
    requestRefresh();
  });
  window.addEventListener("blur", function () {
    stopHold();
    clearTimeout(enterHoldTimer);
    enterHoldTimer = null;
    enterPressed = false;
  });
  // System stats polling (every 5s)
  var statsPending = false;
  function noteStats(ok) {
    health.statsOk = ok;
    health.statsAt = Date.now();
    if (overlay.mode === "status") renderStatus();
  }
  function updateSystemStats() {
    if (!isBackground() && PREFS.showSystemStats && !statsPending) {
      statsPending = true;
      svcCall(
        SVC,
        SVC_STATS_M,
        {},
        function (d) {
          statsPending = false;
          noteStats(!!(d && d.returnValue));
          if (d && d.returnValue) {
            var cpu = document.getElementById("statCpu");
            var ram = document.getElementById("statRam");
            var temp = document.getElementById("statTemp");
            if (cpu)
              cpu.textContent =
                (typeof d.cpu === "number" ? d.cpu : "--") + "%";
            if (ram)
              ram.textContent =
                (typeof d.ram === "number" ? d.ram : "--") + "%";
            if (temp)
              temp.textContent =
                typeof d.temp === "number" ? d.temp + "°C" : "--°C";
          }
        },
        function () {
          statsPending = false;
          noteStats(false);
        }
      );
    }
    setTimeout(updateSystemStats, 5000);
  }
  setTimeout(updateSystemStats, 1000);
})();

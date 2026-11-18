/* Local calendar date helpers (not UTC). Also wraps localStorage for sync. */

function localDateStr(date) {
  var d = (date instanceof Date) ? date : new Date();
  var m = String(d.getMonth() + 1);
  var day = String(d.getDate());
  if (m.length < 2) m = '0' + m;
  if (day.length < 2) day = '0' + day;
  return d.getFullYear() + '-' + m + '-' + day;
}

/** Shift today's local date by a number of days (negative = past). */
function localDateShifted(offsetDays) {
  var d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return localDateStr(d);
}

/** Local YYYY-MM-DD from year + monthIndex (0-11) + day. */
function localDateYMD(year, monthIndex, day) {
  return localDateStr(new Date(year, monthIndex, day));
}

/* Sync shim: wraps localStorage immediately (classic script, not deferred).
   ES module sync.js loads later and flushes the write queue. */
(function () {
  if (typeof localStorage === 'undefined') return;
  if (window.__syncOrigLocalStorage) return;

  var STATIC_KEYS = {
    products: true,
    recipes: true,
    weights: true,
    weightHistory: true,
    name: true,
    height: true,
    weight: true,
    'target-weight': true,
    calories: true,
    'carb-pct': true,
    'protein-pct': true,
    'fat-pct': true,
    dishes: true,
    warmups: true,
    familyBlocks: true,
    'target-date': true
  };

  function isAppKey(key) {
    if (!key || typeof key !== 'string') return false;
    if (key.indexOf('firebase:') === 0 || key.indexOf('firebaseui') === 0) return false;
    if (key.indexOf('__sync') === 0) return false;
    if (STATIC_KEYS[key]) return true;
    if (/^diary-\d{4}-\d{2}-\d{2}$/.test(key)) return true;
    if (/^workouts-\d{4}-\d{2}-\d{2}$/.test(key)) return true;
    if (/^steps-\d{4}-\d{2}-\d{2}$/.test(key)) return true;
    if (/^familyBlock-/.test(key)) return true;
    return false;
  }

  function listAppKeys() {
    var keys = [];
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (isAppKey(k)) keys.push(k);
    }
    return keys;
  }

  var orig = {
    setItem: localStorage.setItem.bind(localStorage),
    removeItem: localStorage.removeItem.bind(localStorage),
    clear: localStorage.clear.bind(localStorage),
    getItem: localStorage.getItem.bind(localStorage),
    key: localStorage.key.bind(localStorage)
  };

  window.__syncOrigLocalStorage = orig;
  window.__syncQueue = [];
  window.__isCalorieAppKey = isAppKey;
  window.__listCalorieAppKeys = listAppKeys;

  function enqueue(op, key, value) {
    if (!isAppKey(key) && op !== 'clear') return;
    if (typeof window.__syncPush === 'function') {
      window.__syncPush(op, key, value);
    } else {
      window.__syncQueue.push({ op: op, key: key, value: value });
    }
  }

  function hide(name, fn) {
    Object.defineProperty(localStorage, name, {
      value: fn,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  hide('setItem', function (key, value) {
    orig.setItem(key, value);
    enqueue('set', String(key), value == null ? '' : String(value));
  });

  hide('removeItem', function (key) {
    orig.removeItem(key);
    enqueue('remove', String(key));
  });

  // Do not call native clear(): it would also wipe Firebase auth keys.
  hide('clear', function () {
    var keys = listAppKeys();
    for (var i = 0; i < keys.length; i++) orig.removeItem(keys[i]);
    enqueue('clear', null, keys);
  });

  // One-time-safe merge: entries in weightHistory that are missing from weights
  // are copied into weights as {date, value}. weightHistory is left untouched.
  (function mergeWeightHistory() {
    var rawHist = orig.getItem('weightHistory');
    if (!rawHist) return;
    var hist;
    try { hist = JSON.parse(rawHist); } catch (e) { return; }
    if (!Array.isArray(hist) || !hist.length) return;

    var weights = [];
    var rawW = orig.getItem('weights');
    if (rawW) {
      try { weights = JSON.parse(rawW); } catch (e) { weights = []; }
      if (!Array.isArray(weights)) weights = [];
    }

    var byDate = {};
    for (var i = 0; i < weights.length; i++) {
      if (weights[i] && weights[i].date) byDate[weights[i].date] = true;
    }

    var added = 0;
    for (var j = 0; j < hist.length; j++) {
      var e = hist[j];
      if (!e || !e.date || byDate[e.date]) continue;
      var rawVal = (e.value != null) ? e.value : e.weight;
      var val = parseFloat(rawVal);
      if (isNaN(val)) continue;
      weights.push({ date: e.date, value: val });
      byDate[e.date] = true;
      added++;
    }
    if (!added) return;
    weights.sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date));
    });
    localStorage.setItem('weights', JSON.stringify(weights));
  })();
})();

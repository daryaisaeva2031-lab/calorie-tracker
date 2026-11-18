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
    'fat-pct': true
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
})();

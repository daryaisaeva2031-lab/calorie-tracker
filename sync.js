// Cross-device sync for calorie-tracker via Firebase Auth (Google) + Firestore.
// Pages always render from localStorage; this module never blocks first paint.

const FIREBASE_VERSION = '10.12.2';
const FIREBASE_CDN = 'https://www.gstatic.com/firebasejs/' + FIREBASE_VERSION;
let fb = null; // populated on first configured init via dynamic import

async function loadFirebase() {
  if (fb) return fb;
  const [appMod, authMod, fsMod] = await Promise.all([
    import(FIREBASE_CDN + '/firebase-app.js'),
    import(FIREBASE_CDN + '/firebase-auth.js'),
    import(FIREBASE_CDN + '/firebase-firestore.js')
  ]);
  fb = {
    initializeApp: appMod.initializeApp,
    getAuth: authMod.getAuth,
    initializeAuth: authMod.initializeAuth,
    GoogleAuthProvider: authMod.GoogleAuthProvider,
    signInWithPopup: authMod.signInWithPopup,
    signInWithRedirect: authMod.signInWithRedirect,
    getRedirectResult: authMod.getRedirectResult,
    signOut: authMod.signOut,
    setPersistence: authMod.setPersistence,
    browserLocalPersistence: authMod.browserLocalPersistence,
    indexedDBLocalPersistence: authMod.indexedDBLocalPersistence,
    browserPopupRedirectResolver: authMod.browserPopupRedirectResolver,
    onAuthStateChanged: authMod.onAuthStateChanged,
    getFirestore: fsMod.getFirestore,
    collection: fsMod.collection,
    doc: fsMod.doc,
    setDoc: fsMod.setDoc,
    deleteDoc: fsMod.deleteDoc,
    onSnapshot: fsMod.onSnapshot,
    serverTimestamp: fsMod.serverTimestamp
  };
  return fb;
}

// === FIREBASE_CONFIG ===
// Replace these placeholder values with the real config from
// Firebase Console → Project settings → Your apps (Web app).
const firebaseConfig = {
  apiKey: "AIzaSyANBU4NgGnna--MeJzUPF8hikaSzIYoZno",
  authDomain: "calorie-tracker-b4f64.firebaseapp.com",
  projectId: "calorie-tracker-b4f64",
  storageBucket: "calorie-tracker-b4f64.firebasestorage.app",
  messagingSenderId: "261846159655",
  appId: "1:261846159655:web:7d6bde7da2d92167455902"
};
// === END FIREBASE_CONFIG ===

// Firestore docs are limited to 1 MiB. No current app key is expected to
// approach that size (products/recipes/diary/workouts for one person stay
// well under ~100 KB), so values are stored as a single `value` string
// without chunking. If a write is ever > ~900 KB we skip the upload and
// log a warning instead of silently failing the whole doc.
const MAX_VALUE_BYTES = 900 * 1024;
const DEBOUNCE_MS = 500;

const isAppKey = window.__isCalorieAppKey || (() => false);
const listAppKeys = window.__listCalorieAppKeys || (() => []);
const orig = window.__syncOrigLocalStorage || {
  setItem: localStorage.setItem.bind(localStorage),
  removeItem: localStorage.removeItem.bind(localStorage),
  getItem: localStorage.getItem.bind(localStorage)
};

let auth = null;
let db = null;
let currentUid = null;
let unsubKv = null;
let status = 'idle'; // idle | unsigned | signing-in | syncing | signed-in | offline | unconfigured | error
let lastError = '';
const REDIRECT_FLAG = '__syncRedirectPending';
let applyingRemote = false;
let initialPullDone = false;
let pendingKeys = new Set();
const debounceTimers = new Map();
const dirtyKeys = new Map(); // key -> {op, value}

function isConfigReady() {
  return !!(
    firebaseConfig &&
    firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    !String(firebaseConfig.apiKey).startsWith('YOUR_') &&
    !String(firebaseConfig.projectId).startsWith('YOUR_')
  );
}

function byteLength(str) {
  return new TextEncoder().encode(str == null ? '' : String(str)).length;
}

function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}

function setStatus(next) {
  status = next;
  renderStatus();
}

function getLastError() {
  return lastError || '';
}

function setAuthError(message, nextStatus) {
  lastError = message || 'Не получилось войти. Попробуйте ещё раз.';
  setStatus(nextStatus || 'error');
}

function clearAuthError() {
  lastError = '';
}

function friendlyAuthError(err) {
  const code = err && err.code;
  const raw = (err && (err.message || err.code)) || '';
  if (code === 'auth/unauthorized-domain') {
    return 'Этот адрес сайта не разрешён для входа Google. Нужно добавить его в Firebase.';
  }
  if (code === 'auth/web-storage-unsupported') {
    return 'Safari блокирует сохранение входа. Выйдите из режима «Частный доступ» и попробуйте снова.';
  }
  if (code === 'auth/network-request-failed') {
    return 'Нет сети. Проверьте интернет и нажмите «Войти через Google» ещё раз.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'Вход через Google не включён в проекте Firebase.';
  }
  if (code === 'auth/popup-blocked') {
    return 'Окно входа было заблокировано. Пробуем другой способ…';
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'Вход отменили до завершения.';
  }
  if (code === 'auth/redirect-cancelled-by-user') {
    return 'Вход отменили до завершения.';
  }
  if (code === 'auth/account-exists-with-different-credential') {
    return 'Этот адрес уже используется другим способом входа.';
  }
  return raw ? ('Не получилось войти: ' + raw) : 'Не получилось войти. Попробуйте ещё раз.';
}

function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
}

function isMobile() {
  const ua = navigator.userAgent || '';
  if (isIOS()) return true;
  if (/Android|Mobile|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true;
  try {
    return window.matchMedia('(max-width: 900px) and (pointer: coarse)').matches;
  } catch (e) {
    return false;
  }
}

function markRedirectPending() {
  try {
    orig.setItem(REDIRECT_FLAG, JSON.stringify({
      at: Date.now(),
      href: String(location.href),
      standalone: isStandalone(),
      ios: isIOS()
    }));
  } catch (e) {}
}

function readRedirectPending() {
  try {
    const raw = orig.getItem(REDIRECT_FLAG);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.at) return null;
    // Ignore stale flags older than 20 minutes.
    if (Date.now() - data.at > 20 * 60 * 1000) {
      clearRedirectPending();
      return null;
    }
    return data;
  } catch (e) {
    return null;
  }
}

function clearRedirectPending() {
  try { orig.removeItem(REDIRECT_FLAG); } catch (e) {}
}

function kvCol(uid) {
  return fb.collection(db, 'users', uid, 'kv');
}

function kvDoc(uid, key) {
  return fb.doc(db, 'users', uid, 'kv', key);
}

async function pushToCloud(op, key, value) {
  if (!currentUid || !db) return;
  if (op !== 'clear' && !isAppKey(key)) return;
  setStatus(navigator.onLine === false ? 'offline' : 'syncing');
  try {
    if (op === 'clear') {
      // Local keys are already gone; `value` is the list captured by the shim.
      const keys = (Array.isArray(value) ? value : []).filter((k) => isAppKey(k));
      await Promise.all(keys.map((k) => fb.deleteDoc(kvDoc(currentUid, k)).catch(() => {})));
    } else if (op === 'remove') {
      pendingKeys.add(key);
      await fb.deleteDoc(kvDoc(currentUid, key));
    } else {
      const str = value == null ? '' : String(value);
      if (byteLength(str) > MAX_VALUE_BYTES) {
        console.warn('[sync] key too large for a single Firestore doc, skipped:', key, byteLength(str));
        pendingKeys.delete(key);
        dirtyKeys.delete(key);
        setStatus(currentUid ? 'signed-in' : 'unsigned');
        return;
      }
      pendingKeys.add(key);
      await fb.setDoc(kvDoc(currentUid, key), {
        value: str,
        updatedAt: fb.serverTimestamp()
      });
    }
    if (op !== 'clear') dirtyKeys.delete(key);
    if (dirtyKeys.size === 0) setStatus(navigator.onLine === false ? 'offline' : 'signed-in');
  } catch (err) {
    console.warn('[sync] write failed, will retry:', key, err && err.message);
    setStatus(navigator.onLine === false ? 'offline' : 'error');
  }
}

function enqueuePush(op, key, value) {
  if (applyingRemote) return;
  if (op !== 'clear' && !isAppKey(key)) return;

  if (op === 'clear') {
    debounceTimers.forEach((t) => clearTimeout(t));
    debounceTimers.clear();
    dirtyKeys.clear();
    dirtyKeys.set('__clear__', { op: 'clear', value: value || [] });
    if (currentUid) pushToCloud('clear', null, value || []);
    return;
  }

  dirtyKeys.set(key, { op, value });
  if (!currentUid) return;
  if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(() => {
    debounceTimers.delete(key);
    const item = dirtyKeys.get(key);
    if (!item) return;
    pushToCloud(item.op, key, item.value);
  }, DEBOUNCE_MS));
}

window.__syncPush = enqueuePush;

// Flush writes that happened before this module was ready.
if (Array.isArray(window.__syncQueue) && window.__syncQueue.length) {
  const queued = window.__syncQueue.splice(0, window.__syncQueue.length);
  queued.forEach((item) => enqueuePush(item.op, item.key, item.value));
}

function applyCloudSnapshot(snapshot) {
  let changed = false;
  snapshot.docChanges().forEach((change) => {
    const key = change.doc.id;
    if (!isAppKey(key)) return;
    if (dirtyKeys.has(key)) return;
    if (change.doc.metadata && change.doc.metadata.hasPendingWrites) return;
    if (pendingKeys.has(key) && change.type !== 'removed') {
      // Own write has been acknowledged; keep listening for later remote edits.
      if (!change.doc.metadata.hasPendingWrites) pendingKeys.delete(key);
    }

    applyingRemote = true;
    try {
      if (change.type === 'removed') {
        pendingKeys.delete(key);
        if (orig.getItem(key) != null) {
          orig.removeItem(key);
          changed = true;
        }
      } else {
        const value = change.doc.data() ? change.doc.data().value : '';
        const str = value == null ? '' : String(value);
        if (orig.getItem(key) !== str) {
          orig.setItem(key, str);
          changed = true;
        }
        pendingKeys.delete(key);
      }
    } finally {
      applyingRemote = false;
    }
  });
  return changed;
}

function applyFullCloud(snapshot) {
  let changed = false;
  const cloudKeys = new Set();
  snapshot.forEach((d) => {
    const key = d.id;
    if (!isAppKey(key)) return;
    cloudKeys.add(key);
    // A write made on this page (before auth finished) is newer than cloud.
    if (dirtyKeys.has(key)) return;
    const value = d.data() ? d.data().value : '';
    const str = value == null ? '' : String(value);
    if (orig.getItem(key) !== str) {
      applyingRemote = true;
      try {
        orig.setItem(key, str);
      } finally {
        applyingRemote = false;
      }
      changed = true;
    }
  });
  return { changed, cloudKeys };
}

let reloadScheduled = false;
function scheduleReload() {
  if (reloadScheduled) return;
  reloadScheduled = true;
  const tryReload = () => {
    if (isTyping()) {
      document.dispatchEvent(new CustomEvent('storage-synced'));
      setTimeout(tryReload, 500);
      return;
    }
    window.location.reload();
  };
  tryReload();
}

async function uploadAllLocal() {
  if (!currentUid) return;
  const keys = listAppKeys();
  setStatus('syncing');
  for (const key of keys) {
    const value = orig.getItem(key);
    await pushToCloud('set', key, value);
  }
  setStatus(navigator.onLine === false ? 'offline' : 'signed-in');
}

function startListener(uid) {
  if (unsubKv) {
    unsubKv();
    unsubKv = null;
  }
  initialPullDone = false;
  setStatus('syncing');

  unsubKv = fb.onSnapshot(
    kvCol(uid),
    async (snapshot) => {
      if (!initialPullDone) {
        if (snapshot.empty) {
          // First sign-in ever (cloud empty): keep this device's data and upload it.
          await uploadAllLocal();
          initialPullDone = true;
          setStatus(navigator.onLine === false ? 'offline' : 'signed-in');
          return;
        }
        // Cloud has data: cloud wins on conflicts, except keys written on
        // this page before auth finished. Local-only keys are then uploaded
        // so a day that existed only on this device is not dropped.
        const { changed, cloudKeys } = applyFullCloud(snapshot);
        initialPullDone = true;
        const localOnly = listAppKeys().filter((k) => !cloudKeys.has(k));
        for (const key of localOnly) {
          await pushToCloud('set', key, orig.getItem(key));
        }
        retryDirty();
        setStatus(navigator.onLine === false ? 'offline' : 'signed-in');
        if (changed) scheduleReload();
        return;
      }

      if (snapshot.metadata.hasPendingWrites) {
        const changedPending = applyCloudSnapshot(snapshot);
        if (changedPending) scheduleReload();
        return;
      }

      const changed = applyCloudSnapshot(snapshot);
      if (changed) scheduleReload();
      if (dirtyKeys.size === 0) setStatus(navigator.onLine === false ? 'offline' : 'signed-in');
    },
    (err) => {
      console.warn('[sync] listener error:', err && err.message);
      setStatus(navigator.onLine === false ? 'offline' : 'error');
    }
  );
}

function stopListener() {
  if (unsubKv) {
    unsubKv();
    unsubKv = null;
  }
  currentUid = null;
  initialPullDone = false;
  pendingKeys.clear();
}

function shouldUseRedirect() {
  return isIOS() || isStandalone() || isMobile();
}

async function signIn() {
  if (!auth) {
    setAuthError('Синхронизация ещё загружается. Подождите секунду и нажмите ещё раз.');
    return;
  }
  clearAuthError();
  setStatus('signing-in');
  const provider = new fb.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const useRedirect = shouldUseRedirect();
  try {
    if (useRedirect) {
      markRedirectPending();
      await fb.signInWithRedirect(auth, provider);
      return;
    }
    await fb.signInWithPopup(auth, provider);
  } catch (err) {
    const code = err && err.code;
    if (!useRedirect && (code === 'auth/popup-blocked' || code === 'auth/popup-closed-by-user' ||
        code === 'auth/cancelled-popup-request' || code === 'auth/operation-not-supported-in-this-environment')) {
      try {
        markRedirectPending();
        await fb.signInWithRedirect(auth, provider);
        return;
      } catch (err2) {
        console.warn('[sync] redirect sign-in failed:', err2 && err2.message);
        setAuthError(friendlyAuthError(err2));
        return;
      }
    }
    console.warn('[sync] sign-in failed:', err && err.message);
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request' ||
        code === 'auth/redirect-cancelled-by-user') {
      clearRedirectPending();
      clearAuthError();
      setStatus(auth && auth.currentUser ? 'signed-in' : 'unsigned');
      return;
    }
    setAuthError(friendlyAuthError(err));
  }
}

async function signOutUser() {
  if (!auth) return;
  if (!confirm('Выйти из аккаунта? Данные на этом устройстве сохранятся.')) return;
  try {
    stopListener();
    await fb.signOut(auth);
    setStatus('unsigned');
  } catch (err) {
    console.warn('[sync] sign-out failed:', err && err.message);
  }
}

function getUserInfo() {
  const u = auth && auth.currentUser;
  if (!u) return null;
  return {
    uid: u.uid,
    email: u.email || '',
    name: u.displayName || '',
    photo: u.photoURL || ''
  };
}

const statusListeners = [];

function renderStatus() {
  const leftover = document.getElementById('sync-widget');
  if (leftover) leftover.remove();
  const detail = { status, user: getUserInfo() };
  document.dispatchEvent(new CustomEvent('calorie-sync-status', { detail }));
  statusListeners.forEach((fn) => {
    try { fn(detail); } catch (err) { console.warn('[sync] status listener', err); }
  });
}

function exportBackup() {
  const data = {};
  listAppKeys().forEach((k) => { data[k] = orig.getItem(k); });
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'calorie-tracker-backup-' + localDateStr() + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importBackupFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      const data = parsed && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        alert('Неверный формат файла.');
        return;
      }
      const keys = Object.keys(data).filter(isAppKey);
      if (!keys.length) {
        alert('В файле нет данных приложения.');
        return;
      }
      if (!confirm('Загрузить копию? Текущие данные на этом устройстве будут заменены.')) return;

      const incoming = new Set(keys);
      listAppKeys().forEach((k) => {
        if (!incoming.has(k)) localStorage.removeItem(k);
      });
      keys.forEach((k) => {
        const v = data[k];
        localStorage.setItem(k, v == null ? '' : String(v));
      });
      alert('Копия загружена.');
      window.location.reload();
    } catch (err) {
      alert('Не получилось прочитать файл.');
    }
  };
  reader.readAsText(file);
}

window.CalorieSync = {
  exportBackup,
  importBackupFromFile,
  isAppKey,
  listAppKeys,
  signIn,
  signOut: signOutUser,
  getStatus: () => status,
  getUser: getUserInfo,
  getLastError,
  isStandalone,
  isIOS,
  onStatusChange: (fn) => {
    if (typeof fn === 'function') statusListeners.push(fn);
  }
};
document.dispatchEvent(new CustomEvent('calorie-sync-ready'));

function retryDirty() {
  if (!currentUid || !navigator.onLine) return;
  dirtyKeys.forEach((item, key) => {
    if (key === '__clear__') pushToCloud('clear', null, item.value || []);
    else pushToCloud(item.op, key, item.value);
  });
}

async function init() {
  if (!isConfigReady()) {
    setStatus('unconfigured');
    return;
  }

  try {
    await loadFirebase();
    const app = fb.initializeApp(firebaseConfig);
    try {
      auth = fb.initializeAuth(app, {
        persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence],
        popupRedirectResolver: fb.browserPopupRedirectResolver
      });
    } catch (authInitErr) {
      auth = fb.getAuth(app);
      try {
        await fb.setPersistence(auth, fb.browserLocalPersistence);
      } catch (persErr) {
        console.warn('[sync] persistence:', persErr && persErr.message);
      }
    }
    db = fb.getFirestore(app);
  } catch (err) {
    console.warn('[sync] Firebase init failed:', err && err.message);
    setStatus('unconfigured');
    return;
  }

  window.addEventListener('online', () => {
    if (currentUid) {
      setStatus(dirtyKeys.size ? 'syncing' : 'signed-in');
      retryDirty();
    }
  });
  window.addEventListener('offline', () => {
    if (currentUid) setStatus('offline');
  });

  try {
    const result = await fb.getRedirectResult(auth);
    if (result && result.user) {
      clearRedirectPending();
      clearAuthError();
    }
  } catch (err) {
    console.warn('[sync] redirect result:', err && err.message);
    clearRedirectPending();
    setAuthError(friendlyAuthError(err));
  }

  if (!auth.currentUser) {
    const pending = readRedirectPending();
    if (pending && !lastError) {
      clearRedirectPending();
      if (isStandalone() || pending.standalone) {
        setAuthError('На iPhone вход из приложения на экране «Домой» часто не завершается: Google открывается в Safari, и результат туда и попадает. Откройте сайт в Safari и войдите там, затем пользуйтесь им в Safari.');
      } else {
        setAuthError('Вход не завершился. Нажмите «Войти через Google» ещё раз.');
      }
    }
  }

  fb.onAuthStateChanged(auth, (user) => {
    if (user) {
      clearRedirectPending();
      if (status === 'error' && lastError) {
        // Keep a sign-in error only when there is no user.
        clearAuthError();
      }
      currentUid = user.uid;
      startListener(user.uid);
    } else {
      stopListener();
      if (status !== 'error' && status !== 'signing-in' && status !== 'unconfigured') {
        setStatus('unsigned');
      }
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { renderStatus(); });
} else {
  renderStatus();
}

init().catch((err) => {
  console.warn('[sync] init error:', err && err.message);
  setStatus('unconfigured');
});

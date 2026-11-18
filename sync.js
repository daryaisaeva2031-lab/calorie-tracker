// Cross-device sync for calorie-tracker via the Cloudflare Worker API.
// Pages always render from localStorage (wrapped by sync-shim.js); this module
// never blocks first paint. Sign-in: Google Identity Services ID token stored
// in localStorage 'gtoken' (same as api-client.js), sent as Bearer token.
//
// Key → worker route mapping (values are stored as parsed JSON):
//   products, recipes, dishes, weights, shopping → /api/<key>
//   diary-YYYY-MM-DD                           → /api/diary/YYYY-MM-DD
//   every other app key (name, height, weight, target-weight, calories,
//   carb/protein/fat-pct, target-date, weekMenu, warmups, familyBlocks,
//   familyBlock-*, workouts-*, steps-*, weightHistory)
//                                              → /api/profile, inside
//   { kv: { <key>: value }, diaryStamps: { <date>: ms } }

const WORKER_URL = 'https://calorie-tracker.goldengloves59.workers.dev';
const GOOGLE_WEB_CLIENT_ID = '261846159655-3d5mop7bgr7hk7kh2clbgvr383elfcri.apps.googleusercontent.com';
const ROUTE_KEYS = ['products', 'recipes', 'dishes', 'weights', 'shopping'];
const DEBOUNCE_MS = 600;
const PULL_MIN_INTERVAL_MS = 60 * 1000;

const isAppKey = window.__isCalorieAppKey || (() => false);
const listAppKeys = window.__listCalorieAppKeys || (() => []);
const orig = window.__syncOrigLocalStorage || {
  setItem: localStorage.setItem.bind(localStorage),
  removeItem: localStorage.removeItem.bind(localStorage),
  getItem: localStorage.getItem.bind(localStorage)
};

function localDateStrSafe(d) {
  if (typeof window.localDateStr === 'function') return window.localDateStr(d);
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function storageValuesEqual(a, b) {
  if (typeof window.__storageValuesEqual === 'function') return window.__storageValuesEqual(a, b);
  return a === b;
}

let status = 'idle';
let lastError = '';
let lastPullAt = 0;
let pulling = null;
const statusListeners = [];
const debounceTimers = new Map();

// ---------- token ----------
function getToken() { return orig.getItem('gtoken'); }
function setToken(t) { if (t) orig.setItem('gtoken', t); else orig.removeItem('gtoken'); }

function decodeJwt(t) {
  try {
    const part = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(part + '==='.slice((part.length + 3) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) { return null; }
}

function tokenPayload() {
  const t = getToken();
  return t ? decodeJwt(t) : null;
}

function tokenValid() {
  const p = tokenPayload();
  return !!(p && p.exp && p.exp * 1000 > Date.now() + 30 * 1000);
}

// ---------- dirty keys (persist across reloads / expired sessions) ----------
function readJsonOrig(key, fallback) {
  try { const v = JSON.parse(orig.getItem(key) || 'null'); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function getDirty() { return new Set(readJsonOrig('__syncDirty', [])); }
function saveDirty(set) { orig.setItem('__syncDirty', JSON.stringify(Array.from(set))); }
function markDirty(key) { const s = getDirty(); s.add(key); saveDirty(s); }
function clearDirty(key) { const s = getDirty(); if (s.delete(key)) saveDirty(s); }
function getLocalStamps() { return readJsonOrig('__syncStamps', {}); }
function setLocalStamp(date, ts) {
  const s = getLocalStamps();
  if (ts == null) delete s[date]; else s[date] = ts;
  orig.setItem('__syncStamps', JSON.stringify(s));
}

// ---------- status ----------
function setStatus(next) { status = next; renderStatus(); }
function getLastError() { return lastError || ''; }
function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }

function getUserInfo() {
  if (!tokenValid()) return null;
  const p = tokenPayload();
  return { uid: p.sub, email: p.email || '', name: p.name || '', photo: p.picture || '' };
}

function renderStatus() {
  const detail = { status, user: getUserInfo() };
  document.dispatchEvent(new CustomEvent('calorie-sync-status', { detail }));
  statusListeners.forEach((fn) => { try { fn(detail); } catch (err) { console.warn('[sync] status listener', err); } });
}

function onlineStatus() { return navigator.onLine === false ? 'offline' : 'signed-in'; }

// ---------- worker API ----------
class AuthError extends Error {}

async function api(path, method, body) {
  if (!tokenValid()) throw new AuthError('expired');
  const r = await fetch(WORKER_URL + path, {
    method: method || 'GET',
    headers: { 'Authorization': 'Bearer ' + getToken(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (r.status === 401) throw new AuthError('auth');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function handleError(err) {
  if (err instanceof AuthError) {
    lastError = 'Сессия Google закончилась — войдите ещё раз в профиле. Данные на этом устройстве сохранены и отправятся после входа.';
    setStatus('unsigned');
    trySilentSignIn();
    return;
  }
  console.warn('[sync]', err && err.message);
  lastError = 'Не получилось синхронизировать. Попробуем ещё раз позже.';
  setStatus(navigator.onLine === false ? 'offline' : 'error');
}

function routeFor(key) {
  if (ROUTE_KEYS.indexOf(key) !== -1) return { type: 'route', path: '/api/' + key };
  const m = /^diary-(\d{4}-\d{2}-\d{2})$/.exec(key);
  if (m) return { type: 'diary', date: m[1], path: '/api/diary/' + m[1] };
  return { type: 'profile' };
}

function parseLocal(raw) {
  if (raw == null) return null;
  const s = String(raw);
  const t = s.trim();
  if (t.charAt(0) === '{' || t.charAt(0) === '[') {
    try { return JSON.parse(t); } catch (e) { return s; }
  }
  return s;
}

function toLocalString(v) {
  if (v == null) return null;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function isEmptyValue(v) {
  if (v == null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// Profile writes are read-modify-write; serialize them.
let profileChain = Promise.resolve();
const pendingProfile = new Map(); // key -> value (undefined = delete)
const pendingStamps = new Map();  // date -> ts (null = delete)

function flushProfile() {
  const run = profileChain.catch(() => {}).then(async () => {
    if (!pendingProfile.size && !pendingStamps.size) return;
    const changes = new Map(pendingProfile);
    const stamps = new Map(pendingStamps);
    pendingProfile.clear();
    pendingStamps.clear();
    try {
      const prof = await api('/api/profile');
      const p = (prof && typeof prof === 'object' && !Array.isArray(prof)) ? prof : {};
      p.kv = (p.kv && typeof p.kv === 'object') ? p.kv : {};
      p.diaryStamps = (p.diaryStamps && typeof p.diaryStamps === 'object') ? p.diaryStamps : {};
      changes.forEach((v, k) => { if (v === undefined) delete p.kv[k]; else p.kv[k] = v; });
      stamps.forEach((ts, d) => { if (ts == null) delete p.diaryStamps[d]; else p.diaryStamps[d] = ts; });
      await api('/api/profile', 'PUT', p);
      changes.forEach((v, k) => clearDirty(k));
      stamps.forEach((ts, d) => { setLocalStamp(d, ts); });
    } catch (err) {
      changes.forEach((v, k) => { if (!pendingProfile.has(k)) pendingProfile.set(k, v); });
      stamps.forEach((ts, d) => { if (!pendingStamps.has(d)) pendingStamps.set(d, ts); });
      throw err;
    }
  });
  profileChain = run;
  return run;
}

// defer=true: only queue profile/stamp changes; caller runs flushProfile().
async function pushKey(key, defer) {
  const raw = orig.getItem(key);
  const r = routeFor(key);
  if (r.type === 'profile') {
    pendingProfile.set(key, raw == null ? undefined : parseLocal(raw));
    if (!defer) await flushProfile();
    return;
  }
  let body = parseLocal(raw);
  if (r.type === 'diary') {
    if (body == null || typeof body !== 'object') body = {};
    await api(r.path, 'PUT', body);
    const ts = raw == null ? null : Date.now();
    pendingStamps.set(r.date, ts);
    if (!defer) await flushProfile();
    clearDirty(key);
    return;
  }
  if (body == null || typeof body !== 'object') body = [];
  await api(r.path, 'PUT', body);
  clearDirty(key);
}

function schedulePush(key) {
  markDirty(key);
  if (!tokenValid()) return;
  if (debounceTimers.has(key)) clearTimeout(debounceTimers.get(key));
  debounceTimers.set(key, setTimeout(async () => {
    debounceTimers.delete(key);
    setStatus('syncing');
    try {
      await pushKey(key);
      if (!debounceTimers.size) { lastError = ''; setStatus(onlineStatus()); }
    } catch (err) { handleError(err); }
  }, DEBOUNCE_MS));
}

function enqueuePush(op, key, value) {
  if (op === 'clear') {
    (Array.isArray(value) ? value : []).filter(isAppKey).forEach(schedulePush);
    return;
  }
  if (!isAppKey(key)) return;
  schedulePush(key);
}

window.__syncPush = enqueuePush;
if (Array.isArray(window.__syncQueue) && window.__syncQueue.length) {
  const queued = window.__syncQueue.splice(0, window.__syncQueue.length);
  queued.forEach((q) => enqueuePush(q.op, q.key, q.value));
}

// ---------- pull ----------
function applyCloud(key, cloudVal, changed) {
  const next = toLocalString(cloudVal);
  const prev = orig.getItem(key);
  if (next == null) return;
  if (prev != null && storageValuesEqual(prev, next)) return;
  orig.setItem(key, next);
  changed.push(key);
}

const LEGACY_PROFILE = { name: 'name', height: 'height', weight: 'weight', target: 'target-weight', goal: 'calories', p: 'protein-pct', f: 'fat-pct', c: 'carb-pct' };

async function pullAll() {
  if (!tokenValid()) return;
  if (pulling) return pulling;
  pulling = (async () => {
    setStatus('syncing');
    const changed = [];
    const toPush = new Set();
    const dirty = getDirty();
    try {
      const results = await Promise.all(ROUTE_KEYS.map((k) => api('/api/' + k)).concat([api('/api/profile')]));
      const prof = results[ROUTE_KEYS.length];
      const p = (prof && typeof prof === 'object' && !Array.isArray(prof)) ? prof : {};
      const kv = (p.kv && typeof p.kv === 'object') ? Object.assign({}, p.kv) : {};
      Object.keys(LEGACY_PROFILE).forEach((lk) => {
        const k = LEGACY_PROFILE[lk];
        if (!(k in kv) && p[lk] != null && p[lk] !== '') kv[k] = String(p[lk]);
      });
      const remoteStamps = (p.diaryStamps && typeof p.diaryStamps === 'object') ? p.diaryStamps : {};

      ROUTE_KEYS.forEach((k, i) => {
        const cloud = results[i];
        if (dirty.has(k)) { toPush.add(k); return; }
        if (isEmptyValue(cloud)) {
          if (!isEmptyValue(parseLocal(orig.getItem(k)))) toPush.add(k);
          return;
        }
        applyCloud(k, cloud, changed);
      });

      Object.keys(kv).forEach((k) => {
        if (!isAppKey(k)) return;
        if (dirty.has(k)) { toPush.add(k); return; }
        applyCloud(k, kv[k], changed);
      });

      const localKeys = listAppKeys();
      localKeys.forEach((k) => {
        if (routeFor(k).type === 'profile' && !(k in kv)) toPush.add(k);
      });

      // Diary days: fetch those whose cloud stamp differs from ours, plus
      // yesterday and today (they may have been written straight to the API).
      const localStamps = getLocalStamps();
      const dates = new Set();
      Object.keys(remoteStamps).forEach((d) => { if (remoteStamps[d] !== localStamps[d]) dates.add(d); });
      const today = new Date();
      const yest = new Date(); yest.setDate(yest.getDate() - 1);
      dates.add(localDateStrSafe(today));
      dates.add(localDateStrSafe(yest));
      const dateList = Array.from(dates);
      const diaries = await Promise.all(dateList.map((d) => api('/api/diary/' + d)));
      dateList.forEach((d, i) => {
        const key = 'diary-' + d;
        const cloud = diaries[i];
        if (dirty.has(key)) { toPush.add(key); return; }
        if (isEmptyValue(cloud)) {
          if (orig.getItem(key) != null && !(d in remoteStamps)) toPush.add(key);
          return;
        }
        applyCloud(key, cloud, changed);
        if (d in remoteStamps) setLocalStamp(d, remoteStamps[d]);
      });
      localKeys.forEach((k) => {
        const r = routeFor(k);
        if (r.type === 'diary' && !(r.date in remoteStamps) && !dates.has(r.date)) toPush.add(k);
      });
      dirty.forEach((k) => toPush.add(k));

      for (const k of toPush) {
        if (orig.getItem(k) == null && routeFor(k).type !== 'profile' && !dirty.has(k)) continue;
        await pushKey(k, true);
      }
      await flushProfile();
      lastPullAt = Date.now();
      lastError = '';
      setStatus(onlineStatus());
      if (changed.length) scheduleReload(changed);
    } catch (err) {
      handleError(err);
    } finally {
      pulling = null;
    }
  })();
  return pulling;
}

function isTyping() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
}

let reloadScheduled = false;
function scheduleReload(changedKeys) {
  const keys = Array.isArray(changedKeys) ? changedKeys.filter(Boolean) : [];
  if (!keys.length) return;
  const detail = { keys };
  document.dispatchEvent(new CustomEvent('calorie-sync', { detail }));
  document.dispatchEvent(new CustomEvent('storage-synced', { detail }));
  if (typeof window.__calorieOnSync === 'function') {
    try { if (window.__calorieOnSync(keys) === true) return; } catch (err) { console.warn('[sync] page sync handler:', err && err.message); }
  }
  if (reloadScheduled) return;
  reloadScheduled = true;
  const tryReload = () => {
    if (isTyping()) { setTimeout(tryReload, 500); return; }
    try {
      sessionStorage.setItem('__calorieScrollY', String(window.scrollY || 0));
      sessionStorage.setItem('__calorieScrollPath', location.pathname);
    } catch (e) {}
    window.location.reload();
  };
  tryReload();
}

// ---------- Google Identity Services ----------
let gisInitialized = false;
function loadGisClient() {
  if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
  if (loadGisClient._p) return loadGisClient._p;
  loadGisClient._p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => (window.google && google.accounts && google.accounts.id) ? resolve() : reject(new Error('Google не загрузился'));
    s.onerror = () => { loadGisClient._p = null; reject(new Error('Не удалось загрузить вход Google.')); };
    document.head.appendChild(s);
  });
  return loadGisClient._p;
}

function onGisCredential(response) {
  const cred = response && response.credential;
  if (!cred) return;
  setToken(cred);
  lastError = '';
  setStatus('syncing');
  pullAll();
}

function initGis(autoSelect) {
  if (gisInitialized) return;
  google.accounts.id.initialize({
    client_id: GOOGLE_WEB_CLIENT_ID,
    callback: onGisCredential,
    auto_select: !!autoSelect,
    cancel_on_tap_outside: true,
    context: 'signin',
    itp_support: true
  });
  gisInitialized = true;
}

function mountGoogleButton(host) {
  if (!host) return Promise.resolve();
  host.innerHTML = '<div class="account-hint">Загружается вход Google…</div>';
  return loadGisClient().then(() => {
    initGis(true);
    host.innerHTML = '';
    const width = Math.max(200, Math.min(360, host.clientWidth || 300));
    google.accounts.id.renderButton(host, {
      type: 'standard', theme: 'outline', size: 'large', text: 'signin_with',
      shape: 'rectangular', logo_alignment: 'left', locale: 'ru', width: width
    });
  }).catch((err) => {
    host.innerHTML = '';
    const hint = document.createElement('p');
    hint.className = 'account-hint';
    hint.textContent = (err && err.message) ? err.message : 'Не удалось загрузить кнопку Google.';
    host.appendChild(hint);
  });
}

function signIn() {
  return loadGisClient().then(() => { initGis(true); google.accounts.id.prompt(); }).catch((err) => {
    lastError = (err && err.message) || 'Не получилось войти.';
    setStatus('error');
  });
}

// When the 1-hour Google token expires, try a silent re-sign-in once per tab.
function trySilentSignIn() {
  if (!getToken()) return;
  try { if (sessionStorage.getItem('__syncSilentTried')) return; sessionStorage.setItem('__syncSilentTried', '1'); } catch (e) {}
  loadGisClient().then(() => { initGis(true); google.accounts.id.prompt(); }).catch(() => {});
}

function signOutUser() {
  if (!confirm('Выйти из аккаунта? Данные на этом устройстве сохранятся.')) return;
  setToken(null);
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {}
  lastError = '';
  setStatus('unsigned');
}

// ---------- backup ----------
function exportBackup() {
  const data = {};
  listAppKeys().forEach((k) => { data[k] = orig.getItem(k); });
  const payload = { version: 1, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'calorie-tracker-backup-' + localDateStrSafe() + '.json';
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
      if (!data || typeof data !== 'object' || Array.isArray(data)) { alert('Неверный формат файла.'); return; }
      const keys = Object.keys(data).filter(isAppKey);
      if (!keys.length) { alert('В файле нет данных приложения.'); return; }
      if (!confirm('Загрузить копию? Текущие данные на этом устройстве будут заменены.')) return;
      const incoming = new Set(keys);
      listAppKeys().forEach((k) => { if (!incoming.has(k)) localStorage.removeItem(k); });
      keys.forEach((k) => { const v = data[k]; localStorage.setItem(k, v == null ? '' : String(v)); });
      alert('Копия загружена.');
      setTimeout(() => window.location.reload(), DEBOUNCE_MS + 1500);
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
  mountGoogleButton,
  isGisEnabled: () => true,
  getGoogleClientId: () => GOOGLE_WEB_CLIENT_ID,
  signOut: signOutUser,
  getStatus: () => status,
  getUser: getUserInfo,
  getLastError,
  isStandalone,
  isIOS,
  isReady: () => true,
  syncNow: () => pullAll(),
  onStatusChange: (fn) => { if (typeof fn === 'function') statusListeners.push(fn); }
};
document.dispatchEvent(new CustomEvent('calorie-sync-ready'));

// ---------- init ----------
window.addEventListener('online', () => { if (tokenValid()) pullAll(); });
window.addEventListener('offline', () => { if (tokenValid()) setStatus('offline'); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tokenValid() && Date.now() - lastPullAt > PULL_MIN_INTERVAL_MS) pullAll();
});

if (tokenValid()) {
  pullAll();
} else {
  setStatus('unsigned');
  if (getToken()) trySilentSignIn();
}

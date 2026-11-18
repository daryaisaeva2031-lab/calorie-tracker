// API client for calorie-tracker → Cloudflare Worker
const API = 'https://calorie-tracker.goldengloves59.workers.dev';
const CLIENT_ID = '261846159655-3d5mop7bgr7hk7kh2clbgvr383elfcri.apps.googleusercontent.com';

// Prefer the 30-day worker session (set by sync.js); fall back to the Google ID token.
function getToken() { return localStorage.getItem('gsession') || localStorage.getItem('gtoken'); }
function setToken(t) { if (t) localStorage.setItem('gtoken', t); else localStorage.removeItem('gtoken'); }

async function api(path, method = 'GET', body) {
  const token = getToken();
  if (!token) throw new Error('login');
  const r = await fetch(API + path, {
    method,
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    if (token === localStorage.getItem('gsession')) { localStorage.removeItem('gsession'); localStorage.removeItem('gsessionInfo'); }
    else setToken(null);
    throw new Error('auth');
  }
  return r.json();
}

window.CalAPI = {
  getToken, setToken, CLIENT_ID,
  products: { list: () => api('/api/products'), save: l => api('/api/products', 'PUT', l) },
  diary: { get: d => api('/api/diary/' + d), save: (d, v) => api('/api/diary/' + d, 'PUT', v) },
  weights: { list: () => api('/api/weights'), save: l => api('/api/weights', 'PUT', l) },
  recipes: { list: () => api('/api/recipes'), save: l => api('/api/recipes', 'PUT', l) },
  dishes: { list: () => api('/api/dishes'), save: l => api('/api/dishes', 'PUT', l) },
  shopping: { list: () => api('/api/shopping'), save: l => api('/api/shopping', 'PUT', l) },
  profile: { get: () => api('/api/profile'), save: p => api('/api/profile', 'PUT', p) },
};

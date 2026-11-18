// Auto-update: if the server has a newer copy of this page than the cached one, reload once.
(function () {
  var busy = false;
  function check() {
    if (busy || !window.fetch) return;
    busy = true;
    var url = location.pathname;
    var key = 'au-' + url;
    var tries = +(sessionStorage.getItem(key) || 0);
    fetch(url, { cache: 'force-cache' }).then(function (r) { return r.text(); }).then(function (oldHtml) {
      return fetch(url, { cache: 'reload' }).then(function (r) { if (!r.ok) throw 0; return r.text(); }).then(function (newHtml) {
        if (newHtml !== oldHtml && tries < 2) { sessionStorage.setItem(key, tries + 1); location.reload(); }
        else sessionStorage.removeItem(key);
      });
    }).catch(function () {}).then(function () { busy = false; });
  }
  check();
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(); });
})();

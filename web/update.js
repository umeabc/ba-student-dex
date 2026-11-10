/*
 * update.js — 检查 GitHub 的 Android Release 是否有新版本。
 * 原生桥避免 WebView 跨域限制；浏览器预览退化为普通 fetch。
 */
(function (root) {
  'use strict';

  var REPO = 'umeabc/ba-student-dex';
  var API = 'https://api.github.com/repos/' + REPO + '/releases?per_page=30';
  var TIMEOUT = 15000;
  var TAG = /^android-v(\d+\.\d+\.\d+)$/;

  function parseVer(v) {
    var s = String(v == null ? '' : v).replace(/^\s*v/i, '');
    var m = s.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!m) return null;
    return [parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0, parseInt(m[3] || '0', 10) || 0];
  }

  function isNewer(latest, current) {
    var a = parseVer(latest);
    var b = parseVer(current);
    if (!a || !b) return false;
    for (var i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
  }

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; reject(new Error('timeout')); }
      }, ms);
      promise.then(function (v) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(v);
      }, function (e) {
        if (done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  function fetchReleases() {
    if (root.BAFetch && root.BAFetch.available()) {
      return root.BAFetch.json(API, { Accept: 'application/vnd.github+json' });
    }
    return fetch(API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('http-' + r.status);
        return r.json();
      });
  }

  function selectLatest(releases) {
    if (!Array.isArray(releases)) return null;
    var best = null;
    var bestApk = null;
    releases.forEach(function (rel) {
      if (!rel || !TAG.test(String(rel.tag_name || '')) || !Array.isArray(rel.assets)) return;
      var apk = rel.assets.find(function (asset) {
        return asset && typeof asset.name === 'string' && /\.apk$/i.test(asset.name) && asset.browser_download_url;
      });
      if (apk && (!best || isNewer(rel.tag_name, best.tag_name))) {
        best = rel;
        bestApk = apk;
      }
    });
    return best ? { release: best, apk: bestApk } : null;
  }

  /** @param {string} currentVersion 形如 "V1.0.0" */
  function check(currentVersion) {
    return withTimeout(fetchReleases(), TIMEOUT)
      .then(function (releases) {
        var selected = selectLatest(releases);
        if (!selected) return { ok: false, error: 'no-android-release' };
        var rel = selected.release;
        var latest = rel.tag_name;
        return {
          ok: true,
          hasUpdate: isNewer(latest, currentVersion),
          latest: latest,
          current: currentVersion,
          name: rel.name || latest,
          notes: rel.body || '',
          url: selected.apk.browser_download_url,
          publishedAt: rel.published_at || ''
        };
      })
      .catch(function (e) {
        return { ok: false, error: String((e && e.message) || e) };
      });
  }

  root.BAUpdate = {
    check: check,
    isNewer: isNewer,
    current: function () { return root.BA_VERSION || ''; }
  };
})(typeof window !== 'undefined' ? window : this);

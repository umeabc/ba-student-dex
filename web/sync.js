/*
 * sync.js — App 内「联网检查 gamekee 新实装学生」的实现。
 *
 * 为什么需要原生桥：页面是 file:// 加载的，直接 fetch gamekee 会被 CORS 拦，
 * 而且接口要求 game-alias 请求头、图片 CDN 校验 Referer —— 这些浏览器都发不出来。
 * 所以由 Swift 侧（WKScriptMessageHandler "ba"）代发请求，这里只负责调度和解析。
 *
 * 原生协议：
 *   postMessage({id, op:'fetch', url, headers})
 *   postMessage({id, op:'store', action:'load'|'save', key, value})
 *   原生回调 window.__baRPC(id, status, base64)
 */
(function (root) {
  'use strict';

  var API = 'https://www.gamekee.com';
  var ENTRY_ROOT = 23941;   // 游戏图鉴
  var ENTRY_STUDENTS = 49443; // 实装学生
  var CHECK_INTERVAL = 30 * 60 * 1000; // 同一份数据 30 分钟内不重复检查
  var MAX_NEW_PER_RUN = 6;             // 一次最多处理几个新学生，剩下的下次再来

  var seq = 0;
  var pending = {};
  var decoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null;

  function hasBridge() {
    return !!(root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.ba);
  }

  function bytesFromBase64(b64) {
    var bin = root.atob(b64 || '');
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }

  root.__baRPC = function (id, status, b64) {
    var p = pending[id];
    if (!p) return;
    delete pending[id];
    p.resolve({ status: status, bytes: bytesFromBase64(b64), b64: b64 || '' });
  };

  function rpc(payload) {
    return new Promise(function (resolve, reject) {
      if (!hasBridge()) { reject(new Error('no-bridge')); return; }
      var id = String(++seq);
      pending[id] = { resolve: resolve, reject: reject };
      payload.id = id;
      try {
        root.webkit.messageHandlers.ba.postMessage(payload);
      } catch (e) {
        delete pending[id];
        reject(e);
        return;
      }
      setTimeout(function () {
        if (pending[id]) { delete pending[id]; reject(new Error('timeout')); }
      }, 40000);
    });
  }

  function fetchText(url, headers) {
    return rpc({ op: 'fetch', url: url, headers: headers || {} }).then(function (r) {
      if (r.status === 0) throw new Error('network');
      if (r.status !== 200) throw new Error('http-' + r.status);
      var text = decoder ? decoder.decode(r.bytes) : String.fromCharCode.apply(null, r.bytes);
      if (text.charAt(0) === '<') throw new Error('blocked'); // 反爬页面
      return text;
    });
  }

  function fetchJSON(url, headers) {
    return fetchText(url, headers).then(function (t) { return JSON.parse(t); });
  }

  // 二进制（音频）：直接返回原生给的 base64，交给页面转 Blob
  function fetchBase64(url, headers) {
    return rpc({ op: 'fetch', url: url, headers: headers || {} }).then(function (r) {
      if (r.status === 0) throw new Error('network');
      if (r.status !== 200) throw new Error('http-' + r.status);
      return r.b64;
    });
  }

  /* --------------------------------------------------------- 语音试听地址 */
  // 内置数据里不带音频地址（太大），点播放时按需向 WIKI 拉一次并缓存。
  var voiceAudioCache = {};

  function voiceAudio(id, contentId) {
    if (!hasBridge()) return Promise.resolve(null);
    if (voiceAudioCache[id]) return Promise.resolve(voiceAudioCache[id]);
    return loadOverlay().then(function (ov) {
      var synced = ov && ov.students && ov.students[id];
      if (synced && synced.voiceAudio) { voiceAudioCache[id] = synced.voiceAudio; return synced.voiceAudio; }
      // 原生 store 只有一个键（整个 overlay），所以语音地址只做内存缓存，不落盘
      return getStudentRaw({ id: id, content_id: contentId }).then(function (raw) {
        var map = BAParse.extractVoiceAudio(BAParse.compactRows(raw.inner.baseData));
        voiceAudioCache[id] = map;
        return map;
      });
    }).catch(function () { return null; });
  }

  /* ------------------------------------------------------------------ store */
  function loadOverlay() {
    if (!hasBridge()) return Promise.resolve(null);
    return rpc({ op: 'store', action: 'load', key: 'overlay' }).then(function (r) {
      if (r.status !== 200) return null;
      var text = decoder ? decoder.decode(r.bytes) : '';
      if (!text) return null;
      var o = JSON.parse(text);
      return (o && o.students) ? o : null;
    }).catch(function () { return null; });
  }

  function saveOverlay(ov) {
    if (!hasBridge()) return Promise.resolve(false);
    return rpc({ op: 'store', action: 'save', key: 'overlay', value: JSON.stringify(ov) })
      .then(function () { return true; }).catch(function () { return false; });
  }

  /* ----------------------------------------------------------------- images */
  var imgCache = {};

  function downscale(bytes, maxW, mime, quality) {
    return new Promise(function (resolve) {
      var url;
      try {
        url = root.URL.createObjectURL(new Blob([bytes], { type: mime || 'image/png' }));
      } catch (e) { resolve(''); return; }
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width;
          var h = img.naturalHeight || img.height;
          if (!w || !h) { resolve(''); return; }
          var scale = Math.min(1, maxW / w);
          var cw = Math.max(1, Math.round(w * scale));
          var ch = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = cw; canvas.height = ch;
          var ctx = canvas.getContext('2d');
          if (mime === 'image/jpeg') {
            ctx.fillStyle = '#0f1826';
            ctx.fillRect(0, 0, cw, ch);
          }
          ctx.drawImage(img, 0, 0, cw, ch);
          var out = canvas.toDataURL(mime === 'image/jpeg' ? 'image/jpeg' : 'image/png', quality || 0.82);
          root.URL.revokeObjectURL(url);
          resolve(out);
        } catch (e) { root.URL.revokeObjectURL(url); resolve(''); }
      };
      img.onerror = function () { root.URL.revokeObjectURL(url); resolve(''); };
      img.src = url;
    });
  }

  // 下载并压缩成 data URI；失败返回空串（UI 会退化成占位块）
  function grabImage(url, maxW, mime) {
    if (!url) return Promise.resolve('');
    if (url.indexOf('data:') === 0) return Promise.resolve(url);
    if (imgCache[url]) return imgCache[url];
    var p = rpc({ op: 'fetch', url: url, headers: { Referer: 'https://www.gamekee.com/' } })
      .then(function (r) {
        if (r.status !== 200 || !r.bytes.length) return '';
        if (r.bytes[0] === 0x3c) return ''; // '<' => 反爬页面
        return downscale(r.bytes, maxW, mime);
      })
      .catch(function () { return ''; });
    imgCache[url] = p;
    return p;
  }

  function mapLimit(items, limit, fn) {
    var i = 0;
    var out = new Array(items.length);
    function next() {
      if (i >= items.length) return Promise.resolve();
      var idx = i++;
      return fn(items[idx], idx).then(function (v) { out[idx] = v; return next(); });
    }
    var runners = [];
    for (var k = 0; k < Math.min(limit, items.length); k++) runners.push(next());
    return Promise.all(runners).then(function () { return out; });
  }

  /* ------------------------------------------------------------- student build */
  function getStudentRaw(item) {
    return fetchJSON(API + '/v1/content/detail/' + item.content_id, { 'game-alias': 'ba' })
      .then(function (d) {
        var data = d && d.data;
        if (!data) throw new Error('detail-empty');
        if (data.content_cdn) {
          var cdnUrl = data.content_cdn.indexOf('//') === 0 ? 'https:' + data.content_cdn : data.content_cdn;
          return fetchJSON(cdnUrl, { Referer: 'https://www.gamekee.com/' }).then(function (o) {
            return { data: data, inner: typeof o.content === 'string' ? JSON.parse(o.content) : o };
          });
        }
        if (data.content_json) {
          return { data: data, inner: JSON.parse(data.content_json) };
        }
        throw new Error('no-content');
      });
  }

  function localizeImages(s) {
    // 先收集「任务」，再由 mapLimit 控制并发（否则会同时发起几十个请求）
    var jobs = [];
    function add(holder, key, maxW, mime) {
      if (!holder || !holder[key]) return;
      var original = holder[key];
      jobs.push(function () {
        return grabImage(original, maxW, mime).then(function (dataUri) {
          if (dataUri) holder[key] = dataUri;
        });
      });
    }

    jobs.push(function () {
      return grabImage(s.avatarRemote, 320, 'image/jpeg').then(function (u) { if (u) s.avatar = u; });
    });

    (s.skills || []).forEach(function (k) { add(k, 'icon', 96, 'image/png'); });
    (s.terms || []).forEach(function (t) { add(t, 'icon', 64, 'image/png'); });

    add(s.uniqueWeapon, 'icon', 96, 'image/png');
    if (s.uniqueWeapon && s.uniqueWeapon.skill) add(s.uniqueWeapon.skill, 'icon', 96, 'image/png');
    add(s.favoriteItem, 'icon', 96, 'image/png');
    add(s.chocolate, 'icon', 96, 'image/png');

    // 站位 / 战术作用 的图标是文字图片，映射表里没有时直接显示图片
    if (!s.position && s.positionImage) {
      jobs.push(function () {
        return grabImage(s.positionImage, 160, 'image/png').then(function (u) { if (u) s.positionImage = u; });
      });
    }
    if (!s.tactic && s.tacticImage) {
      jobs.push(function () {
        return grabImage(s.tacticImage, 120, 'image/png').then(function (u) { if (u) s.tacticImage = u; });
      });
    }

    (s.exMats || []).forEach(function (m) { (m.items || []).forEach(function (it) { add(it, 'icon', 64, 'image/png'); }); });
    (s.skillMats || []).forEach(function (m) { (m.items || []).forEach(function (it) { add(it, 'icon', 64, 'image/png'); }); });

    // 礼物偏好：每档的「喜欢程度」图标 + 具体礼物
    (s.giftTiers || []).forEach(function (t) {
      if (t.level) {
        var lvUrl = t.level;
        jobs.push(function () {
          return grabImage(lvUrl, 72, 'image/png').then(function (u) { if (u) t.level = u; });
        });
      }
      (t.items || []).forEach(function (_, i) {
        var itemUrl = t.items[i];
        jobs.push(function () {
          return grabImage(itemUrl, 72, 'image/png').then(function (u) { if (u) t.items[i] = u; });
        });
      });
    });

    // 赠绊等级奖励的角色头像
    (s.bond || []).forEach(function (b) {
      if (!b.icon) return;
      var u0 = b.icon;
      jobs.push(function () {
        return grabImage(u0, 96, 'image/png').then(function (u) { if (u) b.icon = u; });
      });
    });

    // 立绘 / 回忆大厅体积太大，同步版不下载：
    // portraits 清空后沿用 App 内置的；hall 必须置空，否则会带一个远程地址
    // 进到「立绘」页，在 App 内加载不出来变成裂图。
    s.portraits = [];
    s.hall = { image: '' };

    return mapLimit(jobs, 5, function (job) { return job(); });
  }

  function buildStudent(item) {
    return getStudentRaw(item).then(function (r) {
      var rows = BAParse.compactRows(r.inner.baseData);
      var s = BAParse.parseStudent({
        entryId: item.id,
        contentId: item.content_id,
        title: r.data.title,
        summary: r.data.summary || '',
        updatedAt: r.data.updated_at,
        icon: item.icon,
        nameAlias: item.name_alias || '',
        rows: rows
      });
      return localizeImages(s).then(function () { return s; });
    });
  }

  /* ------------------------------------------------------------------- check */
  var state = { running: false, lastResult: null, lastCheck: 0, auto: true, token: 0 };

  // bind_updated 与内容 updated_at 有时差 1 秒，留一点容差
  var STAMP_TOLERANCE = 2;

  function check(opts) {
    opts = opts || {};
    if (!hasBridge()) return Promise.resolve({ ok: false, reason: 'no-bridge' });
    if (state.running) return Promise.resolve({ ok: false, reason: 'busy' });
    var now = Date.now();
    if (!opts.force && state.lastCheck && (now - state.lastCheck) < CHECK_INTERVAL) {
      return Promise.resolve({ ok: false, reason: 'throttled' });
    }
    state.running = true;
    state.lastCheck = now;
    var myToken = ++state.token;
    // 兜底：任何一步卡死都不会让 running 永远为 true
    setTimeout(function () {
      if (state.running && state.token === myToken) {
        state.running = false;
        state.lastResult = { ok: false, error: 'timeout', at: now };
      }
    }, 150000);

    return loadOverlay()
      .then(function (existing) {
        var ov = existing || { version: 1, students: {}, index: [] };
        ov.students = ov.students || {};
        ov.index = ov.index || [];
        ov.stamps = ov.stamps || {};

        // 已知 = 内置数据 + 本地已同步过的（两处都要算，避免重复添加）
        var known = {};
        (opts.known || (root.BA_INDEX || []).map(function (s) { return s.id; }))
          .forEach(function (id) { known[id] = 1; });
        ov.index.forEach(function (s) { if (s && s.id) known[s.id] = 1; });
        Object.keys(ov.students).forEach(function (id) { known[id] = 1; });

        // 每个学生上次同步时的 bind_updated；没有记录时用内置数据的 updated_at 兜底
        var localUpdated = opts.updated || {};
        function baseline(id) {
          if (ov.stamps[id]) return ov.stamps[id];
          var u = localUpdated[id];
          return u ? u + STAMP_TOLERANCE : 0;
        }

        return fetchJSON(API + '/v1/wiki/entry', { 'game-alias': 'ba' })
          .then(function (tree) {
            var roots = (tree && tree.data && tree.data.entry_list) || [];
            var g = roots.filter(function (e) { return e.id === ENTRY_ROOT; })[0];
            if (!g) throw new Error('entry-404');
            var stu = (g.child || []).filter(function (e) { return e.id === ENTRY_STUDENTS; })[0];
            if (!stu) throw new Error('entry-404');
            var all = stu.child || [];

            var fresh = [];
            var changed = [];
            all.forEach(function (c) {
              if (!c.content_id) return;
              if (!known[c.id]) { fresh.push(c); return; }
              // 已知学生：bind_updated 变新 → 资料有改动
              if (c.bind_updated && c.bind_updated > baseline(c.id)) {
                c.__isUpdate = true;
                changed.push(c);
              }
            });
            return { total: all.length, all: all, fresh: fresh, changed: changed, ov: ov };
          });
      })
      .then(function (r) {
        var ov = r.ov;
        var queue = r.fresh.concat(r.changed);
        var isChanged = {};
        r.changed.forEach(function (c) { isChanged[c.id] = 1; });

        if (!queue.length) {
          // 没有新增/改动：只刷新一次时间戳水位
          r.all.forEach(function (c) { if (c.bind_updated) ov.stamps[c.id] = c.bind_updated; });
          ov.updatedAt = now;
          state.running = false;
          state.lastResult = { ok: true, added: 0, updated: 0, total: r.total, at: now };
          return saveOverlay(ov).then(function () {
            return { ok: true, added: 0, updated: 0, total: r.total };
          });
        }

        var todo = queue.slice(0, MAX_NEW_PER_RUN);
        var todoIds = {};
        todo.forEach(function (c) { todoIds[c.id] = 1; });

        var added = [];
        var updated = [];
        var chain = Promise.resolve();
        todo.forEach(function (item) {
          chain = chain.then(function () {
            return buildStudent(item).then(function (s) {
              if (isChanged[item.id]) {
                // 已有学生：保留内置的立绘与头像，避免被空值覆盖
                delete s.avatar;
                s.portraits = [];
                s.isUpdated = true;
                s.updatedSyncedAt = now;
                s.syncedAt = now;
                ov.students[s.id] = s;
                ov.index = ov.index.filter(function (x) { return x && x.id !== s.id; });
                ov.index.push(BAParse.summarize(s));
                updated.push(s);
              } else if (!ov.students[s.id]) {
                s.syncedAt = now;
                s.isNew = true;
                ov.students[s.id] = s;
                ov.index = ov.index.filter(function (x) { return x && x.id !== s.id; });
                ov.index.push(BAParse.summarize(s));
                added.push(s);
              }
              ov.stamps[s.id] = item.bind_updated || now;
            }).catch(function () { /* 单个失败不影响其它，也不写水位，下次重试 */ });
          });
        });

        return chain.then(function () {
          // 未改动、且本次没处理过的学生，只更新水位
          r.all.forEach(function (c) {
            if (!c.bind_updated) return;
            if (todoIds[c.id]) return;          // 已处理
            if (isChanged[c.id]) return;        // 改动但本轮没轮到 → 保留旧水位，下次继续
            ov.stamps[c.id] = c.bind_updated;
          });
          ov.updatedAt = now;
          ov.count = (ov.index || []).length;
          return saveOverlay(ov).then(function () {
            state.running = false;
            state.lastResult = { ok: true, added: added.length, updated: updated.length, total: r.total, at: now };
            return {
              ok: true,
              added: added.length,
              updated: updated.length,
              total: r.total,
              students: added,
              updatedStudents: updated,
              remaining: queue.length - todo.length
            };
          });
        });
      })
      .catch(function (e) {
        state.running = false;
        state.lastResult = { ok: false, error: String(e && e.message || e), at: now };
        return { ok: false, error: String(e && e.message || e) };
      });
  }

  root.BASync = {
    available: hasBridge,
    load: loadOverlay,
    check: check,
    state: state,
    reset: function () { state.lastCheck = 0; return rpc({ op: 'store', action: 'save', key: 'overlay', value: '' }); }
  };

  // 给其它模块复用同一套「原生代发请求」能力（绕开 CORS / Referer 限制）
  root.BAFetch = {
    text: fetchText,
    json: fetchJSON,
    b64: fetchBase64,
    available: hasBridge
  };

  // 语音试听地址（按需拉取 + 缓存）
  root.BASync.voiceAudio = voiceAudio;

  /* ------------------------------------------------------------ 素材缓存 */
  // 原生把文件写到 Documents/ba-media/，这里只负责搬运（base64）
  function cacheSet(key, b64) {
    return rpc({ op: 'cache', action: 'set', key: key, data: b64 })
      .then(function (r) { return r.status === 200; })
      .catch(function () { return false; });
  }

  function cacheGet(key) {
    return rpc({ op: 'cache', action: 'get', key: key })
      .then(function (r) {
        if (r.status !== 200 || !r.b64) return '';
        return r.b64;
      })
      .catch(function () { return ''; });
  }

  function cacheSize() {
    return rpc({ op: 'cache', action: 'size' })
      .then(function (r) {
        var t = decoder ? decoder.decode(r.bytes) : '';
        return parseInt(t, 10) || 0;
      })
      .catch(function () { return 0; });
  }

  function cacheClear() {
    return rpc({ op: 'cache', action: 'clear' })
      .then(function (r) { return r.status === 200; })
      .catch(function () { return false; });
  }

  root.BASync.cache = { get: cacheGet, set: cacheSet, size: cacheSize, clear: cacheClear, available: hasBridge };
})(typeof window !== 'undefined' ? window : this);

/* 什亭之匣 · 蔚蓝档案学生图鉴 — single page app (offline first) */
(function () {
  'use strict';

  const APP_NAME = '什亭之匣';
  const APP_VERSION = 'V1.0.2';

  // 内置数据（打包进 App），联网同步到的新学生会追加到这里
  const INDEX = (window.BA_INDEX || []).slice();
  const STUDENTS = window.BA_STUDENTS || {};
  const AVATARS = window.BA_AVATARS || null;
  const BY_ID = {};
  INDEX.forEach(function (s) { BY_ID[s.id] = s; });

  const LS_FAV = 'ba.dex.favs';
  const LS_SORT = 'ba.dex.sort';

  // localStorage can be unavailable when the page is opened from file:// —
  // fall back to in-memory storage so the app never crashes.
  const store = (function () {
    try {
      const k = '__ba_test__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch (e) {
      const mem = {};
      return {
        getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
      };
    }
  })();

  function loadJSON(key, fallback) {
    try { return JSON.parse(store.getItem(key) || JSON.stringify(fallback)); } catch (e) { return fallback; }
  }

  const state = {
    tab: 'students',
    query: '',
    filters: { rarity: [], school: [], attack: [], defense: [], position: [], role: [], tactic: [], weapon: [] },
    sort: store.getItem(LS_SORT) || 'date',
    favs: new Set(loadJSON(LS_FAV, [])),
    detail: null,
    detailTab: 'overview',
    skillLv: {},
    voiceCat: null,
    voiceTrans: 'off',        // 'off' 官方翻译 / 'fan' 民间翻译
    voiceAudio: undefined,    // undefined=未请求; null=加载中; {}=无音频
    voiceAudioFor: null,      // 当前 audio 属于哪个学生
    voiceAudioLoading: {},    // id -> 1（避免重复请求）
    mediaCat: null,           // 影画鉴赏当前分类
    netToast: 0,
    sheetOpen: false,
    draft: null,
  };

  /* ------------------------------------------------------------- helpers */
  const esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  function rich(s) {
    if (!s) return '';
    let out = esc(s);
    out = out.replace(/\*red:([^*]*)\*/g, '<em class="hl">$1</em>');
    out = out.replace(/\*red:/g, '');
    out = out.replace(/\*(?=\S)/g, '');
    return out.replace(/\n/g, '<br>');
  }

  // WIKI 里同一种属性存在不同译法（贯通/贯穿、支援/辅助），两种都要能取到颜色，
  // 否则会落到下面的灰色兜底 #7b8aa0 上。
  const ATK_COLOR = {
    '爆炸': '#ef5f3c',   // 红
    '贯通': '#d99a1f',   // 深黄（游戏内图标色）
    '贯穿': '#d99a1f',   // 同 贯通，兼容旧译名
    '神秘': '#4d7df2',   // 蓝
    '振动': '#9b5cf0',   // 紫
    '治疗': '#22a875'
  };
  const DEF_COLOR = {
    '轻装甲': '#4d9df2',
    '重装甲': '#d99a1f',
    '特殊装甲': '#9b5cf0',
    '弹力装甲': '#22a875',
    '复合装甲': '#e0742c'
  };
  const ROLE_COLOR = {
    '输出': '#ef5f3c',
    '坦克': '#4d9df2',
    '治疗': '#22a875',
    '辅助': '#9b5cf0',
    '支援': '#9b5cf0'
  };
  const GRADE_COLOR = { S: '#f2b132', A: '#9b5cf0', B: '#4d7df2', C: '#93a2b8', D: '#c3ccd8' };
  const POSITION_CN = { FRONT: '前排', MIDDLE: '中排', BACK: '后排' };
  const TACTIC_CN = { STRIKER: '突击', SPECIAL: '支援' };
  const SKILL_KIND = { 'EX技能': 'EX', '普通技能': 'NS', '被动技能': 'PS', '辅助技能': 'SS', '子技能': 'SUB' };
  const SKILL_COLOR = { EX: '#ef5f3c', NS: '#3b7bfa', PS: '#9b5cf0', SS: '#22a875', SUB: '#e8a92f' };

  function atkColor(v) { return ATK_COLOR[v] || '#7b8aa0'; }
  function defColor(v) { return DEF_COLOR[v] || '#7b8aa0'; }
  function roleColor(v) { return ROLE_COLOR[v] || '#7b8aa0'; }

  function avatar(id) {
    if (AVATARS && AVATARS[id]) return AVATARS[id];
    return 'avatars/' + id + '.jpg';
  }

  // 同步来的学生头像存的是 data URI
  function avatarOf(s) {
    if (s && s.avatar) return s.avatar;
    return avatar(s ? s.id : '');
  }

  // 同步来的学生没有「站位 / 战术作用」的文字映射时，直接显示 WIKI 上的文字图片
  function tagOrImage(text, image, height) {
    if (text) return esc(text);
    if (image) return '<img src="' + image + '" alt="" style="height:' + (height || 14) + 'px;width:auto;max-width:58px;object-fit:contain;display:inline-block;vertical-align:-2px">';
    return '—';
  }

  function stars(n) { return '★'.repeat(n || 0); }

  function fmtNum(v) {
    return String(v == null ? '' : v).replace(/\s*\n\s*/g, ' / ').trim();
  }

  function shortSchool(v) {
    return String(v || '')
      .replace(/学园$/, '').replace(/学院$/, '').replace(/高等学校$/, '')
      .replace(/高级中学$/, '').replace(/警察学校$/, '').replace(/分校$/, '')
      .replace(/高中$/, '').replace(/中学$/, '');
  }

  function fmtCV(v) {
    if (!v) return '';
    const parts = String(v).split('\n').map(function (line) {
      const m = line.match(/^\s*([日韩中英])\s*\|\s*(.+)$/);
      return m ? m[2].trim() + '（' + m[1] + '）' : line.trim();
    }).filter(Boolean);
    return parts.join(' / ');
  }

  function starBadge(v) {
    if (!v) return '<span class="st none">—</span>';
    if (/^[★]+$/.test(v)) return '<span class="st">' + v + '</span>';
    return '<span class="st none">' + esc(v) + '</span>';
  }

  const ICON = {
    students: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="3.5" y="3.5" width="7" height="7" rx="2"/><rect x="13.5" y="3.5" width="7" height="7" rx="2"/><rect x="3.5" y="13.5" width="7" height="7" rx="2"/><rect x="13.5" y="13.5" width="7" height="7" rx="2"/></svg>',
    school: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 4l9 5.5"/><path d="M5 11v9h14v-9"/><path d="M9.5 20v-5h5v5"/></svg>',
    heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 20s-7.5-4.7-7.5-9.6A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 7.5 3c0 4.9-7.5 9.6-7.5 9.6Z"/></svg>',
    heartFill: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M12 20s-7.5-4.7-7.5-9.6A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 7.5 3c0 4.9-7.5 9.6-7.5 9.6Z"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 5-7 7 7 7"/></svg>',
    filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M7 12h10M10 17h4"/></svg>',
  };

  /* --------------------------------------------------------------- filter */
  function uniq(arr) {
    const seen = {};
    const out = [];
    arr.forEach(function (v) { if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
    return out;
  }

  // 筛选面板的候选项依赖学生集合，同步到新学生后需要重建
  let FACETS = null;

  function buildFacets() {
    FACETS = {
      rarity: { label: '稀有度', values: [3, 2, 1], fmt: function (v) { return v + '★'; } },
      school: { label: '学院', values: uniq(INDEX.map(function (s) { return s.school; })) },
      attack: { label: '攻击类型', values: uniq(INDEX.map(function (s) { return s.attack; })) },
      defense: { label: '防御类型', values: uniq(INDEX.map(function (s) { return s.defense; })) },
      position: { label: '站位', values: ['FRONT', 'MIDDLE', 'BACK'], fmt: function (v) { return POSITION_CN[v]; } },
      role: { label: '作用', values: uniq(INDEX.map(function (s) { return s.role; })) },
      tactic: { label: '战术作用', values: ['STRIKER', 'SPECIAL'], fmt: function (v) { return TACTIC_CN[v]; } },
      weapon: { label: '武器', values: uniq(INDEX.map(function (s) { return s.weaponType; })) },
    };
  }

  buildFacets();

  function activeFilterCount() {
    return Object.keys(state.filters).reduce(function (n, k) { return n + state.filters[k].length; }, 0);
  }

  function matches(s) {
    const f = state.filters;
    if (f.rarity.length && f.rarity.indexOf(s.rarity) < 0) return false;
    if (f.school.length && f.school.indexOf(s.school) < 0) return false;
    if (f.attack.length && f.attack.indexOf(s.attack) < 0) return false;
    if (f.defense.length && f.defense.indexOf(s.defense) < 0) return false;
    if (f.position.length && f.position.indexOf(s.position) < 0) return false;
    if (f.role.length && f.role.indexOf(s.role) < 0) return false;
    if (f.tactic.length && f.tactic.indexOf(s.tactic) < 0) return false;
    if (f.weapon.length && f.weapon.indexOf(s.weaponType) < 0) return false;
    if (state.query) {
      const q = state.query.toLowerCase();
      const hay = (s.name + ' ' + (s.aliases || []).join(' ') + ' ' + (s.school || '') + ' ' + (s.club || '')).toLowerCase();
      if (hay.indexOf(q) < 0) return false;
    }
    return true;
  }

  // Wiki dates look like "2026/9/23" or "2021/02/04" — string comparison would
  // put 9/23 before 10/28, so always compare a numeric key.
  function dateKey(v) {
    const m = String(v == null ? '' : v).match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    if (!m) return -1;
    return (+m[1]) * 10000 + (+m[2]) * 100 + (+m[3]);
  }

  function latestReleaseDate() {
    let best = '';
    for (let i = 0; i < INDEX.length; i++) {
      if (dateKey(INDEX[i].releaseDate) > dateKey(best)) best = INDEX[i].releaseDate;
    }
    return best;
  }

  function sortList(list) {
    const out = list.slice();
    if (state.sort === 'name') {
      out.sort(function (a, b) { return a.name.localeCompare(b.name, 'zh-Hans-CN'); });
    } else if (state.sort === 'rarity') {
      out.sort(function (a, b) { return b.rarity - a.rarity || a.name.localeCompare(b.name, 'zh-Hans-CN'); });
    } else {
      out.sort(function (a, b) {
        return dateKey(b.releaseDate) - dateKey(a.releaseDate) ||
          a.name.localeCompare(b.name, 'zh-Hans-CN');
      });
    }
    return out;
  }

  function filtered() { return sortList(INDEX.filter(matches)); }

  /* ----------------------------------------------------------------- list */
  function isNewStudent(s) {
    return !!(s && s.isNew && s.syncedAt && (Date.now() - s.syncedAt) < 7 * 864e5);
  }

  function isUpdatedStudent(s) {
    return !!(s && s.isUpdated && s.updatedSyncedAt && (Date.now() - s.updatedSyncedAt) < 7 * 864e5);
  }

  function cardHTML(s) {
    return '' +
      '<button class="card" data-act="open" data-id="' + s.id + '">' +
        '<img loading="lazy" src="' + avatarOf(s) + '" alt="' + esc(s.name) + '">' +
        '<span class="scrim"></span>' +
        (isNewStudent(s) ? '<span class="newbadge">NEW</span>'
          : (isUpdatedStudent(s) ? '<span class="newbadge upd">更新</span>' : '')) +
        '<span class="meta">' +
          '<span class="nm">' + esc(s.name) + '</span>' +
          '<span class="sub">' + esc(shortSchool(s.school)) + ' · ' + esc(s.role) + '</span>' +
        '</span>' +
        '<span class="accentbar" style="background:' + atkColor(s.attack) + '"></span>' +
      '</button>';
  }

  function sortLabel() {
    return { date: '日期', name: '名称', rarity: '稀有' }[state.sort];
  }

  function listView() {
    const list = filtered();
    const chips = [
      { k: 'all', label: '全部', on: activeFilterCount() === 0 && !state.query },
      { k: '3', label: '3★', on: state.filters.rarity.length === 1 && state.filters.rarity[0] === 3 },
      { k: '2', label: '2★', on: state.filters.rarity.length === 1 && state.filters.rarity[0] === 2 },
      { k: '1', label: '1★', on: state.filters.rarity.length === 1 && state.filters.rarity[0] === 1 },
    ];
    let html = '';
    html += '<div class="chiprow">';
    chips.forEach(function (c) {
      html += '<button class="chip ' + (c.on ? 'on' : '') + '" data-act="quick" data-k="' + c.k + '">' + c.label + '</button>';
    });
    html += '<button class="chip ' + (activeFilterCount() ? 'on' : '') + '" data-act="filter-open">' +
      '<span style="width:14px;height:14px;display:inline-flex">' + ICON.filter + '</span>筛选' +
      (activeFilterCount() ? '<span class="badge">' + activeFilterCount() + '</span>' : '') + '</button>';
    html += '<button class="chip" data-act="sort-cycle">' + sortLabel() + ' ⇅</button>';
    html += '</div>';

    if (!list.length) {
      html += '<div class="empty"><div class="big">🔍</div>没有符合条件的学生<br>试试更换筛选条件或关键词</div>';
      return html;
    }
    html += '<div class="grid">' + list.map(cardHTML).join('') + '</div>';
    html += '<div class="empty" style="padding:26px 0 4px">已显示 ' + list.length + ' / ' + INDEX.length + ' 名学生</div>';
    return html;
  }

  /* --------------------------------------------------------------- schools */
  function schoolsView() {
    const groups = {};
    INDEX.forEach(function (s) {
      if (!s.school) return;
      (groups[s.school] = groups[s.school] || []).push(s);
    });
    const names = Object.keys(groups).sort(function (a, b) { return groups[b].length - groups[a].length; });
    let html = '<div class="section-title">按学院浏览 · ' + names.length + ' 所</div>';
    names.forEach(function (n) {
      const arr = groups[n].slice().sort(function (a, b) { return b.rarity - a.rarity || a.name.localeCompare(b.name); });
      html += '<button class="school-card" data-act="school" data-name="' + esc(n) + '">' +
        '<span class="avatars">' + arr.slice(0, 3).map(function (s) {
          return '<img src="' + avatarOf(s) + '" alt="">';
        }).join('') + '</span>' +
        '<span class="col"><span class="nm">' + esc(n) + '</span><span class="cnt">' + arr.length + ' 名学生</span></span>' +
        '<span class="arrow">›</span>' +
      '</button>';
    });
    return html;
  }

  /* ----------------------------------------------------------------- favs */
  function favView() {
    const list = sortList(INDEX.filter(function (s) { return state.favs.has(s.id); }));
    if (!list.length) {
      return '<div class="empty" style="padding-top:80px"><div class="big">♡</div>还没有收藏的学生<br><span style="font-size:12.5px">在学生详情页点击右上角收藏</span></div>';
    }
    return '<div class="section-title">我的收藏 · ' + list.length + '</div><div class="grid">' + list.map(cardHTML).join('') + '</div>';
  }

  /* ----------------------------------------------------------------- more */
  function refreshCacheSize() {
    if (!window.BASync || !window.BASync.cache || !window.BASync.cache.available()) return;
    window.BASync.cache.size().then(function (bytes) {
      state.cacheSizeText = bytes > 0 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : '0 MB';
      const el = document.getElementById('cache-size');
      if (el) el.textContent = state.cacheSizeText;
    });
  }

  function syncStatusText() {
    if (!window.BASync || !window.BASync.available()) return '需在 App 内使用';
    const st = window.BASync.state;
    if (st.running) return '检查中…';
    const r = st.lastResult;
    if (!r) return '点此检查';
    if (!r.ok) return '检查失败';
    const parts = [];
    if (r.added) parts.push('新增 ' + r.added + ' 名');
    if (r.updated) parts.push('更新 ' + r.updated + ' 名');
    return parts.length ? parts.join(' · ') : '已是最新';
  }

  function lastCheckText() {
    const st = window.BASync && window.BASync.state;
    if (!st || !st.lastCheck) return '—';
    const d = new Date(st.lastCheck);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function moreView() {
    setTimeout(refreshCacheSize, 0);
    const schools = uniq(INDEX.map(function (s) { return s.school; })).length;
    const r3 = INDEX.filter(function (s) { return s.rarity === 3; }).length;
    const strikes = INDEX.filter(function (s) { return s.tactic === 'STRIKER'; }).length;
    return '' +
      '<div class="section-title">数据总览</div>' +
      '<div class="stat-cards">' +
        '<div class="stat-card"><div class="n">' + INDEX.length + '</div><div class="l">实装学生</div></div>' +
        '<div class="stat-card"><div class="n">' + r3 + '</div><div class="l">3★ 学生</div></div>' +
        '<div class="stat-card"><div class="n">' + schools + '</div><div class="l">所属学院</div></div>' +
      '</div>' +
      '<div class="section-title">数据更新</div>' +
      '<div class="panel">' +
        '<button class="rowlink" data-act="sync-now" style="width:100%;text-align:left">' +
          '<span>立即同步WIKI数据</span><span class="r"><span id="sync-status">' + syncStatusText() + '</span> ›</span></button>' +
        '<div class="rowlink"><span>上次检查</span><span class="r">' + lastCheckText() + '</span></div>' +
        '<div class="rowlink"><span>自动检查</span><span class="r">每次启动 · 30 分钟内不重复</span></div>' +
      '</div>' +
      '<div class="section-title">关于</div>' +
      '<div class="panel">' +
        '<div class="rowlink"><span>应用名称</span><span class="r">' + esc(APP_NAME) + '</span></div>' +
        '<div class="rowlink"><span>版本</span><span class="r" id="app-version">' + esc(APP_VERSION) + '</span></div>' +
        '<button class="rowlink" data-act="check-update" style="width:100%;text-align:left">' +
          '<span>检查更新</span><span class="r" id="update-status">›</span></button>' +
        '<div class="rowlink"><span>学生总数</span><span class="r">' + INDEX.length + ' 名</span></div>' +
        '<div class="rowlink"><span>突击 / 支援</span><span class="r">' + strikes + ' / ' + (INDEX.length - strikes) + '</span></div>' +
        '<div class="rowlink"><span>数据来源</span><span class="r">GameKee 蔚蓝档案 WIKI</span></div>' +
        '<div class="rowlink"><span>最新实装</span><span class="r">' + (latestReleaseDate() || '—') + '</span></div>' +
      '</div>' +
      '<div class="section-title">存储</div>' +
      '<div class="panel">' +
        '<div class="rowlink"><span>素材缓存</span><span class="r" id="cache-size">' + (state.cacheSizeText || '…') + '</span></div>' +
        '<button class="rowlink" data-act="cache-clear" style="width:100%;text-align:left">' +
          '<span>清理缓存</span><span class="r">›</span></button>' +
      '</div>' +
      '<div class="section-title">说明</div>' +
      '<div class="panel"><div class="panel-body" style="font-size:12.5px;line-height:1.7;color:var(--sub)">' +
        '本应用为玩家自制的非官方资料查询工具，学生资料、立绘与语音文本版权归 NEXON Games / Yostar 及原 WIKI 贡献者所有。' +
        '数据整理自 gamekee.com 蔚蓝档案 WIKI 的「游戏图鉴 · 实装学生」，仅用于学习交流，请勿用于商业用途。' +
        '新学生的资料由 App 启动时自动同步，图片为压缩后的离线副本。' +
      '</div></div>' +
      '<div style="height:20px"></div>';
  }

  /* --------------------------------------------------------------- detail */
  function detailHTML(s) {
    const isFav = state.favs.has(s.id);
    let html = '';
    html += '<div class="hero-block">';
    html += '<div class="hero">' +
      '<img class="bg" src="' + avatarOf(s) + '" alt="">' +
      '<span class="scrim"></span>' +
      '<img class="art" src="' + avatarOf(s) + '" alt="">' +
      '<button class="navbtn back" data-act="back">' + ICON.back + '</button>' +
      '<button class="navbtn fav ' + (isFav ? 'on' : '') + '" data-act="fav" data-id="' + s.id + '">' + (isFav ? ICON.heartFill : ICON.heart) + '</button>' +
      '</div>';

    html += '<div class="hero-info">' +
      '<h2>' + esc(s.name) + '</h2>' +
      '<div class="stars">' + stars(s.rarity) + '</div>' +
      '<div class="line">' + esc(s.school) + (s.club ? ' · ' + esc(s.club) : '') + '</div>' +
      '<div class="hero-tags">' +
        '<span class="tag solid" style="background:' + atkColor(s.attack) + '">' + esc(s.attack) + '</span>' +
        '<span class="tag" style="color:' + defColor(s.defense) + ';border-color:' + defColor(s.defense) + '55">' + esc(s.defense) + '</span>' +
        '<span class="tag" style="color:' + roleColor(s.role) + '">' + esc(s.role) + '</span>' +
        '<span class="tag">' + tagOrImage(POSITION_CN[s.position], s.positionImage, 12) + '</span>' +
        '<span class="tag">' + tagOrImage(TACTIC_CN[s.tactic], s.tacticImage, 12) + '</span>' +
      '</div>' +
    '</div>' +
    '</div>';

    const TABS = [
      ['overview', '概览'], ['skills', '技能'], ['stats', '属性'], ['grow', '养成'],
      ['profile', '资料'], ['voice', '语音'], ['media', '影画'],
    ];
    html += '<div class="segwrap"><div class="seg">' +
      TABS.map(function (t) {
        return '<button class="' + (state.detailTab === t[0] ? 'on' : '') + '" data-act="dt" data-t="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div></div>';

    html += '<div class="detail-body">' + detailTabHTML(s) + '</div>';
    return html;
  }

  function secTitle(t, extra) {
    return '<div class="section-title">' + esc(t) + (extra || '') + '</div>';
  }

  function detailTabHTML(s) {
    switch (state.detailTab) {
      case 'skills': return skillsTab(s);
      case 'stats': return statsTab(s);
      case 'grow': return growTab(s);
      case 'profile': return profileTab(s);
      case 'voice': return voiceTab(s);
      case 'media': return mediaTab(s);
      default: return overviewTab(s);
    }
  }

  function overviewTab(s) {
    let html = '';
    if (s.summary) {
      html += '<div class="panel" style="margin-top:14px"><div class="panel-body">' +
        '<div style="font-size:12px;font-weight:800;color:var(--sub);letter-spacing:.06em;margin-bottom:6px">PROFILE</div>' +
        '<div style="font-size:13.5px;line-height:1.68">' + rich(s.summary) + '</div></div></div>';
    }

    html += secTitle('基础信息');
    const kv = [
      ['稀有度', stars(s.rarity)],
      ['战术作用', tagOrImage(TACTIC_CN[s.tactic], s.tacticImage, 11)],
      ['站位', tagOrImage(POSITION_CN[s.position], s.positionImage, 11)],
      ['攻击类型', s.attack],
      ['防御类型', s.defense],
      ['武器类型', s.weaponType || '—'],
      ['所属学院', s.school],
      ['所属社团', s.club || '—'],
      ['实装日期', s.releaseDate || '—'],
      ['声优', fmtCV(s.profile && s.profile.cv) || '—'],
    ];
    html += '<div class="panel"><div class="kvgrid">' + kv.map(function (r) {
      const raw = String(r[1] == null ? '' : r[1]);
      const body = raw.indexOf('<img') === 0 ? raw : esc(raw.replace(/\s*\n\s*/g, ' / '));
      return '<div class="cell"><div class="k">' + r[0] + '</div><div class="v">' + body + '</div></div>';
    }).join('') + '</div></div>';

    html += secTitle('地形适应');
    const t = s.terrain || {};
    html += '<div class="terrain">' + [['市街', t.urban], ['屋外', t.outdoor], ['屋内', t.indoor]].map(function (x) {
      const g = x[1] || '-';
      return '<div class="t"><div class="grade" style="color:' + (GRADE_COLOR[g] || 'var(--sub)') + '">' + esc(g) + '</div><div class="lbl">' + x[0] + '</div></div>';
    }).join('') + '</div>';

    const rv = s.review || {};
    html += secTitle('角色评测');
    html += '<div class="panel"><div class="panel-body">';
    if (rv.score) {
      const m = String(rv.score).match(/^(\d+)\s*\(?([A-Za-z]*)\)?$/);
      html += '<div class="score-box"><div class="score">' + (m ? m[1] : esc(rv.score)) +
        (m && m[2] ? '<small> ' + m[2] + '</small>' : '') + '</div>' +
        '<div style="color:var(--sub);font-size:12px;line-height:1.5">综合评分<br><span style="color:var(--ink-2);font-weight:700">WIKI 编辑组</span></div></div>';
    }
    if (rv.tiers && rv.tiers.length) {
      html += '<div class="tiers">' + rv.tiers.map(function (x) {
        return '<span class="tierchip">' + esc(x.name) + ' ' + starBadge(x.value) + '</span>';
      }).join('') + '</div>';
    }
    if (rv.employment) html += '<div class="note"><b>就业场合</b><br>' + rich(rv.employment) + '</div>';
    if (rv.advice) html += '<div class="note"><b>抽取与培养建议</b><br>' + rich(rv.advice) + '</div>';
    html += '</div></div>';

    html += secTitle('技能速览');
    html += '<div class="panel">' + (s.skills || []).map(function (k, i) {
      const kind = SKILL_KIND[k.kindLabel] || 'SK';
      return '<button class="skill-brief" data-act="skill" data-i="' + i + '" style="width:100%;text-align:left">' +
        '<span class="skill-icon" style="width:36px;height:32px;background:' + (SKILL_COLOR[kind] || '#7b8aa0') + ';font-size:11px">' + kind + '</span>' +
        '<span style="flex:1;min-width:0"><span class="t1">' + esc(k.name || k.kindLabel) + '</span>' +
        '<span class="t2">' + esc(k.kindLabel) + ' · ' + (k.levels ? k.levels.length : 0) + ' 级</span></span>' +
        '<span class="chev">›</span>' +
      '</button>';
    }).join('') + '</div>';

    return html;
  }

  function skillsTab(s) {
    let html = '<div style="height:14px"></div>';
    (s.skills || []).forEach(function (k, idx) {
      const kind = SKILL_KIND[k.kindLabel] || 'SK';
      const lv = state.skillLv[idx] || 1;
      const list = k.levels || [];
      const entry = list.filter(function (x) { return x.lv === lv; })[0] || list[0] || { text: '' };
      html += '<div class="skill" data-skill="' + idx + '">' +
        '<div class="skill-head">' +
          '<div class="skill-icon" style="background:' + (SKILL_COLOR[kind] || '#7b8aa0') + '">' +
            (k.icon ? '<img src="' + k.icon + '" alt="">' : kind) +
          '</div>' +
          '<div class="skill-title">' +
            '<div class="kind">' + esc(k.kindLabel) + '</div>' +
            '<div class="nm">' + esc(k.name || '—') + '</div>' +
            (entry.cost ? '<div class="cost">COST ' + esc(entry.cost) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="lvbar">' + list.map(function (x) {
          return '<button class="' + (x.lv === lv ? 'on' : '') + '" data-act="lv" data-i="' + idx + '" data-lv="' + x.lv + '">LV' + x.lv + '</button>';
        }).join('') + '</div>' +
        '<div class="skill-text">' + (entry.text ? rich(entry.text) : '<span style="color:var(--sub)">暂无描述</span>') + '</div>' +
      '</div>';
    });

    html += secTitle('EX 技能升级材料');
    html += matTable(s.exMats);
    html += secTitle('其他技能升级材料');
    html += matTable(s.skillMats);
    return html;
  }

  function matTable(list) {
    if (!list || !list.length) return '<div class="panel"><div class="panel-body" style="color:var(--sub);font-size:13px">暂无数据</div></div>';
    let html = '<div class="panel"><div class="panel-body" style="padding:4px 12px">' +
      '<table class="matable"><thead><tr><th style="width:46px">等级</th><th>所需材料</th></tr></thead><tbody>';
    list.forEach(function (m) {
      html += '<tr><td class="lv">LV' + m.lv + '</td><td><div class="mat-inline">' +
        (m.items || []).map(function (it) {
          return '<span class="it">' + (it.icon ? '<img src="' + it.icon + '" alt="">' : '') +
            '<span>' + esc(fmtNum(it.count)) + '</span></span>';
        }).join('') + '</div></td></tr>';
    });
    html += '</tbody></table></div></div>';
    return html;
  }

  function statsTab(s) {
    const init = (s.stats && s.stats.init) || [];
    const max = (s.stats && s.stats.max) || [];
    const maxMap = {};
    max.forEach(function (x) { maxMap[x.name] = x.value; });
    let html = '<div style="height:14px"></div>';
    html += '<div class="panel"><div class="panel-body" style="padding:6px 12px">' +
      '<table class="stat-table"><thead><tr><th>属性</th><th>初始</th><th>满级</th><th style="text-align:right">成长</th></tr></thead><tbody>';
    init.forEach(function (x) {
      const a = parseFloat(String(x.value).replace(/[^\d.]/g, ''));
      const b = parseFloat(String(maxMap[x.name] || '').replace(/[^\d.]/g, ''));
      const d = (!isNaN(a) && !isNaN(b)) ? (b - a) : null;
      html += '<tr><td>' + esc(x.name) + '</td><td>' + esc(fmtNum(x.value)) + '</td><td class="v2">' + esc(fmtNum(maxMap[x.name] || '—')) + '</td>' +
        '<td class="delta">' + (d && d > 0 ? '+' + d.toLocaleString('en-US') : '') + '</td></tr>';
    });
    html += '</tbody></table></div></div>';

    if (s.equipDetails && s.equipDetails.length) {
      html += secTitle('装备（满级）');
      html += '<div class="panel">' + s.equipDetails.map(function (e) {
        return '<div style="padding:12px 14px;border-bottom:1px solid var(--line)">' +
          '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<span style="font-weight:700">' + esc(e.name) + '</span>' +
            '<span style="font-size:11px;color:var(--sub);font-weight:700">' + esc(e.slot) + ' · ' + esc(e.grade) + '</span>' +
          '</div>' +
          '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">' + (e.attrs || []).map(function (a) {
            return '<span class="tierchip">' + esc(a.name) + ' <span style="color:var(--accent)">' + esc(a.value) + '</span></span>';
          }).join('') + '</div>' +
        '</div>';
      }).join('') + '</div>';
    }

    const uw = s.uniqueWeapon || {};
    if (uw.table && uw.table.rows && uw.table.rows.length) {
      html += secTitle('专武数值');
      html += '<div class="panel"><div class="panel-body" style="padding:6px 12px">' +
        '<table class="stat-table"><thead><tr><th>' + esc(uw.name || '专武') + '</th>' +
        uw.table.cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        uw.table.rows.map(function (r) {
          return '<tr><td>' + esc(r.label) + '</td>' + r.values.map(function (v) { return '<td class="v2">' + esc(v || '—') + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table></div></div>';
    }

    // 能力解放：优先用「25级」那一行（537 行）的数值，
    // 介绍区的 279~281 行经常是 WIKI 的占位文字（如「这个不用写」）
    const abilityAttrs = (s.abilityDetail && s.abilityDetail.attrs && s.abilityDetail.attrs.length)
      ? s.abilityDetail.attrs
      : ((s.ability && s.ability.attrs) || []).filter(function (a) { return a && a.value && !/不用写/.test(a.value); });
    if (abilityAttrs.length) {
      html += secTitle('能力解放（25级）');
      html += '<div class="panel"><div class="panel-body"><div class="matgrid">' + abilityAttrs.map(function (a) {
        return '<span class="mat"><span class="n">' + esc(a.name) + '</span><span class="x">+' + esc(a.value) + '</span></span>';
      }).join('') + '</div></div></div>';
    }

    const bonds = (s.bond || []).filter(function (b) { return b && ((b.attrs && b.attrs.length) || b.icon); });
    if (bonds.length) {
      html += secTitle('羁绊等级奖励（50级）');
      html += '<div class="panel">' + bonds.map(function (b) {
        return '<div style="padding:12px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px">' +
          (b.icon ? '<img src="' + b.icon + '" style="width:34px;height:38px;object-fit:contain;border-radius:8px" alt="">' : '') +
          '<span style="flex:1;font-weight:700;font-size:13.5px">' + esc(b.label) + '</span>' +
          '<span style="display:flex;gap:6px;flex-wrap:wrap">' + (b.attrs || []).map(function (a) {
            return '<span class="tierchip">' + esc(a.name) + ' <span style="color:var(--accent)">' + esc(a.value) + '</span></span>';
          }).join('') + '</span>' +
        '</div>';
      }).join('') + '</div>';
    }
    return html;
  }

  function growTab(s) {
    const uw = s.uniqueWeapon || {};
    let html = '<div style="height:14px"></div>';
    if (uw.name) {
      html += '<div class="skill">' +
        '<div class="skill-head">' +
          '<div class="skill-icon" style="background:linear-gradient(135deg,#f2b132,#ef5f3c)">' + (uw.icon ? '<img src="' + uw.icon + '" alt="">' : '★') + '</div>' +
          '<div class="skill-title"><div class="kind">专属武器</div><div class="nm">' + esc(uw.name) + '</div></div>' +
        '</div>' +
        '<div class="skill-text" style="color:var(--sub)">' + esc(uw.desc) + '</div>' +
        (uw.star3 ? '<div class="note" style="margin-top:10px"><b>★3</b>　' + esc(uw.star3) + (uw.star4 ? '<br><b>★4</b>　' + esc(uw.star4) : '') + '</div>' : '') +
      '</div>';

      if (uw.skill && uw.skill.levels && uw.skill.levels.length) {
        const lv = state.skillLv['uw'] || 10;
        const e = uw.skill.levels.filter(function (x) { return x.lv === lv; })[0] || uw.skill.levels[0];
        html += '<div class="skill"><div class="skill-head">' +
          '<div class="skill-icon" style="background:#9b5cf0">' + (uw.skill.icon ? '<img src="' + uw.skill.icon + '" alt="">' : '★2') + '</div>' +
          '<div class="skill-title"><div class="kind">★2 强化技能</div><div class="nm">' + esc(uw.skill.name || '—') + '</div></div>' +
          '</div><div class="lvbar">' + uw.skill.levels.map(function (x) {
            return '<button class="' + (x.lv === lv ? 'on' : '') + '" data-act="lv" data-i="uw" data-lv="' + x.lv + '">LV' + x.lv + '</button>';
          }).join('') + '</div><div class="skill-text">' + rich(e.text) + '</div></div>';
      }
    }

    const fi = s.favoriteItem || {};
    if (fi.name) {
      const lv = state.skillLv['fi'] || 10;
      const lvl = (fi.t2skill && fi.t2skill.levels) || [];
      const e = lvl.filter(function (x) { return x.lv === lv; })[0] || lvl[0] || { text: '' };
      html += '<div class="skill">' +
        '<div class="skill-head">' +
          '<div class="skill-icon" style="background:linear-gradient(135deg,#ff7a9a,#9b5cf0)">' + (fi.icon ? '<img src="' + fi.icon + '" alt="">' : '♥') + '</div>' +
          '<div class="skill-title"><div class="kind">爱用品</div><div class="nm">' + esc(fi.name) + '</div></div>' +
        '</div>' +
        '<div class="skill-text" style="color:var(--sub)">' + esc(fi.desc) + '</div>' +
        (fi.t1 ? '<div class="note"><b>T1</b>　' + rich(fi.t1) + '</div>' : '') +
        (lvl.length ? '<div class="lvbar">' + lvl.map(function (x) {
          return '<button class="' + (x.lv === lv ? 'on' : '') + '" data-act="lv" data-i="fi" data-lv="' + x.lv + '">LV' + x.lv + '</button>';
        }).join('') + '</div><div class="skill-text">' + rich(e.text) + '</div>' : '') +
      '</div>';
    }

    if (s.exMats && s.exMats.length) { html += secTitle('EX 技能材料'); html += matTable(s.exMats); }
    if (s.skillMats && s.skillMats.length) { html += secTitle('普通技能材料'); html += matTable(s.skillMats); }
    return html;
  }

  // 「★3 爱丽丝（女仆）」→ 找 App 里同名的学生，实现跳转
  function resolveSameName(rawName) {
    const nm = String(rawName || '').replace(/^★\d+\s*/, '').replace(/^NPC\s*/, '').trim();
    if (!nm) return null;
    for (let i = 0; i < INDEX.length; i++) {
      if (INDEX[i].name === nm) return INDEX[i];
    }
    return null;
  }

  function profileTab(s) {
    const p = s.profile || {};
    const rows = [
      ['全名', p.fullName], ['假名', p.kana], ['繁中译名', p.twName], ['简中译名', p.cnName],
      ['年龄', p.age], ['生日', p.birthday], ['身高', p.height], ['兴趣', p.hobby],
      ['设计', p.designer], ['画师', p.artist], ['声优', fmtCV(p.cv)],
      ['回忆大厅解锁', p.hallLevel ? 'Lv.' + p.hallLevel : ''], ['MomoTalk 解锁', p.momoTalkLevel],
    ].filter(function (r) { return r[1] && r[1] !== '-'; });
    let html = '<div style="height:14px"></div>';
    html += '<div class="panel"><div class="panel-body" style="padding:4px 14px">' + rows.map(function (r) {
      return '<div class="kvline"><span class="k">' + r[0] + '</span><span class="v" style="white-space:pre-line">' + esc(String(r[1]).replace(/\s*\n\s*/g, '\n')) + '</span></div>';
    }).join('') + '</div></div>';

    if (p.bio) html += secTitle('个人简介') + '<div class="panel"><div class="panel-body"><div class="quote">' + rich(p.bio) + '</div></div></div>';

    // 礼物偏好：三档「喜欢程度」，每档后面才是具体礼物
    const tiers = s.giftTiers || [];
    if (tiers.length) {
      html += secTitle('礼物偏好');
      html += '<div class="panel">' + tiers.map(function (t) {
        const items = (t.items || []);
        return '<div class="gift-tier">' +
          (t.level ? '<img class="lv" src="' + t.level + '" alt="">' : '<span class="lv empty"></span>') +
          '<div class="items">' + (items.length
            ? items.map(function (u) { return '<img src="' + u + '" alt="">'; }).join('')
            : '<span class="none">暂无收录</span>') + '</div>' +
        '</div>';
      }).join('') + '</div>';
    } else if (s.gifts && s.gifts.length) {
      html += secTitle('礼物偏好');
      html += '<div class="panel"><div class="panel-body"><div class="gift-row">' + s.gifts.map(function (g) {
        return '<span class="g"><img src="' + g + '" alt=""></span>';
      }).join('') + '</div></div></div>';
    }

    const c = s.chocolate || {};
    if (c.name) {
      html += secTitle('情人节巧克力');
      html += '<div class="panel"><div class="panel-body" style="display:flex;gap:12px;align-items:center">' +
        (c.icon ? '<img src="' + c.icon + '" style="width:60px;height:60px;object-fit:contain;border-radius:12px;background:var(--card-2)" alt="">' : '') +
        '<div><div style="font-weight:700">' + esc(c.name) + '</div><div style="font-size:12.5px;color:var(--sub);margin-top:3px;line-height:1.6">' + esc(c.desc) + '</div></div>' +
      '</div></div>';
    }

    if (s.sameName && s.sameName.length) {
      html += secTitle('同名角色');
      html += '<div class="panel">' + s.sameName.map(function (x) {
        const target = resolveSameName(x.name);
        const inner = '<span class="rowlabel">' + esc(x.name) + '</span>' +
          '<span class="r">' + (target ? '查看 ›' : '未收录') + '</span>';
        return target
          ? '<button class="rowlink" data-act="open" data-id="' + target.id + '" style="width:100%;text-align:left">' + inner + '</button>'
          : '<div class="rowlink" style="opacity:.55">' + inner + '</div>';
      }).join('') + '</div>';
    }

    html += secTitle('数据来源');
    html += '<div class="panel"><div class="panel-body" style="font-size:12.5px;color:var(--sub);line-height:1.7">' +
      '内容整理自 GameKee 蔚蓝档案 WIKI：' +
      '<a href="https://www.gamekee.com/ba/second/23941" target="_blank" rel="noreferrer">实装学生图鉴</a>' +
      (p.sourceUrl ? '<br>角色考据：<a href="' + p.sourceUrl + '" target="_blank" rel="noreferrer">' + p.sourceUrl + '</a>' : '') +
    '</div></div>';
    return html;
  }

  function voiceTab(s) {
    const cats = Object.keys(s.voices || {});
    if (!cats.length) return '<div class="empty">暂无语音资料</div>';
    if (!state.voiceCat || cats.indexOf(state.voiceCat) < 0) state.voiceCat = cats[0];

    // 是否有官方翻译 / 民间翻译（任意一条即可）
    let hasOff = false;
    let hasFan = false;
    cats.forEach(function (c) {
      (s.voices[c] || []).forEach(function (v) { if (v.off) hasOff = true; if (v.fan || v.zh) hasFan = true; });
    });
    const mode = state.voiceTrans === 'fan' ? 'fan' : 'off';

    // 试听地址按需加载（内置数据里不带，太大）
    const audio = state.voiceAudioFor === s.id ? state.voiceAudio : undefined;
    if (audio === undefined) loadVoiceAudio(s);
    const audioReady = audio && Object.keys(audio).length > 0;

    // 声优
    const cv = s.cv || {};
    const cvBits = [];
    if (cv.jp) cvBits.push(['日配', cv.jp]);
    if (cv.cn) cvBits.push(['中配', cv.cn]);
    if (cv.kr) cvBits.push(['韩配', cv.kr]);

    let html = '<div style="height:14px"></div>';
    if (cvBits.length) {
      html += '<div class="cv-line">' + cvBits.map(function (b) {
        return '<span><b>' + esc(b[0]) + '</b>' + esc(b[1]) + '</span>';
      }).join('') + '</div>';
    }
    html += '<div class="voice-cat">' + cats.map(function (c) {
      return '<button class="chip ' + (c === state.voiceCat ? 'on' : '') + '" data-act="vcat" data-c="' + esc(c) + '">' + esc(c) +
        '<span style="opacity:.6;font-weight:600">' + s.voices[c].length + '</span></button>';
    }).join('') + '</div>';

    if (hasOff && hasFan) {
      html += '<div class="vtrans">' +
        '<span class="vtrans-label">译文</span>' +
        '<button class="vchip ' + (mode === 'off' ? 'on' : '') + '" data-act="vtrans" data-m="off">官方翻译</button>' +
        '<button class="vchip ' + (mode === 'fan' ? 'on' : '') + '" data-act="vtrans" data-m="fan">民间翻译</button>' +
      '</div>';
    }

    const items = s.voices[state.voiceCat] || [];
    html += '<div class="panel"><div class="panel-body" style="padding:2px 14px">' + items.map(function (v) {
      const key = state.voiceCat + '|' + v.label;
      const langs = (audioReady && audio[key]) ? audio[key] : null;
      // 兼容旧版同步缓存：那时只有 v.zh（等于现在的民翻）
      const vFan = v.fan || v.zh || '';
      const vOff = v.off || '';
      const zh = mode === 'off' ? (vOff || vFan) : (vFan || vOff);
      const isOfficial = mode === 'off' ? !!vOff : (!vFan && !!vOff);
      const tag = isOfficial ? '官' : '民';
      let plays = '';
      if (langs) {
        const names = ['日', '中', '韩'];
        plays = '<span class="vplays">' + langs.map(function (u, i) {
          if (!u) return '';
          return '<button class="vplay" data-act="vplay" data-url="' + esc(u) + '" data-key="' + esc(key) + '" data-lang="' + i +
            '" title="' + names[i] + '配">' + '<i>▶</i>' + names[i] + '</button>';
        }).join('') + '</span>';
      } else if (audio === null) {
        plays = '<span class="vplays loading">载入试听…</span>';
      }
      return '<div class="voice-item">' +
        '<div class="vtop"><span class="lb">' + esc(v.label) + '</span>' + plays + '</div>' +
        (v.jp ? '<div class="jp">' + esc(v.jp) + '</div>' : '') +
        (zh ? '<div class="zh"><span class="vtag">' + tag + '</span>' + esc(zh) + '</div>' : '') +
      '</div>';
    }).join('') + '</div></div>';
    html += '<div class="netnote">语音首次播放需联网加载，之后会缓存到本地</div>';
    return html;
  }

  /* -------------------------------------------------------- 语音试听 */

  // 内置数据不带音频地址，第一次进「语音」页时向 WIKI 拉一份，之后走缓存
  function loadVoiceAudio(s) {
    if (!window.BASync || !window.BASync.voiceAudio) return;
    if (state.voiceAudioLoading[s.id]) return;
    state.voiceAudioLoading[s.id] = 1;
    state.voiceAudioFor = s.id;
    state.voiceAudio = null;
    window.BASync.voiceAudio(s.id, s.contentId).then(function (map) {
      delete state.voiceAudioLoading[s.id];
      if (state.detail !== s.id) return;
      state.voiceAudio = map || {};
      if (state.detailTab === 'voice') rerenderBody();
    });
  }

  const audioUrlCache = {};
  let curAudio = null;
  let curKey = '';

  function stopVoice() {
    const on = detailEl.querySelector('.vplay.on');
    if (on) on.classList.remove('on');
    if (curAudio) {
      try { curAudio.pause(); } catch (e) { /* ignore */ }
      curAudio = null;
    }
    curKey = '';
  }

  // 音频从原生桥取（CDN 校验 Referer，网页侧拿不到），转成 Blob URL 播放
  function resolveAudioUrl(url) {
    if (audioUrlCache[url]) return Promise.resolve(audioUrlCache[url]);
    if (!window.BAFetch || !window.BAFetch.available()) {
      return Promise.reject(new Error('需要在 App 内联网播放'));
    }
    return window.BAFetch.b64(url, { Referer: 'https://www.gamekee.com/' }).then(function (b64) {
      const bin = atob(b64 || '');
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = /\.mp3$/i.test(url) ? 'audio/mpeg' : 'audio/ogg';
      const obj = URL.createObjectURL(new Blob([bytes], { type: mime }));
      audioUrlCache[url] = obj;
      return obj;
    });
  }

  function playVoice(btn) {
    const url = btn.dataset.url;
    if (!url) return;
    const key = btn.dataset.key + ':' + btn.dataset.lang;
    if (curKey === key && curAudio) { stopVoice(); return; }
    stopVoice();
    curKey = key;
    btn.classList.add('loading');
    resolveAudioUrl(url).then(function (objUrl) {
      btn.classList.remove('loading');
      const a = new Audio(objUrl);
      curAudio = a;
      a.onended = function () {
        btn.classList.remove('on');
        if (curAudio === a) { curAudio = null; curKey = ''; }
      };
      btn.classList.add('on');
      const p = a.play();
      if (p && p.catch) p.catch(function () { btn.classList.remove('on'); stopVoice(); toast('播放失败，请重试'); });
    }).catch(function (e) {
      btn.classList.remove('loading');
      curKey = '';
      toast('语音加载失败：' + ((e && e.message) || '网络错误'));
    });
  }

  /* ------------------------------------------------------- 影画鉴赏 */

  const MEDIA_CATS = [
    ['portraits', '立绘'],
    ['intro', '官方介绍'],
    ['lobby', '回忆大厅'],
    ['stamps', '表情'],
    ['artbookJp', '设定集·日'],
    ['artbookTw', '设定集·繁中'],
    ['tv', 'TV动画'],
    ['derivative', '官方衍生'],
    ['videos', '视频']
  ];

  const mediaBlob = {};     // url -> blob: 地址
  const mediaPending = {};  // url -> Promise（并发请求合并）
  const mediaLoading = {};  // url -> 1
  const mediaDead = {};     // url -> 1（加载失败，别一直重试）

  function mediaItems(s) {
    const m = s.media || {};
    if (!m.intro && s.officialImages) m.intro = s.officialImages;
    if (!m.stamps && s.expressions) m.stamps = s.expressions;
    return {
      portraits: (s.portraits || []).map(function (p) { return { url: p.url, label: p.name, local: true }; }),
      intro: (m.intro || []).map(function (u) { return { url: u, label: '官方介绍' }; }),
      lobby: (m.lobby || []).map(function (u) { return { url: u, label: '回忆大厅' }; }),
      stamps: (m.stamps || []).map(function (u) { return { url: u, label: '表情' }; }),
      artbookJp: (m.artbookJp || []).map(function (u) { return { url: u, label: '设定集' }; }),
      artbookTw: (m.artbookTw || []).map(function (u) { return { url: u, label: '设定集' }; }),
      tv: (m.tv || []).map(function (u) { return { url: u, label: 'TV动画' }; }),
      derivative: (m.derivative || []).map(function (u) { return { url: u, label: '官方衍生' }; }),
      videos: (m.videos || []).map(function (v) { return { url: v.url, label: v.label, video: true }; })
    };
  }

  // 远程素材要经过原生桥取（CDN 校验 Referer），转成 blob 再给 <img> / <video>
  function mediaBlobUrl(url) {
    if (mediaBlob[url]) return Promise.resolve(mediaBlob[url]);
    if (mediaDead[url]) return Promise.reject(new Error('failed'));
    if (mediaPending[url]) return mediaPending[url];
    if (!window.BAFetch || !window.BAFetch.available()) {
      return Promise.reject(new Error('需在 App 内联网加载'));
    }

    const store = window.BASync && window.BASync.cache;
    const job = (store && store.available() ? store.get(url) : Promise.resolve(''))
      .then(function (cached) {
        if (cached) return cached;
        // 没缓存就联网拉，拉到顺手存盘（下次秒开、可离线）
        return window.BAFetch.b64(url, { Referer: 'https://www.gamekee.com/' }).then(function (b64) {
          // 超过约 9MB 的文件不缓存，避免把手机塞满
          if (store && store.available() && b64 && b64.length < 12 * 1024 * 1024) {
            store.set(url, b64);
          }
          return b64;
        });
      })
      .then(function (b64) {
        const bin = atob(b64 || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const mime = /\.mp4$/i.test(url) ? 'video/mp4'
          : /\.webp$/i.test(url) ? 'image/webp'
          : /\.jpe?g$/i.test(url) ? 'image/jpeg' : 'image/png';
        const blob = URL.createObjectURL(new Blob([bytes], { type: mime }));
        mediaBlob[url] = blob;
        return blob;
      });

    mediaPending[url] = job.then(function (v) {
      delete mediaPending[url];
      return v;
    }, function (e) {
      delete mediaPending[url];
      mediaDead[url] = 1;
      throw e;
    });
    return mediaPending[url];
  }

  // 渲染完再按需拉图：只加载滚动到视野内的，避免一进页面就下几 MB
  let mediaIO = null;
  const mediaQueue = [];
  let mediaActive = 0;

  function pumpMedia() {
    while (mediaActive < 4 && mediaQueue.length) {
      const img = mediaQueue.shift();
      const url = img.dataset.murl;
      if (!url || img.src) continue;
      mediaActive++;
      mediaBlobUrl(url).then(function (blob) {
        img.src = blob;
        img.removeAttribute('data-murl');
        const ph = img.parentNode.querySelector('.mph');
        if (ph) ph.remove();
      }).catch(function () {
        img.removeAttribute('data-murl');
        const ph = img.parentNode.querySelector('.mph');
        if (ph) ph.textContent = '加载失败';
      }).then(function () {
        mediaActive--;
        pumpMedia();
      });
    }
  }

  function loadMediaImages() {
    if (mediaIO) { mediaIO.disconnect(); mediaIO = null; }
    mediaQueue.length = 0;
    const nodes = Array.prototype.slice.call(detailEl.querySelectorAll('img[data-murl]'));
    if (!nodes.length) return;
    if (typeof IntersectionObserver === 'undefined') {
      nodes.forEach(function (n) { mediaQueue.push(n); });
      pumpMedia();
      return;
    }
    // .detail 本身是滚动容器，root 必须指向它，否则会一次性加载全部
    mediaIO = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        mediaIO.unobserve(en.target);
        mediaQueue.push(en.target);
        pumpMedia();
      });
    }, { root: detailEl, rootMargin: '250px 0px' });
    nodes.forEach(function (n) { mediaIO.observe(n); });
  }

  let viewerToken = 0;

  function openMediaViewer(url, isVideo) {
    closeMediaViewer();
    const token = ++viewerToken;
    const root = document.createElement('div');
    root.className = 'mv-root';
    root.id = 'media-viewer';
    root.innerHTML = '<div class="mv-backdrop" data-act="mclose"></div>' +
      '<button class="mv-close" data-act="mclose" aria-label="关闭">✕</button>' +
      '<div class="mv-body">' +
        (isVideo
          ? '<video id="mv-video" controls playsinline autoplay></video>'
          : '<img id="mv-img" alt="">') +
        '<div class="mv-hint">点击空白处关闭</div>' +
      '</div>';
    document.body.appendChild(root);
    requestAnimationFrame(function () { root.classList.add('open'); });
    const el = root.querySelector(isVideo ? '#mv-video' : '#mv-img');
    const ph = document.createElement('div');
    ph.className = 'mv-loading';
    ph.textContent = isVideo ? '视频下载中…' : '加载中…';
    root.querySelector('.mv-body').appendChild(ph);
    mediaBlobUrl(url).then(function (blob) {
      // 用户已经关掉浮层了：不要挂到已移除的元素上，更不能自动播放
      if (token !== viewerToken || !root.parentNode) return;
      ph.remove();
      el.src = blob;
      if (isVideo) { const p = el.play(); if (p && p.catch) p.catch(function () {}); }
    }).catch(function (e) {
      if (token !== viewerToken) return;
      ph.textContent = '加载失败：' + ((e && e.message) || '网络错误');
    });
  }

  function closeMediaViewer() {
    viewerToken++;
    const root = document.getElementById('media-viewer');
    if (!root) return;
    const v = root.querySelector('video');
    if (v) { try { v.pause(); } catch (e) { /* ignore */ } }
    root.classList.remove('open');
    setTimeout(function () { if (root.parentNode) root.parentNode.removeChild(root); }, 220);
  }

  function mediaTab(s) {
    const items = mediaItems(s);
    const cats = MEDIA_CATS.filter(function (c) { return (items[c[0]] || []).length; });
    if (!cats.length) return '<div class="empty">暂无鉴赏素材</div>';
    if (!state.mediaCat || !items[state.mediaCat] || !items[state.mediaCat].length) {
      state.mediaCat = cats[0][0];
    }
    const list = items[state.mediaCat] || [];

    let html = '<div style="height:14px"></div>';
    html += '<div class="voice-cat">' + cats.map(function (c) {
      return '<button class="chip ' + (c[0] === state.mediaCat ? 'on' : '') + '" data-act="mcat" data-c="' + c[0] + '">' +
        esc(c[1]) + '<span style="opacity:.6;font-weight:600">' + items[c[0]].length + '</span></button>';
    }).join('') + '</div>';

    // 大图类（官方介绍/回忆大厅/设定集/TV动画/官方衍生）单列整幅显示，表情走两列
    const single = ['intro', 'lobby', 'artbookJp', 'artbookTw', 'tv', 'derivative'].indexOf(state.mediaCat) >= 0;
    const gridCls = single ? ' single' : (state.mediaCat === 'portraits' ? '' : ' fit');
    html += '<div class="mgallery' + gridCls + '">' + list.map(function (it, i) {
      if (it.video) {
        return '<button class="mcard vid" data-act="mplay" data-url="' + esc(it.url) + '" data-label="' + esc(it.label) + '">' +
          '<span class="vplaymask">▶</span><span class="mlabel">' + esc(it.label) + '</span></button>';
      }
      if (it.local) {
        return '<figure class="mcard"><img loading="lazy" src="' + it.url + '" alt=""><figcaption>' + esc(it.label) + '</figcaption></figure>';
      }
      return '<figure class="mcard" data-act="mview" data-url="' + esc(it.url) + '">' +
        '<div class="mph"><span class="mspin"></span></div>' +
        '<img data-murl="' + esc(it.url) + '" alt="">' +
        '</figure>';
    }).join('') + '</div>';

    html += '<div class="netnote">' +
      (state.mediaCat === 'portraits'
        ? '立绘已随 App 缓存，离线可看'
        : '此类素材首次查看需联网，加载后自动缓存到本地，之后可离线查看') +
      '</div>';

    setTimeout(loadMediaImages, 0);
    return html;
  }

  /* ------------------------------------------------------------------ view */
  const view = document.getElementById('view');
  const topbar = document.getElementById('topbar');
  const tabbar = document.getElementById('tabbar');
  const detailEl = document.getElementById('detail');
  const sheetRoot = document.getElementById('sheet');

  function chrome() {
    if (state.detail) { topbar.style.display = 'none'; tabbar.style.display = 'none'; }
    else { topbar.style.display = ''; tabbar.style.display = ''; }
  }

  function renderTop() {
    const titles = { students: ['STUDENT DEX', '学生图鉴'], schools: ['ACADEMY', '学院'], favorites: ['FAVORITES', '收藏'], more: ['ABOUT', '更多'] };
    const t = titles[state.tab];
    const count = state.tab === 'students' ? (filtered().length + ' / ' + INDEX.length) : '';
    topbar.innerHTML =
      '<div class="topbar-title"><h1><small>' + t[0] + '</small>' + t[1] + '</h1>' +
      '<div class="count">' + count + '</div></div>' +
      (state.tab === 'students' ?
        '<div class="search ' + (state.query ? 'has-text' : '') + '">' + ICON.search +
        '<input id="q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" ' +
        'autocorrect="off" autocapitalize="off" spellcheck="false" ' +
        'placeholder="搜索学生 / 别名 / 学院" value="' + esc(state.query) + '">' +
        '<button class="clear" data-act="clear-q">✕</button></div>' : '');
    Array.prototype.forEach.call(tabbar.querySelectorAll('button'), function (b) {
      b.classList.toggle('on', b.dataset.tab === state.tab);
    });
  }

  function render() {
    chrome();
    if (state.detail) {
      const s = STUDENTS[state.detail];
      if (!s) { state.detail = null; return render(); }
      detailEl.innerHTML = detailHTML(s);
    } else {
      renderTop();
      let html = '';
      if (state.tab === 'students') html = listView();
      else if (state.tab === 'schools') html = schoolsView();
      else if (state.tab === 'favorites') html = favView();
      else html = moreView();
      view.innerHTML = html;
      window.scrollTo(0, 0);
    }
  }

  function rerenderBody() {
    if (state.detail) {
      const s = STUDENTS[state.detail];
      const body = detailEl.querySelector('.detail-body');
      const y = body ? body.scrollTop : 0;
      detailEl.innerHTML = detailHTML(s);
      const next = detailEl.querySelector('.detail-body');
      if (next && y) next.scrollTop = y;
    } else {
      render();
    }
  }

  /* ------------------------------------------------------------- navigation */
  function openDetail(id) {
    state.detail = id;
    state.detailTab = 'overview';
    state.voiceCat = null;
    state.skillLv = {};
    detailEl.classList.add('in');
    render();
    try { history.pushState({ detail: id }, ''); } catch (e) { /* file:// */ }
  }

  function closeDetail() {
    if (!state.detail) return;
    stopVoice();
    closeMediaViewer();
    detailEl.classList.remove('in');
    state.detail = null;
    render();
  }

  window.addEventListener('popstate', function () {
    if (state.detail) closeDetail();
  });

  /* ------------------------------------------------- 从左边缘右滑返回上一级 */
  // 和 iOS 原生返回手势一样：手指跟手拖动详情页，松手时按位移/速度判定。
  (function initEdgeSwipe() {
    const EDGE = 30;        // 手指必须落在左侧 30px 内才触发
    const RATIO = 0.3;      // 拖过屏宽 30% 就返回
    const VELOCITY = 0.45;  // px/ms，快速轻扫也能返回

    let active = false;
    let decided = false;
    let startX = 0;
    let startY = 0;
    let dx = 0;
    let startedAt = 0;

    function reset() {
      active = false;
      decided = false;
      dx = 0;
      detailEl.style.transition = '';
      detailEl.style.transform = '';
    }

    detailEl.addEventListener('touchstart', function (e) {
      if (!state.detail || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX > EDGE) return;
      active = true;
      decided = false;
      dx = 0;
      startX = t.clientX;
      startY = t.clientY;
      startedAt = Date.now();
      detailEl.style.transition = 'none';
    }, { passive: true });

    detailEl.addEventListener('touchmove', function (e) {
      if (!active || e.touches.length !== 1) return;
      const t = e.touches[0];
      dx = t.clientX - startX;
      const dy = t.clientY - startY;

      // 竖向为主 → 交给页面滚动，放弃本次手势
      if (!decided) {
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) { reset(); return; }
        if (dx > 8) decided = true;
      }
      if (dx <= 0) return;
      if (e.cancelable) e.preventDefault();
      detailEl.style.transform = 'translateX(' + dx + 'px)';
    }, { passive: false });

    function finish() {
      if (!active) return;
      const width = detailEl.clientWidth || window.innerWidth || 390;
      const velocity = dx / Math.max(1, Date.now() - startedAt);
      const back = dx > width * RATIO || (dx > 56 && velocity > VELOCITY);
      active = false;

      detailEl.style.transition = 'transform .26s cubic-bezier(.32,.72,0,1)';
      if (!back) {
        detailEl.style.transform = 'translateX(0)';
        setTimeout(reset, 280);
        return;
      }
      detailEl.style.transform = 'translateX(100%)';
      setTimeout(function () {
        // 先清掉内联样式，再走原来的关闭逻辑，避免视觉跳变
        detailEl.style.transition = '';
        detailEl.style.transform = '';
        closeDetail();
        dx = 0;
        decided = false;
      }, 240);
    }

    detailEl.addEventListener('touchend', finish);
    detailEl.addEventListener('touchcancel', finish);
  })();

  /* ----------------------------------------------------------------- events */
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;

    if (act === 'open') { openDetail(Number(btn.dataset.id)); return; }
    if (act === 'back') { closeDetail(); return; }
    if (act === 'fav') {
      const id = Number(btn.dataset.id);
      if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
      store.setItem(LS_FAV, JSON.stringify(Array.from(state.favs)));
      detailEl.innerHTML = detailHTML(STUDENTS[state.detail]);
      return;
    }
    if (act === 'tab') { state.tab = btn.dataset.tab; render(); return; }
    if (act === 'quick') {
      const k = btn.dataset.k;
      if (k === 'all') {
        // 点「全部」= 清除所有筛选维度（含稀有度），不只是稀有度
        state.filters = emptyFilters();
      } else {
        state.filters.rarity = [Number(k)];
      }
      state.query = '';
      render();
      return;
    }
    if (act === 'sort-cycle') {
      const order = ['date', 'rarity', 'name'];
      state.sort = order[(order.indexOf(state.sort) + 1) % order.length];
      store.setItem(LS_SORT, state.sort);
      render();
      return;
    }
    if (act === 'clear-q') { state.query = ''; render(); return; }
    if (act === 'school') {
      state.tab = 'students';
      state.query = '';
      state.filters = { rarity: [], school: [btn.dataset.name], attack: [], defense: [], position: [], role: [], tactic: [], weapon: [] };
      render();
      return;
    }
    if (act === 'filter-open') { openSheet(); return; }
    if (act === 'filter-close') { closeSheet(true); return; }
    if (act === 'filter-reset') { state.draft = emptyFilters(); renderSheet(); return; }
    if (act === 'facet') {
      const k = btn.dataset.k;
      let v = btn.dataset.v;
      if (k === 'rarity') v = Number(v);
      const arr = state.draft[k];
      const i = arr.indexOf(v);
      if (i < 0) arr.push(v); else arr.splice(i, 1);
      // 只更新这个按钮和底部计数，不重绘整个面板（重绘会把滚动位置重置到顶部）
      btn.classList.toggle('on', arr.indexOf(v) >= 0);
      updateSheetCount();
      return;
    }
    if (act === 'sync-now') {
      if (!window.BASync || !window.BASync.available()) { toast('联网同步需在 App 内使用'); return; }
      const st = document.getElementById('sync-status');
      if (st) st.textContent = '检查中…';
      window.BASync.check(syncOpts({ force: true })).then(function (r) {
        if (r && r.ok && (r.added || r.updated)) {
          afterSync(r);
        } else if (r && r.ok) {
          toast('已是最新，共 ' + (r.total || INDEX.length) + ' 名学生');
        } else {
          toast('检查失败：' + ((r && r.error) || '网络错误'));
        }
        if (!state.detail) render();
      });
      return;
    }
    if (act === 'cache-clear') {
      if (!window.BASync || !window.BASync.cache || !window.BASync.cache.available()) { toast('需在 App 内使用'); return; }
      window.BASync.cache.clear().then(function (ok) {
        Object.keys(mediaBlob).forEach(function (k) { delete mediaBlob[k]; });
        Object.keys(mediaDead).forEach(function (k) { delete mediaDead[k]; });
        state.cacheSizeText = '0 MB';
        const el = document.getElementById('cache-size');
        if (el) el.textContent = '0 MB';
        toast(ok ? '缓存已清理' : '清理失败');
      });
      return;
    }
    if (act === 'check-update') {
      const el = document.getElementById('update-status');
      if (el) el.textContent = '检查中…';
      checkForUpdate(true).then(function () {
        if (el) el.textContent = '›';
      });
      return;
    }
    if (act === 'modal-close') { closeUpdateDialog(); return; }
    if (act === 'modal-update') {
      const root = document.getElementById('update-modal');
      const url = root ? root.dataset.url : '';
      closeUpdateDialog();
      if (url) openExternal(url);
      return;
    }
    if (act === 'skill') {
      state.detailTab = 'skills';
      state.voiceCat = null;
      rerenderBody();
      const target = detailEl.querySelector('[data-skill="' + btn.dataset.i + '"]');
      if (target) target.scrollIntoView({ block: 'start' });
      return;
    }
    if (act === 'dt') { stopVoice(); closeMediaViewer(); state.detailTab = btn.dataset.t; state.voiceCat = null; rerenderBody(); detailEl.scrollTop = 0; return; }
    if (act === 'lv') { state.skillLv[btn.dataset.i] = Number(btn.dataset.lv); rerenderBody(); return; }
    if (act === 'vcat') { stopVoice(); state.voiceCat = btn.dataset.c; rerenderBody(); return; }
    if (act === 'vtrans') { state.voiceTrans = btn.dataset.m; rerenderBody(); return; }
    if (act === 'vplay') { playVoice(btn); return; }
    if (act === 'mcat') { state.mediaCat = btn.dataset.c; rerenderBody(); return; }
    if (act === 'mview') { openMediaViewer(btn.dataset.url, false); return; }
    if (act === 'mplay') { openMediaViewer(btn.dataset.url, true); return; }
    if (act === 'mclose') { closeMediaViewer(); return; }
  });

  // --------------------------------------------------------------- search
  // IMPORTANT: never re-create the <input> while typing — on iOS that kills
  // the keyboard / IME composition. Only the result list and the counters are
  // refreshed, the input node itself is left untouched.
  let composing = false;

  function applySearch() {
    const box = topbar.querySelector('.search');
    if (box) box.classList.toggle('has-text', !!state.query);
    const cnt = topbar.querySelector('.count');
    if (cnt) cnt.textContent = filtered().length + ' / ' + INDEX.length;
    view.innerHTML = listView();
  }

  function scheduleSearch(delay) {
    clearTimeout(window.__qt);
    window.__qt = setTimeout(applySearch, delay == null ? 140 : delay);
  }

  document.addEventListener('input', function (e) {
    if (e.target.id !== 'q') return;
    state.query = e.target.value;
    if (composing) return; // wait for compositionend (Chinese / Japanese IME)
    scheduleSearch(140);
  });

  document.addEventListener('compositionstart', function (e) {
    if (e.target.id === 'q') composing = true;
  });

  document.addEventListener('compositionend', function (e) {
    if (e.target.id !== 'q') return;
    composing = false;
    state.query = e.target.value;
    scheduleSearch(40);
  });

  // native "clear" button of <input type="search">
  document.addEventListener('search', function (e) {
    if (e.target.id !== 'q') return;
    state.query = e.target.value;
    scheduleSearch(0);
  });

  /* ------------------------------------------------------------------ sheet */
  function emptyFilters() {
    return { rarity: [], school: [], attack: [], defense: [], position: [], role: [], tactic: [], weapon: [] };
  }

  // 打开筛选面板时锁住页面滚动，避免手指滑动「穿透」到背后的图鉴列表
  let scrollLockY = 0;

  function lockPageScroll() {
    if (document.body.dataset.locked === '1') return;
    scrollLockY = window.scrollY || window.pageYOffset || 0;
    document.body.dataset.locked = '1';
    document.body.style.position = 'fixed';
    document.body.style.top = (-scrollLockY) + 'px';
    document.body.style.left = '0';
    document.body.style.right = '0';
    document.body.style.width = '100%';
    document.body.style.overflow = 'hidden';
  }

  function unlockPageScroll() {
    if (document.body.dataset.locked !== '1') return;
    document.body.dataset.locked = '';
    document.body.style.position = '';
    document.body.style.top = '';
    document.body.style.left = '';
    document.body.style.right = '';
    document.body.style.width = '';
    document.body.style.overflow = '';
    window.scrollTo(0, scrollLockY);
  }

  function openSheet() {
    state.draft = JSON.parse(JSON.stringify(state.filters));
    sheetRoot.hidden = false;
    lockPageScroll();
    requestAnimationFrame(function () { sheetRoot.classList.add('open'); });
    renderSheet();
  }

  function closeSheet(apply) {
    const before = JSON.stringify(state.filters);
    if (apply && state.draft) state.filters = state.draft;
    const changed = JSON.stringify(state.filters) !== before;
    const keepY = scrollLockY;
    state.draft = null;
    sheetRoot.classList.remove('open');
    setTimeout(function () { sheetRoot.hidden = true; }, 280);
    unlockPageScroll();
    render();
    // 没有实际改动筛选条件时，保持在原来的列表位置（只在真改了筛选后才回到顶部）
    if (!changed) window.scrollTo(0, keepY);
  }

  function countWith(f) {
    const saved = state.filters;
    state.filters = f;
    let n = 0;
    INDEX.forEach(function (s) { if (matches(s)) n++; });
    state.filters = saved;
    return n;
  }

  function renderSheet() {
    const d = state.draft || emptyFilters();
    let html = '';
    Object.keys(FACETS).forEach(function (k) {
      const f = FACETS[k];
      if (!f.values.length) return;
      html += '<div class="fgroup"><div class="fl">' + f.label + '</div><div class="fchips">' +
        f.values.map(function (v) {
          const on = d[k].indexOf(v) >= 0;
          const label = f.fmt ? f.fmt(v) : v;
          return '<button class="fchip ' + (on ? 'on' : '') + '" data-act="facet" data-k="' + k + '" data-v="' + esc(v) + '">' + esc(label) + '</button>';
        }).join('') + '</div></div>';
    });
    sheetRoot.innerHTML =
      '<div class="sheet-backdrop" data-act="filter-close"></div>' +
      '<div class="sheet">' +
        '<div class="sheet-head"><h3>筛选</h3><button class="done" data-act="filter-close">完成</button></div>' +
        '<div class="sheet-body">' + html + '</div>' +
        '<div class="sheet-foot"><button class="btn ghost" data-act="filter-reset">重置</button>' +
        '<button class="btn primary" data-act="filter-close">查看 ' + countWith(d) + ' 名学生</button></div>' +
      '</div>';
  }

  // 只刷新筛选面板底部的「查看 N 名学生」，不重绘整个面板
  function updateSheetCount() {
    const btn = sheetRoot.querySelector('.sheet-foot .btn.primary');
    if (!btn) return;
    btn.textContent = '查看 ' + countWith(state.draft || emptyFilters()) + ' 名学生';
  }

  /* ------------------------------------------------------- 版本更新检查 */
  // Release 里的更新日志是 markdown，这里只做轻量清洗：去标题符号/加粗，链接留文字
  function formatReleaseNotes(text) {
    if (!text) return '（该版本没有填写更新说明）';
    let out = esc(text);
    out = out.replace(/^#{1,6}\s*/gm, '');
    out = out.replace(/\*\*(.+?)\*\*/g, '$1');
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
    out = out.replace(/^\s*[-*]\s+/gm, '· ');
    out = out.replace(/^\s*-{3,}\s*$/gm, '');   // 去掉分隔线
    out = out.replace(/\n{3,}/g, '\n\n');
    return out.trim();
  }

  function closeUpdateDialog() {
    const root = document.getElementById('update-modal');
    if (!root) return;
    root.classList.remove('open');
    setTimeout(function () { if (root.parentNode) root.parentNode.removeChild(root); }, 240);
  }

  function openExternal(url) {
    try {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      try { window.open(url, '_blank'); } catch (e2) { /* ignore */ }
    }
  }

  function showUpdateDialog(info) {
    closeUpdateDialog();
    const root = document.createElement('div');
    root.className = 'modal-root';
    root.id = 'update-modal';
    root.dataset.url = info.url || '';
    root.innerHTML =
      '<div class="modal-backdrop" data-act="modal-close"></div>' +
      '<div class="modal" role="dialog" aria-modal="true">' +
        '<div class="modal-head">' +
          '<h3>发现新版本 ' + esc(info.latest) + '</h3>' +
          '<div class="modal-sub">当前 ' + esc(APP_VERSION) + ' → 最新 ' + esc(info.latest) + '</div>' +
        '</div>' +
        '<div class="modal-body">' + formatReleaseNotes(info.notes) + '</div>' +
        '<div class="modal-actions">' +
          '<button class="btn ghost" data-act="modal-close">暂不更新</button>' +
          '<button class="btn primary" data-act="modal-update">立即更新</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    requestAnimationFrame(function () { root.classList.add('open'); });
  }

  // manual=true 时会给用户反馈（已是最新 / 检查失败）
  function checkForUpdate(manual) {
    if (!window.BAUpdate) {
      if (manual) toast('当前版本不支持检查更新');
      return Promise.resolve(null);
    }
    return window.BAUpdate.check(APP_VERSION).then(function (r) {
      if (!r || !r.ok) {
        if (manual) toast('检查更新失败：' + ((r && r.error) || '网络错误'));
        return r;
      }
      if (!r.hasUpdate) {
        if (manual) toast('已是最新版本 ' + APP_VERSION);
        return r;
      }
      showUpdateDialog(r);
      return r;
    });
  }

  /* ------------------------------------------------------------------- boot */

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, 2600);
  }

  // 把联网同步到的学生合并进内存数据（新增 + 资料变更）
  function mergeOverlay(ov) {
    if (!ov) return { added: 0, updated: 0 };
    let added = 0;
    let updated = 0;
    (ov.index || []).forEach(function (summary) {
      if (!summary || !summary.id) return;
      const full = (ov.students || {})[summary.id];

      if (BY_ID[summary.id]) {
        // 已存在：这是「资料有改动」的学生，更新摘要与详情
        if (full && full.isUpdated) {
          Object.assign(BY_ID[summary.id], summary);
          const old = STUDENTS[summary.id];
          const merged = Object.assign({}, old, full);
          if (old) {
            // 同步版不含立绘/头像，别把内置的覆盖掉
            if (!full.portraits || !full.portraits.length) merged.portraits = old.portraits;
            if (!full.avatar && old.avatar) merged.avatar = old.avatar;
            // 站位/战术作用在 App 内没有图标映射表，解析出来是空的，
            // 这时沿用内置的文字值，避免退化成图片标签
            if (!full.position && old.position) merged.position = old.position;
            if (!full.tactic && old.tactic) merged.tactic = old.tactic;
          }
          STUDENTS[summary.id] = merged;
          BY_ID[summary.id].isUpdated = full.isUpdated;
          BY_ID[summary.id].updatedSyncedAt = full.updatedSyncedAt;
          updated++;
        }
        return;
      }

      if (full) { summary.isNew = full.isNew; summary.syncedAt = full.syncedAt; }
      INDEX.push(summary);
      BY_ID[summary.id] = summary;
      if (!STUDENTS[summary.id] && full) STUDENTS[summary.id] = full;
      added++;
    });
    if (added) buildFacets();
    return { added: added, updated: updated };
  }

  function knownIds() {
    return INDEX.map(function (s) { return s.id; });
  }

  // id → 内容更新时间，供同步模块判断「是否被改过」
  function knownUpdated() {
    const map = {};
    INDEX.forEach(function (s) {
      const full = STUDENTS[s.id];
      if (full && full.updatedAt) map[s.id] = full.updatedAt;
    });
    return map;
  }

  function syncOpts(extra) {
    return Object.assign({ known: knownIds(), updated: knownUpdated() }, extra || {});
  }

  function afterSync(result) {
    if (!result || !result.ok) return;
    if (!result.added && !result.updated) return;
    window.BASync.load().then(function (ov) {
      mergeOverlay(ov);
      if (state.detail) rerenderBody(); else render();
      const parts = [];
      if (result.added) parts.push('新增 ' + result.added + ' 名学生');
      if (result.updated) parts.push('更新 ' + result.updated + ' 名学生的资料');
      let msg = '已' + parts.join('，');
      if (result.remaining > 0) msg += '（还有 ' + result.remaining + ' 名，下次启动继续）';
      toast(msg);
    });
  }

  function bindSyncEvents() {
    if (!window.BASync || !window.BASync.onEvent) return;
    window.BASync.onEvent(function (type) {
      if (type === 'waiting-network') {
        const el = document.getElementById('sync-status');
        if (el) el.textContent = '等待网络…';
        if (!state.netToast) {
          state.netToast = 1;
          toast('等待网络连接…在系统弹窗点「允许」后会自动继续');
        }
      } else if (type === 'network-ok') {
        state.netToast = 0;
        const el = document.getElementById('sync-status');
        if (el) el.textContent = '同步中…';
      }
    });
  }

  function startApp() {
    bindSyncEvents();
    render();
    const boot = document.getElementById('boot');
    if (boot) boot.remove();
    if (window.BASync && window.BASync.available()) {
      // 等首屏渲染完再联网，避免拖慢启动
      setTimeout(function () { window.BASync.check(syncOpts()).then(afterSync); }, 1200);
    }
    // 版本检查：每次启动跑一次，失败静默
    setTimeout(function () { checkForUpdate(false); }, 2600);
  }

  tabbar.innerHTML = [
    ['students', '学生', ICON.students],
    ['schools', '学院', ICON.school],
    ['favorites', '收藏', ICON.heart],
    ['more', '更多', ICON.more],
  ].map(function (t) {
    return '<button data-act="tab" data-tab="' + t[0] + '">' + t[2] + '<span>' + t[1] + '</span></button>';
  }).join('');

  window.addEventListener('scroll', function () {
    if (window.scrollY > 4) topbar.classList.add('scrolled'); else topbar.classList.remove('scrolled');
  }, { passive: true });

  if (window.BASync && window.BASync.available()) {
    window.BASync.load()
      .then(function (ov) { mergeOverlay(ov); startApp(); })
      .catch(startApp);
  } else {
    startApp();
  }
})();

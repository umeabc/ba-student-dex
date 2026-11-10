/*
 * parser-core.js — 解析 GameKee 蔚蓝档案 WIKI 的「学生表格模板」。
 *
 * 同一份代码同时被两处使用，保证「App 内置数据」和「App 内联网同步的数据」
 * 结构完全一致：
 *   - Node: crawl/parse.js  ->  require('./parser-core.js')
 *   - Web : <script src="parser-core.js">  ->  window.BAParse
 *
 * 每个学生固定 570 行 × 8 列，行标签由单元格的 isGlobal 标记给出，
 * 位置（行号）在同一模板下是稳定的。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BAParse = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 站位 / 战术作用 的图标在 WIKI 里是「文字图片」，按图片内容的 sha256 前 16 位聚类
  var ICON_LABEL = {
    'a7988774d4b347e1': 'STRIKER', '6f4366f6bca47e12': 'STRIKER', '1557215891c1e697': 'STRIKER',
    'fdaca2580c8db24d': 'BACK', '554848c8951ae562': 'BACK', '321ddff3ff84406b': 'BACK',
    'cbee79f02729d862': 'MIDDLE', '6225eff195ee53bc': 'MIDDLE', 'ca2c05340874014e': 'MIDDLE',
    '47a8320bf18d46d4': 'MIDDLE', 'b67d9e3aaeb22b6e': 'MIDDLE', '2b947b5dd57d0f50': 'MIDDLE',
    '719b1007be0bbf65': 'MIDDLE',
    '57a98b3d8e512096': 'FRONT', 'ab9bf5d4e7edacf5': 'FRONT', 'c45b6046f28d5155': 'FRONT',
    '71a3369b0edc6ef9': 'FRONT', '3c33b1bd73f06601': 'FRONT',
    '204715b69264f888': 'SPECIAL', 'a5dc4e0c3773632b': 'SPECIAL', '72200c5083b3a117': 'SPECIAL',
    'e99f72a5e100eadb': 'SPECIAL', 'ee89c2f2c90a2017': 'SPECIAL', 'c86b383e5a832fc2': 'SPECIAL'
  };

  // 由 build 阶段写入 data/build/icon_groups.json 的 url -> hash 映射。
  // App 内同步时拿不到这个映射，新图标会退化成「显示原图」，见 positionImage。
  var URL_HASH = null;
  function setIconMap(map) { URL_HASH = map || null; }

  var clean = function (s) {
    return String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  };

  var SCHOOL_ALIAS = {
    '三一综合学院': '三一综合学园',
    '百鬼夜行综合学院': '百鬼夜行联合学院',
    '阿拜多斯高等学校': '阿拜多斯高中',
    '崔尼蒂综合学园': '三一综合学园'
  };
  var ROLE_ALIAS = { 'T.S': '支援', 'TS': '支援' };
  var normSchool = function (v) { return SCHOOL_ALIAS[v] || v; };
  var normRole = function (v) { return ROLE_ALIAS[v] || v; };
  var url = function (u) { return !u ? '' : (u.charAt(0) === '/' && u.charAt(1) === '/' ? 'https:' + u : u); };

  function helpers(rows) {
    var label = function (row) {
      if (!row || !row.length) return '';
      var g = null;
      for (var i = 0; i < row.length; i++) { if (row[i].g) { g = row[i]; break; } }
      return clean((g || row[0]).v);
    };
    var col = function (row, i) {
      if (!row) return '';
      for (var k = 0; k < row.length; k++) { if (row[k].c === i) return clean(row[k].v); }
      return '';
    };
    return { label: label, col: col };
  }

  function imgOf(row) {
    if (!row) return '';
    for (var i = 0; i < row.length; i++) { if (row[i].t === 'i') return url(row[i].v); }
    return '';
  }

  // 取某列的音频地址（WIKI 的语音单元格 type = 'audio'）
  function audioOf(row, i) {
    if (!row) return '';
    for (var k = 0; k < row.length; k++) {
      if (row[k].c === i && row[k].t === 'audio') return url(row[k].v);
    }
    return '';
  }

  // 语音表所在行范围与分类（同一套模板里位置固定）
  var VOICE_CATS = { '通常': 1, '大厅及咖啡馆': 1, '好感度': 1, '战斗': 1, '成长': 1, '事件': 1, '活动': 1 };

  // 从行数据里抽取「分类|标题 -> [日配, 中配, 韩配]」的音频表
  function extractVoiceAudio(rows) {
    var out = {};
    var h = helpers(rows);
    for (var i = 295; i <= 447; i++) {
      var cat = h.col(rows[i], 0);
      var lb = h.col(rows[i], 1);
      if (!cat || !lb || !VOICE_CATS[cat]) continue;
      var jp = audioOf(rows[i], 4);
      var cn = audioOf(rows[i], 6);
      var kr = audioOf(rows[i], 7);
      if (jp || cn || kr) out[cat + '|' + lb] = [jp, cn, kr];
    }
    return out;
  }

  function hashOfUrl(u) {
    if (!URL_HASH || !u) return '';
    var h = URL_HASH[u];
    return h ? (ICON_LABEL[h] || '') : '';
  }

  function kvPairs(row, startCol) {
    var out = [];
    if (!row) return out;
    var cells = row.filter(function (c) { return c.t === 't' && c.c >= (startCol || 0); });
    for (var i = 0; i + 1 < cells.length; i += 2) {
      var k = clean(cells[i].v);
      var v = clean(cells[i + 1].v);
      if (k) out.push({ name: k, value: v });
    }
    return out;
  }

  function parseSkillBlock(rows, i) {
    var h = helpers(rows);
    var skill = { kindLabel: '', name: '', icon: '', levels: [] };
    var j = i;
    while (j < rows.length) {
      var l = h.label(rows[j]);
      if (j > i && l === '技能类型') break;
      if (l === '技能类型') skill.kindLabel = h.col(rows[j], 1);
      else if (l === '技能名称') skill.name = h.col(rows[j], 1);
      else if (l === '技能图标') skill.icon = imgOf(rows[j]);
      else if (l === '技能描述') { /* 描述文字在等级行里 */ }
      else if (/^LV\d+$/.test(l)) {
        var entry = { lv: Number(l.replace('LV', '')), text: h.col(rows[j], 1) };
        var next = rows[j + 1];
        if (next && h.label(next) === '技能COST') { entry.cost = h.col(next, 1); j++; }
        skill.levels.push(entry);
      } else break;
      j++;
    }
    return { skill: skill, next: j };
  }

  function parseMaterials(rows, start) {
    var h = helpers(rows);
    var out = [];
    var i = start;
    while (i < rows.length && h.label(rows[i]) !== '其他技能升级材料' && h.label(rows[i]) !== '技能名词') {
      var l = h.label(rows[i]);
      if (/^LV\d+$/.test(l)) {
        var imgs = (rows[i] || []).filter(function (c) { return c.t === 'i'; });
        var nums = rows[i + 1] || [];
        var items = [];
        for (var k = 0; k < imgs.length; k++) {
          var im = imgs[k];
          var n = '';
          for (var m = 0; m < nums.length; m++) { if (nums[m].c === im.c) { n = clean(nums[m].v); break; } }
          items.push({ icon: url(im.v), count: n });
        }
        out.push({ lv: Number(l.replace('LV', '')), items: items });
        i += 2;
        continue;
      }
      if (l === '所需个数' || l === '') { i++; continue; }
      break;
    }
    return { out: out, next: i };
  }

  function parseStudent(raw) {
    var rows = raw.rows;
    var h = helpers(rows);
    var label = h.label;
    var col = h.col;
    var s = {};

    s.id = raw.entryId;
    s.contentId = raw.contentId;
    s.name = col(rows[0], 1) || raw.title;
    s.avatarRemote = url(raw.icon);
    s.aliases = clean(raw.nameAlias).split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    s.summary = clean(raw.summary);
    s.updatedAt = raw.updatedAt;

    var rarityRaw = col(rows[2], 1);
    s.rarity = Number((rarityRaw.match(/\d/) || [3])[0]);
    // 图标映射表的 key 是原始 URL（可能以 // 开头），所以先用原值查表再补协议
    var tacticRawUrl = col(rows[3], 2);
    s.tacticImage = url(tacticRawUrl);
    s.tactic = hashOfUrl(tacticRawUrl) || '';
    s.school = normSchool(col(rows[4], 1));
    s.schoolIcon = imgOf(rows[4]);
    s.club = col(rows[5], 1);
    s.releaseDate = col(rows[6], 1);
    s.role = normRole(col(rows[7], 1));
    s.roleIcon = imgOf(rows[7]);
    s.attack = col(rows[8], 1);
    s.attackIcon = imgOf(rows[8]);
    s.defense = col(rows[9], 1);
    s.defenseIcon = imgOf(rows[9]);
    var positionRawUrl = col(rows[10], 2);
    s.positionImage = url(positionRawUrl);
    s.position = hashOfUrl(positionRawUrl) || '';
    s.terrain = { urban: col(rows[11], 1), outdoor: col(rows[12], 1), indoor: col(rows[13], 1) };
    s.weaponType = col(rows[14], 1);
    s.weaponIcon = imgOf(rows[14]);
    s.equipment = [col(rows[15], 1), col(rows[16], 1), col(rows[17], 1)].filter(Boolean);

    s.portraits = [];
    for (var p = 19; p <= 24; p++) {
      var img = imgOf(rows[p]);
      if (!img) continue;
      s.portraits.push({ name: col(rows[p], 1) || '立绘' + (p - 18), url: img });
    }
    s.hall = { image: imgOf(rows[26]) };
    s.bgm = url(col(rows[30], 1));

    s.skills = [];
    var i = 33;
    while (i < rows.length) {
      var l = label(rows[i]);
      if (l === '技能名词') break;
      if (l === '技能类型') {
        var r = parseSkillBlock(rows, i);
        var hasContent = r.skill.name || r.skill.icon || r.skill.levels.some(function (x) { return x.text; });
        if (hasContent) s.skills.push(r.skill);
        i = r.next;
        continue;
      }
      i++;
    }

    var exIdx = -1, otherIdx = -1, termIdx = -1;
    for (var k0 = 31; k0 < rows.length; k0++) {
      var l0 = label(rows[k0]);
      if (l0 === 'EX技能升级材料' && exIdx < 0) exIdx = k0;
      else if (l0 === '其他技能升级材料' && otherIdx < 0) otherIdx = k0;
      else if (l0 === '技能名词' && termIdx < 0) termIdx = k0;
    }
    if (exIdx > 0) s.exMats = parseMaterials(rows, exIdx + 1).out;
    if (otherIdx > 0) s.skillMats = parseMaterials(rows, otherIdx + 1).out;

    s.terms = [];
    if (termIdx > 0) {
      for (var k = termIdx + 1; k < termIdx + 12; k++) {
        var lt = label(rows[k]);
        if (!lt || lt === '专武') break;
        s.terms.push({ name: lt, icon: imgOf(rows[k]) });
      }
    }

    // 专武
    s.uniqueWeapon = {
      icon: imgOf(rows[195]),
      name: col(rows[196], 1),
      desc: col(rows[197], 1),
      table: { cols: [], rows: [] },
      skill: { name: col(rows[202], 1), icon: imgOf(rows[203]), description: col(rows[204], 1), levels: [] },
      star3: col(rows[215], 1),
      star3Icon: imgOf(rows[215]),
      star4: col(rows[216], 1)
    };
    for (var q = 198; q <= 201; q++) {
      var lq = label(rows[q]);
      var vals = [];
      for (var c = 1; c <= 5; c++) vals.push(col(rows[q], c));
      if (q === 198) s.uniqueWeapon.table.cols = vals.filter(Boolean);
      else if (lq && vals.some(Boolean)) s.uniqueWeapon.table.rows.push({ label: lq, values: vals });
    }
    for (var q2 = 205; q2 <= 214; q2++) {
      var t2 = col(rows[q2], 1);
      if (t2) s.uniqueWeapon.skill.levels.push({ lv: Number(label(rows[q2]).replace('LV', '')), text: t2 });
    }

    // 爱用品
    s.favoriteItem = {
      icon: imgOf(rows[219]),
      name: col(rows[220], 1),
      desc: col(rows[221], 1),
      t1: col(rows[222], 1),
      t2mats: (rows[223] || []).filter(function (c) { return c.t === 'i'; }).map(function (c) { return url(c.v); }),
      t2skill: { name: col(rows[224], 1), icon: imgOf(rows[225]), levels: [] }
    };
    for (var q3 = 227; q3 <= 236; q3++) {
      var t3 = col(rows[q3], 1);
      if (t3) s.favoriteItem.t2skill.levels.push({ lv: Number(label(rows[q3]).replace('LV', '')), text: t3 });
    }

    // 学生信息
    s.profile = {
      fullName: col(rows[240], 1),
      kana: (col(rows[241], 1) + ' ' + col(rows[241], 2)).trim(),
      twName: col(rows[243], 1),
      cnName: col(rows[244], 1),
      age: col(rows[245], 1),
      birthday: col(rows[246], 1),
      height: col(rows[247], 1),
      hobby: col(rows[248], 1),
      designer: col(rows[249], 1),
      artist: col(rows[250], 1),
      cv: col(rows[251], 1),
      hallLevel: col(rows[252], 1),
      momoTalkLevel: col(rows[253], 1),
      momoTalkStatus: col(rows[254], 1),
      bio: col(rows[255], 1),
      sourceUrl: col(rows[256], 1)
    };

    // 礼物偏好：三行，每行第 1 列是「喜欢程度」图标，后面才是具体礼物
    s.giftTiers = [];
    s.gifts = [];
    [260, 263, 266].forEach(function (idx) {
      var imgs = (rows[idx] || []).filter(function (c) { return c.t === 'i'; });
      if (!imgs.length) return;
      var tier = {
        level: url(imgs[0].v),
        items: imgs.slice(1).map(function (c) { return url(c.v); })
      };
      s.giftTiers.push(tier);
      tier.items.forEach(function (u) { s.gifts.push(u); });
    });

    s.chocolate = { icon: imgOf(rows[273]), name: col(rows[274], 1), desc: col(rows[275], 1) };

    // 能力解放：279~281 行常被 WIKI 编辑者填占位文字（如「这个不用写」），
    // 真正的 25 级数值在 537 行，UI 优先用 abilityDetail。
    s.ability = {
      attrs: [kvPairs(rows[279], 1)[0], kvPairs(rows[280], 1)[0], kvPairs(rows[281], 1)[0]]
        .filter(function (a) { return a && a.value && !/不用写/.test(a.value); }),
      mats: (rows[282] || []).filter(function (c) { return c.t === 'i'; }).map(function (c) { return url(c.v); })
    };

    s.sameName = [];
    for (var q4 = 285; q4 <= 290; q4++) {
      var nm = col(rows[q4], 1);
      if (!nm) continue;
      var link = '';
      (rows[q4] || []).forEach(function (x) { if (x.t === 't' && /https?:\/\//.test(x.v)) link = x.v; });
      s.sameName.push({ name: nm, icon: imgOf(rows[q4]), url: link });
    }

    // 语音：日文原文 + 官翻(第 5 列) / 民翻(第 3 列)，另存三语试听地址
    var voices = {};
    var voiceAudio = {};
    for (var q5 = 295; q5 <= 447; q5++) {
      var cat = col(rows[q5], 0);
      var lb = col(rows[q5], 1);
      if (!cat || !lb || !VOICE_CATS[cat]) continue;
      var jp = col(rows[q5], 2);
      var fan = col(rows[q5], 3);   // 民间翻译
      var off = col(rows[q5], 5);   // 官方翻译，没有官方时为空
      var aJp = audioOf(rows[q5], 4);
      var aCn = audioOf(rows[q5], 6);
      var aKr = audioOf(rows[q5], 7);
      if (!jp && !fan && !off && !aJp && !aCn && !aKr) continue;
      (voices[cat] = voices[cat] || []).push({ label: lb, jp: jp, fan: fan, off: off });
      if (aJp || aCn || aKr) voiceAudio[cat + '|' + lb] = [aJp, aCn, aKr];
    }
    s.voices = voices;
    s.voiceAudio = voiceAudio;

    // 声优（日 / 中 / 韩），形如「日 | 藤井ゆきよ\n中 | 陈婷婷\n韩 | 김이안（金怡侒）」
    s.cv = { jp: '', cn: '', kr: '' };
    String(col(rows[251], 1) || '').split(/\n/).forEach(function (line) {
      var m = line.match(/^\s*(日|中|韩)\s*[|｜]\s*(.+?)\s*$/);
      if (!m) return;
      s.cv[m[1] === '日' ? 'jp' : (m[1] === '中' ? 'cn' : 'kr')] = m[2];
    });

    // 数值
    s.stats = {
      init: kvPairs(rows[505], 0).concat(kvPairs(rows[506], 0), kvPairs(rows[507], 0), kvPairs(rows[508], 0)),
      max: kvPairs(rows[511], 0).concat(kvPairs(rows[512], 0), kvPairs(rows[513], 0), kvPairs(rows[514], 0)),
      weapon: [
        { name: '攻击力', value: col(rows[517], 1) },
        { name: '生命值', value: col(rows[518], 1) },
        { name: '治愈力', value: col(rows[519], 1) }
      ].filter(function (x) { return x.value; })
    };

    s.equipDetails = [];
    [[522, 523, '1号装备'], [525, 526, '2号装备'], [528, 529, '3号装备']].forEach(function (pair) {
      var type = col(rows[pair[1]], 0);
      if (!type) return;
      s.equipDetails.push({
        slot: pair[2],
        name: type,
        grade: col(rows[pair[1]], 1),
        attrs: kvPairs(rows[pair[1]], 2)
      });
    });
    s.giftDetail = { t1Value: kvPairs(rows[533], 1) };
    s.abilityDetail = { attrs: kvPairs(rows[537], 1) };
    s.bond = [];
    for (var q6 = 540; q6 <= 542; q6++) {
      var lb2 = label(rows[q6]);
      if (!lb2) continue;
      var bondIcon = imgOf(rows[q6]);
      var bondAttrs = kvPairs(rows[q6], 2);
      // 没有头像也没有属性的空档位直接跳过，避免详情页出现空行
      if (!bondIcon && !bondAttrs.length) continue;
      s.bond.push({ label: lb2, icon: bondIcon, attrs: bondAttrs });
    }

    // 评测
    s.review = {
      score: col(rows[552], 2),
      scoreIcon: imgOf(rows[552]),
      tiers: [],
      skills: { ex: col(rows[561], 1), ns: col(rows[562], 1), ps: col(rows[563], 1), ss: col(rows[564], 1) },
      employment: col(rows[566], 1),
      advice: col(rows[567], 1)
    };
    for (var q7 = 553; q7 <= 558; q7++) {
      var lq2 = label(rows[q7]);
      if (!lq2) continue;
      s.review.tiers.push({ name: lq2, value: col(rows[q7], 2), icon: imgOf(rows[q7]) });
    }

    // 影画鉴赏：官方介绍 / 回忆大厅 / 表情 / 设定集 / TV动画 / 官方衍生 / 视频
    function imgs(rowIdx) {
      var r = rows[rowIdx] || [];
      var out = [];
      r.forEach(function (c) {
        if (c.t === 'i') out.push(url(c.v));
        else if (c.t === 'imageset') {
          String(c.v || '').split(',').forEach(function (u) { if (u) out.push(url(u)); });
        }
      });
      return out.filter(Boolean);
    }
    function videos(rowIdx, name) {
      var r = rows[rowIdx] || [];
      var out = [];
      r.forEach(function (c) {
        if (c.t === 'video' && c.v) out.push({ label: name || '视频', url: url(c.v) });
      });
      return out;
    }

    s.media = {
      intro: imgs(450).concat(imgs(451), imgs(452), imgs(453)),   // 官方介绍
      lobby: imgs(26),                                            // 回忆大厅（静态图）
      stamps: imgs(456),                                          // 角色表情
      artbookJp: imgs(461),                                       // 设定集（日语）
      artbookTw: imgs(462),                                       // 设定集（繁中）
      tv: imgs(463),                                              // TV动画设定图
      derivative: imgs(465).concat(imgs(468), imgs(469), imgs(470), imgs(471), imgs(472),
        imgs(473), imgs(474), imgs(475), imgs(476), imgs(477), imgs(478), imgs(479),
        imgs(480), imgs(481), imgs(482), imgs(483), imgs(484), imgs(486)),  // 官方衍生 / 本家画
      videos: videos(489, '角色演示')
        .concat(videos(490, 'PV'), videos(491, 'PV'), videos(492, 'PV'), videos(493, 'PV'))
        .concat(videos(494, '回忆大厅视频'), videos(495, '回忆大厅视频'))
        .concat(videos(496, '独家记忆（中）'), videos(497, '独家记忆（日）'))
        .concat(videos(498, 'Live'), videos(499, 'Live'), videos(500, 'Live'))
    };

    // 兼容旧字段
    s.officialImages = s.media.intro.slice();
    s.expressions = s.media.stamps.slice();

    return s;
  }

  // 把 WIKI 的 baseData [[{key,type,value,isGlobal}...]] 压成 [[{c,v,t,g}...]]
  function compactRows(baseData) {
    return baseData.map(function (row) {
      var cells = [];
      for (var i = 0; i < row.length; i++) {
        var c = row[i];
        var v = c.value;
        if (v === undefined || v === null) v = '';
        v = String(v);
        if (!v.trim()) continue;
        var cell = { c: i, v: v, t: c.type === 'image' ? 'i' : (c.type === 'text' ? 't' : c.type) };
        if (c.isGlobal) cell.g = 1;
        cells.push(cell);
      }
      return cells;
    });
  }

  function summarize(s) {
    return {
      id: s.id,
      name: s.name,
      rarity: s.rarity,
      school: s.school,
      role: s.role,
      attack: s.attack,
      defense: s.defense,
      position: s.position,
      tactic: s.tactic,
      weaponType: s.weaponType,
      releaseDate: s.releaseDate,
      aliases: s.aliases,
      club: s.club
    };
  }

  return {
    parseStudent: parseStudent,
    compactRows: compactRows,
    summarize: summarize,
    setIconMap: setIconMap,
    extractVoiceAudio: extractVoiceAudio
  };
});

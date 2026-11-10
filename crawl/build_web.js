// Assemble the web app: rewrite remote image urls to bundled local files,
// emit data.js, copy avatars / icons.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'data', 'build');
const WEB = path.join(ROOT, 'web');

const imgmap = JSON.parse(fs.readFileSync(path.join(SRC, 'imgmap.json'), 'utf8'));
const portraitmapPath = path.join(SRC, 'portraitmap.json');
const portraitmap = fs.existsSync(portraitmapPath) ? JSON.parse(fs.readFileSync(portraitmapPath, 'utf8')) : {};

function local(u) {
  if (!u) return u;
  const h = imgmap[u];
  return h ? 'img/' + h + '.png' : null;
}

function localPortrait(u) {
  if (!u) return u;
  const h = portraitmap[u];
  return h ? 'portraits/' + h + '.jpg' : u;
}

function rewriteStudent(s) {
  const fix = (o, k) => { if (o && o[k]) { const l = local(o[k]); if (l) o[k] = l; } };
  (s.skills || []).forEach((k) => fix(k, 'icon'));
  (s.terms || []).forEach((t) => fix(t, 'icon'));
  fix(s.uniqueWeapon, 'icon');
  if (s.uniqueWeapon && s.uniqueWeapon.skill) fix(s.uniqueWeapon.skill, 'icon');
  fix(s.favoriteItem, 'icon');
  fix(s.chocolate, 'icon');
  const mats = (s.favoriteItem && s.favoriteItem.t2mats) || [];
  s.favoriteItem && (s.favoriteItem.t2mats = mats.map((u) => local(u) || u));
  (s.exMats || []).forEach((m) => (m.items || []).forEach((it) => { const l = local(it.icon); if (l) it.icon = l; }));
  (s.skillMats || []).forEach((m) => (m.items || []).forEach((it) => { const l = local(it.icon); if (l) it.icon = l; }));
  (s.ability.mats || []).forEach((u, i) => { const l = local(u); if (l) s.ability.mats[i] = l; });
  s.gifts = (s.gifts || []).map((u) => local(u) || u);
  (s.giftTiers || []).forEach((t) => {
    t.level = local(t.level) || t.level;
    t.items = (t.items || []).map((u) => local(u) || u);
  });
  (s.bond || []).forEach((b) => { b.icon = local(b.icon) || ''; });
  (s.portraits || []).forEach((p) => { p.url = localPortrait(p.url); });
  s.hall = s.hall || {};
  s.hall.image = '';

  // 同名角色只用来跳转，图标不打包（远程图会因 Referer 校验加载失败）
  (s.sameName || []).forEach((x) => { x.icon = ''; });

  // 语音音频地址不打包（3.7MB+），App 里点播放时按需向 WIKI 拉取
  delete s.voiceAudio;
  return s;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    const a = path.join(from, f);
    const b = path.join(to, f);
    if (fs.statSync(a).isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

function main() {
  const index = JSON.parse(fs.readFileSync(path.join(SRC, 'index.json'), 'utf8'));
  const students = {};
  const lastUpdated = {};
  for (const f of fs.readdirSync(path.join(SRC, 'students'))) {
    const s = rewriteStudent(JSON.parse(fs.readFileSync(path.join(SRC, 'students', f), 'utf8')));
    students[s.id] = s;
    const d = new Date(s.updatedAt * 1000);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    lastUpdated[key] = (lastUpdated[key] || 0) + 1;
  }

  // newest release date + newest wiki update
  const newest = index.map((s) => s.releaseDate).sort().slice(-1)[0] || '';

  fs.mkdirSync(path.join(WEB, 'avatars'), { recursive: true });
  copyDir(path.join(SRC, 'avatars'), path.join(WEB, 'avatars'));
  if (fs.existsSync(path.join(SRC, 'img'))) copyDir(path.join(SRC, 'img'), path.join(WEB, 'img'));
  if (fs.existsSync(path.join(SRC, 'portraits'))) copyDir(path.join(SRC, 'portraits'), path.join(WEB, 'portraits'));

  const payload = 'window.BA_INDEX=' + JSON.stringify(index) + ';\n' +
    'window.BA_STUDENTS=' + JSON.stringify(students) + ';\n' +
    'window.BA_UPDATED=' + JSON.stringify(newest) + ';\n';
  fs.writeFileSync(path.join(WEB, 'data.js'), payload);

  console.log('web data.js', (payload.length / 1048576).toFixed(2), 'MB, students', Object.keys(students).length);
  auditRemoteImages(students);
}

// 体检：界面会 <img> 渲染的字段不允许残留远程地址
// （CDN 要求 Referer，App 内 file:// 页面发不出来，会变成裂图）
function auditRemoteImages(students) {
  const buckets = {};
  const hit = (name, url) => {
    if (typeof url === 'string' && url.indexOf('http') === 0) {
      buckets[name] = (buckets[name] || 0) + 1;
    }
  };
  for (const id of Object.keys(students)) {
    const s = students[id];
    (s.skills || []).forEach((k) => hit('skills.icon', k.icon));
    (s.terms || []).forEach((t) => hit('terms.icon', t.icon));
    hit('uniqueWeapon.icon', s.uniqueWeapon && s.uniqueWeapon.icon);
    hit('uniqueWeapon.skill.icon', s.uniqueWeapon && s.uniqueWeapon.skill && s.uniqueWeapon.skill.icon);
    hit('favoriteItem.icon', s.favoriteItem && s.favoriteItem.icon);
    hit('chocolate.icon', s.chocolate && s.chocolate.icon);
    (s.giftTiers || []).forEach((t) => {
      hit('giftTiers.level', t.level);
      (t.items || []).forEach((u) => hit('giftTiers.items', u));
    });
    (s.bond || []).forEach((b) => hit('bond.icon', b.icon));
    (s.portraits || []).forEach((p) => hit('portraits', p.url));
    (s.exMats || []).concat(s.skillMats || []).forEach((m) => {
      (m.items || []).forEach((it) => hit('materials.icon', it.icon));
    });
    (s.ability && s.ability.mats || []).forEach((u) => hit('ability.mats', u));
  }
  const kinds = Object.keys(buckets);
  if (!kinds.length) {
    console.log('✓ 图片体检通过：所有会被渲染的图片都是本地路径');
  } else {
    console.log('⚠ 仍有远程图片（App 内会裂图）:');
    kinds.forEach((k) => console.log('   ', k, buckets[k]));
  }
}

main();

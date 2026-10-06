/* xmind.js — 心智圖：照 XMind 的操作與長相做的心智圖工具（使用者的話：「新增一個 xmind 的功能，要盡善盡美，盡量一樣」）。
 *
 * 一份心智圖是一篇 area:'xmind'、meta.xmind 的筆記，內容是一個 ```xmind 圍欄裡的 JSON（跟看板、drawio 一樣
 * 「文字就是真相」）：
 *   { sheets: [ { id, name, theme, structure, root: topic, floating: [topic{x,y}], rels: [...], bounds: [...], sums: [...] } ] }
 *   topic = { id, title, children, collapsed, notes, labels, markers, link, style: { fill, stroke, color, fs, bold, shape } }
 * 版面照 XMind：上面工具列（子主題／同階主題／關聯／外框／摘要／備註／標籤／標記／連結／結構／主題／大綱／縮放／匯出），
 * 中間畫布（滾輪捲、Ctrl+滾輪縮放、拖空白處平移），右邊格式面板，左邊可開的大綱，下面是工作表分頁。
 * 操作照 XMind：Tab 子主題、Enter 同階主題、Delete 刪、F2／雙擊／直接打字改字、空白鍵收合、方向鍵在主題間移動、
 * 拖主題到別的主題上變成它的子主題、拖到空白處變自由主題、Ctrl+Z／Y 復原重做、Ctrl+C／V 複製整枝。
 * 結構：平衡圖（左右）、邏輯圖（右／左）、組織圖（往下）、樹狀圖（右）、時間軸。主題（配色）六套。
 * 標記：優先順序 1–9、任務進度 0–8、旗幟、星星、人物、符號；備註（圖示＋提示）、標籤、超連結；關聯線、外框、摘要。
 * 版面（layout）是純函式：同一份 JSON 在編輯器、預覽、PDF、匯出都畫出一樣的圖（文字寬度用字元類別估，不量 DOM）。
 */
(function (global) {
  'use strict';

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }
  function uid(p) { return (p || 't') + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3); }
  function fmt(n) { return String(Math.round(n * 10) / 10); }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  const FONT = "'Noto Sans TC', 'Microsoft JhengHei', Helvetica, Arial, sans-serif";

  // ---------------- 文字量測（跟 mindmap.js 同一套估法，不量 DOM） ----------------
  function charW(ch) {
    const c = ch.charCodeAt(0);
    if (c >= 0x1100 && (c <= 0x115f || c === 0x2329 || c === 0x232a || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6))) return 1;
    return 0.56;
  }
  function textWidth(s, fs) { let w = 0; for (let i = 0; i < s.length; i++) w += charW(s[i]); return w * fs; }
  function wrapText(s, fs, max) {
    const out = [];
    String(s || '').split('\n').forEach(function (para) {
      if (textWidth(para, fs) <= max) { out.push(para); return; }
      let cur = '', curW = 0;
      for (let i = 0; i < para.length; i++) {
        const ch = para[i], w = charW(ch) * fs;
        if (curW + w > max && cur !== '') {
          const sp = cur.lastIndexOf(' ');
          if (sp > 0 && cur.length - sp < 14) { out.push(cur.slice(0, sp)); cur = cur.slice(sp + 1); curW = textWidth(cur, fs); }
          else { out.push(cur); cur = ''; curW = 0; }
        }
        cur += ch; curW += w;
      }
      if (cur !== '') out.push(cur);
    });
    return out.length ? out : [''];
  }

  // ---------------- 主題（配色）與結構 ----------------
  const THEMES = {
    classic: { name: '經典', bg: '#ffffff', root: { fill: '#2d3e50', color: '#ffffff' }, branch: ['#e74c3c', '#e67e22', '#f1c40f', '#27ae60', '#16a085', '#2980b9', '#8e44ad', '#34495e'], mainColor: '#ffffff', subColor: '#2d3e50', mainShape: 'round', subShape: 'underline', line: 'curve' },
    snow: { name: '雪白', bg: '#f7f8fa', root: { fill: '#3d5a80', color: '#ffffff' }, branch: ['#98c1d9', '#ee6c4d', '#3d5a80', '#e0a458', '#8fb339', '#7a6fbe', '#56a3a6', '#c97b84'], mainColor: '#1b2a41', mainFillAlpha: .22, subColor: '#1b2a41', mainShape: 'round', subShape: 'plain', line: 'curve' },
    business: { name: '商務', bg: '#ffffff', root: { fill: '#1f3a5f', color: '#ffffff' }, branch: ['#1f3a5f', '#3c6e9e', '#5b8db8', '#7fa8cc', '#2a9d8f', '#577590', '#4d6d9a', '#6c8ead'], mainColor: '#ffffff', subColor: '#1f3a5f', mainShape: 'rect', subShape: 'underline', line: 'elbow' },
    colorful: { name: '繽紛', bg: '#fffdf7', root: { fill: '#ff6b6b', color: '#ffffff' }, branch: ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7', '#9775fa', '#f783ac'], mainColor: '#ffffff', subColor: '#343a40', mainShape: 'pill', subShape: 'underline', line: 'curve' },
    dark: { name: '深色', bg: '#1e2430', root: { fill: '#f5f6fa', color: '#1e2430' }, branch: ['#ff7675', '#fdcb6e', '#55efc4', '#74b9ff', '#a29bfe', '#fd79a8', '#81ecec', '#ffeaa7'], mainColor: '#1e2430', subColor: '#e6e9ef', mainShape: 'round', subShape: 'underline', line: 'curve' },
    fresh: { name: '清新', bg: '#f3fbf6', root: { fill: '#2b9348', color: '#ffffff' }, branch: ['#2b9348', '#55a630', '#80b918', '#aacc00', '#007f5f', '#52b788', '#40916c', '#95d5b2'], mainColor: '#ffffff', subColor: '#1b4332', mainShape: 'round', subShape: 'plain', line: 'straight' }
  };
  const STRUCTURES = [['map', '平衡圖（左右）'], ['logic-right', '邏輯圖（向右）'], ['logic-left', '邏輯圖（向左）'], ['org-down', '組織圖（向下）'], ['tree-right', '樹狀圖'], ['timeline', '時間軸']];
  const MARKER_GROUPS = [
    { key: 'priority', name: '優先順序', items: ['1', '2', '3', '4', '5', '6', '7', '8', '9'], single: true },
    { key: 'task', name: '任務進度', items: ['0', '1', '2', '3', '4', '5', '6', '7', '8'], single: true },
    { key: 'flag', name: '旗幟', items: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'], single: true },
    { key: 'star', name: '星星', items: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'], single: true },
    { key: 'people', name: '人物', items: ['red', 'orange', 'yellow', 'green', 'blue', 'purple'], single: true },
    { key: 'symbol', name: '符號', items: ['check', 'cross', 'exclaim', 'question', 'info', 'heart', 'plus', 'minus'], single: false }
  ];
  const MARKER_HEX = { red: '#e74c3c', orange: '#e67e22', yellow: '#f1c40f', green: '#27ae60', blue: '#2980b9', purple: '#8e44ad' };
  function themeOf(key) { return THEMES[key] || THEMES.classic; }
  function colorAlpha(hex, a) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return hex;
    return 'rgba(' + parseInt(m[1], 16) + ',' + parseInt(m[2], 16) + ',' + parseInt(m[3], 16) + ',' + a + ')';
  }

  // ---------------- 模型 ----------------
  function newTopic(title) { return { id: uid('t'), title: title, children: [], collapsed: false, notes: '', labels: [], markers: [], link: '', style: {} }; }
  function newSheet(name) {
    const root = newTopic('中心主題');
    return { id: uid('s'), name: name || '工作表 1', theme: 'classic', structure: 'map', root: root, floating: [], rels: [], bounds: [], sums: [] };
  }
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 2000) : ''; }
  function cleanStyle(s) {
    const o = {};
    if (!s || typeof s !== 'object') return o;
    ['fill', 'stroke', 'color'].forEach(function (k) { if (/^#[0-9a-f]{3,8}$/i.test(s[k] || '')) o[k] = s[k]; });
    if (typeof s.fs === 'number' && s.fs >= 8 && s.fs <= 72) o.fs = Math.round(s.fs);
    if (s.bold) o.bold = 1;
    if (['rect', 'round', 'pill', 'underline', 'plain', 'ellipse'].indexOf(s.shape) >= 0) o.shape = s.shape;
    return o;
  }
  function cleanTopic(t, seen, depth) {
    if (!t || typeof t !== 'object' || depth > 40) return null;
    let id = typeof t.id === 'string' ? t.id.slice(0, 40) : uid('t');
    if (seen[id]) id = uid('t');
    seen[id] = 1;
    const o = { id: id, title: str(t.title, 500), children: [], collapsed: !!t.collapsed, notes: str(t.notes, 5000), labels: [], markers: [], link: '', style: cleanStyle(t.style) };
    (Array.isArray(t.labels) ? t.labels : []).forEach(function (l) { if (typeof l === 'string' && l.trim()) o.labels.push(l.trim().slice(0, 60)); });
    (Array.isArray(t.markers) ? t.markers : []).forEach(function (m) {
      if (typeof m !== 'string') return;
      const p = m.split(':'), g = MARKER_GROUPS.find(function (x) { return x.key === p[0]; });
      if (g && g.items.indexOf(p[1]) >= 0) o.markers.push(m);
    });
    const link = str(t.link, 2000).trim();
    if (/^(https?:\/\/|#note\/|mailto:)/i.test(link)) o.link = link;
    if (typeof t.x === 'number' && isFinite(t.x)) o.x = t.x;
    if (typeof t.y === 'number' && isFinite(t.y)) o.y = t.y;
    (Array.isArray(t.children) ? t.children : []).forEach(function (c) { const cc = cleanTopic(c, seen, depth + 1); if (cc) o.children.push(cc); });
    return o;
  }
  function cleanSheet(s, i) {
    const seen = {};
    const sh = { id: typeof s.id === 'string' ? s.id.slice(0, 40) : uid('s'), name: str(s.name, 80) || ('工作表 ' + (i + 1)),
      theme: THEMES[s.theme] ? s.theme : 'classic', structure: STRUCTURES.some(function (x) { return x[0] === s.structure; }) ? s.structure : 'map',
      root: cleanTopic(s.root, seen, 0) || newTopic('中心主題'), floating: [], rels: [], bounds: [], sums: [] };
    (Array.isArray(s.floating) ? s.floating : []).forEach(function (f) { const t = cleanTopic(f, seen, 0); if (t) { if (t.x == null) t.x = 0; if (t.y == null) t.y = 0; sh.floating.push(t); } });
    const has = function (id) { return !!seen[id]; };
    (Array.isArray(s.rels) ? s.rels : []).forEach(function (r) { if (r && has(r.from) && has(r.to) && r.from !== r.to) sh.rels.push({ id: typeof r.id === 'string' ? r.id.slice(0, 40) : uid('r'), from: r.from, to: r.to, title: str(r.title, 200) }); });
    const rng = function (x, key) {
      if (!x || !has(x.topic)) return null;
      const from = Math.max(0, parseInt(x.from, 10) || 0), to = Math.max(from, parseInt(x.to, 10) || from);
      return { id: typeof x.id === 'string' ? x.id.slice(0, 40) : uid(key), topic: x.topic, from: from, to: to, title: str(x.title, 200) };
    };
    (Array.isArray(s.bounds) ? s.bounds : []).forEach(function (x) { const b = rng(x, 'b'); if (b) sh.bounds.push(b); });
    (Array.isArray(s.sums) ? s.sums : []).forEach(function (x) { const b = rng(x, 'm'); if (b) { if (!b.title) b.title = '摘要'; sh.sums.push(b); } });
    return sh;
  }
  function parse(text) {
    let raw = null;
    try { raw = JSON.parse(String(text || '')); } catch (e) { raw = null; }
    if (!raw || typeof raw !== 'object') raw = {};
    const doc = { sheets: [] };
    const sheets = Array.isArray(raw.sheets) ? raw.sheets : (raw.root ? [raw] : []);
    sheets.forEach(function (s, i) { if (s && typeof s === 'object') doc.sheets.push(cleanSheet(s, i)); });
    if (!doc.sheets.length) doc.sheets.push(newSheet('工作表 1'));
    return doc;
  }
  function serialize(doc) { return JSON.stringify(doc, null, 1); }
  function payloadOf(content) { const m = /^```xmind[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/m.exec(String(content || '')); return m ? m[1] : null; }
  function wrap(json) { return '```xmind\n' + json + '\n```\n'; }
  function generate(title) {
    const sh = newSheet('工作表 1');
    sh.root.title = title || '中心主題';
    ['主題 1', '主題 2', '主題 3'].forEach(function (t) { sh.root.children.push(newTopic(t)); });
    return wrap(serialize({ sheets: [sh] }));
  }
  function isNote(note) { return !!(note && note.meta && note.meta.xmind); }

  // ---------------- 樹的工具 ----------------
  function walk(t, fn, parent, depth) { fn(t, parent || null, depth || 0); t.children.forEach(function (c) { walk(c, fn, t, (depth || 0) + 1); }); }
  function allRoots(sheet) { return [sheet.root].concat(sheet.floating); }
  function findTopic(sheet, id) { let hit = null; allRoots(sheet).forEach(function (r) { walk(r, function (t) { if (t.id === id) hit = t; }); }); return hit; }
  function parentOf(sheet, id) { let hit = null; allRoots(sheet).forEach(function (r) { walk(r, function (t, p) { if (t.id === id) hit = p; }); }); return hit; }
  function isDescendant(t, id) { let yes = false; walk(t, function (x) { if (x.id === id) yes = true; }); return yes; }
  function countAll(t) { let n = 0; walk(t, function () { n++; }); return n - 1; }
  function cloneTopic(t) { const c = JSON.parse(JSON.stringify(t)); walk(c, function (x) { x.id = uid('t'); }); return c; }

  // ---------------- 版面 ----------------
  const PAD_X = 14, PAD_Y = 8, GAP_X = 44, GAP_Y = 12, MAIN_GAP_Y = 18, MAX_TEXT = 260, ICON = 16;
  function fsOf(t, depth) { return t.style.fs || (depth === 0 ? 18 : depth === 1 ? 14 : 13); }
  function shapeOf(t, depth, theme) { return t.style.shape || (depth === 0 ? 'round' : depth === 1 ? theme.mainShape : theme.subShape); }
  // 一個主題的框：文字幾行、標記幾個、有沒有備註／連結圖示、標籤那一行
  function measure(t, depth) {
    const fs = fsOf(t, depth);
    const lines = wrapText(t.title || ' ', fs, MAX_TEXT);
    const tw = Math.max.apply(null, lines.map(function (l) { return textWidth(l, fs) * (t.style.bold || depth === 0 ? 1.04 : 1); }));
    const icons = t.markers.length + (t.notes ? 1 : 0) + (t.link ? 1 : 0);
    const w = Math.max(40, tw + PAD_X * 2 + (icons ? icons * (ICON + 4) : 0));
    let h = lines.length * fs * 1.35 + PAD_Y * 2;
    const labelsH = t.labels.length ? 18 : 0;
    return { w: w, h: h, fs: fs, lines: lines, icons: icons, labelsH: labelsH };
  }
  // 把一棵（子）樹排好：回傳 { nodes: Map id→box, w, h } 的整塊大小。dir: 1 右、-1 左。
  // 子主題垂直疊、置中對齊父主題；收合的主題不排子樹。
  function layoutLogic(t, depth, dir, x, y, pos, color) {
    const m = measure(t, depth);
    const box = { id: t.id, t: t, depth: depth, dir: dir, w: m.w, h: m.h + m.labelsH, m: m, color: color };
    pos.push(box);
    const kids = t.collapsed ? [] : t.children;
    if (!kids.length) { box.x = x; box.y = y; box.bw = box.w; box.bh = box.h; return box; }
    // 先排子樹算總高
    const subs = [];
    let total = 0;
    kids.forEach(function (c, i) {
      const sb = layoutLogic(c, depth + 1, dir, 0, 0, pos, color);
      subs.push(sb); total += sb.bh;
    });
    const gap = depth === 0 ? MAIN_GAP_Y : GAP_Y;
    total += gap * (kids.length - 1);
    box.bh = Math.max(box.h, total);
    const cx = dir > 0 ? x + box.w + GAP_X : x - GAP_X;   // 子樹起點的 x
    let cy = y + box.h / 2 - total / 2;
    subs.forEach(function (sb) {
      const dx = (dir > 0 ? cx : cx - sb.w) - sb.x, dy = cy + (sb.bh - sb.h) / 2 - sb.y;   // 子主題框在自己那塊裡置中
      shift(sb, dx, dy, pos);
      cy += sb.bh + gap;
    });
    box.x = x; box.y = y;
    box.bw = box.w + GAP_X + Math.max.apply(null, subs.map(function (s) { return s.bw; }));
    return box;
  }
  function shift(box, dx, dy, pos) {
    // 把 box 以及它底下（pos 裡 depth 更深、屬於這棵子樹）的全部移動：用子樹 id 集合
    const ids = {};
    walk(box.t, function (x) { ids[x.id] = 1; });
    pos.forEach(function (b) { if (ids[b.id]) { b.x += dx; b.y += dy; } });
  }
  function layoutOrg(t, depth, x, y, pos, color) {   // 向下：子主題橫排
    const m = measure(t, depth);
    const box = { id: t.id, t: t, depth: depth, dir: 0, w: m.w, h: m.h + m.labelsH, m: m, color: color };
    pos.push(box);
    const kids = t.collapsed ? [] : t.children;
    if (!kids.length) { box.x = x; box.y = y; box.bw = box.w; box.bh = box.h; return box; }
    const subs = []; let total = 0;
    kids.forEach(function (c) { const sb = layoutOrg(c, depth + 1, 0, 0, pos, color); subs.push(sb); total += sb.bw; });
    const gap = depth === 0 ? 28 : 18;
    total += gap * (kids.length - 1);
    box.bw = Math.max(box.w, total);
    let cx = x + box.w / 2 - total / 2;
    const cy = y + box.h + GAP_X;
    subs.forEach(function (sb) { shift(sb, cx + (sb.bw - sb.w) / 2 - sb.x, cy - sb.y, pos); cx += sb.bw + gap; });
    box.x = x; box.y = y;
    box.bh = box.h + GAP_X + Math.max.apply(null, subs.map(function (s) { return s.bh; }));
    return box;
  }
  function layoutTree(t, depth, x, y, pos, color) {   // 樹狀：子主題在右下方縱向排
    const m = measure(t, depth);
    const box = { id: t.id, t: t, depth: depth, dir: 1, w: m.w, h: m.h + m.labelsH, m: m, color: color };
    pos.push(box);
    const kids = t.collapsed ? [] : t.children;
    box.x = x; box.y = y;
    if (!kids.length) { box.bw = box.w; box.bh = box.h; return box; }
    const indent = depth === 0 ? 40 : 28;
    let cy = y + box.h + GAP_Y, maxW = box.w;
    kids.forEach(function (c) {
      const sb = layoutTree(c, depth + 1, 0, 0, pos, color);
      shift(sb, x + indent - sb.x, cy - sb.y, pos);
      cy += sb.bh + GAP_Y;
      maxW = Math.max(maxW, indent + sb.bw);
    });
    box.bw = maxW; box.bh = cy - GAP_Y - y;
    return box;
  }
  // 整張工作表：回傳 { boxes, byId, edges, bounds, sums, rels, w, h, axis }
  function layoutSheet(sheet) {
    const theme = themeOf(sheet.theme);
    const pos = [], edges = [];
    const root = sheet.root, st = sheet.structure;
    const rm = measure(root, 0);
    const branchColor = function (i) { return theme.branch[i % theme.branch.length]; };
    if (st === 'map' || st === 'logic-right' || st === 'logic-left') {
      const rootBox = { id: root.id, t: root, depth: 0, dir: 0, w: rm.w, h: rm.h + rm.labelsH, m: rm, color: theme.root.fill, x: 0, y: 0 };
      pos.push(rootBox);
      const kids = root.collapsed ? [] : root.children;
      const right = [], left = [];
      kids.forEach(function (c, i) {
        const side = st === 'logic-left' ? -1 : st === 'logic-right' ? 1 : (i % 2 === 0 ? 1 : -1);
        (side > 0 ? right : left).push({ t: c, i: i });
      });
      [[right, 1], [left, -1]].forEach(function (pair) {
        const list = pair[0], dir = pair[1];
        if (!list.length) return;
        const subs = []; let total = 0;
        list.forEach(function (o) { const sb = layoutLogic(o.t, 1, dir, 0, 0, pos, branchColor(o.i)); subs.push(sb); total += sb.bh; });
        total += MAIN_GAP_Y * (list.length - 1);
        let cy = rootBox.h / 2 - total / 2;
        const cx = dir > 0 ? rootBox.w + GAP_X + 16 : -GAP_X - 16;
        subs.forEach(function (sb) { shift(sb, (dir > 0 ? cx : cx - sb.w) - sb.x, cy + (sb.bh - sb.h) / 2 - sb.y, pos); cy += sb.bh + MAIN_GAP_Y; });
      });
    } else if (st === 'org-down') {
      const rb = layoutOrg(root, 0, 0, 0, pos, theme.root.fill);
      // 主幹各自的顏色：第一層的子樹各染一色
      root.children.forEach(function (c, i) { walk(c, function (x) { const b = pos.find(function (p) { return p.id === x.id; }); if (b) b.color = branchColor(i); }); });
    } else if (st === 'tree-right') {
      layoutTree(root, 0, 0, 0, pos, theme.root.fill);
      root.children.forEach(function (c, i) { walk(c, function (x) { const b = pos.find(function (p) { return p.id === x.id; }); if (b) b.color = branchColor(i); }); });
    } else if (st === 'timeline') {
      const rootBox = { id: root.id, t: root, depth: 0, dir: 1, w: rm.w, h: rm.h + rm.labelsH, m: rm, color: theme.root.fill, x: 0, y: 0 };
      pos.push(rootBox);
      const kids = root.collapsed ? [] : root.children;
      let cx = rootBox.w + 60;
      kids.forEach(function (c, i) {
        const sb = layoutTree(c, 1, 0, 0, pos, branchColor(i));
        const above = i % 2 === 1;
        const y = above ? rootBox.h / 2 - 34 - sb.h : rootBox.h / 2 + 34;
        shift(sb, cx - sb.x, y - sb.y, pos);
        cx += Math.max(sb.bw, sb.w) + 36;
      });
    }
    // 自由主題：各自是一棵小邏輯圖（向右），放在自己的 x,y
    sheet.floating.forEach(function (f, i) {
      const sb = layoutLogic(f, 1, 1, 0, 0, pos, theme.branch[(i + 3) % theme.branch.length]);
      shift(sb, (f.x || 0) - sb.x, (f.y || 0) - sb.y, pos);
      pos.filter(function (b) { return isDescendant(f, b.id); }).forEach(function (b) { b.floating = true; });
    });
    const byId = {};
    pos.forEach(function (b) { byId[b.id] = b; });
    // 連線：父 → 子（不含收合的）
    allRoots(sheet).forEach(function (r) {
      walk(r, function (t, p) {
        if (!p) return;
        const a = byId[p.id], b = byId[t.id];
        if (a && b) edges.push({ from: a, to: b, color: b.color });
      });
    });
    // 外框／摘要的範圍
    const bounds = sheet.bounds.map(function (bd) { const r = rangeBox(byId, sheet, bd, true); return r ? Object.assign({ bd: bd }, r) : null; }).filter(Boolean);
    const sums = sheet.sums.map(function (sm) { const r = rangeBox(byId, sheet, sm); return r ? Object.assign({ sm: sm }, r) : null; }).filter(Boolean);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pos.forEach(function (b) { x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); });
    bounds.concat(sums).forEach(function (r) { x0 = Math.min(x0, r.x - 10); y0 = Math.min(y0, r.y - 24); x1 = Math.max(x1, r.x + r.w + (r.sm ? 140 : 10)); y1 = Math.max(y1, r.y + r.h + 10); });
    return { boxes: pos, byId: byId, edges: edges, bounds: bounds, sums: sums, theme: theme, x0: x0, y0: y0, x1: x1, y1: y1, structure: st };
  }
  // 某個主題第 from..to 個子主題（含它們的子樹）的外框
  function rangeBox(byId, sheet, r, titled) {
    const parent = findTopic(sheet, r.topic);
    if (!parent || parent.collapsed) return null;
    const kids = parent.children.slice(r.from, r.to + 1);
    if (!kids.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, dir = 1;
    kids.forEach(function (k) {
      walk(k, function (t) { const b = byId[t.id]; if (!b) return; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h); dir = b.dir || 1; });
    });
    if (x0 === Infinity) return null;
    const top = titled && r.title ? 26 : 8;   // 外框的標題寫在框內左上角，所以有標題時上緣多留一行
    return { x: x0 - 8, y: y0 - top, w: x1 - x0 + 16, h: y1 - y0 + top + 8, dir: dir, parent: byId[parent.id] };
  }

  // ---------------- 畫 ----------------
  function markerSVG(m, x, y, s) {
    const p = m.split(':'), g = p[0], v = p[1], r = s / 2, cx = x + r, cy = y + r;
    if (g === 'priority') return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + (v <= 3 ? '#e74c3c' : v <= 6 ? '#e67e22' : '#2980b9') + '"/><text x="' + cx + '" y="' + (cy + r * 0.45) + '" text-anchor="middle" font-size="' + (s * 0.68) + '" font-weight="700" fill="#fff">' + v + '</text>';
    if (g === 'task') {
      const frac = parseInt(v, 10) / 8;
      let h = '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r - 1) + '" fill="#fff" stroke="#2980b9" stroke-width="1.5"/>';
      if (frac >= 1) h += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r - 2.5) + '" fill="#2980b9"/>';
      else if (frac > 0) { const a = frac * Math.PI * 2, rr = r - 2.5; h += '<path d="M' + cx + ',' + cy + ' L' + cx + ',' + (cy - rr) + ' A' + rr + ',' + rr + ' 0 ' + (frac > .5 ? 1 : 0) + ' 1 ' + fmt(cx + rr * Math.sin(a)) + ',' + fmt(cy - rr * Math.cos(a)) + ' Z" fill="#2980b9"/>'; }
      return h;
    }
    const col = MARKER_HEX[v] || '#555';
    if (g === 'flag') return '<path d="M' + (x + 3) + ',' + (y + s - 1) + ' V' + (y + 1) + ' H' + (x + s - 2) + ' L' + (x + s - 5) + ',' + (y + 4.5) + ' L' + (x + s - 2) + ',' + (y + 8) + ' H' + (x + 3) + '" fill="' + col + '" stroke="' + col + '" stroke-width="1.2" stroke-linejoin="round"/>';
    if (g === 'star') { const pts = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; pts.push(fmt(cx + rr * Math.cos(a)) + ',' + fmt(cy + rr * Math.sin(a))); } return '<polygon points="' + pts.join(' ') + '" fill="' + col + '"/>'; }
    if (g === 'people') return '<circle cx="' + cx + '" cy="' + (y + r * 0.7) + '" r="' + (r * 0.42) + '" fill="' + col + '"/><path d="M' + (x + 1) + ',' + (y + s) + ' a' + (r - 1) + ',' + (r * 0.75) + ' 0 0 1 ' + (s - 2) + ',0 Z" fill="' + col + '"/>';
    const SYM = { check: ['✓', '#27ae60'], cross: ['✕', '#e74c3c'], exclaim: ['!', '#e67e22'], question: ['?', '#2980b9'], info: ['i', '#7f8c8d'], heart: ['♥', '#e84393'], plus: ['+', '#27ae60'], minus: ['−', '#c0392b'] };
    const sy = SYM[v] || ['•', '#555'];
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + sy[1] + '"/><text x="' + cx + '" y="' + (cy + r * 0.45) + '" text-anchor="middle" font-size="' + (s * 0.7) + '" font-weight="700" fill="#fff">' + esc(sy[0]) + '</text>';
  }
  function topicSVG(b, theme, hit) {
    const t = b.t, m = b.m, d = b.depth;
    const shape = shapeOf(t, d, theme);
    const fill = t.style.fill || (d === 0 ? theme.root.fill : d === 1 ? (theme.mainFillAlpha ? colorAlpha(b.color, theme.mainFillAlpha) : b.color) : 'none');
    const stroke = t.style.stroke || (d === 0 ? 'none' : d === 1 ? (theme.mainFillAlpha ? b.color : 'none') : 'none');
    const color = t.style.color || (d === 0 ? theme.root.color : d === 1 ? theme.mainColor : theme.subColor);
    const x = b.x, y = b.y, w = b.w, h = b.h - m.labelsH;
    let s = '<g class="xm-topic' + (b.floating ? ' is-floating' : '') + '" data-id="' + esc(t.id) + '">';
    if (hit) s += '<rect class="xm-hit" x="' + fmt(x - 4) + '" y="' + fmt(y - 4) + '" width="' + fmt(w + 8) + '" height="' + fmt(b.h + 8) + '" fill="transparent"/>';
    if (shape === 'underline') s += '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) + '" fill="' + (t.style.fill || 'none') + '"/><line x1="' + fmt(x) + '" y1="' + fmt(y + h) + '" x2="' + fmt(x + w) + '" y2="' + fmt(y + h) + '" stroke="' + (t.style.stroke || b.color) + '" stroke-width="2"/>';
    else if (shape === 'plain') { if (t.style.fill) s += '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) + '" rx="4" fill="' + t.style.fill + '"/>'; }
    else if (shape === 'ellipse') s += '<ellipse cx="' + fmt(x + w / 2) + '" cy="' + fmt(y + h / 2) + '" rx="' + fmt(w / 2 + 4) + '" ry="' + fmt(h / 2 + 2) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>';
    else s += '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) + '" rx="' + (shape === 'pill' ? h / 2 : shape === 'round' ? 8 : 2) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"/>';
    // 標記、備註、連結圖示在文字前面
    let ix = x + PAD_X - 2, iy = y + h / 2 - ICON / 2;
    t.markers.forEach(function (mk) { s += markerSVG(mk, ix, iy, ICON); ix += ICON + 4; });
    if (t.notes) { s += '<g class="xm-note-ic" data-note="' + esc(t.id) + '"><title>' + esc(t.notes.slice(0, 400)) + '</title><rect x="' + fmt(ix + 1) + '" y="' + fmt(iy + 1) + '" width="' + (ICON - 2) + '" height="' + (ICON - 2) + '" rx="2" fill="#fff" stroke="#888"/><path d="M' + fmt(ix + 4) + ',' + fmt(iy + 5) + ' h8 M' + fmt(ix + 4) + ',' + fmt(iy + 8) + ' h8 M' + fmt(ix + 4) + ',' + fmt(iy + 11) + ' h5" stroke="#888" stroke-width="1.2"/></g>'; ix += ICON + 4; }
    if (t.link) { s += '<g class="xm-link-ic" data-link="' + esc(t.link) + '"><title>' + esc(t.link) + '</title><circle cx="' + fmt(ix + ICON / 2) + '" cy="' + fmt(iy + ICON / 2) + '" r="' + (ICON / 2 - 1) + '" fill="#2980b9"/><path d="M' + fmt(ix + 5) + ',' + fmt(iy + 9) + ' l3,-3 M' + fmt(ix + 8) + ',' + fmt(iy + 10) + ' l3,-3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></g>'; ix += ICON + 4; }
    const tx = ix + 2, lh = m.fs * 1.35, top = y + PAD_Y;
    m.lines.forEach(function (ln, i) {
      s += '<text x="' + fmt(tx) + '" y="' + fmt(top + i * lh + lh * 0.72) + '" font-size="' + m.fs + '" fill="' + color + '"' + (t.style.bold || d === 0 ? ' font-weight="700"' : '') + '>' + esc(ln) + '</text>';
    });
    if (t.labels.length) {
      let lx = x + 4;
      t.labels.forEach(function (lb) {
        const lw = textWidth(lb, 10) + 10;
        s += '<rect x="' + fmt(lx) + '" y="' + fmt(y + h + 2) + '" width="' + fmt(lw) + '" height="14" rx="7" fill="' + colorAlpha(b.color === 'none' ? '#888888' : b.color, .18) + '"/><text x="' + fmt(lx + 5) + '" y="' + fmt(y + h + 12.5) + '" font-size="10" fill="' + (theme.bg === '#1e2430' ? '#e6e9ef' : '#444') + '">' + esc(lb) + '</text>';
        lx += lw + 4;
      });
    }
    if (t.collapsed && t.children.length) {
      // 收合：枝尾一個小圓圈寫著數量，點了展開
      const cx = b.dir < 0 ? x - 10 : (b.dir === 0 ? x + w / 2 : x + w + 10), cy = b.dir === 0 ? y + b.h + 10 : y + h / 2;
      s += '<g class="xm-fold" data-fold="' + esc(t.id) + '"><circle cx="' + fmt(cx) + '" cy="' + fmt(cy) + '" r="8" fill="#fff" stroke="' + (b.color === 'none' ? '#888' : b.color) + '" stroke-width="1.5"/><text x="' + fmt(cx) + '" y="' + fmt(cy + 3.5) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#333">' + countAll(t) + '</text></g>';
    }
    return s + '</g>';
  }
  function edgePath(e, structure, lineStyle) {
    const a = e.from, b = e.to;
    if (structure === 'org-down') {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h - (a.m.labelsH || 0), x2 = b.x + b.w / 2, y2 = b.y, my = (y1 + y2) / 2;
      return 'M' + fmt(x1) + ',' + fmt(y1) + ' V' + fmt(my) + ' H' + fmt(x2) + ' V' + fmt(y2);
    }
    if (structure === 'tree-right' || (structure === 'timeline' && b.depth > 1)) {
      const x1 = a.x + 14, y1 = a.y + a.h - (a.m.labelsH || 0), x2 = b.x, y2 = b.y + (b.h - (b.m.labelsH || 0)) / 2;
      return 'M' + fmt(x1) + ',' + fmt(y1) + ' V' + fmt(y2) + ' H' + fmt(x2);
    }
    if (structure === 'timeline') {
      // 主幹：從軸線垂直接到主題
      const ax = b.x + 14, ay = a.y + (a.h - (a.m.labelsH || 0)) / 2, y2 = b.y > ay ? b.y : b.y + b.h - (b.m.labelsH || 0);
      return 'M' + fmt(ax) + ',' + fmt(ay) + ' V' + fmt(y2);
    }
    const dir = b.dir || 1;
    const x1 = dir > 0 ? a.x + a.w : a.x, y1 = a.y + (a.h - (a.m.labelsH || 0)) / 2;
    const bh = b.h - (b.m.labelsH || 0);
    const underline = b.depth >= 2;
    const x2 = dir > 0 ? b.x : b.x + b.w, y2 = underline ? b.y + bh : b.y + bh / 2;
    if (lineStyle === 'straight') return 'M' + fmt(x1) + ',' + fmt(y1) + ' L' + fmt(x2) + ',' + fmt(y2) + (underline ? ' H' + fmt(dir > 0 ? b.x + b.w : b.x) : '');
    if (lineStyle === 'elbow') { const mx = (x1 + x2) / 2; return 'M' + fmt(x1) + ',' + fmt(y1) + ' H' + fmt(mx) + ' V' + fmt(y2) + ' H' + fmt(x2) + (underline ? ' H' + fmt(dir > 0 ? b.x + b.w : b.x) : ''); }
    const c = Math.abs(x2 - x1) * 0.5;
    return 'M' + fmt(x1) + ',' + fmt(y1) + ' C' + fmt(x1 + dir * c) + ',' + fmt(y1) + ' ' + fmt(x2 - dir * c) + ',' + fmt(y2) + ' ' + fmt(x2) + ',' + fmt(y2) + (underline ? ' H' + fmt(dir > 0 ? b.x + b.w : b.x) : '');
  }
  function relPath(a, b) {
    // 兩個主題中心之間的虛線弧，弓向垂直方向
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
    const dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len, ny = dx / len, bend = Math.min(80, len * 0.25);
    const c1x = ax + dx * 0.25 + nx * bend, c1y = ay + dy * 0.25 + ny * bend, c2x = ax + dx * 0.75 + nx * bend, c2y = ay + dy * 0.75 + ny * bend;
    // 端點縮到框邊：用方向把起點／終點往外推到框外一點點
    const p1 = edgePoint(a, c1x, c1y), p2 = edgePoint(b, c2x, c2y);
    return { d: 'M' + fmt(p1.x) + ',' + fmt(p1.y) + ' C' + fmt(c1x) + ',' + fmt(c1y) + ' ' + fmt(c2x) + ',' + fmt(c2y) + ' ' + fmt(p2.x) + ',' + fmt(p2.y), mid: { x: (p1.x + 3 * c1x + 3 * c2x + p2.x) / 8, y: (p1.y + 3 * c1y + 3 * c2y + p2.y) / 8 }, end: p2, ctrl: { x: c2x, y: c2y } };
  }
  function edgePoint(b, tx, ty) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const t = Math.min(dx ? (b.w / 2 + 4) / Math.abs(dx) : Infinity, dy ? (b.h / 2 + 4) / Math.abs(dy) : Infinity);
    return { x: cx + dx * t, y: cy + dy * t };
  }
  // 整張工作表的 SVG 內容（不含 <svg>）；hit：編輯器要的點擊範圍
  function sheetInner(sheet, L, hit) {
    const theme = L.theme;
    let s = '';
    // 外框
    L.bounds.forEach(function (r) {
      s += '<g class="xm-bound" data-bound="' + esc(r.bd.id) + '"><rect x="' + fmt(r.x) + '" y="' + fmt(r.y) + '" width="' + fmt(r.w) + '" height="' + fmt(r.h) + '" rx="12" fill="' + colorAlpha(r.parent && r.parent.color !== 'none' ? (L.byId[r.parent.t.children[r.bd.from] && r.parent.t.children[r.bd.from].id] || r.parent).color : '#888888', .1) + '" stroke="' + ((L.byId[r.parent.t.children[r.bd.from].id] || r.parent).color) + '" stroke-width="1.5" stroke-dasharray="6 4"/>' +
        (r.bd.title ? '<text x="' + fmt(r.x + 10) + '" y="' + fmt(r.y + 16) + '" font-size="11" font-weight="600" fill="' + ((L.byId[r.parent.t.children[r.bd.from].id] || r.parent).color) + '">' + esc(r.bd.title) + '</text>' : '') + '</g>';
    });
    // 連線
    const axis = L.structure === 'timeline' ? L.boxes.find(function (b) { return b.depth === 0; }) : null;
    if (axis) {
      const lastMain = L.boxes.filter(function (b) { return b.depth === 1 && !b.floating; });
      const ex = lastMain.length ? Math.max.apply(null, lastMain.map(function (b) { return b.x + b.w; })) : axis.x + axis.w + 60;
      s += '<line x1="' + fmt(axis.x + axis.w) + '" y1="' + fmt(axis.y + axis.h / 2) + '" x2="' + fmt(ex + 20) + '" y2="' + fmt(axis.y + axis.h / 2) + '" stroke="' + theme.root.fill + '" stroke-width="3" stroke-linecap="round"/>';
    }
    L.edges.forEach(function (e) {
      const col = e.color === 'none' ? '#999' : e.color;
      s += '<path class="xm-edge" d="' + edgePath(e, L.structure, theme.line) + '" fill="none" stroke="' + col + '" stroke-width="' + (e.to.depth === 1 ? 2.5 : 1.6) + '" stroke-linecap="round"/>';
    });
    // 摘要：外側一個大括號＋摘要主題
    L.sums.forEach(function (r) {
      const dir = r.dir || 1, bx = dir > 0 ? r.x + r.w + 6 : r.x - 6, col = (L.byId[r.parent.t.children[r.sm.from].id] || r.parent).color;
      const mid = r.y + r.h / 2;
      s += '<g class="xm-sum" data-sum="' + esc(r.sm.id) + '"><path d="M' + fmt(bx) + ',' + fmt(r.y) + ' q' + (dir * 8) + ',0 ' + (dir * 8) + ',8 V' + fmt(mid - 8) + ' q0,8 ' + (dir * 8) + ',8 q' + (-dir * 8) + ',0 ' + (-dir * 8) + ',8 V' + fmt(r.y + r.h - 8) + ' q0,8 ' + (-dir * 8) + ',8" fill="none" stroke="' + col + '" stroke-width="1.6"/>';
      const fs = 13, lines = wrapText(r.sm.title || '摘要', fs, 200), tw = Math.max.apply(null, lines.map(function (l) { return textWidth(l, fs); })) + PAD_X * 2, th = lines.length * fs * 1.35 + PAD_Y * 2;
      const tx = dir > 0 ? bx + 22 : bx - 22 - tw, ty = mid - th / 2;
      s += '<line x1="' + fmt(dir > 0 ? bx + 16 : bx - 16) + '" y1="' + fmt(mid) + '" x2="' + fmt(dir > 0 ? tx : tx + tw) + '" y2="' + fmt(mid) + '" stroke="' + col + '" stroke-width="1.6"/>';
      s += '<rect class="xm-sum-box" x="' + fmt(tx) + '" y="' + fmt(ty) + '" width="' + fmt(tw) + '" height="' + fmt(th) + '" rx="6" fill="' + colorAlpha(col, .15) + '" stroke="' + col + '" stroke-width="1.2"/>';
      lines.forEach(function (ln, i) { s += '<text x="' + fmt(tx + PAD_X) + '" y="' + fmt(ty + PAD_Y + i * fs * 1.35 + fs * 0.97) + '" font-size="' + fs + '" fill="' + (theme.bg === '#1e2430' ? '#e6e9ef' : '#333') + '">' + esc(ln) + '</text>'; });
      s += '</g>';
      r.box = { x: tx, y: ty, w: tw, h: th };
    });
    // 主題
    L.boxes.forEach(function (b) { s += topicSVG(b, theme, hit); });
    // 關聯線（畫在最上面）
    sheet.rels.forEach(function (rel) {
      const a = L.byId[rel.from], b = L.byId[rel.to];
      if (!a || !b) return;
      const p = relPath(a, b);
      const ang = Math.atan2(p.end.y - p.ctrl.y, p.end.x - p.ctrl.x);
      const ax = p.end.x, ay = p.end.y, L1 = 9, W1 = 5;
      const arrow = '<polygon points="' + fmt(ax) + ',' + fmt(ay) + ' ' + fmt(ax - L1 * Math.cos(ang) + W1 * Math.sin(ang)) + ',' + fmt(ay - L1 * Math.sin(ang) - W1 * Math.cos(ang)) + ' ' + fmt(ax - L1 * Math.cos(ang) - W1 * Math.sin(ang)) + ',' + fmt(ay - L1 * Math.sin(ang) + W1 * Math.cos(ang)) + '" fill="#8e44ad"/>';
      s += '<g class="xm-rel" data-rel="' + esc(rel.id) + '">' + (hit ? '<path class="xm-hit" d="' + p.d + '" fill="none" stroke="transparent" stroke-width="12"/>' : '') +
        '<path d="' + p.d + '" fill="none" stroke="#8e44ad" stroke-width="1.6" stroke-dasharray="6 4"/>' + arrow +
        (rel.title ? '<rect x="' + fmt(p.mid.x - textWidth(rel.title, 11) / 2 - 5) + '" y="' + fmt(p.mid.y - 9) + '" width="' + fmt(textWidth(rel.title, 11) + 10) + '" height="18" rx="4" fill="' + theme.bg + '" stroke="#8e44ad" stroke-width="1"/><text x="' + fmt(p.mid.x) + '" y="' + fmt(p.mid.y + 4) + '" text-anchor="middle" font-size="11" fill="#8e44ad">' + esc(rel.title) + '</text>' : '') + '</g>';
    });
    return s;
  }
  function renderSheet(sheet, o) {
    o = o || {};
    const L = layoutSheet(sheet);
    const PAD = 24;
    const W = Math.ceil(L.x1 - L.x0 + PAD * 2), H = Math.ceil(L.y1 - L.y0 + PAD * 2);
    return '<svg class="xm-svg" xmlns="http://www.w3.org/2000/svg" viewBox="' + fmt(L.x0 - PAD) + ' ' + fmt(L.y0 - PAD) + ' ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" font-family="' + FONT + '">' +
      (o.background !== false ? '<rect x="' + fmt(L.x0 - PAD) + '" y="' + fmt(L.y0 - PAD) + '" width="' + W + '" height="' + H + '" fill="' + L.theme.bg + '"/>' : '') + sheetInner(sheet, L, false) + '</svg>';
  }
  function renderSVG(text, o) {
    const doc = typeof text === 'string' ? parse(text) : text;
    return renderSheet(doc.sheets[clamp((o && o.sheet) || 0, 0, doc.sheets.length - 1)], o);
  }
  function blockHTML(payload) {
    const doc = parse(payload);
    if (doc.sheets.length === 1) return '<div class="xmind-block">' + renderSheet(doc.sheets[0]) + '</div>';
    return '<div class="xmind-block xmind-multi">' + doc.sheets.map(function (s) { return '<figure class="xm-fig"><figcaption class="xm-fig-t">' + esc(s.name) + '</figcaption>' + renderSheet(s) + '</figure>'; }).join('') + '</div>';
  }
  function htmlOf(content) { const p = payloadOf(content); return p === null ? '' : blockHTML(p).replace(/^<div class="xmind-block[^"]*">/, '').replace(/<\/div>$/, ''); }
  // 大綱文字（匯出 Markdown）
  function outlineMarkdown(sheet) {
    const out = [];
    const rec = function (t, d) { out.push((d ? '  '.repeat(d - 1) + '- ' : '# ') + t.title + (t.notes ? '  — ' + t.notes.replace(/\n/g, ' ') : '')); t.children.forEach(function (c) { rec(c, d + 1); }); };
    rec(sheet.root, 0);
    sheet.floating.forEach(function (f) { out.push(''); rec(f, 0); });
    return out.join('\n');
  }

  // ---------------- 右鍵／下拉選單（列表頁與編輯器共用；掛在 body 上所以一定是 position: fixed） ----------------
  let menuEl = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
  function menuAt(x, y, items, onPick, cls) {
    closeMenu();
    menuEl = el('div', 'xm-menu' + (cls ? ' ' + cls : ''));
    menuEl.innerHTML = items.map(function (it) { return it ? '<button class="xm-menu-item' + (it[3] ? ' is-danger' : '') + '" type="button" data-a="' + it[0] + '"' + (it[2] ? ' disabled' : '') + '>' + esc(it[1]) + '</button>' : '<div class="xm-menu-sep"></div>'; }).join('');
    document.body.appendChild(menuEl);
    const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
    menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 4)) + 'px';
    menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 4)) + 'px';
    menuEl.addEventListener('click', function (e) { const b = e.target.closest('[data-a]'); if (!b || b.disabled) return; const a = b.getAttribute('data-a'); closeMenu(); onPick(a); });
    return menuEl;
  }
  document.addEventListener('mousedown', function (e) { if (menuEl && !e.target.closest('.xm-menu')) closeMenu(); }, true);
  document.addEventListener('keydown', function (e) { if (menuEl && e.key === 'Escape') { closeMenu(); e.stopPropagation(); } }, true);

  // ---------------- 列表頁（#xmind）：每張心智圖一格，格子裡是第一張工作表的縮圖 ----------------
  // opts: { maps, onOpen(id), onCreate({title}), onRename(n), onTags(n), onDelete(n) }
  function renderIndex(container, opts) {
    container.innerHTML = '';
    const head = el('div', 'boards-head');
    head.appendChild(el('div', 'boards-title', ic('mind-map') + '<span>xmind</span>'));
    head.appendChild(el('div', 'boards-sub', '像 XMind 一樣的心智圖。點一張打開，或建立新的。Tab 加子主題、Enter 加同階主題。'));
    container.appendChild(head);
    const grid = el('div', 'xmi-grid');
    const maps = (opts.maps || []).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    maps.forEach(function (n) {
      const doc = parse(payloadOf(n.content || '') || '');
      const sh = doc.sheets[0];
      const tile = el('button', 'xmi-tile');
      tile.type = 'button';
      tile.setAttribute('data-id', n.id);
      tile.innerHTML = '<span class="xmi-thumb" style="background:' + themeOf(sh.theme).bg + '">' + renderSheet(sh, { background: false }) + '</span>' +
        '<span class="xmi-body"><span class="xmi-t">' + esc(n.title || '未命名心智圖') + '</span>' +
        '<span class="xmi-m">' + (countAll(sh.root) + 1) + ' 個主題' + (doc.sheets.length > 1 ? '・' + doc.sheets.length + ' 張工作表' : '') + '</span></span>' +
        '<span class="xmi-more" title="更多">' + ic('more-horizontal') + '</span>';
      const menu = function (x, y) {
        menuAt(x, y, [['rename', '重新命名'], ['tags', '標籤…'], null, ['del', '移到垃圾桶', false, true]], function (a) {
          if (a === 'rename' && opts.onRename) opts.onRename(n);
          else if (a === 'tags' && opts.onTags) opts.onTags(n);
          else if (a === 'del' && opts.onDelete) opts.onDelete(n);
        });
      };
      tile.addEventListener('click', function (e) {
        if (e.target.closest('.xmi-more')) { e.stopPropagation(); const r = e.target.closest('.xmi-more').getBoundingClientRect(); menu(r.left, r.bottom + 4); return; }
        if (opts.onOpen) opts.onOpen(n.id);
      });
      tile.addEventListener('contextmenu', function (e) { e.preventDefault(); menu(e.clientX, e.clientY); });
      grid.appendChild(tile);
    });
    const add = el('button', 'xmi-tile xmi-tile-new');
    add.type = 'button';
    add.innerHTML = ic('plus') + '<span>建立新心智圖</span>';
    add.addEventListener('click', function () {
      const ask = global.App && App.prompt ? App.prompt({ title: '建立心智圖', placeholder: '中心主題，例如：OSCP 考試準備', ok: '建立' }) : Promise.resolve(window.prompt('中心主題'));
      ask.then(function (t) { t = String(t || '').trim(); if (!t) return; if (opts.onCreate) opts.onCreate({ title: t }); });
    });
    grid.appendChild(add);
    container.appendChild(grid);
  }

  // ---------------- 編輯器 ----------------
  let clipboard = null;
  function open(content, opts) {
    opts = opts || {};
    const host = opts.container;
    if (!host) return { close: function () {}, discard: function () {}, flush: function () { return Promise.resolve(); } };
    let doc = parse(payloadOf(content) || '');
    let si = 0, sheet = doc.sheets[0];
    const ro = !!opts.readOnly;
    let sel = [], zoom = 1, panX = 60, panY = 60, dirty = false, saveTimer = null, closed = false;
    let gesture = null, editing = null, mode = null, outlineOpen = false, L = null;
    const undo = [], redo = [];
    const views = {};

    host.classList.add('xm-page');
    host.innerHTML =
      (opts.banner ? '<div class="xm-ro">' + ic('lock') + '<span>' + esc(opts.banner) + '</span></div>' : '') +
      (ro ? '' : '<div class="xm-toolbar">' +
        tb('child', 'plus', '子主題 (Tab)', '子主題') + tb('sibling', 'plus', '同階主題 (Enter)', '同階主題') + tb('float', 'plus', '自由主題', '自由主題') + sep() +
        tb('rel', 'arrow-right', '關聯：依序點兩個主題', '關聯') + tb('bound', 'square-empty', '外框：圈住選取的同階主題', '外框') + tb('sum', 'quote', '摘要：選取的同階主題外側加摘要', '摘要') + sep() +
        tb('notes', 'file-text', '備註', '備註') + tb('label', 'tag', '標籤', '標籤') + tb('marker', 'star', '標記', '標記') + tb('link', 'link', '超連結', '連結') + sep() +
        '<select class="xm-sel" data-sel="structure" title="結構">' + STRUCTURES.map(function (x) { return '<option value="' + x[0] + '">' + x[1] + '</option>'; }).join('') + '</select>' +
        '<select class="xm-sel" data-sel="theme" title="主題（配色）">' + Object.keys(THEMES).map(function (k) { return '<option value="' + k + '">' + THEMES[k].name + '</option>'; }).join('') + '</select>' + sep() +
        tb('outline', 'list', '大綱', '大綱') + sep() +
        tb('undo', 'undo', '復原 (Ctrl+Z)') + tb('redo', 'redo', '重做 (Ctrl+Y)') + sep() +
        tb('zoomout', 'minus', '縮小') + '<button class="xm-tb xm-zoom" type="button" data-act="zoom100" title="100%">100%</button>' + tb('zoomin', 'plus', '放大') + tb('fit', 'maximize', '符合視窗') + sep() +
        tb('export', 'download', '匯出', '匯出') +
        '<span class="xm-tb-sp"></span><span class="xm-status" aria-live="polite"></span></div>') +
      '<div class="xm-main"><aside class="xm-outline" hidden></aside><div class="xm-canvas" tabindex="0"><svg class="xm-stage" xmlns="http://www.w3.org/2000/svg" font-family="' + FONT + '"><rect class="xm-bg" width="100%" height="100%"/><g class="xm-world"><g class="xm-content"></g><g class="xm-overlay"></g></g></svg></div>' +
      (ro ? '' : '<aside class="xm-format"></aside>') + '</div>' +
      (ro ? '' : '<div class="xm-sheets"><div class="xm-stabs"></div><button class="xm-sadd" type="button" title="新增工作表">' + ic('plus') + '</button></div>');
    function tb(act, icon, title, label) { return '<button class="xm-tb' + (label ? ' xm-tb-text' : '') + '" type="button" data-act="' + act + '" title="' + title + '">' + ic(icon) + (label ? '<span>' + label + '</span>' : '') + '</button>'; }
    function sep() { return '<span class="xm-tb-sep"></span>'; }
    const canvas = host.querySelector('.xm-canvas'), stage = host.querySelector('.xm-stage'), world = host.querySelector('.xm-world'), contentEl = host.querySelector('.xm-content'), overlayEl = host.querySelector('.xm-overlay');
    const formatEl = host.querySelector('.xm-format'), statusEl = host.querySelector('.xm-status'), outlineEl = host.querySelector('.xm-outline'), stabs = host.querySelector('.xm-stabs'), zoomEl = host.querySelector('.xm-zoom');

    function setStatus(t, cls) { if (statusEl) { statusEl.textContent = t || ''; statusEl.className = 'xm-status' + (cls ? ' ' + cls : ''); } }
    function emit() {
      clearTimeout(saveTimer);
      if (!dirty || !opts.onChange || ro) return Promise.resolve();
      dirty = false; setStatus('儲存中…');
      return Promise.resolve(opts.onChange(wrap(serialize(doc)))).then(function () { if (!closed && !dirty) setStatus('已儲存', 'is-ok'); }, function () { if (!closed) setStatus('儲存失敗', 'is-err'); });
    }
    function changed() { dirty = true; setStatus('尚未儲存'); clearTimeout(saveTimer); saveTimer = setTimeout(emit, 600); }
    function begin() { return serialize(doc); }
    function commit(before) {
      if (serialize(doc) === before) return false;
      undo.push({ dsl: before, si: si }); if (undo.length > 100) undo.shift(); redo.length = 0;
      changed(); return true;
    }
    function mutate(fn) { const b = begin(); fn(); commit(b); render(); renderFormat(); renderOutline(); }
    function restore(dsl, which) {
      doc = parse(dsl); si = clamp(which, 0, doc.sheets.length - 1); sheet = doc.sheets[si];
      sel = sel.filter(function (id) { return !!findTopic(sheet, id); });
      renderTabs();
    }
    function doUndo() { if (!undo.length) return; redo.push({ dsl: serialize(doc), si: si }); const u = undo.pop(); restore(u.dsl, u.si); changed(); render(); renderFormat(); renderOutline(); }
    function doRedo() { if (!redo.length) return; undo.push({ dsl: serialize(doc), si: si }); const u = redo.pop(); restore(u.dsl, u.si); changed(); render(); renderFormat(); renderOutline(); }

    // ---- 畫 ----
    function render() {
      L = layoutSheet(sheet);
      stage.style.background = L.theme.bg;
      host.querySelector('.xm-bg').setAttribute('fill', L.theme.bg);
      world.setAttribute('transform', 'translate(' + fmt(panX) + ',' + fmt(panY) + ') scale(' + zoom + ')');
      contentEl.innerHTML = sheetInner(sheet, L, true);
      renderOverlay();
      if (zoomEl) zoomEl.textContent = Math.round(zoom * 100) + '%';
      const ss = host.querySelector('[data-sel="structure"]'), ts = host.querySelector('[data-sel="theme"]');
      if (ss) ss.value = sheet.structure; if (ts) ts.value = sheet.theme;
      refreshToolbar();
    }
    function renderOverlay() {
      const k = 1 / zoom;
      let s = '';
      sel.forEach(function (id) {
        const b = L.byId[id];
        if (b) s += '<rect class="xm-selbox" x="' + fmt(b.x - 4) + '" y="' + fmt(b.y - 4) + '" width="' + fmt(b.w + 8) + '" height="' + fmt(b.h + 8) + '" rx="6" fill="none" stroke-width="' + 2 * k + '"/>';
      });
      if (gesture && gesture.type === 'drag' && gesture.moved) {
        const b = L.byId[gesture.id];
        if (b) s += '<rect class="xm-ghost" x="' + fmt(gesture.gx) + '" y="' + fmt(gesture.gy) + '" width="' + fmt(b.w) + '" height="' + fmt(b.h) + '" rx="6"/>';
        if (gesture.target && L.byId[gesture.target]) { const t = L.byId[gesture.target]; s += '<rect class="xm-target" x="' + fmt(t.x - 6) + '" y="' + fmt(t.y - 6) + '" width="' + fmt(t.w + 12) + '" height="' + fmt(t.h + 12) + '" rx="8" fill="none" stroke-width="' + 2 * k + '"/>'; }
      }
      if (mode === 'rel' && mode_from && L.byId[mode_from]) { const b = L.byId[mode_from]; s += '<rect class="xm-target" x="' + fmt(b.x - 6) + '" y="' + fmt(b.y - 6) + '" width="' + fmt(b.w + 12) + '" height="' + fmt(b.h + 12) + '" rx="8" fill="none" stroke-width="' + 2 * k + '"/>'; }
      overlayEl.innerHTML = s;
    }
    let mode_from = null;
    function refreshToolbar() {
      const bar = host.querySelector('.xm-toolbar');
      if (!bar) return;
      const one = sel.length === 1 && findTopic(sheet, sel[0]);
      const set = function (a, off) { const b = bar.querySelector('[data-act="' + a + '"]'); if (b) b.disabled = !!off; };
      set('child', !one); set('sibling', !one || one === sheet.root || sheet.floating.indexOf(one) >= 0);
      set('notes', !one); set('label', !one); set('marker', !one); set('link', !one);
      set('bound', !sameParentRange()); set('sum', !sameParentRange());
      set('undo', !undo.length); set('redo', !redo.length);
      bar.querySelectorAll('.xm-tb.on').forEach(function (b) { b.classList.remove('on'); });
      if (mode === 'rel') { const b = bar.querySelector('[data-act="rel"]'); if (b) b.classList.add('on'); }
      const ob = bar.querySelector('[data-act="outline"]'); if (ob) ob.classList.toggle('on', outlineOpen);
    }
    // 選取的是同一個父主題底下連續的幾個子主題嗎？（外框／摘要用）
    function sameParentRange() {
      if (!sel.length) return null;
      const p = parentOf(sheet, sel[0]);
      if (!p) return null;
      const idx = sel.map(function (id) { return p.children.findIndex(function (c) { return c.id === id; }); });
      if (idx.some(function (i) { return i < 0; }) || sel.some(function (id) { return parentOf(sheet, id) !== p; })) return null;
      idx.sort(function (a, b) { return a - b; });
      for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return null;
      return { parent: p, from: idx[0], to: idx[idx.length - 1] };
    }
    function select(ids) { sel = ids.slice(); render(); renderFormat(); renderOutline(); }
    function toWorld(e) { const r = stage.getBoundingClientRect(); return { x: (e.clientX - r.left - panX) / zoom, y: (e.clientY - r.top - panY) / zoom }; }
    function fit() {
      if (!L) L = layoutSheet(sheet);
      const r = canvas.getBoundingClientRect();
      const w = L.x1 - L.x0 + 80, h = L.y1 - L.y0 + 80;
      zoom = clamp(Math.min(r.width / w, r.height / h), 0.15, 1.5);
      panX = (r.width - (L.x1 - L.x0) * zoom) / 2 - L.x0 * zoom; panY = (r.height - (L.y1 - L.y0) * zoom) / 2 - L.y0 * zoom;
      render();
    }
    function zoomAt(cx, cy, z) {
      const r = stage.getBoundingClientRect(), sx = cx - r.left, sy = cy - r.top;
      const wx = (sx - panX) / zoom, wy = (sy - panY) / zoom;
      zoom = clamp(z, 0.15, 3); panX = sx - wx * zoom; panY = sy - wy * zoom; render();
    }
    function centerOn(id) {
      const b = L && L.byId[id]; if (!b) return;
      const r = canvas.getBoundingClientRect();
      const sx = panX + (b.x + b.w / 2) * zoom, sy = panY + (b.y + b.h / 2) * zoom;
      if (sx < 40 || sx > r.width - 40 || sy < 40 || sy > r.height - 40) { panX = r.width / 2 - (b.x + b.w / 2) * zoom; panY = r.height / 2 - (b.y + b.h / 2) * zoom; render(); }
    }

    // ---- 動作 ----
    function addChild(parentId, title) {
      const p = findTopic(sheet, parentId); if (!p) return;
      let made = null;
      mutate(function () { made = newTopic(title || ''); p.children.push(made); p.collapsed = false; });
      select([made.id]); centerOn(made.id); startEdit(made.id, true);
    }
    function addSibling(id, title) {
      const p = parentOf(sheet, id); if (!p) { addChild(id, title); return; }
      let made = null;
      mutate(function () { made = newTopic(title || ''); p.children.splice(p.children.findIndex(function (c) { return c.id === id; }) + 1, 0, made); });
      select([made.id]); centerOn(made.id); startEdit(made.id, true);
    }
    function addFloating(w) {
      let made = null;
      mutate(function () { made = newTopic('自由主題'); const c = w || viewCenterWorld(); made.x = c.x; made.y = c.y; sheet.floating.push(made); });
      select([made.id]); startEdit(made.id, true);
    }
    function viewCenterWorld() { const r = canvas.getBoundingClientRect(); return { x: (r.width / 2 - panX) / zoom, y: (r.height / 2 - panY) / zoom }; }
    function removeSelected() {
      const ids = sel.filter(function (id) { return id !== sheet.root.id; });
      if (!ids.length) return;
      let next = null;
      mutate(function () {
        ids.forEach(function (id) {
          const p = parentOf(sheet, id);
          if (p) { const i = p.children.findIndex(function (c) { return c.id === id; }); if (i >= 0) { p.children.splice(i, 1); next = p.children[Math.min(i, p.children.length - 1)] ? p.children[Math.min(i, p.children.length - 1)].id : p.id; fixRanges(p, i); } }
          else { const fi = sheet.floating.findIndex(function (f) { return f.id === id; }); if (fi >= 0) sheet.floating.splice(fi, 1); next = sheet.root.id; }
        });
        // 關聯／外框／摘要若指到不存在的主題就拿掉
        sheet.rels = sheet.rels.filter(function (r) { return findTopic(sheet, r.from) && findTopic(sheet, r.to); });
        sheet.bounds = sheet.bounds.filter(function (b) { const p = findTopic(sheet, b.topic); return p && p.children.length > b.from; });
        sheet.sums = sheet.sums.filter(function (b) { const p = findTopic(sheet, b.topic); return p && p.children.length > b.from; });
      });
      select(next ? [next] : []);
    }
    // 刪掉第 i 個子主題之後，外框／摘要的範圍跟著縮
    function fixRanges(p, i) {
      [sheet.bounds, sheet.sums].forEach(function (list) {
        list.forEach(function (r) { if (r.topic !== p.id) return; if (i < r.from) { r.from--; r.to--; } else if (i <= r.to) r.to--; });
      });
    }
    function toggleCollapse(id) { const t = findTopic(sheet, id); if (!t || !t.children.length) return; mutate(function () { t.collapsed = !t.collapsed; }); }
    function reparent(id, targetId) {
      const t = findTopic(sheet, id), target = findTopic(sheet, targetId);
      if (!t || !target || t === sheet.root || isDescendant(t, targetId)) return;
      mutate(function () {
        detach(id);
        delete t.x; delete t.y;
        target.children.push(t); target.collapsed = false;
      });
    }
    function detach(id) {
      const p = parentOf(sheet, id);
      if (p) { const i = p.children.findIndex(function (c) { return c.id === id; }); p.children.splice(i, 1); fixRanges(p, i); }
      else { const fi = sheet.floating.findIndex(function (f) { return f.id === id; }); if (fi >= 0) sheet.floating.splice(fi, 1); }
    }
    function makeFloating(id, w) {
      const t = findTopic(sheet, id);
      if (!t || t === sheet.root) return;
      mutate(function () { detach(id); t.x = w.x; t.y = w.y; sheet.floating.push(t); });
    }
    function copySelected() { const t = sel.length === 1 && findTopic(sheet, sel[0]); if (!t) return false; clipboard = JSON.stringify(t); return true; }
    function paste() {
      if (!clipboard) return;
      const target = sel.length === 1 && findTopic(sheet, sel[0]);
      if (!target) return;
      let made = null;
      mutate(function () { made = cloneTopic(JSON.parse(clipboard)); delete made.x; delete made.y; target.children.push(made); target.collapsed = false; });
      select([made.id]);
    }
    function setMarker(id, mk) {
      const t = findTopic(sheet, id); if (!t) return;
      const g = MARKER_GROUPS.find(function (x) { return x.key === mk.split(':')[0]; });
      mutate(function () {
        const had = t.markers.indexOf(mk) >= 0;
        if (g.single) t.markers = t.markers.filter(function (m) { return m.split(':')[0] !== g.key; });
        else t.markers = t.markers.filter(function (m) { return m !== mk; });
        if (!had) t.markers.push(mk);
      });
    }
    function addBoundary(asSummary) {
      const r = sameParentRange(); if (!r) return;
      mutate(function () {
        const item = { id: uid(asSummary ? 'm' : 'b'), topic: r.parent.id, from: r.from, to: r.to, title: asSummary ? '摘要' : '' };
        (asSummary ? sheet.sums : sheet.bounds).push(item);
      });
    }

    // ---- 就地改字 ----
    function startEdit(id, replace, sumId) {
      commitEdit();
      const b = id ? L.byId[id] : null;
      let box, value;
      if (b) { box = { x: b.x, y: b.y, w: Math.max(b.w, 90), h: b.h - (b.m.labelsH || 0) }; value = b.t.title; }
      else if (sumId) { const r = L.sums.find(function (x) { return x.sm.id === sumId; }); if (!r || !r.box) return; box = r.box; value = r.sm.title; }
      else return;
      const rc = stage.getBoundingClientRect();
      const ta = el('textarea', 'xm-edit');
      ta.value = replace ? '' : value;
      ta.style.left = rc.left + panX + box.x * zoom + 'px'; ta.style.top = rc.top + panY + box.y * zoom + 'px';
      ta.style.width = Math.max(90, box.w * zoom + 8) + 'px'; ta.style.height = Math.max(28, box.h * zoom) + 'px';
      ta.style.fontSize = clamp((b ? b.m.fs : 13) * zoom, 10, 48) + 'px';
      host.appendChild(ta);
      editing = { id: id, sumId: sumId, el: ta, done: false, orig: value };
      ta.focus(); if (!replace) ta.select();
      ta.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); const theId = id; commitEdit(); canvas.focus(); if (theId && e.ctrlKey === false && !sumId) { /* XMind：Enter 收起後再按一次 Enter 才是同階 */ } }
        else if (e.key === 'Tab') { e.preventDefault(); const theId = id; commitEdit(); if (theId) addChild(theId); }
      });
      ta.addEventListener('blur', function () { commitEdit(); });
      ta.addEventListener('input', function () { ta.style.height = 'auto'; ta.style.height = Math.max(28, ta.scrollHeight) + 'px'; });
    }
    function cancelEdit() { if (!editing) return; editing.done = true; const ed = editing; editing = null; ed.el.remove(); if (ed.el.value === '' && ed.orig === '' && ed.id) { const t = findTopic(sheet, ed.id); if (t && !t.title) { /* 新主題沒打字：留空白標題 */ } } canvas.focus(); }
    function commitEdit() {
      if (!editing || editing.done) return;
      editing.done = true;
      const ed = editing; editing = null; ed.el.remove();
      const v = ed.el.value.replace(/\s+$/, '');
      if (ed.sumId) { const sm = sheet.sums.find(function (x) { return x.id === ed.sumId; }); if (sm && sm.title !== v) mutate(function () { sm.title = v || '摘要'; }); return; }
      const t = findTopic(sheet, ed.id);
      if (!t) return;
      if (t.title !== v) mutate(function () { t.title = v; });
    }

    // ---- 滑鼠 ----
    function onDown(e) {
      closeMenu();
      if (editing) commitEdit();
      canvas.focus();
      const w = toWorld(e);
      const tEl = e.target.closest ? e.target.closest('.xm-topic') : null;
      const fold = e.target.closest ? e.target.closest('[data-fold]') : null;
      const relEl = e.target.closest ? e.target.closest('.xm-rel') : null;
      const sumEl = e.target.closest ? e.target.closest('.xm-sum') : null;
      const noteIc = e.target.closest ? e.target.closest('[data-note]') : null;
      const linkIc = e.target.closest ? e.target.closest('[data-link]') : null;
      if (e.button === 1 || e.button === 2 || (e.button === 0 && !tEl && !relEl && !sumEl)) {
        gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false, right: e.button === 2, hitId: tEl ? tEl.getAttribute('data-id') : null };
        canvas.classList.add('is-panning'); e.preventDefault();
        if (e.button === 0 && !e.shiftKey && sel.length && !ro) { /* 點空白：取消選取（放開時） */ gesture.clearSel = true; }
        return;
      }
      if (e.button !== 0) return;
      if (fold && !ro) { e.preventDefault(); toggleCollapse(fold.getAttribute('data-fold')); return; }
      if (linkIc) { e.preventDefault(); const u = linkIc.getAttribute('data-link'); if (/^#note\//.test(u)) { if (opts.onOpenLink) opts.onOpenLink(u); } else window.open(u, '_blank', 'noopener'); return; }
      if (sumEl) {
        e.preventDefault();
        if (e.detail === 2 && !ro) startEdit(null, false, sumEl.getAttribute('data-sum'));
        else if (!ro) { gesture = { type: 'sumsel', id: sumEl.getAttribute('data-sum') }; }
        return;
      }
      if (relEl) {
        e.preventDefault();
        if (!ro) { const id = relEl.getAttribute('data-rel'); if (e.detail === 2) editRel(id); else selRel = id; render(); }
        return;
      }
      const id = tEl.getAttribute('data-id');
      if (mode === 'rel' && !ro) {
        e.preventDefault();
        if (!mode_from) { mode_from = id; renderOverlay(); setStatus('再點另一個主題'); }
        else if (mode_from !== id) { const from = mode_from; mode_from = null; mode = null; mutate(function () { sheet.rels.push({ id: uid('r'), from: from, to: id, title: '' }); }); setStatus('已加上關聯', 'is-ok'); }
        return;
      }
      if (e.detail === 2 && !ro) { e.preventDefault(); if (noteIc) { select([id]); formatFocus = 'notes'; renderFormat(); return; } select([id]); startEdit(id, false); return; }
      if (e.shiftKey || e.ctrlKey || e.metaKey) sel = sel.indexOf(id) >= 0 ? sel.filter(function (x) { return x !== id; }) : sel.concat([id]);
      else if (sel.indexOf(id) < 0) sel = [id];
      gesture = ro ? null : { type: 'drag', id: id, sx: e.clientX, sy: e.clientY, w0: w, moved: false, target: null, gx: 0, gy: 0 };
      render(); renderFormat(); renderOutline();
      e.preventDefault();
    }
    let selRel = null, formatFocus = null;
    function onMove(e) {
      if (!gesture) return;
      if (gesture.type === 'pan') {
        if (Math.abs(e.clientX - gesture.sx) + Math.abs(e.clientY - gesture.sy) > 3) gesture.moved = true;
        panX = gesture.px + (e.clientX - gesture.sx); panY = gesture.py + (e.clientY - gesture.sy); render(); return;
      }
      if (gesture.type === 'drag') {
        if (!gesture.moved && Math.abs(e.clientX - gesture.sx) + Math.abs(e.clientY - gesture.sy) < 5) return;
        gesture.moved = true;
        const w = toWorld(e), b = L.byId[gesture.id];
        gesture.gx = b.x + (w.x - gesture.w0.x); gesture.gy = b.y + (w.y - gesture.w0.y);
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const tEl = under && under.closest ? under.closest('.xm-topic') : null;
        const tid = tEl ? tEl.getAttribute('data-id') : null;
        gesture.target = tid && tid !== gesture.id && !isDescendant(findTopic(sheet, gesture.id), tid) ? tid : null;
        gesture.w = w;
        renderOverlay();
      }
    }
    function onUp(e) {
      if (!gesture) return;
      const g = gesture; gesture = null;
      canvas.classList.remove('is-panning');
      if (g.type === 'pan') {
        if (g.right && !g.moved) { openContextMenu(e.clientX, e.clientY, g.hitId, toWorld(e)); return; }
        if (!g.moved && g.clearSel) { if (mode === 'rel') { mode = null; mode_from = null; setStatus(''); } selRel = null; select([]); }
        return;
      }
      if (g.type === 'sumsel') return;
      if (g.type === 'drag') {
        if (g.moved) {
          if (g.target) reparent(g.id, g.target);
          else if (g.id !== sheet.root.id) makeFloating(g.id, { x: g.gx, y: g.gy });
          else render();
        } else render();
      }
    }
    stage.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    host.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (editing) commitEdit();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      else { if (e.shiftKey) panX -= e.deltaY; else { panX -= e.deltaX; panY -= e.deltaY; } render(); }
    }, { passive: false });

    // ---- 鍵盤（XMind 的習慣）----
    function onKey(e) {
      if (editing || ro) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      const one = sel.length === 1 ? sel[0] : null;
      if (e.key === 'Tab') { e.preventDefault(); if (one) addChild(one); return; }
      if (e.key === 'Enter' && !mod) { e.preventDefault(); if (one) { if (one === sheet.root.id) addChild(one); else addSibling(one); } return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (selRel) { const id = selRel; selRel = null; mutate(function () { sheet.rels = sheet.rels.filter(function (r) { return r.id !== id; }); }); } else removeSelected(); return; }
      if (e.key === 'F2') { e.preventDefault(); if (one) startEdit(one, false); return; }
      if (e.key === ' ') { e.preventDefault(); if (one) toggleCollapse(one); return; }
      if (e.key === 'Escape') { if (menuEl) closeMenu(); else if (mode) { mode = null; mode_from = null; setStatus(''); renderOverlay(); refreshToolbar(); } else if (sel.length) { e.preventDefault(); e.stopPropagation(); select([]); } return; }
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if (mod && k === 'y') { e.preventDefault(); doRedo(); return; }
      if (mod && k === 'c') { e.preventDefault(); copySelected(); return; }
      if (mod && k === 'v') { e.preventDefault(); paste(); return; }
      if (mod && k === 'd') { e.preventDefault(); if (copySelected()) { const t = findTopic(sheet, one), p = parentOf(sheet, t.id); if (p) { let made = null; mutate(function () { made = cloneTopic(t); p.children.splice(p.children.indexOf(t) + 1, 0, made); }); select([made.id]); } } return; }
      if (e.key.indexOf('Arrow') === 0 && one) { e.preventDefault(); navigate(one, e.key); return; }
      // 選取著直接打字＝取代文字（XMind 的習慣）；輸入法開始組字時 key 是 'Process'，一樣先把輸入框叫出來讓組字落進去
      if (!mod && !e.altKey && (e.key.length === 1 || e.key === 'Process') && one) { startEdit(one, true); }
    }
    // 方向鍵：左右是父／子（看在哪一側），上下是同階
    function navigate(id, key) {
      const b = L.byId[id]; if (!b) return;
      const t = b.t, p = parentOf(sheet, id);
      const dir = b.dir || 1;
      const toChild = function () { const kids = t.collapsed ? [] : t.children; if (kids.length) select([kids[Math.floor((kids.length - 1) / 2)].id]); };
      const toParent = function () { if (p) select([p.id]); };
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        if (sheet.structure === 'org-down' || sheet.structure === 'tree-right') { if (key === 'ArrowDown') toChild(); else toParent(); return; }
        if (!p) return;
        const i = p.children.indexOf(t) + (key === 'ArrowUp' ? -1 : 1);
        if (p.children[i]) select([p.children[i].id]);
        return;
      }
      if (sheet.structure === 'org-down' || sheet.structure === 'tree-right') { if (!p) return; const i = p.children.indexOf(t) + (key === 'ArrowLeft' ? -1 : 1); if (p.children[i]) select([p.children[i].id]); return; }
      if (t === sheet.root) { const kids = t.children; const side = kids.filter(function (c, i) { return (L.byId[c.id] || {}).dir === (key === 'ArrowRight' ? 1 : -1); }); if (side.length) select([side[Math.floor((side.length - 1) / 2)].id]); return; }
      if ((key === 'ArrowRight') === (dir > 0)) toChild(); else toParent();
    }
    host.addEventListener('keydown', onKey);

    // ---- 工具列 ----
    const toolbar = host.querySelector('.xm-toolbar');
    if (toolbar) {
      toolbar.addEventListener('click', function (e) {
        const b = e.target.closest('[data-act]'); if (!b || b.disabled) return;
        act(b.getAttribute('data-act'), b);
      });
      toolbar.querySelector('[data-sel="structure"]').addEventListener('change', function (e) { mutate(function () { sheet.structure = e.target.value; }); fit(); });
      toolbar.querySelector('[data-sel="theme"]').addEventListener('change', function (e) { mutate(function () { sheet.theme = e.target.value; }); });
    }
    function act(a, btn) {
      const one = sel.length === 1 ? sel[0] : null;
      switch (a) {
        case 'child': if (one) addChild(one); break;
        case 'sibling': if (one) addSibling(one); break;
        case 'float': addFloating(); break;
        case 'rel': mode = mode === 'rel' ? null : 'rel'; mode_from = null; setStatus(mode ? '點第一個主題' : ''); refreshToolbar(); renderOverlay(); break;
        case 'bound': addBoundary(false); break;
        case 'sum': addBoundary(true); break;
        case 'notes': formatFocus = 'notes'; renderFormat(); break;
        case 'label': formatFocus = 'labels'; renderFormat(); break;
        case 'link': formatFocus = 'link'; renderFormat(); break;
        case 'marker': if (one) markerPop(btn, one); break;
        case 'outline': outlineOpen = !outlineOpen; outlineEl.hidden = !outlineOpen; renderOutline(); refreshToolbar(); break;
        case 'undo': doUndo(); break;
        case 'redo': doRedo(); break;
        case 'zoomin': { const r = canvas.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, zoom * 1.25); break; }
        case 'zoomout': { const r = canvas.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, zoom / 1.25); break; }
        case 'zoom100': { const r = canvas.getBoundingClientRect(); zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1); break; }
        case 'fit': fit(); break;
        case 'export': exportMenu(btn); break;
      }
      canvas.focus();
    }
    function fileBase() { const t = opts.getTitle ? opts.getTitle() : opts.title; return (String(t || '').trim() || '心智圖').replace(/[\\/:*?"<>|]+/g, '_') + (doc.sheets.length > 1 ? '-' + sheet.name.replace(/[\\/:*?"<>|]+/g, '_') : ''); }
    function download(name, blob) { const a = document.createElement('a'); const url = URL.createObjectURL(blob); a.href = url; a.download = name; a.style.cssText = 'position:fixed;left:-9999px;top:0'; document.body.appendChild(a); a.click(); setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000); }
    function exportMenu(btn) {
      const r = btn.getBoundingClientRect();
      openMenu(r.left, r.bottom + 4, [
        ['png', '匯出 PNG'], ['svg', '匯出 SVG'], ['md', '匯出 Markdown 大綱'], ['txt', '匯出純文字大綱']
      ], function (a) {
        if (a === 'svg') download(fileBase() + '.svg', new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + renderSheet(sheet)], { type: 'image/svg+xml' }));
        else if (a === 'png') { const svg = renderSheet(sheet); const m = /width="(\d+)" height="(\d+)"/.exec(svg); const W = +m[1], H = +m[2], img = new Image(); img.onload = function () { const c = document.createElement('canvas'); c.width = W * 2; c.height = H * 2; const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height); c.toBlob(function (bl) { if (bl) download(fileBase() + '.png', bl); }, 'image/png'); }; img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))); }
        else if (a === 'md') download(fileBase() + '.md', new Blob([outlineMarkdown(sheet)], { type: 'text/markdown' }));
        else if (a === 'txt') download(fileBase() + '.txt', new Blob([outlineMarkdown(sheet).replace(/^# /m, '').replace(/^(\s*)- /gm, '$1')], { type: 'text/plain' }));
      });
    }
    function openMenu(x, y, items, onPick) { menuAt(x, y, items, onPick); }
    function openContextMenu(x, y, hitId, w) {
      if (ro) return;
      if (hitId && sel.indexOf(hitId) < 0) select([hitId]);
      const one = sel.length === 1 ? findTopic(sheet, sel[0]) : null;
      const items = hitId ? [
        ['child', '新增子主題', !one], ['sibling', '新增同階主題', !one || one === sheet.root], ['edit', '編輯文字', !one], null,
        ['bound', '外框', !sameParentRange()], ['sum', '摘要', !sameParentRange()], ['rel', '關聯…', !one], null,
        ['fold', one && one.collapsed ? '展開' : '收合', !one || !one.children.length], ['copy', '複製', !one], ['paste', '貼上為子主題', !clipboard || !one], null,
        ['delete', '刪除', !one || one === sheet.root]
      ] : [['float', '新增自由主題'], ['paste-float', '貼上', !clipboard], null, ['fit', '符合視窗']];
      openMenu(x, y, items, function (a) {
        if (a === 'edit') startEdit(sel[0], false);
        else if (a === 'fold') toggleCollapse(sel[0]);
        else if (a === 'delete') removeSelected();
        else if (a === 'copy') copySelected();
        else if (a === 'paste') paste();
        else if (a === 'paste-float') { if (clipboard) { let made = null; mutate(function () { made = cloneTopic(JSON.parse(clipboard)); made.x = w.x; made.y = w.y; sheet.floating.push(made); }); select([made.id]); } }
        else if (a === 'float') addFloating(w);
        else act(a);
      });
    }
    function editRel(id) {
      const rel = sheet.rels.find(function (r) { return r.id === id; }); if (!rel) return;
      const ask = global.App && App.prompt ? App.prompt({ title: '關聯線的文字', placeholder: '例如：導致、參考', value: rel.title, ok: '確定' }) : Promise.resolve(window.prompt('關聯線的文字', rel.title));
      ask.then(function (v) { if (v === null || v === undefined) return; mutate(function () { rel.title = String(v).trim().slice(0, 200); }); });
    }
    // 標記挑選（XMind 的標記面板：分組）
    function markerPop(anchor, id) {
      closeMenu();
      const t = findTopic(sheet, id); if (!t) return;
      menuEl = el('div', 'xm-menu xm-markers');
      menuEl.setAttribute('data-markers', '1');
      menuEl.innerHTML = MARKER_GROUPS.map(function (g) {
        return '<div class="xm-mk-group"><div class="xm-mk-t">' + g.name + '</div><div class="xm-mk-grid">' + g.items.map(function (v) {
          const mk = g.key + ':' + v, on = t.markers.indexOf(mk) >= 0;
          return '<button class="xm-mk' + (on ? ' on' : '') + '" type="button" data-mk="' + mk + '" title="' + g.name + ' ' + v + '"><svg viewBox="0 0 18 18" width="18" height="18">' + markerSVG(mk, 1, 1, 16) + '</svg></button>';
        }).join('') + '</div></div>';
      }).join('') + '<button class="xm-menu-item" type="button" data-a="clear">清除全部標記</button>';
      document.body.appendChild(menuEl);
      const r = anchor.getBoundingClientRect();
      menuEl.style.left = Math.max(4, Math.min(r.left, window.innerWidth - menuEl.offsetWidth - 4)) + 'px'; menuEl.style.top = (r.bottom + 4) + 'px';
      menuEl.addEventListener('click', function (e) {
        const b = e.target.closest('[data-mk]'); const c = e.target.closest('[data-a="clear"]');
        if (b) { setMarker(id, b.getAttribute('data-mk')); b.classList.toggle('on'); menuEl.querySelectorAll('[data-mk]').forEach(function (x) { const mk = x.getAttribute('data-mk'); x.classList.toggle('on', (findTopic(sheet, id) || { markers: [] }).markers.indexOf(mk) >= 0); }); }
        else if (c) { mutate(function () { t.markers = []; }); closeMenu(); }
      });
    }

    // ---- 格式面板 ----
    function renderFormat() {
      if (!formatEl) return;
      const t = sel.length === 1 ? findTopic(sheet, sel[0]) : null;
      if (!t) {
        formatEl.innerHTML = '<div class="xm-tabs"><span class="xm-tab on">心智圖</span></div><div class="xm-panel">' +
          '<div class="xm-grp">結構</div><div class="xm-row"><select class="xm-input" data-prop="structure">' + STRUCTURES.map(function (x) { return '<option value="' + x[0] + '"' + (x[0] === sheet.structure ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>' +
          '<div class="xm-grp">主題（配色）</div><div class="xm-themes">' + Object.keys(THEMES).map(function (k) { const th = THEMES[k]; return '<button type="button" class="xm-theme' + (k === sheet.theme ? ' on' : '') + '" data-theme="' + k + '" title="' + th.name + '"><span style="background:' + th.bg + ';border-color:' + th.root.fill + '"><i style="background:' + th.root.fill + '"></i>' + th.branch.slice(0, 4).map(function (c) { return '<b style="background:' + c + '"></b>'; }).join('') + '</span><small>' + th.name + '</small></button>'; }).join('') + '</div>' +
          '<div class="xm-grp">統計</div><div class="xm-row xm-dim">' + (countAll(sheet.root) + 1) + ' 個主題・' + sheet.floating.length + ' 個自由主題・' + sheet.rels.length + ' 條關聯</div>' +
          '<div class="xm-grp">操作</div><div class="xm-help">Tab 子主題　Enter 同階主題<br>雙擊／F2／直接打字：改文字<br>空白鍵：收合／展開　方向鍵：移動<br>拖主題到別的主題上：變成它的子主題<br>拖到空白處：自由主題<br>滾輪：捲動　Ctrl+滾輪：縮放　拖空白處：平移</div></div>';
        formatEl.querySelector('[data-prop="structure"]').addEventListener('change', function (e) { mutate(function () { sheet.structure = e.target.value; }); fit(); });
        formatEl.querySelectorAll('[data-theme]').forEach(function (b) { b.addEventListener('click', function () { mutate(function () { sheet.theme = b.getAttribute('data-theme'); }); }); });
        return;
      }
      const depth = (L.byId[t.id] || {}).depth || 0;
      const theme = themeOf(sheet.theme);
      const curFill = t.style.fill || (depth === 0 ? theme.root.fill : depth === 1 ? (L.byId[t.id] || {}).color || '#888888' : '#ffffff');
      const curColor = t.style.color || (depth === 0 ? theme.root.color : depth === 1 ? theme.mainColor : theme.subColor);
      formatEl.innerHTML = '<div class="xm-tabs"><span class="xm-tab on">主題</span></div><div class="xm-panel">' +
        '<div class="xm-grp">文字</div>' +
        '<div class="xm-row"><label>字級</label><input class="xm-input xm-num" type="number" min="8" max="72" data-prop="fs" value="' + fsOf(t, depth) + '"></div>' +
        '<div class="xm-row"><label>粗體</label><input type="checkbox" data-prop="bold"' + (t.style.bold || depth === 0 ? ' checked' : '') + '></div>' +
        '<div class="xm-row"><label>文字顏色</label><input type="color" class="xm-color" data-prop="color" value="' + esc(curColor.length === 7 ? curColor : '#333333') + '"></div>' +
        '<div class="xm-grp">形狀</div>' +
        '<div class="xm-row"><select class="xm-input" data-prop="shape">' + [['', '依主題'], ['round', '圓角矩形'], ['rect', '矩形'], ['pill', '膠囊'], ['ellipse', '橢圓'], ['underline', '底線'], ['plain', '純文字']].map(function (x) { return '<option value="' + x[0] + '"' + ((t.style.shape || '') === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select></div>' +
        '<div class="xm-row"><label>填色</label><input type="color" class="xm-color" data-prop="fill" value="' + esc(/^#[0-9a-f]{6}$/i.test(curFill) ? curFill : '#ffffff') + '"><button type="button" class="xm-btn" data-act2="clearfill">清除</button></div>' +
        '<div class="xm-row"><label>線條顏色</label><input type="color" class="xm-color" data-prop="stroke" value="' + esc(t.style.stroke || '#888888') + '"><button type="button" class="xm-btn" data-act2="clearstroke">清除</button></div>' +
        '<div class="xm-grp">標記</div><div class="xm-row xm-mkrow">' + (t.markers.length ? t.markers.map(function (mk) { return '<svg viewBox="0 0 18 18" width="18" height="18">' + markerSVG(mk, 1, 1, 16) + '</svg>'; }).join('') : '<span class="xm-dim">沒有</span>') + '<button type="button" class="xm-btn" data-act2="markers">選擇…</button></div>' +
        '<div class="xm-grp">備註</div><textarea class="xm-input xm-notes" data-prop="notes" rows="4" placeholder="這個主題的備註…">' + esc(t.notes) + '</textarea>' +
        '<div class="xm-grp">標籤</div><input class="xm-input" type="text" data-prop="labels" placeholder="用逗號分開，例如：重要, 待辦" value="' + esc(t.labels.join(', ')) + '">' +
        '<div class="xm-grp">超連結</div><input class="xm-input" type="url" data-prop="link" placeholder="https://… 或 #note/<id>" value="' + esc(t.link) + '">' +
        '</div>';
      formatEl.querySelectorAll('[data-prop]').forEach(function (inp) {
        const prop = inp.getAttribute('data-prop');
        const apply = function () {
          mutate(function () {
            if (prop === 'fs') t.style.fs = clamp(parseInt(inp.value, 10) || 13, 8, 72);
            else if (prop === 'bold') { if (inp.checked) t.style.bold = 1; else delete t.style.bold; }
            else if (prop === 'color' || prop === 'fill' || prop === 'stroke') t.style[prop] = inp.value;
            else if (prop === 'shape') { if (inp.value) t.style.shape = inp.value; else delete t.style.shape; }
            else if (prop === 'notes') t.notes = inp.value.slice(0, 5000);
            else if (prop === 'labels') t.labels = inp.value.split(/[,，]/).map(function (x) { return x.trim().slice(0, 60); }).filter(Boolean);
            else if (prop === 'link') { const v = inp.value.trim(); t.link = /^(https?:\/\/|#note\/|mailto:)/i.test(v) ? v : (v ? 'https://' + v : ''); }
          });
        };
        inp.addEventListener('change', apply);
        if (prop === 'notes') { let tm = null; inp.addEventListener('input', function () { clearTimeout(tm); tm = setTimeout(function () { t.notes = inp.value.slice(0, 5000); changed(); render(); }, 400); }); }
        inp.addEventListener('keydown', function (e) { e.stopPropagation(); });
      });
      formatEl.querySelectorAll('[data-act2]').forEach(function (b) {
        b.addEventListener('click', function () {
          const a = b.getAttribute('data-act2');
          if (a === 'clearfill') mutate(function () { delete t.style.fill; });
          else if (a === 'clearstroke') mutate(function () { delete t.style.stroke; });
          else if (a === 'markers') markerPop(b, t.id);
        });
      });
      if (formatFocus) { const f = formatEl.querySelector('[data-prop="' + formatFocus + '"]'); if (f) { f.focus(); } formatFocus = null; }
    }
    // ---- 大綱 ----
    function renderOutline() {
      if (!outlineEl || outlineEl.hidden) return;
      let h = '<div class="xm-ol-t">大綱</div>';
      const rec = function (t, d) {
        h += '<div class="xm-ol-row' + (sel.indexOf(t.id) >= 0 ? ' on' : '') + '" data-id="' + esc(t.id) + '" style="padding-left:' + (8 + d * 14) + 'px">' + (t.children.length ? '<span class="xm-ol-tw">' + (t.collapsed ? '▸' : '▾') + '</span>' : '<span class="xm-ol-tw"></span>') + '<span>' + esc(t.title || '（空白）') + '</span></div>';
        if (!t.collapsed) t.children.forEach(function (c) { rec(c, d + 1); });
      };
      rec(sheet.root, 0);
      sheet.floating.forEach(function (f) { h += '<div class="xm-ol-sec">自由主題</div>'; rec(f, 0); });
      outlineEl.innerHTML = h;
    }
    if (outlineEl) outlineEl.addEventListener('click', function (e) {
      const row = e.target.closest('[data-id]'); if (!row) return;
      const id = row.getAttribute('data-id');
      if (e.target.closest('.xm-ol-tw') && findTopic(sheet, id).children.length) { toggleCollapse(id); return; }
      select([id]); centerOn(id);
    });
    // ---- 工作表 ----
    function renderTabs() {
      if (!stabs) return;
      stabs.innerHTML = doc.sheets.map(function (s, i) { return '<button class="xm-stab' + (i === si ? ' on' : '') + '" type="button" data-sheet="' + i + '" title="' + esc(s.name) + '（雙擊改名、右鍵更多）">' + esc(s.name) + '</button>'; }).join('');
    }
    function showSheet(i) {
      if (editing) commitEdit();
      views[sheet.id] = { zoom: zoom, panX: panX, panY: panY };
      si = clamp(i, 0, doc.sheets.length - 1); sheet = doc.sheets[si]; sel = []; selRel = null;
      const v = views[sheet.id];
      if (v) { zoom = v.zoom; panX = v.panX; panY = v.panY; render(); } else fit();
      renderTabs(); renderFormat(); renderOutline();
    }
    const sheetsBar = host.querySelector('.xm-sheets');
    if (sheetsBar) {
      sheetsBar.addEventListener('click', function (e) {
        if (e.target.closest('.xm-sadd')) { const b = begin(); doc.sheets.splice(si + 1, 0, newSheet('工作表 ' + (doc.sheets.length + 1))); commit(b); showSheet(si + 1); return; }
        const t = e.target.closest('[data-sheet]'); if (!t) return;
        const i = parseInt(t.getAttribute('data-sheet'), 10);
        if (e.detail === 2) renameSheet(i); else if (i !== si) showSheet(i);
      });
      sheetsBar.addEventListener('contextmenu', function (e) {
        const t = e.target.closest('[data-sheet]'); if (!t) return;
        e.preventDefault(); e.stopPropagation();
        const i = parseInt(t.getAttribute('data-sheet'), 10);
        openMenu(e.clientX, e.clientY, [['add', '新增工作表'], ['dup', '複製工作表'], ['ren', '重新命名'], null, ['del', '刪除工作表', doc.sheets.length < 2]], function (a) {
          if (a === 'add') { const b = begin(); doc.sheets.splice(i + 1, 0, newSheet('工作表 ' + (doc.sheets.length + 1))); commit(b); showSheet(i + 1); }
          else if (a === 'dup') { const b = begin(); const c = parse(serialize({ sheets: [doc.sheets[i]] })).sheets[0]; c.id = uid('s'); c.name = doc.sheets[i].name + ' 複本'; walk(c.root, function (x) { x.id = uid('t'); }); doc.sheets.splice(i + 1, 0, c); commit(b); showSheet(i + 1); }
          else if (a === 'ren') renameSheet(i);
          else if (a === 'del') { const name = doc.sheets[i].name; const ask = global.App && App.confirm ? App.confirm({ title: '刪除工作表', message: '刪除「' + name + '」？（可以復原）', ok: '刪除', danger: true }) : Promise.resolve(window.confirm('刪除？')); ask.then(function (yes) { if (!yes) return; const b = begin(); doc.sheets.splice(i, 1); commit(b); showSheet(Math.min(i, doc.sheets.length - 1)); }); }
        });
      });
    }
    function renameSheet(i) {
      const s = doc.sheets[i];
      const ask = global.App && App.prompt ? App.prompt({ title: '重新命名工作表', placeholder: '名稱', value: s.name, ok: '確定' }) : Promise.resolve(window.prompt('名稱', s.name));
      ask.then(function (v) { v = String(v || '').trim().slice(0, 80); if (!v || v === s.name) return; const b = begin(); s.name = v; commit(b); renderTabs(); });
    }

    function onResize() { if (!closed) render(); }
    window.addEventListener('resize', onResize);
    function teardown() {
      clearTimeout(saveTimer); closeMenu();
      if (editing) { editing.done = true; editing.el.remove(); editing = null; }
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); window.removeEventListener('resize', onResize);
      host.innerHTML = ''; host.classList.remove('xm-page');
    }
    function close() { if (closed) return; if (editing) commitEdit(); emit(); closed = true; teardown(); if (opts.onClose) opts.onClose(); }
    function discard() { if (closed) return; closed = true; dirty = false; teardown(); }
    function flush() { if (closed) return Promise.resolve(); if (editing) commitEdit(); if (!dirty) return Promise.resolve(); return emit(); }

    renderTabs(); renderFormat();
    requestAnimationFrame(function () { if (!closed) { fit(); if (content) setStatus('已儲存', 'is-ok'); } });
    setTimeout(function () { if (!closed) canvas.focus(); }, 30);
    return { close: close, requestClose: close, discard: discard, flush: flush, setContent: function (c) { doc = parse(payloadOf(c) || ''); si = 0; sheet = doc.sheets[0]; sel = []; renderTabs(); fit(); renderFormat(); renderOutline(); } };
  }

  global.XMind = { isNote: isNote, renderIndex: renderIndex, generate: generate, parse: parse, serialize: serialize, payloadOf: payloadOf, wrap: wrap, renderSVG: renderSVG, renderSheet: renderSheet, blockHTML: blockHTML, htmlOf: htmlOf, open: open, layoutSheet: layoutSheet, THEMES: THEMES, STRUCTURES: STRUCTURES, outlineMarkdown: outlineMarkdown };
})(window);

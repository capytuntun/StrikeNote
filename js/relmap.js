/* relmap.js — 關聯分析：自由畫布的節點／連線圖，像簡化版的 React Flow。
 *
 * 跟心智圖（mindmap.js）同一個哲學：一段純文字 DSL 是唯一的真實來源——可搜尋、
 * 可合併、版本歷史看得懂——每次渲染都從它重新算出 SVG。差別是心智圖的大綱只能
 * 表達樹狀關係，位置是自動排出來的；這裡的圖是自由的（任意節點連任意節點），
 * 所以每個節點的位置也得存下來，不能重新算：
 *
 *   ```relmap
 *   node n1 "弱點A" x=40 y=40 color=red
 *   node n2 "主機1" x=280 y=40
 *   edge n1 n2 "利用"
 *   ```
 *
 * 畫面照著使用者給的參考圖做（深色畫布上的關聯網）：節點是白色圓盤＋彩色圓環，
 * 盤裡是標籤的第一個字當作「圖示」（參考圖裡那是各網站的 favicon，這裡沒有圖片，
 * 拿標籤首字最貼近、也最看得出是哪一顆），完整標籤放在圓盤下方；連線是彎的虛線，
 * 顏色以橘棕為主、零星幾條藍紅紫青，全由 id 雜湊決定所以每次畫都一樣。畫布不分
 * 主題一律深色——跟程式碼區塊、Markdown 編輯器一樣是「畫布類」表面；列印時由
 * pdf.js 用自己的樣式表換成白底（所有顏色都走 class，沒有 inline，pdf.js 才蓋得掉）。
 *
 * `RelMap.open(text, onSave)` 開一個全螢幕編輯器（跟 MindMap.open 同一種疊層），
 * `RelMap.renderSVG(text)` 是唯讀渲染，預覽、PDF、電子書都呼叫這個——編輯器內部
 * 也是用同一份佈局／畫圖邏輯，畫面看到的東西不會因為在哪裡渲染而不一樣。
 *
 * 「多一種筆記」的部分（meta.relMap）在 app.js：開啟這種筆記直接進全螢幕編輯器，
 * 不用先點一下；新增筆記的下拉選單裡也有「關聯分析」範本。
 */
(function (global) {
  'use strict';

  // ---------------- DSL：剖析 / 序列化 ----------------------------------------
  // 一行一個 token：`"引號內含空白"` 當一個 token，其餘以空白分隔。
  function tokenize(line) {
    const out = [];
    const re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1] : m[2]);
    return out;
  }
  function attrsOf(tokens) {
    const a = {};
    tokens.forEach(function (t) {
      const i = t.indexOf('=');
      if (i > 0) a[t.slice(0, i)] = t.slice(i + 1);
    });
    return a;
  }
  function quote(s) { return '"' + String(s || '').replace(/"/g, '\\"') + '"'; }

  function parse(text) {
    const nodes = [], edges = [];
    String(text || '').split('\n').forEach(function (raw) {
      const line = raw.trim();
      if (!line || line[0] === '#') return;
      const t = tokenize(line);
      if (t[0] === 'node' && t[1]) {
        const attrs = attrsOf(t.slice(3));
        nodes.push({
          id: t[1], label: t[2] || '',
          x: attrs.x ? parseFloat(attrs.x) : 0, y: attrs.y ? parseFloat(attrs.y) : 0,
          color: attrs.color || '', shape: attrs.shape || ''
        });
      } else if (t[0] === 'edge' && t[1] && t[2]) {
        // 標籤是第 4 個 token，但只在它不是 key=value 的時候算——沒有標籤時
        // edge 後面可能直接接 style=... 這種屬性。
        let label = '', rest = t.slice(3);
        if (rest.length && rest[0].indexOf('=') < 0) { label = rest[0]; rest = rest.slice(1); }
        edges.push({ from: t[1], to: t[2], label: label });
      }
    });
    return { nodes: nodes, edges: edges };
  }

  function serialize(model) {
    const lines = [];
    model.nodes.forEach(function (n) {
      let l = 'node ' + n.id + ' ' + quote(n.label) + ' x=' + Math.round(n.x) + ' y=' + Math.round(n.y);
      if (n.color) l += ' color=' + n.color;
      if (n.shape) l += ' shape=' + n.shape;
      lines.push(l);
    });
    model.edges.forEach(function (e) {
      let l = 'edge ' + e.from + ' ' + e.to;
      if (e.label) l += ' ' + quote(e.label);
      lines.push(l);
    });
    return lines.join('\n');
  }

  // ---------------- 版面：文字寬度用字元分類估，跟心智圖同一招，不量真的 DOM --
  function charW(code) {
    // 粗略區分全形（CJK 等）跟半形字元的視覺寬度，12px 字級下的估計值。
    if (code >= 0x1100 && (code <= 0x115F || (code >= 0x2E80 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7A3) || (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0xFF00 && code <= 0xFF60) || (code >= 0x3000 && code <= 0x303F))) return 13;
    return 6.8;
  }
  function textWidth(s) {
    let w = 0;
    for (const ch of String(s || '')) w += charW(ch.codePointAt(0));
    return w;
  }
  // 節點 = 半徑 R 的圓盤 + 下方一行標籤。x,y 是整個節點（圓盤＋標籤）外框的左上角，
  // 圓盤置中在外框寬度上；外框寬度取圓盤跟標籤文字較寬者。
  const R = 20, LABEL_H = 22;
  function nodeSize(n) { return { w: Math.max(R * 2 + 8, textWidth(n.label) + 8), h: R * 2 + LABEL_H }; }
  function center(n) { return { x: n.x + n.w / 2, y: n.y + R }; }

  function sizedNodes(model) {
    return model.nodes.map(function (n) {
      const s = nodeSize(n);
      return { id: n.id, label: n.label, x: n.x, y: n.y, w: s.w, h: s.h, color: n.color, shape: n.shape };
    });
  }
  function bbox(nodes) {
    if (!nodes.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    nodes.forEach(function (n) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  // 顏色、彎曲方向都由 id 雜湊決定：同一張圖每次畫都一樣，不會跳動。
  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  const AUTO_COLORS = 8;   // .rm-auto-0 … .rm-auto-7（app.css / pdf.js）
  const EDGE_COLORS = 9;   // .rm-e0 … .rm-e8，橘棕佔多數
  function nodeColorClass(n) { return n.color ? 'rm-' + n.color : 'rm-auto-' + (hash(n.id) % AUTO_COLORS); }
  function edgeColorClass(e) { return 'rm-e' + (hash(e.from + '|' + e.to) % EDGE_COLORS); }

  // 連線的幾何：兩端停在圓盤邊緣（留 3px 給箭頭），中間是二次貝茲曲線，控制點
  // 從連線中點往垂直方向偏，偏移量隨線長縮放、方向照雜湊奇偶決定，整張圖的線才
  // 會有的往左彎有的往右彎。mid 是曲線 t=0.5 的點，標籤跟就地編輯框都放那裡。
  function edgeGeometry(a, b, seed) {
    const ca = center(a), cb = center(b);
    const dx = cb.x - ca.x, dy = cb.y - ca.y;
    const len = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const ux = dx / len, uy = dy / len;
    const bend = (seed % 2 === 0 ? 1 : -1) * Math.min(len * 0.18, 60);
    const c = { x: (ca.x + cb.x) / 2 - uy * bend, y: (ca.y + cb.y) / 2 + ux * bend };
    // 起終點：從圓心朝控制點方向走 R，這樣曲線離開圓盤的方向才跟弧線一致
    function edgePoint(cen, toward) {
      const vx = toward.x - cen.x, vy = toward.y - cen.y;
      const l = Math.max(1, Math.sqrt(vx * vx + vy * vy));
      return { x: cen.x + vx / l * (R + 3), y: cen.y + vy / l * (R + 3) };
    }
    const p1 = edgePoint(ca, c), p2 = edgePoint(cb, c);
    const mid = { x: 0.25 * p1.x + 0.5 * c.x + 0.25 * p2.x, y: 0.25 * p1.y + 0.5 * c.y + 0.25 * p2.y };
    return { p1: p1, p2: p2, c: c, mid: mid };
  }
  function pathD(g, ox, oy) {
    return 'M' + (g.p1.x + ox) + ',' + (g.p1.y + oy) + ' Q' + (g.c.x + ox) + ',' + (g.c.y + oy) +
      ' ' + (g.p2.x + ox) + ',' + (g.p2.y + oy);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  // 圓盤裡的「圖示」：標籤第一個字（英文字母轉大寫）。
  function monogram(label) {
    const first = Array.from(String(label || '').trim())[0];
    return first ? first.toUpperCase() : '·';
  }

  // ---------------- SVG：唯讀渲染（預覽／PDF／電子書都呼叫這個）----------------
  // 所有顏色一律走 CSS class（.rm-node.rm-<color>／.rm-auto-k、.rm-edge.rm-e<k>），不是
  // inline style——pdf.js 才能像心智圖一樣，用自己的列印樣式表覆寫同一批 class。
  function nodeSVG(n, ox, oy, idx, selected) {
    const cls = 'rm-node ' + nodeColorClass(n) + (selected ? ' rm-sel' : '');
    const c = center(n);
    const cx = c.x + ox, cy = c.y + oy;
    return '<g class="' + cls + '" data-i="' + idx + '">' +
      '<circle class="rm-disc" cx="' + cx + '" cy="' + cy + '" r="' + R + '"></circle>' +
      '<text class="rm-mono" x="' + cx + '" y="' + (cy + 1) + '" text-anchor="middle" dominant-baseline="central">' +
      esc(monogram(n.label)) + '</text>' +
      '<text class="rm-lbl" x="' + cx + '" y="' + (cy + R + 15) + '" text-anchor="middle">' +
      esc(n.label || '（未命名）') + '</text></g>';
  }
  function edgeSVG(a, b, e, ox, oy, idx, selected, markerId) {
    const g = edgeGeometry(a, b, hash(e.from + '|' + e.to));
    let s = '<g class="rm-edge ' + edgeColorClass(e) + (selected ? ' rm-sel' : '') + '" data-i="' + idx + '">' +
      // 粗一點的透明底線：讓細虛線也好點選
      '<path class="rm-hit" d="' + pathD(g, ox, oy) + '"></path>' +
      '<path class="rm-line" d="' + pathD(g, ox, oy) + '" marker-end="url(#' + markerId + ')"></path>';
    if (e.label) {
      const tw = textWidth(e.label);
      s += '<rect class="rm-edge-lbg" x="' + (g.mid.x + ox - tw / 2 - 6) + '" y="' + (g.mid.y + oy - 9) +
        '" width="' + (tw + 12) + '" height="18" rx="9"></rect>' +
        '<text class="rm-edge-lbl" x="' + (g.mid.x + ox) + '" y="' + (g.mid.y + oy) +
        '" text-anchor="middle" dominant-baseline="central">' + esc(e.label) + '</text>';
    }
    return s + '</g>';
  }
  function markerDef(id) {
    return '<defs><marker id="' + id + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
      '<path d="M0,0L10,5L0,10z" class="rm-arrowhead"></path></marker></defs>';
  }

  function renderSVG(text, sel) {
    const model = parse(text);
    if (!model.nodes.length) return '';
    const nodes = sizedNodes(model);
    const byId = {}; nodes.forEach(function (n) { byId[n.id] = n; });
    const box = bbox(nodes);
    const PAD = 28;
    const ox = PAD - box.minX, oy = PAD - box.minY;
    const W = Math.max(1, box.maxX - box.minX) + PAD * 2, H = Math.max(1, box.maxY - box.minY) + PAD * 2;
    let edgesSVG = '';
    model.edges.forEach(function (e, i) {
      const a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      edgesSVG += edgeSVG(a, b, e, ox, oy, i, sel && sel.type === 'edge' && sel.i === i, 'rm-arrow');
    });
    const nodesSVG = nodes.map(function (n, i) {
      return nodeSVG(n, ox, oy, i, sel && sel.type === 'node' && sel.i === i);
    }).join('');
    return '<svg class="relmap-svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' +
      markerDef('rm-arrow') + edgesSVG + nodesSVG + '</svg>';
  }


  // ---------------- 筆記種類（meta.relMap）------------------------------------
  function isRelNote(note) { return !!(note && note.meta && note.meta.relMap); }
  const TEMPLATE = 'node n1 "起點" x=40 y=80\nnode n2 "目標" x=320 y=80\nedge n1 n2 "利用"';
  function generate() { return '```relmap\n' + TEMPLATE + '\n```\n'; }

  // ---------------- CSV → 節點／連線 -------------------------------------------
  // 一列一條關聯：source,target[,label]。第一列若是認得的欄名（source/target/label、
  // from/to、起點/終點/關係…）就當標題列，否則整份都是資料。分隔符號自動看第一列
  // 是逗號、tab 還是分號。引號內的逗號／換行照 CSV 規則保留。
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    const first = text.split(/\r?\n/)[0] || '';
    const delim = (first.split('\t').length > first.split(',').length) ? '\t'
      : (first.split(';').length > first.split(',').length ? ';' : ',');
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
        else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return c.trim(); }); });
  }
  const SRC_NAMES = ['source', 'src', 'from', 'a', '起點', '來源', '起始', '來源節點'];
  const DST_NAMES = ['target', 'dst', 'to', 'b', '終點', '目標', '目的', '目標節點'];
  const LBL_NAMES = ['label', 'relation', 'edge', 'type', '關係', '標籤', '說明', '關聯'];
  function slugId(label, used) {
    let base = 'c' + hash(label).toString(36);
    let id = base, k = 1;
    while (used[id]) id = base + '_' + (k++);
    return id;
  }
  // 回傳新加進 model 的節點 id（沒有位置，交給 autoLayout），以及加了幾條連線。
  function importCSV(model, text) {
    const rows = parseCSV(text);
    if (!rows.length) return { nodes: [], edges: 0 };
    let si = 0, ti = 1, li = 2, start = 0;
    const head = rows[0].map(function (c) { return c.trim().toLowerCase(); });
    const find = function (names) { return head.findIndex(function (h) { return names.indexOf(h) >= 0; }); };
    const s = find(SRC_NAMES), t = find(DST_NAMES), l = find(LBL_NAMES);
    if (s >= 0 && t >= 0) { si = s; ti = t; li = l; start = 1; }
    const byLabel = {}, used = {};
    model.nodes.forEach(function (n) { byLabel[n.label.trim().toLowerCase()] = n; used[n.id] = true; });
    const edgeKey = {};
    model.edges.forEach(function (e) { edgeKey[e.from + ' ' + e.to] = true; });
    const added = [];
    let edges = 0;
    function nodeFor(label) {
      const key = label.trim().toLowerCase();
      if (byLabel[key]) return byLabel[key];
      const n = { id: slugId(label, used), label: label.trim(), x: NaN, y: NaN, color: '', shape: '' };
      used[n.id] = true; byLabel[key] = n;
      model.nodes.push(n); added.push(n.id);
      return n;
    }
    for (let r = start; r < rows.length; r++) {
      const row = rows[r];
      const a = (row[si] || '').trim(), b = (row[ti] || '').trim();
      if (!a) continue;
      const na = nodeFor(a);
      if (!b) continue;   // 只有一欄：單獨一個節點
      const nb = nodeFor(b);
      const label = li >= 0 ? (row[li] || '').trim() : '';
      if (na.id === nb.id || edgeKey[na.id + ' ' + nb.id]) continue;
      edgeKey[na.id + ' ' + nb.id] = true;
      model.edges.push({ from: na.id, to: nb.id, label: label });
      edges++;
    }
    return { nodes: added, edges: edges };
  }

  // ---------------- 自動排版：力導向（跟 graph.js 的關聯圖同一套物理）---------------
  // 只動 onlyIds 裡的節點（CSV 匯進來的新節點），沒給就全部重排。同步跑固定回數，
  // 起點是黃金角螺旋，所以同一份資料排出來每次都一樣。
  const GOLDEN = 2.399963;
  function autoLayout(model, onlyIds) {
    const sized = sizedNodes(model);
    if (!sized.length) return;
    const movable = sized.map(function (n) { return !onlyIds || onlyIds.indexOf(n.id) >= 0; });
    let cx0 = 0, cy0 = 0, fixedN = 0;
    sized.forEach(function (n, i) {
      if (!movable[i] && isFinite(n.x)) { cx0 += n.x + n.w / 2; cy0 += n.y + R; fixedN++; }
    });
    if (fixedN) { cx0 /= fixedN; cy0 /= fixedN; } else { cx0 = 400; cy0 = 300; }
    let k = 0;
    sized.forEach(function (n, i) {
      if (movable[i] || !isFinite(n.x)) {
        const r = 70 * Math.sqrt(k + 1), a = k * GOLDEN; k++;
        n.cx = cx0 + r * Math.cos(a); n.cy = cy0 + r * Math.sin(a);
        movable[i] = true;
      } else { n.cx = n.x + n.w / 2; n.cy = n.y + R; }
      n.vx = 0; n.vy = 0;
    });
    const idx = {}; sized.forEach(function (n, i) { idx[n.id] = i; });
    const links = model.edges.map(function (e) { return [idx[e.from], idx[e.to]]; })
      .filter(function (p) { return p[0] !== undefined && p[1] !== undefined; });
    for (let it = 0; it < 320; it++) {
      for (let i = 0; i < sized.length; i++) {
        for (let j = i + 1; j < sized.length; j++) {
          const a = sized[i], b = sized[j];
          const dx = a.cx - b.cx, dy = a.cy - b.cy;
          let d2 = dx * dx + dy * dy; if (d2 < 1) d2 = 1;
          const f = 9000 / d2, d = Math.sqrt(d2);
          const fx = dx / d * f, fy = dy / d * f;
          if (movable[i]) { a.vx += fx; a.vy += fy; }
          if (movable[j]) { b.vx -= fx; b.vy -= fy; }
        }
      }
      links.forEach(function (p) {
        const a = sized[p[0]], b = sized[p[1]];
        const dx = b.cx - a.cx, dy = b.cy - a.cy;
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const f = (d - 190) * 0.02, fx = dx / d * f, fy = dy / d * f;
        if (movable[p[0]]) { a.vx += fx; a.vy += fy; }
        if (movable[p[1]]) { b.vx -= fx; b.vy -= fy; }
      });
      sized.forEach(function (n, i) {
        if (!movable[i]) return;
        n.vx += (cx0 - n.cx) * 0.0016; n.vy += (cy0 - n.cy) * 0.0016;
        n.vx *= 0.82; n.vy *= 0.82;
        n.cx += n.vx; n.cy += n.vy;
      });
    }
    sized.forEach(function (n, i) {
      if (!movable[i]) return;
      const m = model.nodes.find(function (x) { return x.id === n.id; });
      if (m) { m.x = Math.round(n.cx - n.w / 2); m.y = Math.round(n.cy - R); }
    });
  }

  // ---------------- 編輯器：整頁的畫布（照 React Flow 的做法）--------------------
  //   RelMap.open(text, { container, title, onTitle, onChange, onClose })
  // container 是 app.js 給的整頁容器（#relmap-wrap）；沒給就自己掛一個滿版的。
  // 每一次改動（加點、連線、改字、換色、拖完、匯入、排版、還原）都會 debounce 後
  // 呼叫 onChange(dsl)——像其他筆記一樣自動存檔，沒有「完成」鈕；「返回」只是回去。
  //   - 雙擊改字／雙擊空白新增：自己用時間＋位移判斷（isDouble），不靠瀏覽器的
  //     dblclick——第一下 mousedown 會重畫或換選取，第二下落在新的元素上，瀏覽器就
  //     把點擊計數歸零，原生 dblclick 永遠不會來（之前「雙擊改不了」就是這個）。
  //   - 選取只切 class（applySelection），不重畫整張 SVG。
  //   - 左下角 Controls（＋／－／置中／鎖定）、右下角 MiniMap、點狀網格背景隨平移縮放
  //     一起動：這三樣就是 React Flow 一眼認得出來的東西。
  //   - 匯入 CSV：工具列按鈕或把 .csv 拖進畫布，新節點用 autoLayout 排開。
  const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple'];
  let uidSeq = 0;
  function newId() { return 'n' + (Date.now().toString(36)) + (uidSeq++); }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }

  function open(text, opts) {
    if (typeof document === 'undefined') return null;
    if (typeof opts === 'function') opts = { onSave: opts };
    opts = opts || {};
    let model = parse(text);
    let zoom = 1, panX = 40, panY = 40;
    let sel = null;   // { type: 'node'|'edge', i }
    let locked = false;
    const undo = [], redo = [];

    let host = opts.container;
    let ownHost = false;
    if (!host) { host = document.createElement('div'); host.className = 'relmap-wrap rm-own'; document.body.appendChild(host); ownHost = true; }
    host.classList.add('rm-page');
    host.innerHTML =
      '<header class="rm-bar">' +
      '<span class="rm-bar-t">' + ic('network') + '<span>關聯分析</span></span>' +
      (opts.title !== undefined ? '<input class="rm-title" type="text" placeholder="未命名關聯分析">' : '') +
      '<span class="rm-bar-sp"></span>' +
      '<button class="btn btn-ghost rm-undo" type="button" title="復原 (Ctrl+Z)">' + ic('undo') + '</button>' +
      '<button class="btn btn-ghost rm-redo" type="button" title="重做 (Ctrl+Shift+Z)">' + ic('redo') + '</button>' +
      '<span class="rm-bar-sep"></span>' +
      '<button class="btn btn-ghost rm-add" type="button" title="在畫面中央新增一個節點">' + ic('plus') + ' 節點</button>' +
      '<button class="btn btn-ghost rm-color" type="button" title="選取一個節點後可以換它的顏色" disabled>' + ic('grid') + ' 顏色</button>' +
      '<button class="btn btn-ghost rm-csv" type="button" title="匯入 CSV（source,target,label 一列一條關聯；也可以直接把 .csv 拖進畫布）">' + ic('upload') + ' 匯入 CSV</button>' +
      '<button class="btn btn-ghost rm-layout" type="button" title="用力導向把所有節點重新排開">' + ic('wand') + ' 自動排版</button>' +
      '<button class="btn rm-back" type="button">' + ic('arrow-left') + ' 返回</button>' +
      '</header>' +
      '<div class="rm-canvas" tabindex="0">' +
      '<div class="rm-stage"></div>' +
      '<div class="rm-controls rm-ctrl">' +
      '<button class="rm-ctrl-btn rm-zi" type="button" title="放大">' + ic('plus') + '</button>' +
      '<button class="rm-ctrl-btn rm-zo" type="button" title="縮小">' + ic('minus') + '</button>' +
      '<button class="rm-ctrl-btn rm-zfit" type="button" title="縮放到剛好看見整張圖">' + ic('maximize') + '</button>' +
      '<button class="rm-ctrl-btn rm-lock" type="button" title="鎖定：只能平移縮放，不能改圖">' + ic('lock') + '</button>' +
      '</div>' +
      '<div class="rm-minimap rm-ctrl" title="縮圖：點一下把那裡移到畫面中央"><svg viewBox="0 0 160 100" width="160" height="100"></svg></div>' +
      '<div class="rm-drop" hidden>' + ic('upload') + '<span>放開以匯入 CSV</span></div>' +
      '<div class="rm-empty" hidden>' + ic('network') + '<div>還沒有節點</div><div class="rm-empty-hint">雙擊空白處新增節點，或匯入一份 CSV（source,target,label）</div></div>' +
      '</div>';
    const canvas = host.querySelector('.rm-canvas');
    const stage = host.querySelector('.rm-stage');
    const colorBtn = host.querySelector('.rm-color');
    const mini = host.querySelector('.rm-minimap svg');
    const titleEl = host.querySelector('.rm-title');
    if (titleEl) {
      titleEl.value = opts.title || '';
      titleEl.addEventListener('change', function () { if (opts.onTitle) opts.onTitle(titleEl.value.trim()); });
      titleEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } e.stopPropagation(); });
    }
    let input = null;

    // ---- 存檔：每次改動 debounce 後回報 ----
    let saveTimer = null, dirty = false;
    function changed() {
      dirty = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flush, 600);
    }
    function flush() {
      clearTimeout(saveTimer);
      if (!dirty) return;
      dirty = false;
      if (opts.onChange) opts.onChange(serialize(model));
    }
    function snapshot() {
      undo.push(serialize(model));
      if (undo.length > 100) undo.shift();
      redo.length = 0;
      updateUndoBtns();
    }
    function updateUndoBtns() {
      host.querySelector('.rm-undo').disabled = !undo.length;
      host.querySelector('.rm-redo').disabled = !redo.length;
    }
    function nodesSized() { return sizedNodes(model); }
    function byId(id) { return model.nodes.find(function (n) { return n.id === id; }); }
    function sizedOf(n) { const s = nodeSize(n); return { id: n.id, label: n.label, x: n.x, y: n.y, w: s.w, h: s.h }; }

    function applyTransform() {
      stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
      // 點狀網格跟著畫布動：背景圖的位移＝平移量、格距＝24 × 縮放
      const g = 24 * zoom;
      canvas.style.backgroundSize = g + 'px ' + g + 'px';
      canvas.style.backgroundPosition = panX + 'px ' + panY + 'px';
      drawMinimap();
    }
    function draw() {
      closeInput();
      const sized = nodesSized();
      const byIdS = {}; sized.forEach(function (n) { byIdS[n.id] = n; });
      const box = bbox(sized);
      const PAD = 60;
      stage.dataset.ox = PAD - box.minX; stage.dataset.oy = PAD - box.minY;
      const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
      const W = Math.max(canvas.clientWidth / zoom, box.maxX - box.minX + PAD * 2);
      const H = Math.max(canvas.clientHeight / zoom, box.maxY - box.minY + PAD * 2);
      let edgesSVG = '';
      model.edges.forEach(function (e, i) {
        const a = byIdS[e.from], b = byIdS[e.to];
        if (!a || !b) return;
        edgesSVG += edgeSVG(a, b, e, ox, oy, i, sel && sel.type === 'edge' && sel.i === i, 'rm-arrow-ed');
      });
      const nodesSVG = sized.map(function (n, i) {
        const s = nodeSVG(n, ox, oy, i, sel && sel.type === 'node' && sel.i === i);
        const c = center(n);
        return s + '<circle class="rm-handle" data-i="' + i + '" cx="' + (c.x + ox + R + 9) + '" cy="' + (c.y + oy) + '" r="6"></circle>';
      }).join('');
      stage.innerHTML = '<svg class="relmap-svg" width="' + W + '" height="' + H + '">' +
        markerDef('rm-arrow-ed') + edgesSVG + nodesSVG + '</svg>';
      host.querySelector('.rm-empty').hidden = !!model.nodes.length;
      applyTransform();
      colorBtn.disabled = locked || !(sel && sel.type === 'node');
    }
    function applySelection() {
      Array.prototype.forEach.call(stage.querySelectorAll('.rm-node'), function (g) {
        g.classList.toggle('rm-sel', !!(sel && sel.type === 'node' && +g.getAttribute('data-i') === sel.i));
      });
      Array.prototype.forEach.call(stage.querySelectorAll('.rm-edge'), function (g) {
        g.classList.toggle('rm-sel', !!(sel && sel.type === 'edge' && +g.getAttribute('data-i') === sel.i));
      });
      colorBtn.disabled = locked || !(sel && sel.type === 'node');
    }
    function select(type, i) { sel = (type == null) ? null : { type: type, i: i }; applySelection(); }

    // ---- 縮圖（MiniMap）：內容外框跟目前視窗都畫進去，點一下就把那點移到中央 ----
    function drawMinimap() {
      const sized = nodesSized();
      const ox = +stage.dataset.ox || 0, oy = +stage.dataset.oy || 0;
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      // 視窗在舞台座標裡的範圍
      const vx0 = -panX / zoom, vy0 = -panY / zoom, vx1 = (cw - panX) / zoom, vy1 = (ch - panY) / zoom;
      let x0 = vx0, y0 = vy0, x1 = vx1, y1 = vy1;
      sized.forEach(function (n) {
        x0 = Math.min(x0, n.x + ox); y0 = Math.min(y0, n.y + oy);
        x1 = Math.max(x1, n.x + n.w + ox); y1 = Math.max(y1, n.y + n.h + oy);
      });
      const pad = 20; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
      const s = Math.min(160 / Math.max(1, x1 - x0), 100 / Math.max(1, y1 - y0));
      const offX = (160 - (x1 - x0) * s) / 2, offY = (100 - (y1 - y0) * s) / 2;
      mini._map = { x0: x0, y0: y0, s: s, offX: offX, offY: offY };
      let out = '';
      sized.forEach(function (n) {
        const c = center(n);
        out += '<circle class="rm-mm-node ' + nodeColorClass(n) + '" cx="' + ((c.x + ox - x0) * s + offX) + '" cy="' + ((c.y + oy - y0) * s + offY) + '" r="' + Math.max(1.5, R * s) + '"></circle>';
      });
      out += '<rect class="rm-mm-view" x="' + ((vx0 - x0) * s + offX) + '" y="' + ((vy0 - y0) * s + offY) +
        '" width="' + ((vx1 - vx0) * s) + '" height="' + ((vy1 - vy0) * s) + '" rx="2"></rect>';
      mini.innerHTML = out;
    }
    mini.parentElement.addEventListener('mousedown', function (e) {
      e.preventDefault(); e.stopPropagation();
      const m = mini._map; if (!m) return;
      const r = mini.getBoundingClientRect();
      const sx = (e.clientX - r.left - m.offX) / m.s + m.x0, sy = (e.clientY - r.top - m.offY) / m.s + m.y0;
      panX = canvas.clientWidth / 2 - sx * zoom;
      panY = canvas.clientHeight / 2 - sy * zoom;
      applyTransform();
    });

    function toModelXY(clientX, clientY) {
      const r = canvas.getBoundingClientRect();
      return {
        x: (clientX - r.left - panX) / zoom - (+stage.dataset.ox || 0),
        y: (clientY - r.top - panY) / zoom - (+stage.dataset.oy || 0)
      };
    }

    // ---- 縮放／視圖 ----
    function zoomAt(nz, ax, ay) {
      nz = Math.max(0.2, Math.min(3, nz));
      panX = ax - (ax - panX) * (nz / zoom);
      panY = ay - (ay - panY) * (nz / zoom);
      zoom = nz;
      draw();
    }
    function zoomStep(f) { zoomAt(zoom * f, canvas.clientWidth / 2, canvas.clientHeight / 2); }
    function fitView() {
      const sized = nodesSized();
      if (!sized.length) { zoom = 1; panX = 40; panY = 40; draw(); return; }
      const box = bbox(sized);
      const PAD = 60;
      const W = box.maxX - box.minX + PAD * 2, H = box.maxY - box.minY + PAD * 2;
      zoom = Math.max(0.2, Math.min(2, Math.min(canvas.clientWidth / W, canvas.clientHeight / H)));
      panX = (canvas.clientWidth - W * zoom) / 2;
      panY = (canvas.clientHeight - H * zoom) / 2;
      draw();
    }
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      zoomAt(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    const ro = (typeof ResizeObserver !== 'undefined') ? new ResizeObserver(function () { draw(); }) : null;
    if (ro) ro.observe(canvas);

    // ---- 選取 / 刪除 ----
    function deleteSelected() {
      if (!sel || locked) return;
      snapshot();
      if (sel.type === 'node') {
        const id = model.nodes[sel.i].id;
        model.nodes.splice(sel.i, 1);
        model.edges = model.edges.filter(function (e) { return e.from !== id && e.to !== id; });
      } else {
        model.edges.splice(sel.i, 1);
      }
      sel = null;
      draw(); changed();
    }

    // ---- 新增節點 ----
    function addNodeAt(x, y) {
      snapshot();
      const n = { id: newId(), label: '新節點', x: x - R, y: y - R, color: '', shape: '' };
      model.nodes.push(n);
      sel = { type: 'node', i: model.nodes.length - 1 };
      draw(); changed();
      openInput(model.nodes.length - 1, true);
    }

    // ---- 雙擊：自己判斷（見檔頭說明）----
    let lastDown = null;
    function isDouble(e) {
      const now = Date.now();
      const d = !!lastDown && (now - lastDown.t < 400) && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 6;
      lastDown = d ? null : { t: now, x: e.clientX, y: e.clientY };
      return d;
    }

    // ---- 拖曳：移動節點 / 平移畫布 / 拉線連接 ----
    function onCanvasDown(e) {
      if (e.button !== 0) return;
      if (e.target.closest && e.target.closest('.rm-ctrl')) return;
      const handle = e.target.closest && e.target.closest('.rm-handle');
      const nodeEl = e.target.closest && e.target.closest('.rm-node');
      const edgeEl = e.target.closest && e.target.closest('.rm-edge');
      if (isDouble(e)) {
        e.preventDefault();
        if (locked) return;
        if (nodeEl) { const i = +nodeEl.getAttribute('data-i'); select('node', i); openInput(i, true); return; }
        if (edgeEl) { const i = +edgeEl.getAttribute('data-i'); select('edge', i); openEdgeInput(i); return; }
        const p = toModelXY(e.clientX, e.clientY);
        addNodeAt(p.x, p.y);
        return;
      }
      if (handle && !locked) { startConnect(e, +handle.getAttribute('data-i')); return; }
      if (nodeEl) { if (locked) { select('node', +nodeEl.getAttribute('data-i')); startPan(e); } else startMoveNode(e, +nodeEl.getAttribute('data-i')); return; }
      if (edgeEl) { select('edge', +edgeEl.getAttribute('data-i')); return; }
      select(null);
      startPan(e);
    }
    function startMoveNode(e, i) {
      e.preventDefault();
      select('node', i);
      const n = model.nodes[i];
      const before = serialize(model);
      const sx = e.clientX, sy = e.clientY, ox0 = n.x, oy0 = n.y;
      let moved = false;
      function move(ev) {
        const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        if (!moved) return;
        n.x = ox0 + dx; n.y = oy0 + dy;
        draw();
      }
      function up() {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (moved) { undo.push(before); if (undo.length > 100) undo.shift(); redo.length = 0; updateUndoBtns(); changed(); }
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }
    function startPan(e) {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, px0 = panX, py0 = panY;
      canvas.classList.add('mm-dragging');
      function move(ev) { panX = px0 + (ev.clientX - sx); panY = py0 + (ev.clientY - sy); applyTransform(); }
      function up() { canvas.classList.remove('mm-dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }
    function startConnect(e, fromIdx) {
      e.preventDefault(); e.stopPropagation();
      const fromNode = model.nodes[fromIdx];
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('class', 'rm-rubberband');
      const svg = stage.querySelector('svg');
      svg.appendChild(line);
      function place(clientX, clientY) {
        const p = toModelXY(clientX, clientY);
        const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
        const c = center(sizedOf(fromNode));
        const vx = p.x - c.x, vy = p.y - c.y;
        const l = Math.max(1, Math.sqrt(vx * vx + vy * vy));
        line.setAttribute('x1', c.x + vx / l * R + ox);
        line.setAttribute('y1', c.y + vy / l * R + oy);
        line.setAttribute('x2', p.x + ox);
        line.setAttribute('y2', p.y + oy);
      }
      place(e.clientX, e.clientY);
      function move(ev) { place(ev.clientX, ev.clientY); }
      function up(ev) {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        line.remove();
        const target = document.elementFromPoint(ev.clientX, ev.clientY);
        const targetNodeEl = target && target.closest && target.closest('.rm-node');
        if (targetNodeEl) {
          const toIdx = +targetNodeEl.getAttribute('data-i');
          const toNode = model.nodes[toIdx];
          if (toNode && toNode.id !== fromNode.id &&
              !model.edges.some(function (x) { return x.from === fromNode.id && x.to === toNode.id; })) {
            snapshot();
            model.edges.push({ from: fromNode.id, to: toNode.id, label: '' });
            sel = { type: 'edge', i: model.edges.length - 1 };
            draw(); changed();
            return;
          }
        }
        draw();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }
    canvas.addEventListener('mousedown', onCanvasDown);

    // ---- 拖 .csv 進畫布 ----
    const dropHint = host.querySelector('.rm-drop');
    canvas.addEventListener('dragover', function (e) {
      if (locked) return;
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) {
        e.preventDefault(); dropHint.hidden = false;
      }
    });
    canvas.addEventListener('dragleave', function (e) { if (!canvas.contains(e.relatedTarget)) dropHint.hidden = true; });
    canvas.addEventListener('drop', function (e) {
      dropHint.hidden = true;
      if (locked || !e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      readCSVFiles(e.dataTransfer.files);
    });
    function readCSVFiles(files) {
      Array.prototype.forEach.call(files, function (f) {
        const reader = new FileReader();
        reader.onload = function () { doImport(String(reader.result || ''), f.name); };
        reader.readAsText(f);
      });
    }
    function doImport(text, name) {
      snapshot();
      const r = importCSV(model, text);
      if (!r.nodes.length && !r.edges) { undo.pop(); updateUndoBtns(); notify('「' + (name || 'CSV') + '」裡沒有讀到任何關聯（要有 source,target 兩欄）'); return; }
      if (r.nodes.length) autoLayout(model, r.nodes);
      sel = null;
      fitView(); changed();
      notify('已匯入 ' + r.nodes.length + ' 個節點、' + r.edges + ' 條關聯');
    }
    function notify(msg) {
      if (global.App && App.toast) { App.toast(msg); return; }
      const t = document.createElement('div');
      t.className = 'rm-toast'; t.textContent = msg;
      host.appendChild(t);
      setTimeout(function () { t.remove(); }, 2600);
    }

    // ---- 就地改文字（節點）：輸入框蓋在圓盤下方的標籤上 ----
    function openInput(i, selectAll) {
      closeInput();
      const n = model.nodes[i];
      const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
      const s = sizedOf(n), c = center(s);
      input = document.createElement('input');
      input.className = 'rm-input';
      input.value = n.label;
      host.appendChild(input);
      const w = Math.max(120, s.w + 24);
      placeInputAt(c.x + ox - w / 2, c.y + oy + R + 3, w, 24);
      input.focus();
      if (selectAll) input.select();
      function commit() {
        const v = input.value;
        closeInput();
        if (v !== n.label) { snapshot(); n.label = v; draw(); changed(); }
      }
      input.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeInput(); }
      });
      input.addEventListener('blur', commit);
    }
    function openEdgeInput(i) {
      closeInput();
      const e = model.edges[i];
      const a = byId(e.from), b = byId(e.to);
      if (!a || !b) return;
      const ox = +stage.dataset.ox, oy = +stage.dataset.oy;
      const g = edgeGeometry(sizedOf(a), sizedOf(b), hash(e.from + '|' + e.to));
      input = document.createElement('input');
      input.className = 'rm-input rm-input-edge';
      input.placeholder = '連線文字…';
      input.value = e.label || '';
      host.appendChild(input);
      placeInputAt(g.mid.x + ox - 70, g.mid.y + oy - 12, 140, 24);
      input.focus();
      input.select();
      function commit() {
        const v = input.value;
        closeInput();
        if (v !== e.label) { snapshot(); e.label = v; draw(); changed(); }
      }
      input.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); closeInput(); }
      });
      input.addEventListener('blur', commit);
    }
    function placeInputAt(x, y, w, h) {
      const r = canvas.getBoundingClientRect();
      input.style.left = (r.left + x * zoom + panX) + 'px';
      input.style.top = (r.top + y * zoom + panY) + 'px';
      input.style.width = (w * zoom) + 'px';
      input.style.height = (h * zoom) + 'px';
      input.style.fontSize = Math.max(11, 13 * zoom) + 'px';
    }
    function closeInput() { if (input) { const el = input; input = null; el.remove(); } }

    // ---- 顏色（選取節點後按工具列的「顏色」，圓形色板出現在圓盤下方）----
    function colorMenu() {
      if (!sel || sel.type !== 'node' || locked) return;
      closeColorMenu();
      const n = model.nodes[sel.i];
      const pop = document.createElement('div');
      pop.className = 'rm-colors';
      COLORS.forEach(function (c) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rm-swatch' + (c ? ' rm-' + c : ' rm-none') + (n.color === c ? ' on' : '');
        b.title = c || '自動';
        b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        b.addEventListener('click', function () { snapshot(); n.color = c; draw(); changed(); closeColorMenu(); });
        pop.appendChild(b);
      });
      host.appendChild(pop);
      const disc = stage.querySelector('.rm-node[data-i="' + sel.i + '"] .rm-disc');
      const r = disc ? disc.getBoundingClientRect() : colorBtn.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left + r.width / 2 - 74, window.innerWidth - 160)) + 'px';
      pop.style.top = (r.bottom + 26) + 'px';
      setTimeout(function () { document.addEventListener('mousedown', onColorOutside, true); }, 0);
    }
    function onColorOutside(e) { if (!e.target.closest('.rm-colors')) closeColorMenu(); }
    function closeColorMenu() {
      const p = host.querySelector('.rm-colors');
      if (p) p.remove();
      document.removeEventListener('mousedown', onColorOutside, true);
    }

    // ---- 鍵盤（畫布有焦點時）----
    function doUndo() { if (!undo.length) return; redo.push(serialize(model)); model = parse(undo.pop()); sel = null; draw(); changed(); updateUndoBtns(); }
    function doRedo() { if (!redo.length) return; undo.push(serialize(model)); model = parse(redo.pop()); sel = null; draw(); changed(); updateUndoBtns(); }
    function onKey(e) {
      if (input || e.target === titleEl) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSelected(); return; }
      if (e.key === 'F2' && sel && sel.type === 'node' && !locked) { e.preventDefault(); openInput(sel.i, true); return; }
      if (e.key === 'Escape') { if (sel) { e.preventDefault(); select(null); } return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo(); else doUndo();
      }
    }
    host.addEventListener('keydown', onKey);

    // ---- 工具列 / Controls ----
    host.querySelector('.rm-add').addEventListener('click', function () {
      if (locked) return;
      const r = canvas.getBoundingClientRect();
      const p = toModelXY(r.left + canvas.clientWidth / 2, r.top + canvas.clientHeight / 2);
      addNodeAt(p.x, p.y);
    });
    colorBtn.addEventListener('click', colorMenu);
    host.querySelector('.rm-undo').addEventListener('click', doUndo);
    host.querySelector('.rm-redo').addEventListener('click', doRedo);
    host.querySelector('.rm-layout').addEventListener('click', function () {
      if (locked || !model.nodes.length) return;
      snapshot(); autoLayout(model, null); fitView(); changed();
    });
    host.querySelector('.rm-csv').addEventListener('click', function () {
      if (locked) return;
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.csv,.tsv,.txt,text/csv,text/plain'; inp.multiple = true; inp.hidden = true;
      document.body.appendChild(inp);
      inp.addEventListener('change', function () { readCSVFiles(inp.files); inp.remove(); });
      inp.click();
    });
    host.querySelector('.rm-zi').addEventListener('click', function () { zoomStep(1.25); });
    host.querySelector('.rm-zo').addEventListener('click', function () { zoomStep(1 / 1.25); });
    host.querySelector('.rm-zfit').addEventListener('click', fitView);
    const lockBtn = host.querySelector('.rm-lock');
    lockBtn.addEventListener('click', function () {
      locked = !locked;
      lockBtn.classList.toggle('on', locked);
      lockBtn.title = locked ? '解除鎖定' : '鎖定：只能平移縮放，不能改圖';
      canvas.classList.toggle('rm-locked', locked);
      ['.rm-add', '.rm-csv', '.rm-layout'].forEach(function (s) { host.querySelector(s).disabled = locked; });
      applySelection();
    });

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      flush();
      closeInput(); closeColorMenu();
      if (ro) ro.disconnect();
      host.removeEventListener('keydown', onKey);
      host.classList.remove('rm-page');
      host.innerHTML = '';
      if (ownHost) host.remove();
      if (opts.onSave) opts.onSave(serialize(model));
      if (opts.onClose) opts.onClose();
    }
    host.querySelector('.rm-back').addEventListener('click', close);

    updateUndoBtns();
    draw();
    if (model.nodes.length) fitView();
    canvas.focus();
    return { close: close, flush: flush, importCSV: function (t) { doImport(t); } };
  }

  global.RelMap = {
    parse: parse,
    serialize: serialize,
    renderSVG: renderSVG,
    open: open,
    isRelNote: isRelNote,
    generate: generate,
    importCSV: importCSV,
    autoLayout: autoLayout
  };
})(window);

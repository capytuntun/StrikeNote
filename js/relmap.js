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
    text = String(text || '');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);   // Excel 存的 UTF-8 CSV 開頭有 BOM
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
    model.edges.forEach(function (e) { edgeKey[e.from + ' ' + e.to] = true; });
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
      if (na.id === nb.id || edgeKey[na.id + ' ' + nb.id]) continue;
      edgeKey[na.id + ' ' + nb.id] = true;
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

  // ---------------- CSV 匯出／範本 -------------------------------------------------
  function csvCell(s) {
    s = String(s == null ? '' : s);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // 跟匯入同一個格式（source,target,label），沒有連線的節點自己佔一列，匯出再匯入不會掉。
  function toCSV(model) {
    const byId = {}; model.nodes.forEach(function (n) { byId[n.id] = n; });
    const used = {}, rows = [['source', 'target', 'label']];
    model.edges.forEach(function (e) {
      const a = byId[e.from], b = byId[e.to];
      if (!a || !b) return;
      used[a.id] = used[b.id] = true;
      rows.push([a.label, b.label, e.label || '']);
    });
    model.nodes.forEach(function (n) { if (!used[n.id]) rows.push([n.label, '', '']); });
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }
  const CSV_TEMPLATE = [
    ['source', 'target', 'label'],
    ['釣魚信件', '員工電腦', '惡意巨集'],
    ['員工電腦', '檔案伺服器', 'SMB'],
    ['員工電腦', '跳板機', 'RDP'],
    ['跳板機', '網域控制站', 'Kerberoast'],
    ['檔案伺服器', '網域控制站', 'NTLM relay'],
    ['網域控制站', '郵件伺服器', 'DCSync'],
    ['獨立的節點', '', '']
  ].map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  function downloadCSV(name, text) {
    // 開頭放 BOM：Excel 才會把 UTF-8 的中文讀對
    const blob = new Blob([String.fromCharCode(0xFEFF) + text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(name || '關聯分析').replace(/[\\/:*?"<>|]+/g, '_') + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------------- React Flow：只在打開關聯分析頁時才載入 ---------------------------
  // 編輯器就是 React Flow 本尊（@xyflow/react，vendor/reactflow/ 裡固定版本的瀏覽器
  // bundle，沒有 CDN、沒有 build step）。它要三個全域：React、ReactDOM，還有一個
  // jsxRuntime——React 沒有出 jsx-runtime 的瀏覽器版，這裡用 createElement 墊一個。
  // 大約 350 KB，所以不放進 index.html，第一次打開關聯分析頁才抓，抓過就留在頁面上。
  const RF_BASE = 'vendor/reactflow/';
  let rfPromise = null;
  function loadScript(src) {
    return new Promise(function (res, rej) {
      const s = document.createElement('script');
      s.src = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('載入失敗：' + src)); };
      document.head.appendChild(s);
    });
  }
  function loadReactFlow() {
    if (global.ReactFlow && global.React && global.ReactDOM) return Promise.resolve();
    if (rfPromise) return rfPromise;
    if (!document.querySelector('link[data-rf-css]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = RF_BASE + 'xyflow-react.css?v=12.11.6'; css.setAttribute('data-rf-css', '1');
      // 放在 app.css 前面，app.css 裡的 .rm-rf-* 覆寫才贏得過它
      document.head.insertBefore(css, document.head.querySelector('link[rel="stylesheet"]'));
    }
    rfPromise = loadScript(RF_BASE + 'react.production.min.js?v=18.3.1')
      .then(function () { return loadScript(RF_BASE + 'react-dom.production.min.js?v=18.3.1'); })
      .then(function () {
        const R = global.React;
        function jsx(type, props, key) {
          const p = {}; let children;
          for (const k in props) { if (k === 'children') children = props[k]; else p[k] = props[k]; }
          if (key !== undefined) p.key = key;
          if (children === undefined) return R.createElement(type, p);
          return Array.isArray(children) ? R.createElement.apply(null, [type, p].concat(children)) : R.createElement(type, p, children);
        }
        global.jsxRuntime = { jsx: jsx, jsxs: jsx, Fragment: R.Fragment };
        return loadScript(RF_BASE + 'xyflow-react.umd.js?v=12.11.6');
      })
      .catch(function (e) { rfPromise = null; throw e; });
    return rfPromise;
  }

  // 編輯器裡的顏色要給 React Flow 當 inline 值用（箭頭、縮圖都吃不到 CSS class），跟
  // app.css 的 .rm-<色名>／.rm-auto-k／.rm-e<k> 是同一組數字。
  const NODE_HEX = { red: '#e5484d', orange: '#e08a3c', yellow: '#d9b840', green: '#3fb950', teal: '#2fb8ad', blue: '#4c8dff', purple: '#a371f7' };
  const AUTO_HEX = ['#e0c674', '#6fa8dc', '#e08a52', '#5fb88a', '#d97a9c', '#9a86d6', '#5cc2c2', '#d66a6a'];
  const EDGE_HEX = ['#c9822a', '#c9822a', '#c9822a', '#b8702a', '#a86a2c', '#4f8fd6', '#d65f6b', '#8e6fd6', '#4fb0a8'];
  function nodeHex(id, color) { return NODE_HEX[color] || AUTO_HEX[hash(id) % AUTO_COLORS]; }

  // ---------------- 編輯器：整頁的 React Flow 畫布 ------------------------------------
  //   RelMap.open(text, { container, title, onTitle, onChange, onClose })
  // DSL 還是唯一的真實來源：開的時候 parse 成 React Flow 的 nodes/edges，每次改動
  // （拖完、連線、刪除、改字、換色、匯入、排版、還原）debounce 後 serialize 回 DSL 交給
  // onChange——跟其他筆記一樣自動存檔，沒有「完成」，「返回」只是回去。預覽／PDF／電子書
  // 裡的那張圖仍然是上面的 renderSVG()（React Flow 沒辦法把自己印成一段靜態 SVG）。
  //   - 節點是自訂型別 'disc'（白圓盤＋彩色圓環＋首字＋盤下標籤），寬度固定用 nodeSize()
  //     的估計值，跟靜態 SVG 的座標才對得起來。
  //   - 連線是自訂型別 'floating'：從圓盤邊緣到圓盤邊緣的彎虛線（同一套 edgeGeometry），
  //     不是釘在上下左右的 handle 上——關聯網的線要能從任何角度出去。
  //   - Background（點狀）、Controls（含鎖定）、MiniMap 都是 React Flow 內建的。
  const COLORS = ['', 'red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple'];
  let uidSeq = 0;
  function newId() { return 'n' + (Date.now().toString(36)) + (uidSeq++); }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }

  function open(text, opts) {
    if (typeof document === 'undefined') return null;
    if (typeof opts === 'function') opts = { onSave: opts };
    opts = opts || {};
    const undo = [], redo = [];
    let latestNodes = [], latestEdges = [];   // React Flow 狀態的鏡像（effect 同步過來）
    let bound = null;                         // { setNodes, setEdges, rf }，Flow 元件掛上後才有
    let root = null, closed = false, pendingChange = false;

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
      '<button class="btn btn-ghost rm-add" type="button" title="在畫面中央新增一個節點（也可以雙擊空白處）">' + ic('plus') + ' 節點</button>' +
      '<button class="btn btn-ghost rm-color" type="button" title="選取一個節點後可以換它的顏色" disabled>' + ic('grid') + ' 顏色</button>' +
      '<button class="btn btn-ghost rm-csv" type="button" title="匯入 CSV、下載 CSV 範本、把目前的圖匯出成 CSV">' + ic('table') + ' CSV ' + ic('chevron-down') + '</button>' +
      '<button class="btn btn-ghost rm-layout" type="button" title="用力導向把所有節點重新排開">' + ic('wand') + ' 自動排版</button>' +
      '<button class="btn rm-back" type="button">' + ic('arrow-left') + ' 返回</button>' +
      '</header>' +
      '<div class="rm-canvas" tabindex="0">' +
      '<div class="rm-rf-root"></div>' +
      '<div class="rm-loading">載入 React Flow…</div>' +
      '<div class="rm-drop" hidden>' + ic('upload') + '<span>放開以匯入 CSV</span></div>' +
      '<div class="rm-empty" hidden>' + ic('network') + '<div>還沒有節點</div><div class="rm-empty-hint">雙擊空白處新增節點，或從上面的 CSV 選單匯入（source,target,label）</div></div>' +
      '</div>';
    const canvas = host.querySelector('.rm-canvas');
    const rootEl = host.querySelector('.rm-rf-root');
    const colorBtn = host.querySelector('.rm-color');
    const titleEl = host.querySelector('.rm-title');
    if (titleEl) {
      titleEl.value = opts.title || '';
      titleEl.addEventListener('change', function () { if (opts.onTitle) opts.onTitle(titleEl.value.trim()); });
      titleEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); } e.stopPropagation(); });
    }
    let input = null;

    // ---- DSL <-> React Flow ----
    function rfNode(n) {
      return { id: n.id, type: 'disc', position: { x: n.x, y: n.y }, data: { label: n.label, color: n.color || '' }, style: { width: nodeSize(n).w } };
    }
    function rfEdge(e) {
      const k = hash(e.from + '|' + e.to) % EDGE_COLORS;
      return {
        id: e.from + '>' + e.to, source: e.from, target: e.to, type: 'floating', label: e.label || '', data: { k: k },
        markerEnd: { type: 'arrowclosed', color: EDGE_HEX[k], width: 18, height: 18 }
      };
    }
    function currentModel() {
      return {
        nodes: latestNodes.map(function (n) { return { id: n.id, label: n.data.label || '', x: n.position.x, y: n.position.y, color: n.data.color || '', shape: '' }; }),
        edges: latestEdges.map(function (e) { return { from: e.source, to: e.target, label: e.label || '' }; })
      };
    }
    function setAll(model) {
      latestNodes = model.nodes.map(rfNode);
      latestEdges = model.edges.map(rfEdge);
      if (bound) { bound.setNodes(latestNodes); bound.setEdges(latestEdges); }
      refreshChrome();
    }
    function applyNodes(fn) { const next = fn(latestNodes); latestNodes = next; if (bound) bound.setNodes(next); refreshChrome(); }
    function applyEdges(fn) { const next = fn(latestEdges); latestEdges = next; if (bound) bound.setEdges(next); }
    (function () { const m = parse(text); latestNodes = m.nodes.map(rfNode); latestEdges = m.edges.map(rfEdge); })();

    // ---- 存檔／復原 ----
    let saveTimer = null, dirty = false;
    function changed() { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(flush, 600); }
    function flush() {
      clearTimeout(saveTimer);
      if (!dirty) return;
      dirty = false;
      if (opts.onChange) opts.onChange(serialize(currentModel()));
    }
    function snapshot() {
      undo.push(serialize(currentModel()));
      if (undo.length > 100) undo.shift();
      redo.length = 0;
      updateUndoBtns();
    }
    function updateUndoBtns() {
      host.querySelector('.rm-undo').disabled = !undo.length;
      host.querySelector('.rm-redo').disabled = !redo.length;
    }
    function doUndo() { if (!undo.length) return; redo.push(serialize(currentModel())); setAll(parse(undo.pop())); changed(); updateUndoBtns(); }
    function doRedo() { if (!redo.length) return; undo.push(serialize(currentModel())); setAll(parse(redo.pop())); changed(); updateUndoBtns(); }
    function selectedNode() { return latestNodes.find(function (n) { return n.selected; }); }
    function refreshChrome() {
      colorBtn.disabled = !selectedNode();
      host.querySelector('.rm-empty').hidden = !!latestNodes.length;
    }
    function fitSoon() { setTimeout(function () { if (bound) bound.rf.fitView({ padding: 0.15, duration: 250, maxZoom: 1.25 }); }, 80); }
    function notify(msg) {
      if (global.App && App.toast) { App.toast(msg); return; }
      const t = document.createElement('div');
      t.className = 'rm-toast'; t.textContent = msg;
      host.appendChild(t);
      setTimeout(function () { t.remove(); }, 2600);
    }

    // ---- React Flow 元件（沒有 JSX，直接 createElement）----
    function mount() {
      const RE = global.React, RF = global.ReactFlow, h = RE.createElement;   // 注意：R 在這個模組是圓盤半徑，React 另外叫 RE

      function DiscNode(p) {
        const d = p.data, hex = nodeHex(p.id, d.color);
        return h('div', { className: 'rm-rf-node' + (p.selected ? ' is-sel' : '') },
          // 整顆圓盤都是「連到這裡」的落點；只能當終點，拖圓盤本身是搬節點
          h(RF.Handle, { type: 'target', position: RF.Position.Top, className: 'rm-rf-target', isConnectableStart: false }),
          h('div', { className: 'rm-rf-disc', style: { borderColor: hex, color: hex } }, monogram(d.label)),
          h('div', { className: 'rm-rf-label' }, d.label || '（未命名）'),
          // 右邊這顆小圓點才是拉線的起點
          h(RF.Handle, { type: 'source', position: RF.Position.Right, className: 'rm-rf-source' })
        );
      }
      function FloatingEdge(p) {
        const s = RF.useInternalNode(p.source), t = RF.useInternalNode(p.target);
        if (!s || !t || !s.measured || !t.measured) return null;
        function box(n) { return { x: n.internals.positionAbsolute.x, y: n.internals.positionAbsolute.y, w: n.measured.width || (R * 2 + 8), h: n.measured.height || (R * 2 + LABEL_H) }; }
        const g = edgeGeometry(box(s), box(t), hash(p.source + '|' + p.target));
        const hex = EDGE_HEX[(p.data && p.data.k) || 0];
        return h(RF.BaseEdge, {
          id: p.id, path: pathD(g, 0, 0), markerEnd: p.markerEnd, interactionWidth: 18,
          style: p.selected ? { stroke: '#4c8dff', strokeWidth: 2.5 } : { stroke: hex, strokeWidth: 1.6, strokeDasharray: '6 4', strokeLinecap: 'round' },
          label: p.label || undefined, labelX: g.mid.x, labelY: g.mid.y,
          labelStyle: { fill: '#9aa4b5', fontSize: 11, fontWeight: 600 },
          labelShowBg: true, labelBgStyle: { fill: '#1c2331', stroke: '#2a3242' }, labelBgPadding: [7, 3], labelBgBorderRadius: 9
        });
      }
      const nodeTypes = { disc: DiscNode }, edgeTypes = { floating: FloatingEdge };

      function Flow() {
        const ns = RF.useNodesState(latestNodes), es = RF.useEdgesState(latestEdges);
        const nodes = ns[0], setNodes = ns[1], onNodesChange = ns[2];
        const edges = es[0], setEdges = es[1], onEdgesChange = es[2];
        const rf = RF.useReactFlow();
        const dragSnap = RE.useRef(null);
        RE.useEffect(function () {
          latestNodes = nodes; latestEdges = edges;
          refreshChrome();
          if (pendingChange) { pendingChange = false; changed(); }
        }, [nodes, edges]);
        RE.useEffect(function () {
          bound = { setNodes: setNodes, setEdges: setEdges, rf: rf };
          return function () { bound = null; };
        }, []);
        // 刪除（Delete／Backspace 是 React Flow 自己處理的）：套用之前先留一份復原點
        const handleNodes = RE.useCallback(function (changes) {
          if (changes.some(function (c) { return c.type === 'remove'; })) { if (!pendingChange) snapshot(); pendingChange = true; }
          onNodesChange(changes);
        }, [onNodesChange]);
        const handleEdges = RE.useCallback(function (changes) {
          if (changes.some(function (c) { return c.type === 'remove'; })) { if (!pendingChange) snapshot(); pendingChange = true; }
          onEdgesChange(changes);
        }, [onEdgesChange]);
        const onConnect = RE.useCallback(function (c) {
          if (!c.source || !c.target || c.source === c.target) return;
          if (latestEdges.some(function (e) { return e.source === c.source && e.target === c.target; })) return;
          snapshot(); pendingChange = true;
          setEdges(function (list) { return list.concat([rfEdge({ from: c.source, to: c.target, label: '' })]); });
        }, []);
        return h(RF.ReactFlow, {
          nodes: nodes, edges: edges, nodeTypes: nodeTypes, edgeTypes: edgeTypes,
          onNodesChange: handleNodes, onEdgesChange: handleEdges, onConnect: onConnect,
          onNodeDragStart: function () { dragSnap.current = serialize(currentModel()); },
          onNodeDragStop: function () {
            const before = dragSnap.current; dragSnap.current = null;
            if (before == null) return;
            // 位置要等這一輪 state 套完才是新的
            setTimeout(function () {
              if (serialize(currentModel()) === before) return;
              undo.push(before); if (undo.length > 100) undo.shift(); redo.length = 0; updateUndoBtns(); changed();
            }, 0);
          },
          onNodeDoubleClick: function (ev, node) { openInput(node.id); },
          onEdgeDoubleClick: function (ev, edge) { openEdgeInput(edge.id, ev.clientX, ev.clientY); },
          colorMode: 'dark', connectionMode: 'loose', connectionRadius: 34, zoomOnDoubleClick: false,
          deleteKeyCode: ['Backspace', 'Delete'], minZoom: 0.15, maxZoom: 3,
          fitView: true, fitViewOptions: { padding: 0.2, maxZoom: 1.25 },
          connectionLineStyle: { stroke: '#4c8dff', strokeWidth: 2, strokeDasharray: '5 3' },
          attributionPosition: 'top-right'
        },
          h(RF.Background, { variant: 'dots', gap: 24, size: 1.3, color: 'rgba(255,255,255,.16)' }),
          h(RF.Controls, { position: 'bottom-left' }),
          h(RF.MiniMap, {
            position: 'bottom-right', pannable: true, zoomable: true,
            nodeColor: function (n) { return nodeHex(n.id, n.data && n.data.color); },
            nodeStrokeWidth: 0, nodeBorderRadius: 40, maskColor: 'rgba(15, 19, 26, .62)'
          })
        );
      }
      root = global.ReactDOM.createRoot(rootEl);
      root.render(h(RF.ReactFlowProvider, null, h(Flow)));
      host.querySelector('.rm-loading').hidden = true;
      refreshChrome();
    }

    // ---- 雙擊空白處：新增節點（React Flow 沒有 pane 的雙擊事件，自己接）----
    canvas.addEventListener('dblclick', function (e) {
      if (!bound || !e.target.classList || !e.target.classList.contains('react-flow__pane')) return;
      addNodeAt(e.clientX, e.clientY);
    });
    function addNodeAt(clientX, clientY) {
      if (!bound) return;
      const p = bound.rf.screenToFlowPosition({ x: clientX, y: clientY });
      const n = { id: newId(), label: '新節點', x: Math.round(p.x - nodeSize({ label: '新節點' }).w / 2), y: Math.round(p.y - R), color: '' };
      snapshot();
      applyNodes(function (list) {
        return list.map(function (x) { return x.selected ? Object.assign({}, x, { selected: false }) : x; })
          .concat([Object.assign(rfNode(n), { selected: true })]);
      });
      changed();
      setTimeout(function () { openInput(n.id); }, 80);   // 等 React 把節點畫出來才量得到位置
    }

    // ---- 就地改文字：輸入框是 body 層的 fixed 元素，疊在節點標籤／連線標籤上 ----
    function openInput(id) {
      closeInput();
      const node = latestNodes.find(function (n) { return n.id === id; });
      const lbl = rootEl.querySelector('.react-flow__node[data-id="' + cssEsc(id) + '"] .rm-rf-label');
      if (!node || !lbl) return;
      const r = lbl.getBoundingClientRect();
      const w = Math.max(140, r.width + 40);
      placeInput(r.left + r.width / 2 - w / 2, r.top - 3, w, Math.max(24, r.height + 6), node.data.label || '', '節點名稱…', function (v) {
        if (v === (node.data.label || '')) return;
        snapshot();
        applyNodes(function (list) {
          return list.map(function (n) {
            return n.id === id ? Object.assign({}, n, { data: Object.assign({}, n.data, { label: v }), style: { width: nodeSize({ label: v }).w } }) : n;
          });
        });
        changed();
      });
    }
    function openEdgeInput(id, x, y) {
      closeInput();
      const edge = latestEdges.find(function (e) { return e.id === id; });
      if (!edge) return;
      placeInput(x - 75, y - 13, 150, 26, edge.label || '', '連線文字…', function (v) {
        if (v === (edge.label || '')) return;
        snapshot();
        applyEdges(function (list) { return list.map(function (e) { return e.id === id ? Object.assign({}, e, { label: v }) : e; }); });
        changed();
      });
    }
    function placeInput(left, top, w, hgt, value, placeholder, onCommit) {
      input = document.createElement('input');
      input.className = 'rm-input';
      input.value = value; input.placeholder = placeholder;
      input.style.left = Math.max(4, left) + 'px'; input.style.top = top + 'px';
      input.style.width = w + 'px'; input.style.height = hgt + 'px';
      host.appendChild(input);
      input.focus(); input.select();
      const el = input;
      let done = false;
      function finish(save) {
        if (done) return; done = true;
        const v = el.value;
        if (input === el) input = null;
        el.remove();
        if (save) onCommit(v);
      }
      el.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      el.addEventListener('blur', function () { finish(true); });
    }
    function closeInput() { if (input) { const el = input; input = null; el.blur(); } }
    function cssEsc(s) { return (global.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"'); }

    // ---- 顏色 ----
    function colorMenu() {
      const sel = selectedNode();
      if (!sel) return;
      closePopups();
      const pop = document.createElement('div');
      pop.className = 'rm-colors rm-pop';
      COLORS.forEach(function (c) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rm-swatch' + (c ? ' rm-' + c : ' rm-none') + ((sel.data.color || '') === c ? ' on' : '');
        b.title = c || '自動';
        b.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
        b.addEventListener('click', function () {
          closePopups();
          snapshot();
          applyNodes(function (list) { return list.map(function (n) { return n.id === sel.id ? Object.assign({}, n, { data: Object.assign({}, n.data, { color: c }) }) : n; }); });
          changed();
        });
        pop.appendChild(b);
      });
      showPopup(pop, colorBtn);
    }

    // ---- CSV 選單：匯入／下載範本／匯出 ----
    function csvMenu() {
      closePopups();
      const pop = document.createElement('div');
      pop.className = 'rm-menu rm-pop';
      const items = [
        { icon: 'upload', label: '匯入 CSV…', fn: pickCSV },
        { icon: 'download', label: '下載 CSV 範本', fn: function () { downloadCSV('關聯分析-範本', CSV_TEMPLATE); } },
        { icon: 'file-text', label: '匯出成 CSV', fn: function () {
          const m = currentModel();
          if (!m.nodes.length) { notify('畫布上還沒有節點可以匯出'); return; }
          downloadCSV((titleEl && titleEl.value.trim()) || '關聯分析', toCSV(m));
        } }
      ];
      items.forEach(function (it) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'rm-menu-item';
        b.innerHTML = ic(it.icon) + '<span>' + esc(it.label) + '</span>';
        b.addEventListener('click', function () { closePopups(); it.fn(); });
        pop.appendChild(b);
      });
      const hint = document.createElement('div');
      hint.className = 'rm-menu-hint';
      hint.innerHTML = '格式：一列一條關聯<br><code>source,target,label</code><br>label 可以不填；也可以把 .csv 直接拖進畫布';
      pop.appendChild(hint);
      showPopup(pop, host.querySelector('.rm-csv'));
    }
    function showPopup(pop, anchor) {
      host.appendChild(pop);
      const r = anchor.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = (r.bottom + 6) + 'px';
      setTimeout(function () { document.addEventListener('mousedown', onPopOutside, true); }, 0);
    }
    function onPopOutside(e) { if (!e.target.closest('.rm-pop')) closePopups(); }
    function closePopups() {
      Array.prototype.forEach.call(host.querySelectorAll('.rm-pop'), function (p) { p.remove(); });
      document.removeEventListener('mousedown', onPopOutside, true);
    }
    function pickCSV() {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.csv,.tsv,.txt,text/csv,text/plain'; inp.multiple = true; inp.hidden = true;
      document.body.appendChild(inp);
      inp.addEventListener('change', function () { readCSVFiles(inp.files); inp.remove(); });
      inp.click();
    }
    function readCSVFiles(files) {
      Array.prototype.forEach.call(files, function (f) {
        const reader = new FileReader();
        reader.onload = function () { doImport(String(reader.result || ''), f.name); };
        reader.readAsText(f);
      });
    }
    function doImport(csvText, name) {
      const model = currentModel();
      const before = serialize(model);
      const r = importCSV(model, csvText);
      if (!r.nodes.length && !r.edges) { notify('「' + (name || 'CSV') + '」裡沒有讀到任何關聯（要有 source,target 兩欄）'); return; }
      undo.push(before); if (undo.length > 100) undo.shift(); redo.length = 0; updateUndoBtns();
      if (r.nodes.length) autoLayout(model, r.nodes);
      setAll(model);
      changed(); fitSoon();
      notify('已匯入 ' + r.nodes.length + ' 個節點、' + r.edges + ' 條關聯');
    }
    const dropHint = host.querySelector('.rm-drop');
    canvas.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0) { e.preventDefault(); dropHint.hidden = false; }
    });
    canvas.addEventListener('dragleave', function (e) { if (!canvas.contains(e.relatedTarget)) dropHint.hidden = true; });
    canvas.addEventListener('drop', function (e) {
      dropHint.hidden = true;
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      e.preventDefault();
      readCSVFiles(e.dataTransfer.files);
    });

    // ---- 鍵盤：Delete／Backspace 交給 React Flow；這裡只管復原、F2 ----
    function onKey(e) {
      if (input || e.target === titleEl) return;
      if (e.key === 'F2') { const s = selectedNode(); if (s) { e.preventDefault(); openInput(s.id); } return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); }
    }
    host.addEventListener('keydown', onKey);

    // ---- 工具列 ----
    host.querySelector('.rm-add').addEventListener('click', function () {
      const r = canvas.getBoundingClientRect();
      addNodeAt(r.left + r.width / 2, r.top + r.height / 2);
    });
    colorBtn.addEventListener('click', colorMenu);
    host.querySelector('.rm-csv').addEventListener('click', csvMenu);
    host.querySelector('.rm-undo').addEventListener('click', doUndo);
    host.querySelector('.rm-redo').addEventListener('click', doRedo);
    host.querySelector('.rm-layout').addEventListener('click', function () {
      const model = currentModel();
      if (!model.nodes.length) return;
      snapshot(); autoLayout(model, null); setAll(model); changed(); fitSoon();
    });

    function close() {
      if (closed) return;
      closed = true;
      closeInput(); closePopups();
      flush();
      host.removeEventListener('keydown', onKey);
      const finalDsl = serialize(currentModel());
      if (root) { try { root.unmount(); } catch (e) { /* ignore */ } root = null; }
      host.classList.remove('rm-page');
      host.innerHTML = '';
      if (ownHost) host.remove();
      if (opts.onSave) opts.onSave(finalDsl);
      if (opts.onClose) opts.onClose();
    }
    host.querySelector('.rm-back').addEventListener('click', close);

    updateUndoBtns();
    refreshChrome();
    loadReactFlow().then(function () {
      if (!closed) mount();
    }, function (e) {
      if (closed) return;
      const l = host.querySelector('.rm-loading');
      l.textContent = 'React Flow 載入失敗（' + (e && e.message || e) + '），重新整理後再試一次。';
      l.classList.add('is-error');
    });
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
    toCSV: toCSV,
    autoLayout: autoLayout
  };
})(window);

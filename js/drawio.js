/* drawio（js/drawio.js）—— 基本的繪圖工具
 *
 * 版面照 draw.io 的樣子：上面選單列＋工具列，左邊圖形，中間畫布，右邊格式面板。功能只做
 * 基本的那一些：放圖形、搬動、縮放、拉連線、改文字、改顏色線條、復原重做、複製貼上、
 * 縮放平移、匯出 PNG／SVG。是自己寫的，不是把 draw.io 放進來——沒有圖層、分頁、旋轉、
 * 群組、容器、圖庫這些。
 *
 * 跟關聯分析（relmap.js）同一套想法：
 *   - 圖的原始資料是一段文字（DSL），一行一個圖形或一條連線，存在筆記的 ```drawio 圍欄裡。
 *     搜尋得到、版本紀錄的差異看得懂、備份還原不用另外處理。
 *   - renderSVG() 是 DSL 的純函式：文字寬度用字元類別估，不量 DOM，所以預覽、PDF、
 *     電子書、編輯器畫布出來是同一張圖。
 *
 *   shape <id> <種類> x= y= w= h= ["文字"] [fill=#hex|none] [stroke=#hex|none] [sw=] [dash=1]
 *                                          [fs=] [fc=#hex] [bold=1] [align=left|center|right]
 *   edge  <id> <起點> <終點> ["文字"] [style=straight|elbow|curve] [start=none|arrow]
 *                                     [end=none|arrow] [stroke=] [sw=] [dash=1] [fs=] [fc=]
 *   opt   grid=0
 *
 * 種類除了基本的幾何圖形，還有一組網路設備（router、switch、firewall、server…，見 DEVICES）：
 * 一樣是畫出來的向量圖形，吃同一組 fill／stroke，文字寫在圖形下面。
 *
 * 種類是 image 的圖形是一張圖片（左邊「我的圖示」裡上傳的）：多一個 src=img:<檔案 id>。
 * 寫成 img:<id> 是故意的——伺服器判斷「誰看得到這個上傳」就是看筆記內容裡有沒有這串字，
 * 所以圖分享出去，對方也看得到上面的圖示，不用另外開權限。
 *
 * 起點／終點是圖形的 id（連線會跟著圖形走），或 @x,y（畫布上的一個點）。圖形在清單裡的
 * 順序就是疊放順序；連線一律畫在圖形上面。顏色是使用者自己挑的，所以直接寫在 SVG 的屬性
 * 上（不像關聯分析走 CSS class）；畫布永遠是白紙，印出來也是白紙，不跟主題變色。
 */
(function (global) {
  'use strict';

  function ic(name) { return global.Icons ? Icons.svg(name) : ''; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt(n) { return String(Math.round(n * 10) / 10); }

  const FONT = "Helvetica, Arial, 'Noto Sans TC', 'Microsoft JhengHei', sans-serif";
  const SHAPE_DEF = { fill: '#ffffff', stroke: '#000000', sw: 1, dash: 0, fs: 12, fc: '#000000', bold: 0, align: 'center' };
  const EDGE_DEF = { stroke: '#000000', sw: 1, dash: 0, fs: 11, fc: '#000000', bold: 0, style: 'straight', start: 'none', end: 'arrow' };
  const BASIC = ['rect', 'round', 'pill', 'ellipse', 'diamond', 'para', 'hex', 'tri', 'cyl', 'cloud', 'doc', 'actor', 'text', 'image'];
  function isType(t) { return BASIC.indexOf(t) >= 0 || isDevice(t); }
  // 圖片的來源只收 img:<id>，id 只有英數、底線、點、連字號——這個值會寫進 SVG 的 href
  const SRC_RE = /^img:([A-Za-z0-9_][\w.-]{0,63})$/;
  // 文字放在圖形下面的那幾種（本身沒有地方寫字）
  function labelBelow(s) { return s.type === 'actor' || s.type === 'image' || isDevice(s.type); }
  const ALIGNS = ['left', 'center', 'right'];
  const STYLES = ['straight', 'elbow', 'curve'];
  const GRID = 10, MIN_SIZE = 10;

  // 左邊那排圖形。大小照 draw.io 的預設值。
  const PALETTE = [
    { title: '一般', items: [
      { type: 'rect', w: 120, h: 60, name: '矩形' },
      { type: 'round', w: 120, h: 60, name: '圓角矩形' },
      { type: 'text', w: 60, h: 30, name: '文字', label: '文字' },
      { type: 'ellipse', w: 120, h: 80, name: '橢圓' },
      { type: 'rect', w: 80, h: 80, name: '正方形' },
      { type: 'ellipse', w: 80, h: 80, name: '圓形' },
      { type: 'pill', w: 120, h: 40, name: '起訖（膠囊）' },
      { type: 'diamond', w: 80, h: 80, name: '菱形' },
      { type: 'para', w: 120, h: 60, name: '平行四邊形' },
      { type: 'hex', w: 120, h: 80, name: '六邊形' },
      { type: 'tri', w: 60, h: 80, name: '三角形' },
      { type: 'cyl', w: 60, h: 80, name: '圓柱（資料庫）' },
      { type: 'cloud', w: 120, h: 80, name: '雲' },
      { type: 'doc', w: 120, h: 80, name: '文件' },
      { type: 'actor', w: 30, h: 60, name: '人' }
    ] },
    { title: '網路設備', devices: true, items: [] },     // 內容在 DEVICES 定義完之後填進去
    { title: '連線', items: [
      { edge: 'straight', end: 'arrow', name: '箭頭' },
      { edge: 'straight', end: 'none', name: '直線' },
      { edge: 'straight', end: 'arrow', start: 'arrow', name: '雙向箭頭' },
      { edge: 'straight', end: 'arrow', dash: 1, name: '虛線箭頭' },
      { edge: 'elbow', end: 'arrow', name: '折線' },
      { edge: 'curve', end: 'arrow', name: '曲線' }
    ] }
  ];
  // 格式面板的配色（draw.io 預設的那八組：填色＋線色）
  const PRESETS = [
    ['#ffffff', '#000000'], ['#f5f5f5', '#666666'], ['#dae8fc', '#6c8ebf'], ['#d5e8d4', '#82b366'],
    ['#ffe6cc', '#d79b00'], ['#fff2cc', '#d6b656'], ['#f8cecc', '#b85450'], ['#e1d5e7', '#9673a6']
  ];

  // ---------------- DSL ----------------
  function unescapeStr(s) {
    return String(s).replace(/\\(["\\n])/g, function (m, c) { return c === 'n' ? '\n' : c; });
  }
  function quote(s) {
    return '"' + String(s || '').replace(/\r\n?/g, '\n').replace(/([\\"])/g, '\\$1').replace(/\n/g, '\\n') + '"';
  }
  // 引號裡的算文字、其餘算屬性：文字剛好長得像 x=1 也不會被當成屬性
  function tokenize(line) {
    const out = [];
    const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1] !== undefined ? { q: true, v: unescapeStr(m[1]) } : { q: false, v: m[2] });
    return out;
  }
  function num(v, d, lo, hi) {
    const n = parseFloat(v);
    if (!isFinite(n)) return d;
    return lo === undefined ? n : clamp(n, lo, hi);
  }
  // 顏色只收 #rrggbb 或 none——這個值會原樣寫進 SVG 的屬性
  function color(v, d, allowNone) {
    const s = String(v || '').toLowerCase();
    if (allowNone && s === 'none') return 'none';
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    if (/^#[0-9a-f]{3}$/.test(s)) return '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    return d;
  }
  const ID_RE = /^[A-Za-z][\w-]{0,31}$/;
  function endpointOf(tok) {
    const m = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(tok);
    if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
    return ID_RE.test(tok) ? { id: tok } : null;
  }
  function split(tokens) {
    const o = { label: '', attrs: {} };
    let gotLabel = false;
    tokens.forEach(function (t) {
      if (t.q) { if (!gotLabel) { o.label = t.v; gotLabel = true; } return; }
      const i = t.v.indexOf('=');
      if (i > 0) o.attrs[t.v.slice(0, i)] = t.v.slice(i + 1);
    });
    return o;
  }

  function parse(text) {
    const model = { shapes: [], edges: [], grid: true };
    const seen = {};
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      const line = raw.trim();
      if (!line || line[0] === '#' || line.slice(0, 3) === '```') return;
      const t = tokenize(line);
      if (!t.length || t[0].q) return;
      const kind = t[0].v;
      if (kind === 'shape' && t[1] && t[2] && !t[1].q && !t[2].q) {
        const id = t[1].v, type = t[2].v;
        if (!ID_RE.test(id) || seen[id] || !isType(type)) return;
        const r = split(t.slice(3)), a = r.attrs;
        const src = type === 'image' ? SRC_RE.exec(a.src || '') : null;
        if (type === 'image' && !src) return;      // 沒有來源的圖片畫不出東西
        seen[id] = true;
        model.shapes.push({
          id: id, type: type, label: r.label,
          x: num(a.x, 0), y: num(a.y, 0),
          w: num(a.w, 120, MIN_SIZE, 4000), h: num(a.h, 60, MIN_SIZE, 4000),
          fill: color(a.fill, SHAPE_DEF.fill, true), stroke: color(a.stroke, SHAPE_DEF.stroke, true),
          sw: num(a.sw, SHAPE_DEF.sw, 0.5, 20), dash: a.dash === '1' ? 1 : 0,
          fs: num(a.fs, SHAPE_DEF.fs, 6, 96), fc: color(a.fc, SHAPE_DEF.fc, false),
          bold: a.bold === '1' ? 1 : 0, align: ALIGNS.indexOf(a.align) >= 0 ? a.align : SHAPE_DEF.align
        });
        if (src) model.shapes[model.shapes.length - 1].src = src[1];
      } else if (kind === 'edge' && t[1] && t[2] && t[3] && !t[1].q && !t[2].q && !t[3].q) {
        const id = t[1].v;
        const from = endpointOf(t[2].v), to = endpointOf(t[3].v);
        if (!ID_RE.test(id) || seen[id] || !from || !to) return;
        const r = split(t.slice(4)), a = r.attrs;
        seen[id] = true;
        model.edges.push({
          id: id, from: from, to: to, label: r.label,
          style: STYLES.indexOf(a.style) >= 0 ? a.style : EDGE_DEF.style,
          start: a.start === 'arrow' ? 'arrow' : 'none',
          end: a.end === 'none' ? 'none' : 'arrow',
          stroke: color(a.stroke, EDGE_DEF.stroke, false), sw: num(a.sw, EDGE_DEF.sw, 0.5, 20),
          dash: a.dash === '1' ? 1 : 0,
          fs: num(a.fs, EDGE_DEF.fs, 6, 96), fc: color(a.fc, EDGE_DEF.fc, false), bold: a.bold === '1' ? 1 : 0
        });
      } else if (kind === 'opt') {
        const a = split(t.slice(1)).attrs;
        if (a.grid === '0') model.grid = false;
      }
    });
    return model;
  }
  function endpointText(p) { return p.id ? p.id : '@' + fmt(p.x) + ',' + fmt(p.y); }
  function serialize(model) {
    const lines = [];
    if (model.grid === false) lines.push('opt grid=0');
    model.shapes.forEach(function (s) {
      let l = 'shape ' + s.id + ' ' + s.type + ' x=' + fmt(s.x) + ' y=' + fmt(s.y) + ' w=' + fmt(s.w) + ' h=' + fmt(s.h);
      if (s.label) l += ' ' + quote(s.label);
      if (s.type === 'image') l += ' src=img:' + s.src;
      if (s.fill !== SHAPE_DEF.fill) l += ' fill=' + s.fill;
      if (s.stroke !== SHAPE_DEF.stroke) l += ' stroke=' + s.stroke;
      if (s.sw !== SHAPE_DEF.sw) l += ' sw=' + fmt(s.sw);
      if (s.dash) l += ' dash=1';
      if (s.fs !== SHAPE_DEF.fs) l += ' fs=' + fmt(s.fs);
      if (s.fc !== SHAPE_DEF.fc) l += ' fc=' + s.fc;
      if (s.bold) l += ' bold=1';
      if (s.align !== SHAPE_DEF.align) l += ' align=' + s.align;
      lines.push(l);
    });
    model.edges.forEach(function (e) {
      let l = 'edge ' + e.id + ' ' + endpointText(e.from) + ' ' + endpointText(e.to);
      if (e.label) l += ' ' + quote(e.label);
      if (e.style !== EDGE_DEF.style) l += ' style=' + e.style;
      if (e.start !== EDGE_DEF.start) l += ' start=' + e.start;
      if (e.end !== EDGE_DEF.end) l += ' end=' + e.end;
      if (e.stroke !== EDGE_DEF.stroke) l += ' stroke=' + e.stroke;
      if (e.sw !== EDGE_DEF.sw) l += ' sw=' + fmt(e.sw);
      if (e.dash) l += ' dash=1';
      if (e.fs !== EDGE_DEF.fs) l += ' fs=' + fmt(e.fs);
      if (e.fc !== EDGE_DEF.fc) l += ' fc=' + e.fc;
      if (e.bold) l += ' bold=1';
      lines.push(l);
    });
    return lines.join('\n');
  }
  function indexOf(model) {
    const m = {};
    model.shapes.forEach(function (s) { m[s.id] = s; });
    return m;
  }

  // ---------------- 筆記內容 <-> DSL ----------------
  function payloadOf(content) {
    const m = /^```drawio[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/m.exec(String(content || ''));
    return m ? m[1] : null;
  }
  function wrap(dsl) { return '```drawio\n' + (dsl ? dsl + '\n' : '') + '```\n'; }
  function generate() { return wrap(''); }
  function isNote(note) { return !!(note && note.meta && note.meta.drawio); }
  // 這個功能的第一版是把 draw.io 本尊放進來，存的是一整行 SVG（裡面帶著它自己的圖檔）。
  // 那種格式這個編輯器打不開，但圖不能就這樣不見：照樣顯示，只是不能編輯。
  function isLegacy(payload) {
    const p = String(payload || '').trim();
    return /^(?:base64:|<svg[\s>]|<\?xml|<mxfile[\s>])/.test(p);
  }
  function legacySvg(payload) {
    let p = String(payload || '').trim();
    try {
      if (p.slice(0, 7) === 'base64:') {
        const bin = atob(p.slice(7).replace(/\s+/g, ''));
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        p = new TextDecoder().decode(bytes).trim();
      }
    } catch (e) { return ''; }
    return /^<(?:\?xml|svg[\s>])/.test(p) ? p : '';
  }
  function b64(str) {
    const bytes = new TextEncoder().encode(String(str));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // ---------------- 文字寬度（估的，不量 DOM）----------------
  function charW(ch, fs, bold) {
    const c = ch.codePointAt(0);
    let w;
    if (c >= 0x1100 && (c <= 0x115F || (c >= 0x2E80 && c <= 0xA4CF) || (c >= 0xAC00 && c <= 0xD7A3) ||
      (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFF60) || (c >= 0x3000 && c <= 0x303F))) w = 1;
    else if (ch === ' ') w = 0.28;
    else if ('ilI.,:;|!\'`jt'.indexOf(ch) >= 0) w = 0.3;
    else if ('mwMW@'.indexOf(ch) >= 0) w = 0.86;
    else if (c >= 65 && c <= 90) w = 0.68;
    else w = 0.56;
    return w * fs * (bold ? 1.06 : 1);
  }
  function textW(s, fs, bold) {
    let w = 0;
    for (const ch of String(s || '')) w += charW(ch, fs, bold);
    return w;
  }
  // 折行：英文以字為單位、中文一個字一個字；一個字自己就超寬才硬切
  function wrapText(text, max, fs, bold) {
    const out = [];
    String(text || '').split('\n').forEach(function (para) {
      const toks = para.match(/[A-Za-z0-9_\-./:@#%&+=~]+|\s+|[\s\S]/g) || [];
      let line = '', lw = 0;
      toks.forEach(function (tk) {
        const tw = textW(tk, fs, bold);
        if (lw + tw > max && line) {
          out.push(line.replace(/\s+$/, ''));
          line = ''; lw = 0;
          if (/^\s+$/.test(tk)) return;
        }
        if (tw > max) {
          for (const ch of tk) {
            const cw = charW(ch, fs, bold);
            if (lw + cw > max && line) { out.push(line); line = ''; lw = 0; }
            line += ch; lw += cw;
          }
        } else { line += tk; lw += tw; }
      });
      out.push(line.replace(/\s+$/, ''));
    });
    return out.length ? out : [''];
  }

  // ---------------- 圖形 ----------------
  function strokeAttrs(o) {
    let a = ' stroke="' + o.stroke + '" stroke-width="' + fmt(o.sw) + '"';
    if (o.dash) a += ' stroke-dasharray="' + fmt(o.sw * 5 + 1) + ' ' + fmt(o.sw * 3 + 1) + '"';
    return a;
  }
  function pts(list) { return list.map(function (p) { return fmt(p[0]) + ',' + fmt(p[1]); }).join(' '); }
  // ---------------- 網路設備 ----------------
  // 內建的設備圖示是「畫出來的」，不是圖片檔：每一種是一組圖元，座標寫在 0..1 的方框裡，
  // 畫的時候照圖形的寬高換算成實際座標。不用 transform 放大——那樣線條會跟著變粗、
  // 拉寬的時候還會變扁。顏色跟其他圖形一樣吃 fill／stroke，所以格式面板的配色照樣能用：
  //   body   機身：fill + stroke            paper  螢幕、紙張：白底 + stroke
  //   line   只有線                          ink    實心的小東西（燈號、箭頭）：用線的顏色塗滿
  function pen(s, ox, oy) {
    const x0 = s.x + ox, y0 = s.y + oy, w = s.w, h = s.h, m = Math.min(w, h);
    const sa = strokeAttrs(s);
    const ST = {
      body: ' fill="' + s.fill + '"' + sa + ' stroke-linejoin="round"',
      paper: ' fill="#ffffff"' + sa + ' stroke-linejoin="round"',
      line: ' fill="none"' + sa + ' stroke-linecap="round" stroke-linejoin="round"',
      ink: ' fill="' + (s.stroke === 'none' ? '#666666' : s.stroke) + '" stroke="none"'
    };
    const X = function (a) { return x0 + a * w; }, Y = function (b) { return y0 + b * h; };
    const at = function (list) { return pts(list.map(function (q) { return [X(q[0]), Y(q[1])]; })); };
    let out = '';
    return {
      // r：圓角，單位是「寬高裡比較短的那一邊」
      rect: function (a, b, c, d, r, k) {
        out += '<rect x="' + fmt(X(a)) + '" y="' + fmt(Y(b)) + '" width="' + fmt(c * w) + '" height="' + fmt(d * h) + '"' +
          (r ? ' rx="' + fmt(r * m) + '"' : '') + ST[k || 'body'] + '/>';
      },
      ell: function (cx, cy, rx, ry, k) {
        out += '<ellipse cx="' + fmt(X(cx)) + '" cy="' + fmt(Y(cy)) + '" rx="' + fmt(rx * w) + '" ry="' + fmt(ry * h) + '"' + ST[k || 'body'] + '/>';
      },
      // 圖形拉寬拉扁它都還是圓的（燈號、按鈕）
      dot: function (cx, cy, r, k) {
        out += '<circle cx="' + fmt(X(cx)) + '" cy="' + fmt(Y(cy)) + '" r="' + fmt(Math.max(0.8, r * m)) + '"' + ST[k || 'ink'] + '/>';
      },
      poly: function (list, k) { out += '<polygon points="' + at(list) + '"' + ST[k || 'body'] + '/>'; },
      line: function (list) { out += '<polyline points="' + at(list) + '"' + ST.line + '/>'; },
      // cmds：['M', x, y, 'C', x1, y1, x2, y2, x, y, 'Z' …]，數字都是一對一對的座標
      path: function (cmds, k) {
        let d = '', isX = true;
        cmds.forEach(function (c) {
          if (typeof c === 'string') { d += (d ? ' ' : '') + c; isX = true; return; }
          d += (isX ? ' ' : ',') + fmt(isX ? X(c) : Y(c));
          isX = !isX;
        });
        out += '<path d="' + d + '"' + ST[k || 'body'] + '/>';
      },
      // 帶箭頭的線：箭頭的大小照實際像素算，不跟著圖形變形
      arrow: function (a, b, c, d) {
        const x1 = X(a), y1 = Y(b), x2 = X(c), y2 = Y(d);
        const len = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)) || 1;
        const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
        const hs = clamp(m * 0.13, 2.5, 9);
        const bx = x2 - ux * hs, by = y2 - uy * hs;
        out += '<polyline points="' + pts([[x1, y1], [bx, by]]) + '"' + ST.line + '/>' +
          '<polygon points="' + pts([[x2, y2], [bx - uy * hs * 0.5, by + ux * hs * 0.5], [bx + uy * hs * 0.5, by - ux * hs * 0.5]]) + '"' + ST.ink + '/>';
      },
      // 圖示上的字（VM）：大小跟著圖形走，單位同樣是比較短的那一邊
      text: function (cx, cy, str, size) {
        const fs = Math.max(5, size * m);
        out += '<text x="' + fmt(X(cx)) + '" y="' + fmt(baseline(Y(cy), fs)) + '" text-anchor="middle" font-size="' + fmt(fs) +
          '" font-weight="700"' + ST.ink + '>' + esc(str) + '</text>';
      },
      html: function () { return out; }
    };
  }
  // 半個橢圓用一段三次曲線畫：控制點拉出去 4/3 個半徑，曲線的頂點剛好落在一個半徑的地方
  const ARC = 4 / 3;
  function bust(p) {     // 肩膀（使用者、攻擊者共用）
    p.path(['M', 0.04, 1, 'C', 0.04, 0.66, 0.24, 0.54, 0.5, 0.54, 'C', 0.76, 0.54, 0.96, 0.66, 0.96, 1, 'Z'], 'body');
  }
  const C_BLUE = ['#dae8fc', '#6c8ebf'], C_RED = ['#f8cecc', '#b85450'], C_GREEN = ['#d5e8d4', '#82b366'],
    C_GREY = ['#f5f5f5', '#666666'], C_YELLOW = ['#fff2cc', '#d6b656'], C_ORANGE = ['#ffe6cc', '#d79b00'];
  // 順序就是左邊那一區排出來的順序。w／h 是放到畫布上的大小；color 是預設的［填色, 線色］
  const DEVICES = {
    // ---- 網路 ----
    router: { name: '路由器', w: 80, h: 50, color: C_BLUE, draw: function (p) {
      const r = 0.3;
      p.path(['M', 0, r, 'L', 0, 1 - r, 'C', 0, 1 - r + r * ARC, 1, 1 - r + r * ARC, 1, 1 - r, 'L', 1, r], 'body');
      p.ell(0.5, r, 0.5, r, 'body');
      p.arrow(0.46, r, 0.14, r); p.arrow(0.54, r, 0.86, r);
      p.arrow(0.5, 0.04, 0.5, 0.24); p.arrow(0.5, 0.56, 0.5, 0.36);
    } },
    'switch': { name: '交換器', w: 80, h: 40, color: C_BLUE, draw: function (p) {
      p.rect(0, 0.06, 1, 0.88, 0.12, 'body');
      p.arrow(0.16, 0.36, 0.84, 0.36); p.arrow(0.84, 0.64, 0.16, 0.64);
    } },
    firewall: { name: '防火牆', w: 70, h: 60, color: C_RED, draw: function (p) {
      p.rect(0, 0, 1, 1, 0, 'body');
      [0.25, 0.5, 0.75].forEach(function (y) { p.line([[0, y], [1, y]]); });
      [[0.5, 0], [0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]].forEach(function (q) {
        p.line([[q[0], q[1]], [q[0], q[1] + 0.25]]);
      });
    } },
    shield: { name: '入侵偵測／WAF', w: 56, h: 64, color: C_RED, draw: function (p) {
      p.path(['M', 0.5, 0, 'L', 1, 0.16, 'L', 1, 0.5, 'C', 1, 0.78, 0.78, 0.94, 0.5, 1,
        'C', 0.22, 0.94, 0, 0.78, 0, 0.5, 'L', 0, 0.16, 'Z'], 'body');
      p.line([[0.28, 0.5], [0.45, 0.67], [0.74, 0.33]]);
    } },
    lb: { name: '負載平衡器', w: 80, h: 50, color: C_BLUE, draw: function (p) {
      p.rect(0, 0.06, 1, 0.88, 0.1, 'body');
      p.line([[0.1, 0.5], [0.4, 0.5]]);
      p.arrow(0.4, 0.5, 0.88, 0.24); p.arrow(0.4, 0.5, 0.88, 0.5); p.arrow(0.4, 0.5, 0.88, 0.76);
    } },
    ap: { name: '無線基地台', w: 70, h: 60, color: C_BLUE, draw: function (p) {
      p.path(['M', 0.64, 0.2, 'Q', 0.76, 0.32, 0.64, 0.44], 'line');
      p.path(['M', 0.76, 0.08, 'Q', 0.98, 0.32, 0.76, 0.56], 'line');
      p.path(['M', 0.36, 0.2, 'Q', 0.24, 0.32, 0.36, 0.44], 'line');
      p.path(['M', 0.24, 0.08, 'Q', 0.02, 0.32, 0.24, 0.56], 'line');
      p.line([[0.5, 0.68], [0.5, 0.36]]);
      p.dot(0.5, 0.32, 0.06);
      p.rect(0.05, 0.68, 0.9, 0.3, 0.08, 'body');
      p.dot(0.2, 0.83, 0.035); p.dot(0.32, 0.83, 0.035);
    } },
    modem: { name: '數據機', w: 80, h: 46, color: C_BLUE, draw: function (p) {
      p.line([[0.86, 0.34], [0.86, 0.03]]);
      p.rect(0, 0.34, 1, 0.66, 0.1, 'body');
      [0.14, 0.26, 0.38, 0.5].forEach(function (x) { p.dot(x, 0.67, 0.06); });
    } },
    internet: { name: '網際網路', w: 70, h: 70, color: C_BLUE, draw: function (p) {
      p.ell(0.5, 0.5, 0.5, 0.5, 'body');
      p.ell(0.5, 0.5, 0.22, 0.5, 'line');
      p.line([[0, 0.5], [1, 0.5]]); p.line([[0.5, 0], [0.5, 1]]);
      p.path(['M', 0.07, 0.25, 'Q', 0.5, 0.37, 0.93, 0.25], 'line');
      p.path(['M', 0.07, 0.75, 'Q', 0.5, 0.63, 0.93, 0.75], 'line');
    } },
    // ---- 伺服器 ----
    server: { name: '伺服器', w: 50, h: 70, color: C_GREEN, draw: function (p) {
      p.rect(0, 0, 1, 1, 0.08, 'body');
      [0.1, 0.25, 0.4].forEach(function (y) { p.rect(0.16, y, 0.68, 0.09, 0, 'paper'); });
      p.dot(0.28, 0.8, 0.07);
      p.line([[0.5, 0.8], [0.84, 0.8]]);
    } },
    rack: { name: '機架伺服器', w: 70, h: 70, color: C_GREEN, draw: function (p) {
      [0.02, 0.36, 0.7].forEach(function (y) {
        p.rect(0, y, 1, 0.28, 0.05, 'body');
        p.dot(0.13, y + 0.14, 0.045); p.dot(0.27, y + 0.14, 0.045);
        p.line([[0.45, y + 0.14], [0.88, y + 0.14]]);
      });
    } },
    db: { name: '資料庫', w: 60, h: 70, color: C_GREEN, draw: function (p) {
      const r = 0.11, k = r * ARC;
      p.path(['M', 0, r, 'C', 0, r - k, 1, r - k, 1, r, 'L', 1, 1 - r, 'C', 1, 1 - r + k, 0, 1 - r + k, 0, 1 - r, 'Z'], 'body');
      [r, 0.39, 0.67].forEach(function (y) { p.path(['M', 0, y, 'C', 0, y + k, 1, y + k, 1, y], 'line'); });
    } },
    storage: { name: '儲存設備（NAS）', w: 70, h: 60, color: C_GREEN, draw: function (p) {
      p.rect(0, 0, 1, 1, 0.07, 'body');
      [0, 1, 2, 3].forEach(function (i) { p.rect(0.08 + i * 0.215, 0.12, 0.18, 0.58, 0, 'paper'); });
      p.dot(0.14, 0.85, 0.04); p.dot(0.27, 0.85, 0.04);
      p.line([[0.6, 0.85], [0.9, 0.85]]);
    } },
    web: { name: '網站／網頁伺服器', w: 80, h: 56, color: C_GREEN, draw: function (p) {
      p.rect(0, 0, 1, 1, 0.06, 'body');
      p.rect(0, 0.24, 1, 0.76, 0, 'paper');
      [0.08, 0.17, 0.26].forEach(function (x) { p.dot(x, 0.12, 0.045); });
      p.line([[0.12, 0.45], [0.6, 0.45]]); p.line([[0.12, 0.62], [0.88, 0.62]]); p.line([[0.12, 0.79], [0.74, 0.79]]);
    } },
    mail: { name: '郵件伺服器', w: 70, h: 48, color: C_GREEN, draw: function (p) {
      p.rect(0, 0, 1, 1, 0.05, 'body');
      p.line([[0.02, 0.06], [0.5, 0.6], [0.98, 0.06]]);
    } },
    vm: { name: '虛擬機', w: 70, h: 60, color: C_GREEN, draw: function (p) {
      p.rect(0.2, 0, 0.8, 0.68, 0.06, 'paper');
      p.rect(0, 0.3, 0.8, 0.7, 0.06, 'body');
      p.text(0.4, 0.65, 'VM', 0.3);
    } },
    // ---- 端點 ----
    pc: { name: '桌上型電腦', w: 70, h: 60, color: C_GREY, draw: function (p) {
      p.rect(0, 0, 1, 0.72, 0.06, 'body');
      p.rect(0.08, 0.08, 0.84, 0.56, 0, 'paper');
      p.poly([[0.42, 0.72], [0.58, 0.72], [0.63, 0.9], [0.37, 0.9]], 'body');
      p.rect(0.22, 0.9, 0.56, 0.1, 0.03, 'body');
    } },
    laptop: { name: '筆記型電腦', w: 80, h: 55, color: C_GREY, draw: function (p) {
      p.rect(0.12, 0, 0.76, 0.72, 0.05, 'body');
      p.rect(0.19, 0.08, 0.62, 0.56, 0, 'paper');
      p.poly([[0.12, 0.72], [0.88, 0.72], [1, 1], [0, 1]], 'body');
      p.line([[0.4, 0.87], [0.6, 0.87]]);
    } },
    terminal: { name: '終端機／攻擊機', w: 80, h: 56, color: C_GREY, draw: function (p) {
      p.rect(0, 0, 1, 1, 0.06, 'body');
      p.line([[0, 0.22], [1, 0.22]]);
      [0.08, 0.17, 0.26].forEach(function (x) { p.dot(x, 0.11, 0.04); });
      p.line([[0.14, 0.42], [0.3, 0.58], [0.14, 0.74]]);
      p.line([[0.4, 0.76], [0.66, 0.76]]);
    } },
    phone: { name: '手機', w: 36, h: 66, color: C_GREY, draw: function (p) {
      p.rect(0, 0, 1, 1, 0.22, 'body');
      p.rect(0.1, 0.11, 0.8, 0.72, 0, 'paper');
      p.dot(0.5, 0.915, 0.1);
    } },
    printer: { name: '印表機', w: 70, h: 60, color: C_GREY, draw: function (p) {
      p.rect(0.22, 0, 0.56, 0.32, 0, 'paper');
      p.rect(0, 0.28, 1, 0.46, 0.07, 'body');
      p.rect(0.2, 0.6, 0.6, 0.4, 0, 'paper');
      p.line([[0.32, 0.76], [0.68, 0.76]]); p.line([[0.32, 0.87], [0.68, 0.87]]);
      p.dot(0.86, 0.4, 0.04);
    } },
    camera: { name: '網路攝影機', w: 70, h: 50, color: C_GREY, draw: function (p) {
      p.line([[0.37, 0.62], [0.37, 0.9]]); p.line([[0.14, 0.94], [0.6, 0.94]]);
      p.rect(0.04, 0.06, 0.66, 0.56, 0.1, 'body');
      p.poly([[0.7, 0.22], [0.97, 0.08], [0.97, 0.6], [0.7, 0.46]], 'body');
      p.dot(0.2, 0.24, 0.05);
    } },
    chip: { name: 'IoT／嵌入式裝置', w: 60, h: 60, color: C_GREY, draw: function (p) {
      [0.32, 0.5, 0.68].forEach(function (v) {
        p.line([[v, 0.02], [v, 0.18]]); p.line([[v, 0.82], [v, 0.98]]);
        p.line([[0.02, v], [0.18, v]]); p.line([[0.82, v], [0.98, v]]);
      });
      p.rect(0.18, 0.18, 0.64, 0.64, 0.07, 'body');
      p.rect(0.36, 0.36, 0.28, 0.28, 0, 'paper');
    } },
    // ---- 人與權限 ----
    user: { name: '使用者', w: 50, h: 60, color: C_YELLOW, draw: function (p) {
      bust(p);
      p.ell(0.5, 0.26, 0.24, 0.2, 'body');
    } },
    attacker: { name: '攻擊者', w: 50, h: 60, color: C_RED, draw: function (p) {
      bust(p);
      p.ell(0.5, 0.32, 0.23, 0.19, 'body');
      p.rect(0.3, 0.29, 0.4, 0.07, 0.03, 'ink');                                   // 面罩
      p.poly([[0.27, 0.19], [0.34, 0], [0.66, 0], [0.73, 0.19]], 'ink');           // 帽子
      p.rect(0.06, 0.16, 0.88, 0.06, 0.04, 'ink');                                 // 帽簷
    } },
    lock: { name: '加密／VPN', w: 50, h: 60, color: C_ORANGE, draw: function (p) {
      p.path(['M', 0.24, 0.46, 'L', 0.24, 0.3, 'C', 0.24, -0.02, 0.76, -0.02, 0.76, 0.3, 'L', 0.76, 0.46], 'line');
      p.rect(0.06, 0.44, 0.88, 0.56, 0.08, 'body');
      p.dot(0.5, 0.66, 0.07);
      p.line([[0.5, 0.68], [0.5, 0.84]]);
    } },
    key: { name: '金鑰／帳密', w: 70, h: 36, color: C_ORANGE, draw: function (p) {
      p.line([[0.4, 0.5], [0.97, 0.5]]);
      p.line([[0.78, 0.5], [0.78, 0.84]]); p.line([[0.92, 0.5], [0.92, 0.84]]);
      p.ell(0.2, 0.5, 0.2, 0.4, 'body');
      p.ell(0.2, 0.5, 0.075, 0.15, 'paper');
    } }
  };
  function isDevice(type) { return Object.prototype.hasOwnProperty.call(DEVICES, type); }

  PALETTE.forEach(function (sec) {
    if (!sec.devices) return;
    sec.items = Object.keys(DEVICES).map(function (k) {
      const d = DEVICES[k];
      return { type: k, w: d.w, h: d.h, name: d.name, fill: d.color[0], stroke: d.color[1] };
    });
  });

  // imgs：{ 檔案 id: data URL }。匯出成檔案時用——存下來的圖不能回頭跟伺服器要圖片
  function shapeBody(s, ox, oy, imgs) {
    const x = s.x + ox, y = s.y + oy, w = s.w, h = s.h;
    if (isDevice(s.type)) { const p = pen(s, ox, oy); DEVICES[s.type].draw(p); return p.html(); }
    const st = ' fill="' + s.fill + '"' + strokeAttrs(s) + ' stroke-linejoin="round"';
    const line = ' fill="none"' + strokeAttrs(s) + ' stroke-linecap="round"';
    switch (s.type) {
      case 'round': {
        const r = Math.min(12, Math.min(w, h) * 0.2);
        return '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) + '" rx="' + fmt(r) + '"' + st + '/>';
      }
      case 'pill':
        return '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) + '" rx="' + fmt(Math.min(w, h) / 2) + '"' + st + '/>';
      case 'ellipse':
        return '<ellipse cx="' + fmt(x + w / 2) + '" cy="' + fmt(y + h / 2) + '" rx="' + fmt(w / 2) + '" ry="' + fmt(h / 2) + '"' + st + '/>';
      case 'diamond':
        return '<polygon points="' + pts([[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]]) + '"' + st + '/>';
      case 'para': {
        const d = Math.min(20, w / 2);
        return '<polygon points="' + pts([[x + d, y], [x + w, y], [x + w - d, y + h], [x, y + h]]) + '"' + st + '/>';
      }
      case 'hex': {
        const d = Math.min(20, w / 2);
        return '<polygon points="' + pts([[x + d, y], [x + w - d, y], [x + w, y + h / 2], [x + w - d, y + h], [x + d, y + h], [x, y + h / 2]]) + '"' + st + '/>';
      }
      case 'tri':
        return '<polygon points="' + pts([[x, y], [x + w, y + h / 2], [x, y + h]]) + '"' + st + '/>';
      case 'cyl': {
        const ry = Math.min(15, h * 0.15), rx = w / 2;
        return '<path d="M' + fmt(x) + ',' + fmt(y + ry) + ' A' + fmt(rx) + ',' + fmt(ry) + ' 0 0 1 ' + fmt(x + w) + ',' + fmt(y + ry) +
          ' V' + fmt(y + h - ry) + ' A' + fmt(rx) + ',' + fmt(ry) + ' 0 0 1 ' + fmt(x) + ',' + fmt(y + h - ry) + ' Z"' + st + '/>' +
          '<path d="M' + fmt(x) + ',' + fmt(y + ry) + ' A' + fmt(rx) + ',' + fmt(ry) + ' 0 0 0 ' + fmt(x + w) + ',' + fmt(y + ry) + '"' + line + '/>';
      }
      case 'cloud': {
        const P = function (a, b) { return fmt(x + a * w) + ',' + fmt(y + b * h); };
        return '<path d="M' + P(0.25, 0.25) + ' C' + P(0.05, 0.25) + ' ' + P(0, 0.5) + ' ' + P(0.16, 0.55) +
          ' C' + P(0, 0.66) + ' ' + P(0.18, 0.9) + ' ' + P(0.31, 0.8) +
          ' C' + P(0.4, 1) + ' ' + P(0.7, 1) + ' ' + P(0.8, 0.8) +
          ' C' + P(1, 0.8) + ' ' + P(1, 0.6) + ' ' + P(0.875, 0.5) +
          ' C' + P(1, 0.3) + ' ' + P(0.8, 0.1) + ' ' + P(0.625, 0.2) +
          ' C' + P(0.5, 0.05) + ' ' + P(0.3, 0.05) + ' ' + P(0.25, 0.25) + ' Z"' + st + '/>';
      }
      case 'doc': {
        const d = h * 0.12;
        return '<path d="M' + fmt(x) + ',' + fmt(y) + ' H' + fmt(x + w) + ' V' + fmt(y + h - d) +
          ' Q' + fmt(x + w * 0.75) + ',' + fmt(y + h - 3 * d) + ' ' + fmt(x + w * 0.5) + ',' + fmt(y + h - d) +
          ' Q' + fmt(x + w * 0.25) + ',' + fmt(y + h + d) + ' ' + fmt(x) + ',' + fmt(y + h - d) + ' Z"' + st + '/>';
      }
      case 'actor': {
        const cx = x + w / 2;
        return '<ellipse cx="' + fmt(cx) + '" cy="' + fmt(y + h * 0.125) + '" rx="' + fmt(w * 0.25) + '" ry="' + fmt(h * 0.125) + '"' + st + '/>' +
          '<path d="M' + fmt(cx) + ',' + fmt(y + h * 0.25) + ' V' + fmt(y + h * 0.667) +
          ' M' + fmt(x) + ',' + fmt(y + h * 0.35) + ' H' + fmt(x + w) +
          ' M' + fmt(cx) + ',' + fmt(y + h * 0.667) + ' L' + fmt(x) + ',' + fmt(y + h) +
          ' M' + fmt(cx) + ',' + fmt(y + h * 0.667) + ' L' + fmt(x + w) + ',' + fmt(y + h) + '"' + line + '/>';
      }
      case 'text':
        return '';
      case 'image': {
        const box = ' x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) + '"';
        const inl = imgs && imgs[s.src];
        // 底色在圖片下面、外框在圖片上面；兩個預設都是沒有
        return (s.fill !== 'none' ? '<rect' + box + ' fill="' + s.fill + '" stroke="none"/>' : '') +
          '<image' + box + ' preserveAspectRatio="xMidYMid meet" href="' + (inl ? esc(inl) : '/api/images/' + s.src) + '"' +
          (inl ? '' : ' data-img-id="' + s.src + '"') + '/>' +
          (s.stroke !== 'none' ? '<rect' + box + line + '/>' : '');
      }
      default:
        return '<rect x="' + fmt(x) + '" y="' + fmt(y) + '" width="' + fmt(w) + '" height="' + fmt(h) + '"' + st + '/>';
    }
  }
  const LABEL_PAD = 6;
  // 文字垂直置中：不用 dominant-baseline（DOMPurify 會把那個屬性濾掉，預覽裡的字就往上偏），
  // 自己把「行的中線」換成基線的位置。0.35 是一般字型大寫高度的一半左右。
  function baseline(centerY, fs) { return centerY + fs * 0.35; }
  function labelLines(s) {
    if (!s.label) return [];
    const max = labelBelow(s) ? Math.max(s.w, 90) : Math.max(10, s.w - LABEL_PAD * 2);
    return wrapText(s.label, max, s.fs, s.bold);
  }
  function labelSVG(s, ox, oy) {
    const lines = labelLines(s);
    if (!lines.length) return '';
    const lh = s.fs * 1.3;
    let tx, anchor;
    if (labelBelow(s) || s.align === 'center') { tx = s.x + s.w / 2; anchor = 'middle'; }
    else if (s.align === 'left') { tx = s.x + LABEL_PAD; anchor = 'start'; }
    else { tx = s.x + s.w - LABEL_PAD; anchor = 'end'; }
    const top = labelBelow(s) ? s.y + s.h + 3 : s.y + (s.h - lines.length * lh) / 2;
    let out = '';
    lines.forEach(function (ln, i) {
      out += '<text x="' + fmt(tx + ox) + '" y="' + fmt(baseline(top + oy + i * lh + lh / 2, s.fs)) + '" text-anchor="' + anchor +
        '" font-size="' + fmt(s.fs) + '" fill="' + s.fc + '"' +
        (s.bold ? ' font-weight="700"' : '') + '>' + esc(ln) + '</text>';
    });
    return out;
  }
  // 圖形實際佔的範圍（人形、圖片的文字在下面，會超出自己的框）
  function shapeBounds(s) {
    let h = s.h, x = s.x, w = s.w;
    if (labelBelow(s) && s.label) {
      const lines = labelLines(s);
      h += 3 + lines.length * s.fs * 1.3;
      const lw = Math.max.apply(null, lines.map(function (l) { return textW(l, s.fs, s.bold); }));
      if (lw > w) { x -= (lw - w) / 2; w = lw; }
    }
    return { x: x, y: s.y, w: w, h: h };
  }
  // hit：只有編輯器要的「點得到的範圍」。預覽、PDF、匯出的檔案裡不放，那裡沒有人要點
  function shapeSVG(s, ox, oy, hit, imgs) {
    return '<g class="dio-shape" data-id="' + esc(s.id) + '">' +
      // 整個框都點得到：沒有填色的圖形、純文字，中間是空的
      (hit ? '<rect class="dio-hit" x="' + fmt(s.x + ox) + '" y="' + fmt(s.y + oy) + '" width="' + fmt(s.w) + '" height="' + fmt(s.h) +
      '" fill="none" stroke="none"/>' : '') +
      shapeBody(s, ox, oy, imgs) + labelSVG(s, ox, oy) + '</g>';
  }

  // ---------------- 連線 ----------------
  function centerOf(s) { return { x: s.x + s.w / 2, y: s.y + s.h / 2 }; }
  // 從圖形中心朝 toward 走，碰到邊界的那一點
  function perimeter(s, toward) {
    const c = centerOf(s);
    const dx = toward.x - c.x, dy = toward.y - c.y;
    if (!dx && !dy) return c;
    const a = s.w / 2, b = s.h / 2;
    let t;
    if (s.type === 'ellipse') t = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
    else if (s.type === 'diamond') t = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
    else t = Math.min(dx ? a / Math.abs(dx) : Infinity, dy ? b / Math.abs(dy) : Infinity);
    return { x: c.x + dx * t, y: c.y + dy * t };
  }
  function anchorOf(p, byId) {
    if (p.id) { const s = byId[p.id]; return s ? { shape: s, c: centerOf(s) } : null; }
    return { shape: null, c: { x: p.x, y: p.y } };
  }
  function side(a, dir) {
    if (!a.shape) return a.c;
    const s = a.shape;
    if (dir === 'r') return { x: s.x + s.w, y: a.c.y };
    if (dir === 'l') return { x: s.x, y: a.c.y };
    if (dir === 'b') return { x: a.c.x, y: s.y + s.h };
    return { x: a.c.x, y: s.y };
  }
  function unit(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, l = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: dx / l, y: dy / l };
  }
  // 回傳 { d, p1, p2, mid, u1, u2, box }：u1／u2 是「指向端點」的單位向量，箭頭照它畫
  function edgeGeom(e, byId) {
    const A = anchorOf(e.from, byId), B = anchorOf(e.to, byId);
    if (!A || !B) return null;
    if (e.style === 'straight') {
      const p1 = A.shape ? perimeter(A.shape, B.c) : A.c;
      const p2 = B.shape ? perimeter(B.shape, A.c) : B.c;
      return {
        d: 'M' + fmt(p1.x) + ',' + fmt(p1.y) + ' L' + fmt(p2.x) + ',' + fmt(p2.y),
        p1: p1, p2: p2, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
        u1: unit(p2, p1), u2: unit(p1, p2), pts: [p1, p2]
      };
    }
    const dx = B.c.x - A.c.x, dy = B.c.y - A.c.y;
    const horiz = Math.abs(dx) >= Math.abs(dy);
    let p1, p2, c1, c2;
    if (horiz) {
      p1 = side(A, dx >= 0 ? 'r' : 'l'); p2 = side(B, dx >= 0 ? 'l' : 'r');
      const mx = (p1.x + p2.x) / 2;
      c1 = { x: mx, y: p1.y }; c2 = { x: mx, y: p2.y };
    } else {
      p1 = side(A, dy >= 0 ? 'b' : 't'); p2 = side(B, dy >= 0 ? 't' : 'b');
      const my = (p1.y + p2.y) / 2;
      c1 = { x: p1.x, y: my }; c2 = { x: p2.x, y: my };
    }
    const same = function (a, b) { return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01; };
    const u1 = unit(same(c1, p1) ? p2 : c1, p1), u2 = unit(same(c2, p2) ? p1 : c2, p2);
    if (e.style === 'curve') {
      return {
        d: 'M' + fmt(p1.x) + ',' + fmt(p1.y) + ' C' + fmt(c1.x) + ',' + fmt(c1.y) + ' ' + fmt(c2.x) + ',' + fmt(c2.y) + ' ' + fmt(p2.x) + ',' + fmt(p2.y),
        p1: p1, p2: p2, mid: { x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 },
        u1: u1, u2: u2, pts: [p1, c1, c2, p2]
      };
    }
    return {
      d: 'M' + fmt(p1.x) + ',' + fmt(p1.y) + ' L' + fmt(c1.x) + ',' + fmt(c1.y) + ' L' + fmt(c2.x) + ',' + fmt(c2.y) + ' L' + fmt(p2.x) + ',' + fmt(p2.y),
      p1: p1, p2: p2, mid: { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 },
      u1: u1, u2: u2, pts: [p1, c1, c2, p2]
    };
  }
  // 箭頭自己畫成三角形，不用 <marker>：不必管 id 撞名，印出來、轉成圖片都一樣
  function arrowHead(p, u, e, ox, oy) {
    const L = 7 + e.sw * 2, W = 3 + e.sw;
    const bx = p.x - u.x * L, by = p.y - u.y * L;
    return '<polygon points="' + pts([[p.x + ox, p.y + oy], [bx - u.y * W + ox, by + u.x * W + oy], [bx + u.y * W + ox, by - u.x * W + oy]]) +
      '" fill="' + e.stroke + '" stroke="' + e.stroke + '" stroke-width="' + fmt(Math.min(e.sw, 1)) + '" stroke-linejoin="round"/>';
  }
  function edgeLabelBox(e, g) {
    const lines = e.label ? wrapText(e.label, 220, e.fs, e.bold) : [];
    if (!lines.length) return null;
    const lh = e.fs * 1.3;
    const w = Math.max.apply(null, lines.map(function (l) { return textW(l, e.fs, e.bold); })) + 8;
    const h = lines.length * lh + 2;
    return { lines: lines, lh: lh, x: g.mid.x - w / 2, y: g.mid.y - h / 2, w: w, h: h };
  }
  function edgeSVG(e, byId, ox, oy, hit) {
    const g = edgeGeom(e, byId);
    if (!g) return '';
    const tr = ox || oy ? ' transform="translate(' + fmt(ox) + ',' + fmt(oy) + ')"' : '';
    let s = '<g class="dio-edge" data-id="' + esc(e.id) + '">' +
      // 線只有一兩個像素寬，點得到的範圍另外給一條 12px 的透明線
      (hit ? '<path class="dio-hit" d="' + g.d + '"' + tr + ' fill="none" stroke="#000000" stroke-opacity="0" stroke-width="12"/>' : '') +
      '<path d="' + g.d + '"' + tr + ' fill="none"' + strokeAttrs(e) + ' stroke-linejoin="round" stroke-linecap="round"/>';
    if (e.start === 'arrow') s += arrowHead(g.p1, g.u1, e, ox, oy);
    if (e.end === 'arrow') s += arrowHead(g.p2, g.u2, e, ox, oy);
    const lb = edgeLabelBox(e, g);
    if (lb) {
      s += '<rect x="' + fmt(lb.x + ox) + '" y="' + fmt(lb.y + oy) + '" width="' + fmt(lb.w) + '" height="' + fmt(lb.h) + '" fill="#ffffff" stroke="none"/>';
      lb.lines.forEach(function (ln, i) {
        s += '<text x="' + fmt(g.mid.x + ox) + '" y="' + fmt(baseline(lb.y + oy + 1 + i * lb.lh + lb.lh / 2, e.fs)) + '" text-anchor="middle" font-size="' +
          fmt(e.fs) + '" fill="' + e.fc + '"' + (e.bold ? ' font-weight="700"' : '') + '>' + esc(ln) + '</text>';
      });
    }
    return s + '</g>';
  }

  // ---------------- 唯讀渲染 ----------------
  function boundsOf(model, byId) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const add = function (x, y) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
    model.shapes.forEach(function (s) {
      const b = shapeBounds(s), m = s.sw / 2;
      add(b.x - m, b.y - m); add(b.x + b.w + m, b.y + b.h + m);
    });
    model.edges.forEach(function (e) {
      const g = edgeGeom(e, byId);
      if (!g) return;
      const m = 8 + e.sw * 3;
      g.pts.forEach(function (p) { add(p.x - m, p.y - m); add(p.x + m, p.y + m); });
      const lb = edgeLabelBox(e, g);
      if (lb) { add(lb.x, lb.y); add(lb.x + lb.w, lb.y + lb.h); }
    });
    if (x0 === Infinity) return null;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function renderSVG(text, o) {
    o = o || {};
    const model = typeof text === 'string' ? parse(text) : text;
    if (!model.shapes.length && !model.edges.length) return '';
    const byId = indexOf(model);
    const b = boundsOf(model, byId);
    if (!b) return '';
    const PAD = o.pad === undefined ? 10 : o.pad;
    const ox = PAD - b.x, oy = PAD - b.y;
    const W = Math.ceil(b.w + PAD * 2), H = Math.ceil(b.h + PAD * 2);
    return '<svg class="dio-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H +
      '" font-family="' + FONT + '">' +
      (o.background ? '<rect width="' + W + '" height="' + H + '" fill="#ffffff"/>' : '') +
      model.shapes.map(function (s) { return shapeSVG(s, ox, oy, false, o.images); }).join('') +
      model.edges.map(function (e) { return edgeSVG(e, byId, ox, oy); }).join('') +
      '</svg>';
  }
  function blockHTML(payload, alt) {
    if (isLegacy(payload)) {
      const svg = legacySvg(payload);
      return svg
        ? '<div class="drawio-block"><img class="drawio-img" alt="' + esc(alt || '圖表') + '" src="data:image/svg+xml;base64,' + b64(svg) + '"></div>'
        : '<div class="drawio-block is-empty">' + ic('shapes') + '<span>這張圖的格式讀不出來</span></div>';
    }
    const svg = renderSVG(payload || '');
    if (svg) return '<div class="drawio-block">' + svg + '</div>';
    return '<div class="drawio-block is-empty">' + ic('shapes') + '<span>空白的圖表</span></div>';
  }
  // 嵌入用：一篇圖表筆記的內容 → 圖（沒有東西可畫就回空字串）
  function htmlOf(content, alt) {
    const p = payloadOf(content);
    if (p === null) return '';
    const html = blockHTML(p, alt);
    return html.indexOf('is-empty') >= 0 ? '' : html.replace(/^<div class="drawio-block">/, '').replace(/<\/div>$/, '');
  }

  // ---------------- 唯讀 ----------------
  // 這一頁沒有自己的標題列：標題、版本、分享、PDF 都在 app 最上面那一列，跟一般筆記
  // 同一個位置（app.js 的 openDrawioNote）。這裡只管圖本身。
  // opts.banner：上面那一行說明（誰分享的）；notice：為什麼不能編輯。
  function view(content, opts, notice) {
    opts = opts || {};
    const host = opts.container;
    if (!host) return { close: function () {}, discard: function () {}, flush: function () { return Promise.resolve(); } };
    host.classList.add('dio-page');
    host.innerHTML =
      (opts.banner ? '<div class="dio-ro">' + ic('lock') + '<span>' + esc(opts.banner) + '</span></div>' : '') +
      '<div class="dio-view">' + (notice ? '<div class="dio-notice">' + esc(notice) + '</div>' : '') +
      blockHTML(payloadOf(content) || '', opts.title) + '</div>';
    let closed = false;
    function teardown() { host.innerHTML = ''; host.classList.remove('dio-page'); }
    function close() { if (closed) return; closed = true; teardown(); if (opts.onClose) opts.onClose(); }
    function discard() { if (closed) return; closed = true; teardown(); }
    return { close: close, requestClose: close, discard: discard, flush: function () { return Promise.resolve(); } };
  }

  // ---------------- 編輯器 ----------------
  let clipboard = null;      // 複製的東西留在模組裡：換一張圖也貼得上
  let seq = 0;

  function open(content, opts) {
    opts = opts || {};
    const host = opts.container;
    if (!host) return { close: function () {}, discard: function () {}, flush: function () { return Promise.resolve(); } };
    const payload = payloadOf(content);
    if (isLegacy(payload)) {
      return view(content, opts, '這張圖是用先前內嵌的 draw.io 畫的，現在的編輯器打不開那種格式。圖還在，只是不能在這裡編輯。');
    }

    let model = parse(payload || '');
    let sel = [];
    let zoom = 1, panX = 0, panY = 0;
    const undo = [], redo = [];
    let gesture = null, hoverId = null, editing = null, closed = false, spaceDown = false;
    let saveTimer = null, dirty = false, snapOn = true, tab = 'style', menuEl = null, pasteN = 0;
    const lastColor = {};
    const gridId = 'dio-grid-' + (++seq);

    host.classList.add('dio-page');
    host.innerHTML =
      '<div class="dio-menubar">' +
      ['file:檔案', 'edit:編輯', 'view:檢視', 'arrange:調整'].map(function (m) {
        const p = m.split(':');
        return '<button class="dio-menu-btn" type="button" data-menu="' + p[0] + '">' + p[1] + '</button>';
      }).join('') +
      // 存檔狀態放在選單列的右邊（draw.io 自己也是放這裡）
      '<span class="dio-menubar-sp"></span><span class="dio-status" aria-live="polite"></span>' +
      '</div>' +
      '<div class="dio-toolbar">' +
      tb('zoomout', 'minus', '縮小') +
      '<button class="dio-zoom" type="button" data-act="zoom100" title="回到 100%">100%</button>' +
      tb('zoomin', 'plus', '放大') + tb('fit', 'maximize', '符合視窗') + '<span class="dio-tb-sep"></span>' +
      tb('undo', 'undo', '復原 (Ctrl+Z)') + tb('redo', 'redo', '重做 (Ctrl+Y)') + '<span class="dio-tb-sep"></span>' +
      tb('delete', 'trash', '刪除 (Delete)') + tb('dup', 'copy', '再製 (Ctrl+D)') + '<span class="dio-tb-sep"></span>' +
      tb('front', 'arrow-up-to-line', '移到最前') + tb('back', 'arrow-down-to-line', '移到最後') + '<span class="dio-tb-sep"></span>' +
      '<button class="dio-tb-text" type="button" data-act="export-png" title="把整張圖存成 PNG">' + ic('download') + ' PNG</button>' +
      '<button class="dio-tb-text" type="button" data-act="export-svg" title="把整張圖存成 SVG">' + ic('download') + ' SVG</button>' +
      '</div>' +
      '<div class="dio-main">' +
      '<aside class="dio-side">' + paletteHTML() +
      '<div class="dio-sec dio-icons">' +
      '<div class="dio-sec-t dio-icons-head"><span>我的圖示</span>' +
      '<button class="dio-icon-add" type="button" title="上傳圖示：PNG、JPG、GIF、WebP、SVG，每個 2 MB 以內。也可以把圖片檔直接拖進來">' + ic('plus') + '<span>上傳</span></button></div>' +
      '<div class="dio-sec-grid dio-icon-grid"></div>' +
      '<div class="dio-icon-empty">上傳自己的圖示（主機、防火牆、Logo…），之後每一張圖都能用。只有你自己看得到這個圖示庫。</div>' +
      '<input class="dio-icon-file" type="file" multiple hidden accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml">' +
      '</div>' +
      '<div class="dio-side-hint">點一下放到畫布中央，或直接拖到畫布上。<br>滑到圖形上，從邊上的藍點拉出連線。</div></aside>' +
      '<div class="dio-canvas" tabindex="0">' +
      '<svg class="dio-stage" xmlns="http://www.w3.org/2000/svg" font-family="' + FONT + '">' +
      '<defs><pattern id="' + gridId + '" width="40" height="40" patternUnits="userSpaceOnUse">' +
      '<path d="M10 0V40M20 0V40M30 0V40M0 10H40M0 20H40M0 30H40" fill="none" stroke="#eceef1" stroke-width="0.6"/>' +
      '<path d="M0 0H40M0 0V40" fill="none" stroke="#d8dce2" stroke-width="0.9"/></pattern></defs>' +
      '<rect class="dio-paper" width="100%" height="100%" fill="#ffffff"/>' +
      '<g class="dio-world"><rect class="dio-grid" fill="url(#' + gridId + ')"/>' +
      '<g class="dio-content"></g><g class="dio-overlay"></g></g>' +
      '</svg></div>' +
      '<aside class="dio-format"></aside>' +
      '</div>';
    function tb(act, icon, title) {
      return '<button class="dio-tb" type="button" data-act="' + act + '" title="' + title + '">' + ic(icon) + '</button>';
    }

    const canvas = host.querySelector('.dio-canvas');
    const stage = host.querySelector('.dio-stage');
    const world = host.querySelector('.dio-world');
    const gridRect = host.querySelector('.dio-grid');
    const contentEl = host.querySelector('.dio-content');
    const overlayEl = host.querySelector('.dio-overlay');
    const formatEl = host.querySelector('.dio-format');
    const statusEl = host.querySelector('.dio-status');
    const zoomEl = host.querySelector('.dio-zoom');

    function paletteHTML() {
      return PALETTE.map(function (sec, si) {
        return '<div class="dio-sec"><div class="dio-sec-t">' + esc(sec.title) + '</div><div class="dio-sec-grid">' +
          sec.items.map(function (it, ii) {
            return '<button class="dio-pal' + (sec.devices ? ' dio-dev' : '') + '" type="button" data-pal="' + si + ',' + ii + '" title="' + esc(it.name) + '">' + thumb(it) + '</button>';
          }).join('') + '</div></div>';
      }).join('');
    }
    function thumb(it) {
      const W = 36, H = 28;
      let inner;
      if (it.edge) {
        const e = Object.assign({}, EDGE_DEF, { id: 't', from: { x: 4, y: H - 5 }, to: { x: W - 4, y: 5 }, label: '', style: it.edge, start: it.start || 'none', end: it.end, dash: it.dash || 0, sw: 1.3 });
        inner = edgeSVG(e, {}, 0, 0);
      } else {
        const k = Math.min((W - 4) / it.w, (H - 4) / it.h);
        const s = Object.assign({}, SHAPE_DEF, { id: 't', type: it.type, label: '', x: 0, y: 0, w: it.w * k, h: it.h * k, sw: it.fill ? 1 : 1.3 });
        if (it.fill) { s.fill = it.fill; s.stroke = it.stroke; }
        s.x = (W - s.w) / 2; s.y = (H - s.h) / 2;
        inner = it.type === 'text'
          ? '<text x="' + W / 2 + '" y="' + fmt(baseline(H / 2, 11)) + '" text-anchor="middle" font-size="11" fill="#000000">Text</text>'
          : shapeBody(s, 0, 0);
      }
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '">' + inner + '</svg>';
    }

    // ---- 存檔／復原 ----
    function setStatus(text, cls) {
      statusEl.textContent = text || '';
      statusEl.className = 'dio-status' + (cls ? ' ' + cls : '');
    }
    function emit() {
      clearTimeout(saveTimer);
      if (!dirty || !opts.onChange) return;
      dirty = false;
      setStatus('儲存中…');
      Promise.resolve(opts.onChange(wrap(serialize(model)))).then(function () {
        if (!closed && !dirty) setStatus('已儲存', 'is-ok');
      }, function () { if (!closed) setStatus('儲存失敗', 'is-err'); });
    }
    function changed() {
      dirty = true;
      setStatus('尚未儲存');
      clearTimeout(saveTimer);
      saveTimer = setTimeout(emit, 600);
    }
    function begin() { return serialize(model); }
    function commit(before) {
      if (serialize(model) === before) return false;
      undo.push(before);
      if (undo.length > 100) undo.shift();
      redo.length = 0;
      changed();
      return true;
    }
    function mutate(fn) {
      const before = begin();
      fn();
      commit(before);
      render(); renderFormat(); refreshToolbar();
    }
    function restore(dsl) {
      model = parse(dsl);
      const ids = {};
      model.shapes.forEach(function (s) { ids[s.id] = 1; });
      model.edges.forEach(function (e) { ids[e.id] = 1; });
      sel = sel.filter(function (id) { return ids[id]; });
    }
    function doUndo() {
      if (!undo.length) return;
      redo.push(serialize(model));
      restore(undo.pop());
      changed(); render(); renderFormat(); refreshToolbar();
    }
    function doRedo() {
      if (!redo.length) return;
      undo.push(serialize(model));
      restore(redo.pop());
      changed(); render(); renderFormat(); refreshToolbar();
    }

    // ---- 查詢 ----
    function shapeById(id) { return model.shapes.find(function (s) { return s.id === id; }); }
    function edgeById(id) { return model.edges.find(function (e) { return e.id === id; }); }
    function selShapes() { return sel.map(shapeById).filter(Boolean); }
    function selEdges() { return sel.map(edgeById).filter(Boolean); }
    function newId(prefix) {
      let n = 0;
      model.shapes.concat(model.edges).forEach(function (o) {
        const m = new RegExp('^' + prefix + '(\\d+)$').exec(o.id);
        if (m) n = Math.max(n, parseInt(m[1], 10));
      });
      return prefix + (n + 1);
    }
    function snap(v) { return snapOn ? Math.round(v / GRID) * GRID : Math.round(v); }
    function toWorld(e) {
      const r = stage.getBoundingClientRect();
      return { x: (e.clientX - r.left - panX) / zoom, y: (e.clientY - r.top - panY) / zoom };
    }
    function viewCenter() {
      const r = stage.getBoundingClientRect();
      return { x: (r.width / 2 - panX) / zoom, y: (r.height / 2 - panY) / zoom };
    }

    // ---- 畫 ----
    function render() {
      world.setAttribute('transform', 'translate(' + fmt(panX) + ',' + fmt(panY) + ') scale(' + zoom + ')');
      const r = stage.getBoundingClientRect();
      const vx = -panX / zoom, vy = -panY / zoom;
      gridRect.setAttribute('x', Math.floor(vx / 40) * 40 - 40);
      gridRect.setAttribute('y', Math.floor(vy / 40) * 40 - 40);
      gridRect.setAttribute('width', Math.ceil(r.width / zoom) + 120);
      gridRect.setAttribute('height', Math.ceil(r.height / zoom) + 120);
      gridRect.style.display = model.grid ? '' : 'none';
      const byId = indexOf(model);
      contentEl.innerHTML = model.shapes.map(function (s) { return shapeSVG(s, 0, 0, true); }).join('') +
        model.edges.map(function (e) { return edgeSVG(e, byId, 0, 0, true); }).join('');
      renderOverlay(byId);
      zoomEl.textContent = Math.round(zoom * 100) + '%';
    }
    function renderOverlay(byId) {
      byId = byId || indexOf(model);
      const k = 1 / zoom;
      let s = '';
      sel.forEach(function (id) {
        const sh = byId[id];
        if (sh) {
          s += '<rect class="dio-selbox" x="' + fmt(sh.x) + '" y="' + fmt(sh.y) + '" width="' + fmt(sh.w) + '" height="' + fmt(sh.h) +
            '" stroke-width="' + k + '" stroke-dasharray="' + 4 * k + ' ' + 3 * k + '"/>';
          return;
        }
        const e = edgeById(id), g = e && edgeGeom(e, byId);
        if (g) s += '<path class="dio-seledge" d="' + g.d + '" stroke-width="' + 3 * k + '"/>';
      });
      // 連接點：滑到圖形上才出現，壓在邊的中點上（不在外面——從圖形裡移過去的路上不會離開圖形）
      if (hoverId && !gesture && byId[hoverId]) {
        const h = byId[hoverId];
        [[h.x + h.w / 2, h.y], [h.x + h.w, h.y + h.h / 2], [h.x + h.w / 2, h.y + h.h], [h.x, h.y + h.h / 2]].forEach(function (p) {
          s += '<circle class="dio-conn" data-conn="' + esc(h.id) + '" cx="' + fmt(p[0]) + '" cy="' + fmt(p[1]) + '" r="' + 5 * k + '" stroke-width="' + 1.5 * k + '"/>';
        });
      }
      // 控制點：只有單選才給，畫在連接點上面（四個角，跟連接點不重疊）
      if (sel.length === 1) {
        const sh = byId[sel[0]];
        if (sh) {
          [['nw', sh.x, sh.y], ['ne', sh.x + sh.w, sh.y], ['se', sh.x + sh.w, sh.y + sh.h], ['sw', sh.x, sh.y + sh.h]].forEach(function (c) {
            s += '<rect class="dio-handle" data-handle="' + c[0] + '" x="' + fmt(c[1] - 4 * k) + '" y="' + fmt(c[2] - 4 * k) +
              '" width="' + 8 * k + '" height="' + 8 * k + '" stroke-width="' + k + '"/>';
          });
        } else {
          const e = edgeById(sel[0]), g = e && edgeGeom(e, byId);
          if (g) {
            s += '<circle class="dio-end" data-end="from" cx="' + fmt(g.p1.x) + '" cy="' + fmt(g.p1.y) + '" r="' + 5 * k + '" stroke-width="' + 1.5 * k + '"/>' +
              '<circle class="dio-end" data-end="to" cx="' + fmt(g.p2.x) + '" cy="' + fmt(g.p2.y) + '" r="' + 5 * k + '" stroke-width="' + 1.5 * k + '"/>';
          }
        }
      }
      if (gesture && gesture.type === 'band' && gesture.moved) {
        const b = gesture.box;
        s += '<rect class="dio-band" x="' + fmt(b.x) + '" y="' + fmt(b.y) + '" width="' + fmt(b.w) + '" height="' + fmt(b.h) + '" stroke-width="' + k + '"/>';
      }
      if (gesture && (gesture.type === 'connect' || gesture.type === 'endpoint') && gesture.preview) {
        const g = edgeGeom(gesture.preview, byId);
        if (g) s += '<path class="dio-preview" d="' + g.d + '" stroke-width="' + 1.5 * k + '" stroke-dasharray="' + 5 * k + ' ' + 4 * k + '"/>';
        if (gesture.target && byId[gesture.target]) {
          const t = byId[gesture.target];
          s += '<rect class="dio-target" x="' + fmt(t.x - 3 * k) + '" y="' + fmt(t.y - 3 * k) + '" width="' + fmt(t.w + 6 * k) + '" height="' + fmt(t.h + 6 * k) + '" stroke-width="' + 2 * k + '"/>';
        }
      }
      overlayEl.innerHTML = s;
    }
    function refreshToolbar() {
      const has = sel.length > 0;
      const set = function (act, off) {
        const b = host.querySelector('.dio-toolbar [data-act="' + act + '"]');
        if (b) b.disabled = !!off;
      };
      set('undo', !undo.length); set('redo', !redo.length);
      set('delete', !has); set('dup', !has);
      set('front', !selShapes().length); set('back', !selShapes().length);
    }

    // ---- 縮放／平移 ----
    function zoomAt(cx, cy, z) {
      const r = stage.getBoundingClientRect();
      const sx = cx - r.left, sy = cy - r.top;
      const wx = (sx - panX) / zoom, wy = (sy - panY) / zoom;
      zoom = clamp(z, 0.1, 4);
      panX = sx - wx * zoom; panY = sy - wy * zoom;
      render();
    }
    function zoomCenter(z) {
      const r = stage.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, z);
    }
    function fit() {
      const b = boundsOf(model, indexOf(model));
      const r = stage.getBoundingClientRect();
      if (!b || !r.width) { zoom = 1; panX = 40; panY = 40; render(); return; }
      zoom = clamp(Math.min((r.width - 80) / b.w, (r.height - 80) / b.h), 0.1, 1);
      panX = (r.width - b.w * zoom) / 2 - b.x * zoom;
      panY = (r.height - b.h * zoom) / 2 - b.y * zoom;
      render();
    }

    // ---- 動作 ----
    function select(ids) { sel = ids.slice(); hoverId = null; render(); renderFormat(); refreshToolbar(); }
    function removeSelected() {
      if (!sel.length) return;
      mutate(function () {
        const gone = {};
        sel.forEach(function (id) { gone[id] = 1; });
        model.shapes = model.shapes.filter(function (s) { return !gone[s.id]; });
        // 圖形刪掉了，接在它身上的連線也一起走（留著只會是一條接不到東西的線）
        model.edges = model.edges.filter(function (e) {
          return !gone[e.id] && !(e.from.id && gone[e.from.id]) && !(e.to.id && gone[e.to.id]);
        });
        sel = [];
      });
    }
    function copySelected() {
      const ss = selShapes(), ids = {};
      ss.forEach(function (s) { ids[s.id] = 1; });
      // 連線只有兩頭都跟著被複製（或本來就是接在點上）才帶走
      const es = selEdges().concat(model.edges.filter(function (e) {
        return sel.indexOf(e.id) < 0 && e.from.id && e.to.id && ids[e.from.id] && ids[e.to.id];
      })).filter(function (e) {
        return (!e.from.id || ids[e.from.id]) && (!e.to.id || ids[e.to.id]);
      });
      if (!ss.length && !es.length) return false;
      clipboard = JSON.stringify({ shapes: ss, edges: es });
      pasteN = 0;
      return true;
    }
    function paste(offset) {
      if (!clipboard) return;
      pasteN++;
      const d = offset === undefined ? 20 * pasteN : offset;
      pasteWith(d, d);
    }
    // 右鍵選單的「貼上」：貼在游標那裡（剪貼簿裡那一組的左上角對到游標）
    function pasteAt(w) {
      if (!clipboard) return;
      const data = JSON.parse(clipboard);
      let x0 = Infinity, y0 = Infinity;
      data.shapes.forEach(function (s) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); });
      data.edges.forEach(function (e) { [e.from, e.to].forEach(function (q) { if (!q.id) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); } }); });
      if (x0 === Infinity) return;
      pasteWith(snap(w.x) - x0, snap(w.y) - y0);
    }
    function pasteWith(dx, dy) {
      const data = JSON.parse(clipboard);
      mutate(function () {
        const map = {}, added = [];
        data.shapes.forEach(function (s) {
          const c = Object.assign({}, s, { id: newId('s'), x: s.x + dx, y: s.y + dy });
          map[s.id] = c.id;
          model.shapes.push(c); added.push(c.id);
        });
        data.edges.forEach(function (e) {
          const c = Object.assign({}, e, { id: newId('e') });
          c.from = e.from.id ? { id: map[e.from.id] } : { x: e.from.x + dx, y: e.from.y + dy };
          c.to = e.to.id ? { id: map[e.to.id] } : { x: e.to.x + dx, y: e.to.y + dy };
          model.edges.push(c); added.push(c.id);
        });
        sel = added;
      });
    }
    function duplicate() {
      const keep = clipboard, n = pasteN;
      if (copySelected()) paste(20);
      clipboard = keep; pasteN = n;
    }
    // 疊放順序就是 model.shapes 的順序（後面的畫在上面；連線永遠在圖形之上）
    function reorder(toFront) {
      const ids = {};
      selShapes().forEach(function (s) { ids[s.id] = 1; });
      if (!Object.keys(ids).length) return;
      mutate(function () {
        const pick = model.shapes.filter(function (s) { return ids[s.id]; });
        const rest = model.shapes.filter(function (s) { return !ids[s.id]; });
        model.shapes = toFront ? rest.concat(pick) : pick.concat(rest);
      });
    }
    // 上移／下移一層：選取的整組跟相鄰的那一個沒被選的交換位置
    function reorderStep(up) {
      const ids = {};
      selShapes().forEach(function (s) { ids[s.id] = 1; });
      if (!Object.keys(ids).length) return;
      mutate(function () {
        const arr = model.shapes.slice();
        if (up) {
          for (let i = arr.length - 2; i >= 0; i--) {
            if (ids[arr[i].id] && !ids[arr[i + 1].id]) { const t = arr[i]; arr[i] = arr[i + 1]; arr[i + 1] = t; }
          }
        } else {
          for (let i = 1; i < arr.length; i++) {
            if (ids[arr[i].id] && !ids[arr[i - 1].id]) { const t = arr[i]; arr[i] = arr[i - 1]; arr[i - 1] = t; }
          }
        }
        model.shapes = arr;
      });
    }
    function align(how) {
      const ss = selShapes();
      if (ss.length < 2) return;
      const x0 = Math.min.apply(null, ss.map(function (s) { return s.x; }));
      const x1 = Math.max.apply(null, ss.map(function (s) { return s.x + s.w; }));
      const y0 = Math.min.apply(null, ss.map(function (s) { return s.y; }));
      const y1 = Math.max.apply(null, ss.map(function (s) { return s.y + s.h; }));
      mutate(function () {
        ss.forEach(function (s) {
          if (how === 'left') s.x = x0;
          else if (how === 'right') s.x = x1 - s.w;
          else if (how === 'center') s.x = (x0 + x1) / 2 - s.w / 2;
          else if (how === 'top') s.y = y0;
          else if (how === 'bottom') s.y = y1 - s.h;
          else if (how === 'middle') s.y = (y0 + y1) / 2 - s.h / 2;
        });
      });
    }
    function insert(it, at) {
      const c = at || viewCenter();
      mutate(function () {
        if (it.edge) {
          const e = Object.assign({}, EDGE_DEF, {
            id: newId('e'), label: '', style: it.edge, start: it.start || 'none', end: it.end, dash: it.dash || 0,
            from: { x: snap(c.x - 60), y: snap(c.y + 30) }, to: { x: snap(c.x + 60), y: snap(c.y - 30) }
          });
          model.edges.push(e);
          sel = [e.id];
        } else {
          const s = Object.assign({}, SHAPE_DEF, {
            id: newId('s'), type: it.type, label: it.label || '', w: it.w, h: it.h,
            x: snap(c.x - it.w / 2), y: snap(c.y - it.h / 2)
          });
          if (it.type === 'text' || it.type === 'image') { s.fill = 'none'; s.stroke = 'none'; }
          else if (it.fill) { s.fill = it.fill; s.stroke = it.stroke; }
          if (it.type === 'image') s.src = it.src;
          // 連續點同一個圖形不要整疊在一起
          // （比中心點，不是左上角：大小不同的兩個圖形左上角不一樣，照樣是疊在一起）
          while (model.shapes.some(function (o) {
            return Math.abs(o.x + o.w / 2 - s.x - s.w / 2) < GRID && Math.abs(o.y + o.h / 2 - s.y - s.h / 2) < GRID;
          })) { s.x += 20; s.y += 20; }
          model.shapes.push(s);
          sel = [s.id];
        }
      });
    }
    function download(name, blob) {
      const a = document.createElement('a');
      const url = URL.createObjectURL(blob);
      a.href = url; a.download = name;
      a.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 1000);
    }
    function fileBase() {
      const t = opts.getTitle ? opts.getTitle() : opts.title;
      return (String(t || '').trim() || '圖表').replace(/[\\/:*?"<>|]+/g, '_');
    }
    // 存成檔案的圖不能回頭跟伺服器要圖片（離開這個網站就沒有登入狀態；當成圖片載入的
    // SVG 更是什麼外部資源都不准抓），所以用到的圖示先換成 data URL 包進去
    function imageData() {
      const ids = [];
      model.shapes.forEach(function (sh) { if (sh.type === 'image' && ids.indexOf(sh.src) < 0) ids.push(sh.src); });
      if (!ids.length || !global.Store || !Store.getImageBlob) return Promise.resolve({});
      const map = {};
      return Promise.all(ids.map(function (id) {
        return Store.getImageBlob(id).then(function (blob) {
          if (!blob) return;
          return new Promise(function (resolve) {
            const fr = new FileReader();
            fr.onload = function () { map[id] = String(fr.result); resolve(); };
            fr.onerror = function () { resolve(); };
            fr.readAsDataURL(blob);
          });
        });
      })).then(function () {
        if (Object.keys(map).length < ids.length) toast('有圖示讀不到，匯出的圖會缺那幾個');
        return map;
      });
    }
    function exportSVG() {
      if (!renderSVG(model)) { toast('圖是空的，沒有東西可以匯出'); return; }
      imageData().then(function (imgs) {
        const svg = renderSVG(model, { background: true, images: imgs });
        download(fileBase() + '.svg', new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + svg], { type: 'image/svg+xml' }));
      });
    }
    function exportPNG() {
      if (!renderSVG(model)) { toast('圖是空的，沒有東西可以匯出'); return; }
      imageData().then(function (imgs) { drawPNG(renderSVG(model, { background: true, images: imgs })); });
    }
    function drawPNG(svg) {
      const m = /width="(\d+)" height="(\d+)"/.exec(svg);
      const W = parseInt(m[1], 10), H = parseInt(m[2], 10), K = 2;
      const img = new Image();
      img.onload = function () {
        const c = document.createElement('canvas');
        c.width = W * K; c.height = H * K;
        const g = c.getContext('2d');
        g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (blob) {
          if (blob) download(fileBase() + '.png', blob); else toast('匯出 PNG 失敗');
        }, 'image/png');
      };
      img.onerror = function () { toast('匯出 PNG 失敗'); };
      img.src = 'data:image/svg+xml;base64,' + b64(svg);
    }
    function toast(msg) {
      if (global.App && App.toast) { App.toast(msg); return; }
      setStatus(msg, 'is-err');
    }
    function act(name) {
      closeMenu();
      switch (name) {
        case 'undo': doUndo(); break;
        case 'redo': doRedo(); break;
        case 'delete': removeSelected(); break;
        case 'dup': duplicate(); break;
        case 'copy': copySelected(); break;
        case 'cut': if (copySelected()) removeSelected(); break;
        case 'paste': paste(); break;
        case 'selectall': select(model.shapes.map(function (s) { return s.id; }).concat(model.edges.map(function (e) { return e.id; }))); break;
        case 'front': reorder(true); break;
        case 'back': reorder(false); break;
        case 'forward': reorderStep(true); break;
        case 'backward': reorderStep(false); break;
        case 'edit': if (sel.length === 1) startEdit(sel[0]); break;
        case 'zoomin': zoomCenter(zoom * 1.25); break;
        case 'zoomout': zoomCenter(zoom / 1.25); break;
        case 'zoom100': zoomCenter(1); break;
        case 'fit': fit(); break;
        case 'grid': mutate(function () { model.grid = !model.grid; }); break;
        case 'snap': snapOn = !snapOn; renderFormat(); break;
        case 'export-png': exportPNG(); break;
        case 'export-svg': exportSVG(); break;
        default:
          if (name.indexOf('align-') === 0) align(name.slice(6));
      }
      canvas.focus();
    }

    // ---- 選單 ----
    const MENUS = {
      file: [['export-png', '匯出為 PNG'], ['export-svg', '匯出為 SVG']],
      edit: [['undo', '復原', 'Ctrl+Z'], ['redo', '重做', 'Ctrl+Y'], null, ['cut', '剪下', 'Ctrl+X'], ['copy', '複製', 'Ctrl+C'],
        ['paste', '貼上', 'Ctrl+V'], ['dup', '再製', 'Ctrl+D'], ['delete', '刪除', 'Delete'], null, ['selectall', '全選', 'Ctrl+A']],
      view: [['grid', '格線'], ['snap', '對齊格線'], null, ['zoomin', '放大'], ['zoomout', '縮小'], ['zoom100', '100%'], ['fit', '符合視窗']],
      arrange: [['front', '移到最前', 'Ctrl+Shift+]'], ['forward', '上移一層', 'Ctrl+]'], ['backward', '下移一層', 'Ctrl+['], ['back', '移到最後', 'Ctrl+Shift+['], null, ['align-left', '靠左對齊'], ['align-center', '水平置中'],
        ['align-right', '靠右對齊'], ['align-top', '靠上對齊'], ['align-middle', '垂直置中'], ['align-bottom', '靠下對齊']]
    };
    function closeMenu() {
      if (!menuEl) return;
      menuEl.remove(); menuEl = null;
      host.querySelectorAll('.dio-menu-btn.on').forEach(function (b) { b.classList.remove('on'); });
    }
    function openMenu(btn) {
      const name = btn.getAttribute('data-menu');
      const was = menuEl && menuEl.getAttribute('data-for') === name;
      closeMenu();
      if (was) return;
      const r = btn.getBoundingClientRect();
      menuEl = document.createElement('div');
      menuEl.className = 'dio-menu';
      menuEl.setAttribute('data-for', name);
      menuEl.style.left = r.left + 'px';
      menuEl.style.top = r.bottom + 'px';
      menuEl.innerHTML = MENUS[name].map(function (it) {
        if (!it) return '<div class="dio-menu-sep"></div>';
        const on = (it[0] === 'grid' && model.grid) || (it[0] === 'snap' && snapOn);
        return '<button class="dio-menu-item' + (on ? ' on' : '') + '" type="button" data-act="' + it[0] + '"><span>' + esc(it[1]) +
          '</span><kbd>' + (it[2] || '') + '</kbd></button>';
      }).join('');
      host.appendChild(menuEl);
      btn.classList.add('on');
      menuEl.addEventListener('click', function (e) {
        const b = e.target.closest('[data-act]');
        if (b) act(b.getAttribute('data-act'));
      });
    }

    // ---- 右鍵選單 ----
    // 點在圖形或連線上：先選起它（原本沒選的話），選單針對選取的東西；點在空白處：取消選取，
    // 選單是貼上、全選、檢視（跟 draw.io 一樣）
    function openContextMenu(x, y, hitId, w) {
      closeMenu();
      if (editing) commitEdit();
      if (hitId && sel.indexOf(hitId) < 0) select([hitId]);
      if (!hitId && sel.length) select([]);
      const shapesSel = selShapes().length, anySel = sel.length;
      let items;
      if (hitId) {
        items = [
          ['front', '移到最前', 'Ctrl+Shift+]', shapesSel > 0], ['forward', '上移一層', 'Ctrl+]', shapesSel > 0],
          ['backward', '下移一層', 'Ctrl+[', shapesSel > 0], ['back', '移到最後', 'Ctrl+Shift+[', shapesSel > 0], null,
          ['edit', '編輯文字', 'F2', anySel === 1], null,
          ['cut', '剪下', 'Ctrl+X', true], ['copy', '複製', 'Ctrl+C', true], ['paste', '貼上', 'Ctrl+V', !!clipboard],
          ['dup', '再製', 'Ctrl+D', true], null, ['delete', '刪除', 'Delete', true]
        ];
      } else {
        items = [['paste', '貼上', 'Ctrl+V', !!clipboard], ['selectall', '全選', 'Ctrl+A', true], null,
          ['fit', '符合視窗', '', true], ['grid', '格線', '', true]];
      }
      menuEl = document.createElement('div');
      menuEl.className = 'dio-menu dio-ctx';
      menuEl.setAttribute('data-for', 'ctx');
      menuEl.innerHTML = items.map(function (it) {
        if (!it) return '<div class="dio-menu-sep"></div>';
        const on = it[0] === 'grid' && model.grid;
        return '<button class="dio-menu-item' + (on ? ' on' : '') + '" type="button" data-act="' + it[0] + '"' + (it[3] ? '' : ' disabled') + '><span>' +
          esc(it[1]) + '</span><kbd>' + (it[2] || '') + '</kbd></button>';
      }).join('');
      host.appendChild(menuEl);
      // 貼在游標旁邊，超出視窗就往回折
      const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
      menuEl.style.left = Math.max(4, Math.min(x, window.innerWidth - mw - 4)) + 'px';
      menuEl.style.top = Math.max(4, Math.min(y, window.innerHeight - mh - 4)) + 'px';
      menuEl.addEventListener('click', function (e) {
        const b = e.target.closest('[data-act]');
        if (!b || b.disabled) return;
        const a = b.getAttribute('data-act');
        closeMenu();
        if (a === 'paste' && w) pasteAt(w); else act(a);
      });
    }

    // ---- 就地改文字 ----
    // at：在空白處開一段新的文字。圖形要等真的打了字才建立，取消或沒打字就什麼都不留
    function startEdit(id, at) {
      commitEdit();
      const sh = id ? shapeById(id) : null, ed = id ? edgeById(id) : null;
      if (!sh && !ed && !at) return;
      const r = stage.getBoundingClientRect();
      let box;
      if (sh) box = { x: sh.x, y: labelBelow(sh) ? sh.y + sh.h : sh.y, w: Math.max(sh.w, 60), h: labelBelow(sh) ? 30 : Math.max(sh.h, 24) };
      else if (ed) {
        const g = edgeGeom(ed, indexOf(model));
        if (!g) return;
        box = { x: g.mid.x - 70, y: g.mid.y - 14, w: 140, h: 28 };
      } else box = { x: at.x - 70, y: at.y - 15, w: 140, h: 30 };
      if (sh && labelBelow(sh)) box.x = sh.x + sh.w / 2 - Math.max(sh.w, 90) / 2, box.w = Math.max(sh.w, 90);
      const ta = document.createElement('textarea');
      ta.className = 'dio-edit';
      ta.value = (sh || ed || {}).label || '';
      const fs = (sh || ed || SHAPE_DEF).fs * zoom;
      ta.style.left = r.left + panX + box.x * zoom + 'px';
      ta.style.top = r.top + panY + box.y * zoom + 'px';
      ta.style.width = Math.max(60, box.w * zoom) + 'px';
      ta.style.height = Math.max(26, box.h * zoom) + 'px';
      ta.style.fontSize = clamp(fs, 9, 60) + 'px';
      ta.style.textAlign = sh ? (labelBelow(sh) ? 'center' : sh.align) : 'center';
      host.appendChild(ta);
      editing = { id: id || null, at: at || null, el: ta, done: false };
      ta.focus(); ta.select();
      ta.addEventListener('keydown', function (e) {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
        // 收起來之後焦點要回到畫布，不然接著按 Delete、Ctrl+Z 都沒人接
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitEdit(); canvas.focus(); }
      });
      ta.addEventListener('blur', function () { commitEdit(); });
    }
    function endEdit() {
      const ed = editing;
      editing = null;
      if (ed && ed.el.parentNode) ed.el.remove();
      return ed;
    }
    function cancelEdit() { if (editing) { editing.done = true; endEdit(); canvas.focus(); } }
    function commitEdit() {
      if (!editing || editing.done) return;
      editing.done = true;
      const ed = endEdit();
      const v = ed.el.value.replace(/\s+$/, '');
      if (ed.at) {
        if (!v) return;
        const lines = v.split('\n');
        const widest = Math.max.apply(null, lines.map(function (l) { return textW(l, SHAPE_DEF.fs, false); }));
        insert({ type: 'text', label: v, w: Math.max(40, Math.ceil((widest + 16) / GRID) * GRID),
          h: Math.max(30, Math.ceil((lines.length * SHAPE_DEF.fs * 1.4 + 10) / GRID) * GRID) }, ed.at);
        return;
      }
      const o = shapeById(ed.id) || edgeById(ed.id);
      if (!o || (o.label || '') === v) return;
      mutate(function () { o.label = v; });
    }

    // ---- 滑鼠 ----
    function targetShapeAt(e, exceptId) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const g = el && el.closest ? el.closest('.dio-shape[data-id]') : null;
      const c = el && el.closest ? el.closest('[data-conn]') : null;
      const id = g ? g.getAttribute('data-id') : (c ? c.getAttribute('data-conn') : null);
      return id && id !== exceptId && shapeById(id) ? id : null;
    }
    function onDown(e) {
      closeMenu();
      if (editing) commitEdit();
      canvas.focus();
      if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
        // 右鍵：拖曳是平移，按一下（沒動）放開才是右鍵選單——draw.io 也是這樣
        const hit = e.target.closest ? e.target.closest('[data-id]') : null;
        gesture = { type: 'pan', sx: e.clientX, sy: e.clientY, px: panX, py: panY, moved: false,
          right: e.button === 2, hitId: hit ? hit.getAttribute('data-id') : null, w0: toWorld(e) };
        canvas.classList.add('is-panning');
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      const t = e.target;
      const w = toWorld(e);
      const handle = t.closest('[data-handle]'), endH = t.closest('[data-end]'), dot = t.closest('[data-conn]');
      const el = t.closest('[data-id]');
      // 雙擊在這裡自己認（第二下的 mousedown）：按下時整張圖會重畫，被按的那個元素就不在了，
      // 瀏覽器找不到按下與放開的共同祖先，click 跟 dblclick 都不會發
      if (e.detail === 2 && !handle && !endH && !dot) {
        e.preventDefault();
        onDbl(el ? el.getAttribute('data-id') : null, w);
        return;
      }
      if (handle && sel.length === 1 && shapeById(sel[0])) {
        const s = shapeById(sel[0]);
        gesture = { type: 'resize', dir: handle.getAttribute('data-handle'), before: begin(), id: s.id, o: { x: s.x, y: s.y, w: s.w, h: s.h } };
      } else if (endH && sel.length === 1 && edgeById(sel[0])) {
        const ed = edgeById(sel[0]), which = endH.getAttribute('data-end');
        gesture = { type: 'endpoint', before: begin(), id: ed.id, which: which, orig: ed[which], target: null, preview: null };
      } else if (dot) {
        const from = dot.getAttribute('data-conn');
        gesture = { type: 'connect', before: begin(), from: from, target: null,
          preview: Object.assign({}, EDGE_DEF, { id: '_p', label: '', from: { id: from }, to: { x: w.x, y: w.y } }) };
      } else if (el) {
        const id = el.getAttribute('data-id');
        if (e.shiftKey) sel = sel.indexOf(id) >= 0 ? sel.filter(function (x) { return x !== id; }) : sel.concat([id]);
        else if (sel.indexOf(id) < 0) sel = [id];
        const moving = {};
        selShapes().forEach(function (s) { moving[s.id] = { x: s.x, y: s.y }; });
        const ends = [];
        selEdges().forEach(function (ed) {
          ['from', 'to'].forEach(function (k) { if (!ed[k].id) ends.push({ e: ed, k: k, x: ed[k].x, y: ed[k].y }); });
        });
        gesture = { type: 'move', before: begin(), sx: e.clientX, sy: e.clientY, w0: w, shapes: moving, ends: ends, moved: false };
        render(); renderFormat(); refreshToolbar();
      } else {
        gesture = { type: 'band', w0: w, sx: e.clientX, sy: e.clientY, moved: false, box: { x: w.x, y: w.y, w: 0, h: 0 }, add: e.shiftKey ? sel.slice() : [] };
      }
      e.preventDefault();
    }
    function onMove(e) {
      if (!gesture) return;
      const w = toWorld(e);
      const g = gesture;
      if (g.type === 'pan') {
        if (Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy) > 3) g.moved = true;
        panX = g.px + (e.clientX - g.sx); panY = g.py + (e.clientY - g.sy);
        render();
        return;
      }
      if (g.type === 'palette') {
        g.ghost.style.left = e.clientX + 'px'; g.ghost.style.top = e.clientY + 'px';
        if (Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy) > 4) { g.moved = true; g.ghost.hidden = false; }
        return;
      }
      if (g.type === 'move') {
        if (!g.moved && Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy) < 3) return;
        g.moved = true;
        const dx = w.x - g.w0.x, dy = w.y - g.w0.y;
        // 整組一起對齊格線：以第一個圖形為準算出位移，其他人照同樣的量走，相對位置才不會跑掉
        const first = Object.keys(g.shapes)[0];
        let ax = dx, ay = dy;
        if (first) { ax = snap(g.shapes[first].x + dx) - g.shapes[first].x; ay = snap(g.shapes[first].y + dy) - g.shapes[first].y; }
        else if (g.ends.length) { ax = snap(g.ends[0].x + dx) - g.ends[0].x; ay = snap(g.ends[0].y + dy) - g.ends[0].y; }
        Object.keys(g.shapes).forEach(function (id) {
          const s = shapeById(id);
          if (s) { s.x = g.shapes[id].x + ax; s.y = g.shapes[id].y + ay; }
        });
        g.ends.forEach(function (n) { n.e[n.k] = { x: n.x + ax, y: n.y + ay }; });
        render();
        return;
      }
      if (g.type === 'resize') {
        const s = shapeById(g.id), o = g.o;
        if (!s) return;
        let x0 = o.x, y0 = o.y, x1 = o.x + o.w, y1 = o.y + o.h;
        if (g.dir.indexOf('w') >= 0) x0 = Math.min(snap(w.x), x1 - MIN_SIZE);
        if (g.dir.indexOf('e') >= 0) x1 = Math.max(snap(w.x), x0 + MIN_SIZE);
        if (g.dir.indexOf('n') >= 0) y0 = Math.min(snap(w.y), y1 - MIN_SIZE);
        if (g.dir.indexOf('s') >= 0) y1 = Math.max(snap(w.y), y0 + MIN_SIZE);
        s.x = x0; s.y = y0; s.w = x1 - x0; s.h = y1 - y0;
        render();
        return;
      }
      if (g.type === 'connect') {
        g.target = targetShapeAt(e, g.from);
        g.preview.to = g.target ? { id: g.target } : { x: w.x, y: w.y };
        renderOverlay();
        return;
      }
      if (g.type === 'endpoint') {
        const ed = edgeById(g.id);
        if (!ed) return;
        const other = g.which === 'from' ? ed.to : ed.from;
        g.target = targetShapeAt(e, other.id || null);
        g.preview = Object.assign({}, ed, { id: '_p', label: '' });
        g.preview[g.which] = g.target ? { id: g.target } : { x: w.x, y: w.y };
        renderOverlay();
        return;
      }
      if (g.type === 'band') {
        if (!g.moved && Math.abs(e.clientX - g.sx) + Math.abs(e.clientY - g.sy) < 3) return;
        g.moved = true;
        g.box = { x: Math.min(g.w0.x, w.x), y: Math.min(g.w0.y, w.y), w: Math.abs(w.x - g.w0.x), h: Math.abs(w.y - g.w0.y) };
        renderOverlay();
      }
    }
    function onUp(e) {
      if (!gesture) return;
      const g = gesture;
      gesture = null;
      canvas.classList.remove('is-panning');
      if (g.type === 'pan') {
        if (g.right && !g.moved) openContextMenu(e.clientX, e.clientY, g.hitId, g.w0);
        return;
      }
      const w = toWorld(e);
      if (g.type === 'palette') {
        g.ghost.remove();
        const r = canvas.getBoundingClientRect();
        const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        if (!g.moved) insert(g.item);
        else if (inside) insert(g.item, w);
        canvas.focus();
        return;
      }
      if (g.type === 'move' || g.type === 'resize') {
        commit(g.before);
      } else if (g.type === 'connect') {
        const far = Math.abs(w.x - centerOf(shapeById(g.from)).x) + Math.abs(w.y - centerOf(shapeById(g.from)).y) > 12;
        if (g.target || far) {
          const ed = Object.assign({}, EDGE_DEF, {
            id: newId('e'), label: '', from: { id: g.from },
            to: g.target ? { id: g.target } : { x: snap(w.x), y: snap(w.y) }
          });
          model.edges.push(ed);
          sel = [ed.id];
          commit(g.before);
        }
      } else if (g.type === 'endpoint') {
        const ed = edgeById(g.id);
        if (ed && g.preview) {
          ed[g.which] = g.target ? { id: g.target } : { x: snap(w.x), y: snap(w.y) };
          commit(g.before);
        }
      } else if (g.type === 'band') {
        if (!g.moved) sel = g.add;
        else {
          const b = g.box, inBox = function (x, y) { return x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h; };
          const byId = indexOf(model);
          const hit = model.shapes.filter(function (s) { return inBox(s.x, s.y) && inBox(s.x + s.w, s.y + s.h); }).map(function (s) { return s.id; })
            .concat(model.edges.filter(function (ed) {
              const gg = edgeGeom(ed, byId);
              return gg && inBox(gg.p1.x, gg.p1.y) && inBox(gg.p2.x, gg.p2.y);
            }).map(function (ed) { return ed.id; }));
          sel = g.add.concat(hit.filter(function (id) { return g.add.indexOf(id) < 0; }));
        }
      }
      render(); renderFormat(); refreshToolbar();
    }
    function onHover(e) {
      if (gesture) return;
      const g = e.target.closest ? e.target.closest('.dio-shape[data-id]') : null;
      const c = e.target.closest ? e.target.closest('[data-conn]') : null;
      const id = g ? g.getAttribute('data-id') : (c ? c.getAttribute('data-conn') : null);
      if (id === hoverId) return;
      hoverId = id;
      renderOverlay();
    }
    function onDbl(id, w) {
      if (id) { select([id]); startEdit(id); return; }
      // 雙擊空白處：直接開始打字，打完才變成一段文字
      select([]);
      startEdit(null, w);
    }
    stage.addEventListener('mousedown', onDown);
    stage.addEventListener('mousemove', onHover);
    stage.addEventListener('mouseleave', function () { if (!gesture && hoverId) { hoverId = null; renderOverlay(); } });
    stage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (editing) commitEdit();
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      else {
        if (e.shiftKey) panX -= e.deltaY; else { panX -= e.deltaX; panY -= e.deltaY; }
        render();
      }
    }, { passive: false });

    // 左邊的圖形：點一下放中央，拖過去放在放開的地方
    // ---- 我的圖示 ----
    // 清單每次開編輯器都重新跟伺服器要：只有本人的（伺服器只回自己的），而且不留在模組裡
    // ——同一個分頁登出換人登入，上一個人的圖示不能還掛在這裡。
    const sideEl = host.querySelector('.dio-side');
    const iconGrid = host.querySelector('.dio-icon-grid');
    const iconEmpty = host.querySelector('.dio-icon-empty');
    const iconFile = host.querySelector('.dio-icon-file');
    const iconAdd = host.querySelector('.dio-icon-add');
    const ICON_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
    const ICON_MAX = 2 * 1024 * 1024;
    let icons = [], iconBusy = false;
    function iconTile(it) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dio-pal dio-icon';
      b.setAttribute('data-icon', it.id);
      b.title = it.name || '圖示';
      const img = document.createElement('img');
      img.alt = ''; img.draggable = false; img.loading = 'lazy';
      img.src = '/api/images/' + it.id;
      const del = document.createElement('span');
      del.className = 'dio-icon-del';
      del.setAttribute('data-icon-del', it.id);
      del.title = '從圖示庫移除';
      del.textContent = '×';
      b.appendChild(img); b.appendChild(del);
      return b;
    }
    function renderIcons() {
      // 已經畫出來的那幾格留著不動，不然每上傳一個，整排縮圖都要重新載入一次
      const have = {};
      Array.prototype.forEach.call(iconGrid.children, function (c) { have[c.getAttribute('data-icon')] = c; });
      icons.forEach(function (it) {
        iconGrid.appendChild(have[it.id] || iconTile(it));
        delete have[it.id];
      });
      Object.keys(have).forEach(function (id) { have[id].remove(); });
      iconEmpty.hidden = icons.length > 0;
    }
    // 放到畫布上的大小：長邊 60，照原圖的比例；還不知道原圖多大就先給正方形
    function iconItem(id) {
      const it = icons.find(function (x) { return x.id === id; });
      const img = iconGrid.querySelector('[data-icon="' + id + '"] img');
      const nw = (it && it.nw) || (img && img.naturalWidth) || 0, nh = (it && it.nh) || (img && img.naturalHeight) || 0;
      let w = 60, h = 60;
      if (nw && nh) {
        const k = 60 / Math.max(nw, nh);
        w = Math.max(20, Math.round(nw * k / GRID) * GRID);
        h = Math.max(20, Math.round(nh * k / GRID) * GRID);
      }
      return { type: 'image', src: id, w: w, h: h, name: it ? it.name : '' };
    }
    function measure(file) {
      return new Promise(function (resolve) {
        const url = URL.createObjectURL(file), im = new Image();
        const done = function (w, h) { URL.revokeObjectURL(url); resolve({ w: w, h: h }); };
        im.onload = function () { done(im.naturalWidth, im.naturalHeight); };
        im.onerror = function () { done(0, 0); };
        im.src = url;
      });
    }
    // at：放開滑鼠的位置（把檔案拖到畫布上）——上傳完直接放在那裡
    function uploadIcons(files, at) {
      const list = Array.prototype.slice.call(files || []);
      if (!list.length || iconBusy) return;
      if (!global.Store || !Store.putIcon) { toast('這裡不能上傳圖示'); return; }
      const bad = [], added = [];
      iconBusy = true;
      sideEl.classList.add('is-uploading');
      let chain = Promise.resolve();
      list.forEach(function (f) {
        chain = chain.then(function () {
          if (closed) return;
          if (ICON_TYPES.indexOf(f.type) < 0) { bad.push(f.name + '：只能是 PNG、JPG、GIF、WebP 或 SVG'); return; }
          if (f.size > ICON_MAX) { bad.push(f.name + '：超過 2 MB'); return; }
          return measure(f).then(function (dim) {
            return Store.putIcon(f).then(function (it) {
              it.nw = dim.w; it.nh = dim.h;
              icons.push(it); added.push(it);
              if (!closed) renderIcons();
            });
          }).catch(function (e) { bad.push(f.name + '：' + (e && e.message || '上傳失敗')); });
        });
      });
      chain.then(function () {
        iconBusy = false;
        if (closed) return;
        sideEl.classList.remove('is-uploading');
        if (at && added.length) {
          added.forEach(function (it, i) { insert(iconItem(it.id), { x: at.x + i * 20, y: at.y + i * 20 }); });
        } else if (added.length) {
          const last = iconGrid.querySelector('[data-icon="' + added[added.length - 1].id + '"]');
          if (last && last.scrollIntoView) last.scrollIntoView({ block: 'nearest' });
        }
        if (bad.length) toast(bad.length === 1 ? bad[0] : bad.length + ' 個檔案沒有加進來：' + bad[0] + '…');
        else if (added.length) toast('已加入 ' + added.length + ' 個圖示');
      });
    }
    function removeIcon(id) {
      const it = icons.find(function (x) { return x.id === id; });
      if (!it) return;
      const ask = global.App && App.confirm
        ? App.confirm({ title: '從圖示庫移除', message: '要把「' + (it.name || '圖示') + '」從你的圖示庫移除嗎？已經畫在圖裡的不受影響，照樣看得到。', ok: '移除', danger: true })
        : Promise.resolve(true);
      ask.then(function (yes) {
        if (!yes) return;
        return Store.removeIcon(id).then(function () {
          icons = icons.filter(function (x) { return x.id !== id; });
          if (!closed) renderIcons();
        });
      }).catch(function (e) { toast('移除失敗：' + (e && e.message || e)); });
    }
    if (global.Store && Store.listIcons) {
      Store.listIcons().then(function (l) { if (!closed) { icons = l.concat(icons); renderIcons(); } },
        function () { if (!closed) iconEmpty.textContent = '圖示庫讀不到，重新整理再試一次。'; });
    } else host.querySelector('.dio-icons').hidden = true;
    iconAdd.addEventListener('click', function () { iconFile.value = ''; iconFile.click(); });
    iconFile.addEventListener('change', function () { uploadIcons(iconFile.files); });
    sideEl.addEventListener('click', function (e) {
      const d = e.target.closest('[data-icon-del]');
      if (d) { e.preventDefault(); e.stopPropagation(); removeIcon(d.getAttribute('data-icon-del')); }
    });
    // 從電腦把圖片檔拖進來：丟在左邊＝加進圖示庫；丟在畫布上＝加進圖示庫，順便放在那裡
    function dragHasFiles(e) {
      const t = e.dataTransfer && e.dataTransfer.types;
      return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
    }
    function onDragOver(e) {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      host.classList.add('is-filedrag');
    }
    function onDragLeave(e) { if (!e.relatedTarget || !host.contains(e.relatedTarget)) host.classList.remove('is-filedrag'); }
    function onDrop(e) {
      if (!dragHasFiles(e)) return;
      e.preventDefault(); e.stopPropagation();
      host.classList.remove('is-filedrag');
      const onCanvas = !!(e.target.closest && e.target.closest('.dio-canvas'));
      uploadIcons(e.dataTransfer.files, onCanvas ? toWorld(e) : null);
    }
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);

    sideEl.addEventListener('mousedown', function (e) {
      if (e.target.closest('[data-icon-del]')) return;      // 那是「移除」，不是要拖圖示
      const ib = e.target.closest('[data-icon]');
      const b = ib || e.target.closest('[data-pal]');
      if (!b || e.button !== 0) return;
      let item;
      if (ib) item = iconItem(ib.getAttribute('data-icon'));
      else { const p = b.getAttribute('data-pal').split(','); item = PALETTE[+p[0]].items[+p[1]]; }
      const ghost = document.createElement('div');
      ghost.className = 'dio-ghost';
      ghost.hidden = true;
      if (ib) { const gi = document.createElement('img'); gi.alt = ''; gi.src = '/api/images/' + item.src; ghost.appendChild(gi); }
      else ghost.innerHTML = thumb(item);
      ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
      host.appendChild(ghost);
      if (editing) commitEdit();
      gesture = { type: 'palette', item: item, ghost: ghost, sx: e.clientX, sy: e.clientY, moved: false };
      e.preventDefault();
    });
    host.querySelector('.dio-toolbar').addEventListener('click', function (e) {
      const b = e.target.closest('[data-act]');
      if (b && !b.disabled) act(b.getAttribute('data-act'));
    });
    host.querySelector('.dio-menubar').addEventListener('click', function (e) {
      const b = e.target.closest('[data-menu]');
      if (b) { e.stopPropagation(); openMenu(b); }
    });
    function onDocDown(e) {
      if (menuEl && !e.target.closest('.dio-menu') && !e.target.closest('.dio-menu-btn')) closeMenu();
    }
    document.addEventListener('mousedown', onDocDown, true);

    // ---- 鍵盤 ----
    function onKey(e) {
      if (editing) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (e.key === ' ') { spaceDown = true; canvas.classList.add('can-pan'); e.preventDefault(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeSelected(); return; }
      if (e.key === 'Escape') { if (menuEl) closeMenu(); else if (sel.length) { e.preventDefault(); e.stopPropagation(); select([]); } return; }
      if (e.key === 'F2' || (e.key === 'Enter' && !mod)) { if (sel.length === 1) { e.preventDefault(); startEdit(sel[0]); } return; }
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if (mod && k === 'y') { e.preventDefault(); doRedo(); return; }
      if (mod && k === 'a') { e.preventDefault(); act('selectall'); return; }
      if (mod && k === 'c') { e.preventDefault(); copySelected(); return; }
      if (mod && k === 'x') { e.preventDefault(); act('cut'); return; }
      if (mod && k === 'v') { e.preventDefault(); paste(); return; }
      if (mod && k === 'd') { e.preventDefault(); duplicate(); return; }
      // 疊放順序（跟 draw.io 同一組鍵）：Ctrl+] 上移一層、Ctrl+Shift+] 最前；[ 反過來
      if (mod && (e.key === ']' || e.key === '}')) { e.preventDefault(); if (e.shiftKey || e.key === '}') reorder(true); else reorderStep(true); return; }
      if (mod && (e.key === '[' || e.key === '{')) { e.preventDefault(); if (e.shiftKey || e.key === '{') reorder(false); else reorderStep(false); return; }
      if (e.key.indexOf('Arrow') === 0 && sel.length) {
        e.preventDefault();
        const d = e.shiftKey ? GRID : 1;
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
        const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
        mutate(function () {
          selShapes().forEach(function (s) { s.x += dx; s.y += dy; });
          selEdges().forEach(function (ed) {
            ['from', 'to'].forEach(function (kk) { if (!ed[kk].id) ed[kk] = { x: ed[kk].x + dx, y: ed[kk].y + dy }; });
          });
        });
        return;
      }
      // 直接打字就開始改文字（跟 draw.io 一樣）
      if (!mod && !e.altKey && e.key.length === 1 && sel.length === 1) {
        startEdit(sel[0]);
        if (editing) { editing.el.value = ''; }
      }
    }
    function onKeyUp(e) { if (e.key === ' ') { spaceDown = false; canvas.classList.remove('can-pan'); } }
    host.addEventListener('keydown', onKey);
    host.addEventListener('keyup', onKeyUp);

    // ---- 格式面板 ----
    function colorRow(label, prop, value, allowNone) {
      const off = value === 'none';
      return '<div class="dio-row"><label class="dio-chk">' +
        (allowNone ? '<input type="checkbox" data-toggle="' + prop + '"' + (off ? '' : ' checked') + '>' : '') +
        '<span>' + label + '</span></label>' +
        '<input class="dio-color" type="color" data-prop="' + prop + '" value="' + (off ? '#ffffff' : value) + '"' + (off ? ' disabled' : '') + '></div>';
    }
    function numRow(label, prop, value, min, max, step) {
      return '<div class="dio-row"><span>' + label + '</span><input class="dio-num" type="number" data-prop="' + prop + '" value="' + fmt(value) +
        '" min="' + min + '" max="' + max + '" step="' + (step || 1) + '"></div>';
    }
    function chkRow(label, prop, on) {
      return '<div class="dio-row"><label class="dio-chk"><input type="checkbox" data-prop="' + prop + '"' + (on ? ' checked' : '') + '><span>' + label + '</span></label></div>';
    }
    function segRow(label, prop, value, options) {
      return '<div class="dio-row"><span>' + label + '</span><div class="dio-seg">' + options.map(function (o) {
        return '<button type="button" data-prop="' + prop + '" data-val="' + o[0] + '" class="' + (o[0] === value ? 'on' : '') + '" title="' + o[1] + '">' + (o[2] || o[1]) + '</button>';
      }).join('') + '</div></div>';
    }
    function renderFormat() {
      const ss = selShapes(), es = selEdges();
      if (!ss.length && !es.length) {
        formatEl.innerHTML = '<div class="dio-tabs"><span class="dio-tab on">圖表</span></div><div class="dio-panel">' +
          '<div class="dio-grp">檢視</div>' +
          '<div class="dio-row"><label class="dio-chk"><input type="checkbox" data-act="grid"' + (model.grid ? ' checked' : '') + '><span>格線</span></label></div>' +
          '<div class="dio-row"><label class="dio-chk"><input type="checkbox" data-act="snap"' + (snapOn ? ' checked' : '') + '><span>對齊格線</span></label></div>' +
          '<div class="dio-grp">統計</div>' +
          '<div class="dio-row dio-dim"><span>' + model.shapes.length + ' 個圖形・' + model.edges.length + ' 條連線</span></div>' +
          '<div class="dio-grp">操作</div><div class="dio-help">' +
          '雙擊圖形或連線：改文字<br>雙擊空白處：加文字<br>滾輪：捲動　Ctrl+滾輪：縮放<br>空白鍵＋拖曳、右鍵拖曳：平移<br>Shift＋點：多選　拖空白處：框選</div>' +
          '</div>';
        return;
      }
      const tabs = ss.length ? [['style', '樣式'], ['text', '文字'], ['arrange', '排列']] : [['style', '樣式'], ['text', '文字']];
      if (!tabs.some(function (t) { return t[0] === tab; })) tab = 'style';
      let h = '<div class="dio-tabs">' + tabs.map(function (t) {
        return '<button type="button" class="dio-tab' + (t[0] === tab ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>';
      }).join('') + '</div><div class="dio-panel">';
      const a = ss[0] || es[0];
      if (tab === 'style') {
        if (ss.length) {
          h += '<div class="dio-presets">' + PRESETS.map(function (p, i) {
            return '<button type="button" class="dio-preset" data-preset="' + i + '" style="background:' + p[0] + ';border-color:' + p[1] + '" title="填色 ' + p[0] + '／線條 ' + p[1] + '"></button>';
          }).join('') + '</div>';
          h += colorRow('填滿', 'fill', ss[0].fill, true);
        }
        h += colorRow('線條', 'stroke', a.stroke, !!ss.length && !es.length);
        h += numRow('線寬', 'sw', a.sw, 0.5, 20, 0.5);
        h += chkRow('虛線', 'dash', a.dash);
        if (es.length) {
          const e0 = es[0];
          h += '<div class="dio-grp">連線</div>';
          h += segRow('線型', 'style', e0.style, [['straight', '直線'], ['elbow', '折線'], ['curve', '曲線']]);
          h += segRow('起點', 'start', e0.start, [['none', '無'], ['arrow', '箭頭']]);
          h += segRow('終點', 'end', e0.end, [['none', '無'], ['arrow', '箭頭']]);
        }
      } else if (tab === 'text') {
        h += numRow('字級', 'fs', a.fs, 6, 96, 1);
        h += colorRow('文字顏色', 'fc', a.fc, false);
        h += chkRow('粗體', 'bold', a.bold);
        if (ss.length) h += segRow('對齊', 'align', ss[0].align, [['left', '靠左', ic('align-left')], ['center', '置中', ic('align-center')], ['right', '靠右', ic('align-right')]]);
      } else {
        const s0 = ss[0];
        h += '<div class="dio-grp">順序</div><div class="dio-btns">' +
          '<button type="button" class="dio-btn" data-act="front">移到最前</button><button type="button" class="dio-btn" data-act="back">移到最後</button></div>';
        if (ss.length === 1) {
          h += '<div class="dio-grp">位置與大小</div>' + numRow('X', 'x', s0.x, -20000, 20000, 1) + numRow('Y', 'y', s0.y, -20000, 20000, 1) +
            numRow('寬', 'w', s0.w, MIN_SIZE, 4000, 1) + numRow('高', 'h', s0.h, MIN_SIZE, 4000, 1);
        } else {
          h += '<div class="dio-grp">對齊（' + ss.length + ' 個圖形）</div><div class="dio-btns dio-btns-3">' +
            [['left', '靠左'], ['center', '水平置中'], ['right', '靠右'], ['top', '靠上'], ['middle', '垂直置中'], ['bottom', '靠下']].map(function (x) {
              return '<button type="button" class="dio-btn" data-act="align-' + x[0] + '">' + x[1] + '</button>';
            }).join('') + '</div>';
        }
      }
      formatEl.innerHTML = h + '</div>';
    }
    function applyProp(prop, value) {
      const ss = selShapes(), es = selEdges();
      mutate(function () {
        ss.forEach(function (s) {
          if (prop === 'fill') s.fill = color(value, s.fill, true);
          else if (prop === 'stroke') s.stroke = color(value, s.stroke, true);
          else if (prop === 'sw') s.sw = num(value, s.sw, 0.5, 20);
          else if (prop === 'dash' || prop === 'bold') s[prop] = value ? 1 : 0;
          else if (prop === 'fs') s.fs = num(value, s.fs, 6, 96);
          else if (prop === 'fc') s.fc = color(value, s.fc, false);
          else if (prop === 'align' && ALIGNS.indexOf(value) >= 0) s.align = value;
          else if (prop === 'x' || prop === 'y') s[prop] = num(value, s[prop], -20000, 20000);
          else if (prop === 'w' || prop === 'h') s[prop] = num(value, s[prop], MIN_SIZE, 4000);
        });
        es.forEach(function (e) {
          if (prop === 'stroke') e.stroke = color(value, e.stroke, false);
          else if (prop === 'sw') e.sw = num(value, e.sw, 0.5, 20);
          else if (prop === 'dash' || prop === 'bold') e[prop] = value ? 1 : 0;
          else if (prop === 'fs') e.fs = num(value, e.fs, 6, 96);
          else if (prop === 'fc') e.fc = color(value, e.fc, false);
          else if (prop === 'style' && STYLES.indexOf(value) >= 0) e.style = value;
          else if (prop === 'start' || prop === 'end') e[prop] = value === 'arrow' ? 'arrow' : 'none';
        });
      });
    }
    formatEl.addEventListener('change', function (e) {
      const t = e.target;
      if (t.hasAttribute('data-act')) { act(t.getAttribute('data-act')); return; }
      if (t.hasAttribute('data-toggle')) {
        const prop = t.getAttribute('data-toggle');
        const picker = formatEl.querySelector('.dio-color[data-prop="' + prop + '"]');
        const first = selShapes()[0];
        // 關掉之前記住原本的顏色，再勾回來就是它，不是白色
        if (!t.checked && first && first[prop] !== 'none') lastColor[prop] = first[prop];
        applyProp(prop, t.checked ? (lastColor[prop] || (picker ? picker.value : '#ffffff')) : 'none');
        return;
      }
      if (!t.hasAttribute('data-prop')) return;
      applyProp(t.getAttribute('data-prop'), t.type === 'checkbox' ? t.checked : t.value);
    });
    formatEl.addEventListener('click', function (e) {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) { tab = tabBtn.getAttribute('data-tab'); renderFormat(); return; }
      const pre = e.target.closest('[data-preset]');
      if (pre) {
        const p = PRESETS[+pre.getAttribute('data-preset')];
        mutate(function () { selShapes().forEach(function (s) { s.fill = p[0]; s.stroke = p[1]; }); });
        return;
      }
      const seg = e.target.closest('button[data-prop]');
      if (seg) { applyProp(seg.getAttribute('data-prop'), seg.getAttribute('data-val')); return; }
      const b = e.target.closest('button[data-act]');
      if (b) act(b.getAttribute('data-act'));
    });
    formatEl.addEventListener('keydown', function (e) { e.stopPropagation(); });

    // ---- 關閉 ----
    function teardown() {
      clearTimeout(saveTimer);
      closeMenu();
      if (editing) { editing.done = true; endEdit(); }
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onDocDown, true);
      host.removeEventListener('keydown', onKey);
      host.removeEventListener('keyup', onKeyUp);
      host.removeEventListener('dragover', onDragOver);
      host.removeEventListener('dragleave', onDragLeave);
      host.removeEventListener('drop', onDrop);
      host.innerHTML = ''; host.classList.remove('dio-page', 'is-filedrag');
    }
    // 圖就是一段文字，存檔不用等誰回覆，所以切走時同步送出去就好
    function close() {
      if (closed) return;
      if (editing) commitEdit();
      emit();
      closed = true;
      teardown();
      if (opts.onClose) opts.onClose();
    }
    // 不存檔直接拆掉：還原到舊版本之後用的，免得把還原前的圖又存回去
    function discard() {
      if (closed) return;
      closed = true;
      dirty = false;
      teardown();
    }
    function onResize() { if (!closed) render(); }
    window.addEventListener('resize', onResize);
    // 把還沒送出的改動存掉，存完才回來：版本紀錄、PDF 都要看到現在畫面上這張
    function flush() {
      if (closed) return Promise.resolve();
      if (editing) commitEdit();
      if (!dirty) return Promise.resolve();
      clearTimeout(saveTimer);
      dirty = false;
      setStatus('儲存中…');
      return Promise.resolve(opts.onChange ? opts.onChange(wrap(serialize(model))) : null).then(function () {
        if (!closed && !dirty) setStatus('已儲存', 'is-ok');
      }, function () { if (!closed) setStatus('儲存失敗', 'is-err'); });
    }

    renderFormat(); refreshToolbar();
    // 容器剛顯示出來時還沒有大小，等排版完再對位
    requestAnimationFrame(function () { if (!closed) { fit(); if (model.shapes.length || model.edges.length) setStatus('已儲存', 'is-ok'); } });
    setTimeout(function () { if (!closed) canvas.focus(); }, 30);

    return { close: close, requestClose: close, discard: discard, flush: flush };
  }

  global.DrawIO = {
    open: open, view: view,
    isNote: isNote, generate: generate,
    payloadOf: payloadOf, wrap: wrap, parse: parse, serialize: serialize,
    renderSVG: renderSVG, blockHTML: blockHTML, htmlOf: htmlOf
  };
})(window);

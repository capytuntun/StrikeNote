/* quicknotes.js — 隨筆區：照著 Google Keep 實際的操作方式做，不是自己發明的近似物。
 *
 * 跟其他筆記一樣是一篇 note（area:'quick'，永遠在最上層、沒有資料夾），只是瀏覽／
 * 編輯方式完全不同。照 Keep 做的部分，一項一項對：
 *
 *   - 上方「記點什麼…」平常是一行；點進去（聚焦，不用先打字）就展開成一張完整的
 *     卡片：標題欄、內文、右上角圖釘、底下一排工具（顏色／圖片／封存／更多）跟
 *     「關閉」——沒有「新增」鈕，Keep 也沒有：按關閉、按 Esc、或點卡片外面就是存檔
 *     （有內容才建立，空的直接丟掉）。收合狀態右邊還有「新清單」「新增圖片」兩顆
 *     捷徑，跟 Keep 一樣。
 *   - 點一張卡片是在畫面中央放大成一個對話框編輯（標題、內文、右下角「編輯於 …」、
 *     同一排工具、關閉），不是在原位換成輸入框；關閉／Esc／點外面一律存檔。
 *   - 每張卡片滑過去右上角出現圖釘，底下出現 顏色／圖片／封存／⋮更多（刪除、建立
 *     副本、顯示或隱藏勾選框），跟 Keep 卡片的那一排一樣（沒有提醒跟協作者——這
 *     個系統沒有那兩樣東西）。
 *   - 卡片上的勾選框可以直接勾：點第 N 個框就把內文裡第 N 個「- [ ]」翻過來存回去，
 *     不用點進卡片，Keep 就是這樣。
 *   - 卡片牆是「平衡欄」佈局（layoutMasonry）：每張新卡片放進當下最短的那一欄，
 *     順序照卡片本身的順序左右流動；不是 CSS column-width 那種先排滿一欄再換欄。
 *
 * 顏色（meta.color）、釘選（meta.pinned，沿用既有欄位）、封存（meta.archived）都
 * 存在筆記的 meta 裡；內文是純文字（不走 Markdown，打什麼就是什麼，見 renderPlain）——圖片是
 * `![…](img:id)`（透過 app.js 既有的上傳流程，顯示時抽到卡片最上面），清單是「- [ ]」（編輯時是
 * 一列一個勾選框，使用者看不到記號）。
 */
(function (global) {
  'use strict';

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function ic(name) { return (global.Icons && Icons.svg) ? Icons.svg(name) : ''; }
  function iconBtn(cls, name, title) {
    const b = el('button', cls, ic(name));
    b.type = 'button'; b.title = title;
    b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 不搶走輸入框焦點
    return b;
  }

  const COLORS = [
    { key: '', name: '預設' },
    { key: 'red', name: '紅' }, { key: 'orange', name: '橘' }, { key: 'yellow', name: '黃' },
    { key: 'green', name: '綠' }, { key: 'teal', name: '青' }, { key: 'blue', name: '藍' },
    { key: 'purple', name: '紫' }, { key: 'pink', name: '粉' }
  ];
  const NO_TITLE = '未命名筆記';   // 伺服器的預設標題，不算「真的有標題」

  let showArchived = false;
  let lastOpts = null;

  function isPinned(n) { return !!(n.meta && n.meta.pinned); }
  function isArchived(n) { return !!(n.meta && n.meta.archived); }
  function colorOf(n) { return (n.meta && n.meta.color) || ''; }
  function realTitle(n) { return (n.title && n.title !== NO_TITLE) ? n.title : ''; }
  function timeLabel(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === now.toDateString()) return '編輯於 ' + hm;
    return '編輯於 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  }

  // ---- 勾選框：Markdown 待辦清單的翻轉／整段加上或拿掉 ----
  const TASK_RE = /^(\s*[-*+]\s+\[)( |x|X)(\])/;
  function hasTasks(text) { return String(text || '').split('\n').some(function (l) { return TASK_RE.test(l); }); }
  function toggleTaskLine(text, n) {
    let k = -1;
    return String(text || '').split('\n').map(function (l) {
      const m = TASK_RE.exec(l);
      if (!m) return l;
      k++;
      if (k !== n) return l;
      return l.replace(TASK_RE, function (_, a, mark, c) { return a + (mark === ' ' ? 'x' : ' ') + c; });
    }).join('\n');
  }
  // Keep 的「顯示勾選框」：每一行變成一個項目；「隱藏勾選框」：把記號拿掉留文字
  function toggleChecklist(text) {
    const lines = String(text || '').split('\n');
    if (hasTasks(text)) {
      return lines.map(function (l) { return l.replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s?/, '$1'); }).join('\n');
    }
    return lines.map(function (l) { return l.trim() ? '- [ ] ' + l.replace(/^\s*[-*+]\s+/, '') : l; }).join('\n');
  }

  // ---- 浮動小面板（顏色盤、⋮ 選單）：body 子元素一律 fixed，點外面關掉 ----
  function popupAt(anchor, cls) {
    document.querySelectorAll('.qn-palette, .qn-menu').forEach(function (p) { p.remove(); });
    const pop = el('div', cls);
    document.body.appendChild(pop);
    function place() {
      const r = anchor.getBoundingClientRect();
      pop.style.left = Math.max(6, Math.min(r.left, global.innerWidth - pop.offsetWidth - 8)) + 'px';
      pop.style.top = Math.min(r.bottom + 4, global.innerHeight - pop.offsetHeight - 8) + 'px';
    }
    setTimeout(function () {
      document.addEventListener('mousedown', function out(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', out, true); }
      }, true);
    }, 0);
    return { el: pop, place: place };
  }
  function openPalette(anchor, current, onPick) {
    const pop = popupAt(anchor, 'qn-palette');
    COLORS.forEach(function (c) {
      const b = el('button', 'qn-swatch qn-c-' + (c.key || 'none') + (current === c.key ? ' on' : ''));
      b.type = 'button'; b.title = c.name;
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) { e.stopPropagation(); pop.el.remove(); onPick(c.key); });
      pop.el.appendChild(b);
    });
    pop.place();
  }
  function openMenu(anchor, items) {
    const pop = popupAt(anchor, 'qn-menu');
    items.forEach(function (it) {
      const b = el('button', 'qn-menu-item' + (it.danger ? ' danger' : ''), ic(it.icon) + '<span>' + esc(typeof it.label === 'function' ? it.label() : it.label) + '</span>');   // label 可以是函式：打開時才算（顯示／隱藏勾選框會變）
      b.type = 'button';
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) { e.stopPropagation(); pop.el.remove(); it.fn(); });
      pop.el.appendChild(b);
    });
    pop.place();
  }
  function pickFiles(onFiles) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*,.pdf'; inp.multiple = true; inp.hidden = true;
    document.body.appendChild(inp);
    inp.addEventListener('change', function () { const fs = Array.prototype.slice.call(inp.files || []); inp.remove(); if (fs.length) onFiles(fs); });
    inp.click();
  }
  function prependMedia(content, mds) {
    if (!mds || !mds.length) return content;
    // Keep 把圖片放在卡片最上面，內文在圖下面
    return mds.join('\n') + '\n' + (content ? '\n' + content : '');
  }

  // ---- 共用的「一排工具」：顏色／圖片／封存／⋮更多 ----------------------------
  // ctx = { color(), setColor(k), archived(), toggleArchive(), addMedia(files), more: [{icon,label,fn,danger}] }
  function makeToolbar(ctx) {
    const bar = el('div', 'qn-toolbar');
    const pal = iconBtn('qn-tbtn', 'grid', '背景顏色');
    pal.addEventListener('click', function (e) { e.stopPropagation(); openPalette(pal, ctx.color(), ctx.setColor); });
    bar.appendChild(pal);
    if (ctx.addMedia) {
      const img = iconBtn('qn-tbtn', 'image', '新增圖片');
      img.addEventListener('click', function (e) { e.stopPropagation(); pickFiles(ctx.addMedia); });
      bar.appendChild(img);
    }
    const arc = iconBtn('qn-tbtn', ctx.archived() ? 'folder-open' : 'folder', ctx.archived() ? '取消封存' : '封存');
    arc.addEventListener('click', function (e) { e.stopPropagation(); ctx.toggleArchive(); });
    bar.appendChild(arc);
    if (ctx.more && ctx.more.length) {
      const more = iconBtn('qn-tbtn', 'more-vertical', '更多');
      more.addEventListener('click', function (e) { e.stopPropagation(); openMenu(more, ctx.more); });
      bar.appendChild(more);
    }
    return bar;
  }
  function makePin(pinned, onToggle) {
    const pin = iconBtn('qn-pin-corner' + (pinned ? ' on' : ''), 'pin', pinned ? '取消釘選' : '釘選');
    pin.addEventListener('click', function (e) { e.stopPropagation(); onToggle(); });
    return pin;
  }
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

  // ---- 純文字：隨筆不走 Markdown，打什麼就是什麼（使用者的話：「隨筆不要走 md 要可以直接寫」）----
  // 內文照原樣顯示：換行就是換行，# 不是標題、* 不是清單。只認三樣會變成連結的東西——網址、
  // [[筆記]]、#標籤——還有 Keep 的勾選清單（每行一個 `- [ ]` 項目，編輯時是一列一個勾選框＋輸入框，
  // 使用者看不到那個記號）。圖片／附件存成 `![名稱](img:id)` 這種行（伺服器靠它判斷誰看得到圖），
  // 但顯示時抽出來放卡片最上面、編輯時放在一條可以 ✕ 掉的圖片列，不會出現在輸入框裡。
  const MEDIA_LINE = /^(!?)\[([^\]]*)\]\((img|pdf|file):([A-Za-z0-9_][\w.-]*)\)\s*$/;
  function splitMedia(text) {
    const media = [], lines = [];
    String(text || '').split('\n').forEach(function (l) {
      const m = MEDIA_LINE.exec(l.trim());
      if (m) media.push({ alt: m[2], kind: m[3], id: m[4], bang: m[1] === '!' }); else lines.push(l);
    });
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return { media: media, text: lines.join('\n') };
  }
  function joinMedia(media, text) {
    const head = media.map(function (m) { return (m.kind === 'file' ? '' : '!') + '[' + m.alt + '](' + m.kind + ':' + m.id + ')'; }).join('\n');
    if (!head) return text;
    return head + '\n' + (text ? '\n' + text : '');
  }
  function mediaFromMarkdown(mds) {
    return (mds || []).map(function (md) { const m = MEDIA_LINE.exec(String(md || '').trim()); return m ? { alt: m[2], kind: m[3], id: m[4] } : null; }).filter(Boolean);
  }
  // 一行文字裡的網址、[[筆記]]、#標籤 變成連結，其餘逐段跳脫
  function inlineHTML(s) {
    let out = '', i = 0, m;
    const re = /(https?:\/\/[^\s<>()\[\]"']+)|\[\[([^\]\n]+)\]\]|(^|[\s(（「\[])#([^\s#,，。、;；:：!！?？()（）\[\]]+)/g;
    while ((m = re.exec(s))) {
      out += esc(s.slice(i, m.index));
      if (m[1]) {
        const u = m[1].replace(/[.,;:!?）」』]+$/, ''), tail = m[1].slice(u.length);
        out += '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>' + esc(tail);
      } else if (m[2]) {
        const t = m[2].split('|')[0].trim();
        out += '<a class="note-link" href="#" data-note-title="' + esc(t) + '">' + esc(m[2]) + '</a>';
      } else {
        out += esc(m[3]) + '<a class="hashtag" href="#" data-tag="' + esc(m[4]) + '">#' + esc(m[4]) + '</a>';
      }
      i = m.index + m[0].length;
    }
    return out + esc(s.slice(i));
  }
  function mediaHTML(media) {
    if (!media.length) return '';
    return '<div class="qn-media">' + media.map(function (m) {
      if (m.kind === 'img') return '<img data-img-id="' + esc(m.id) + '" alt="' + esc(m.alt) + '">';
      return '<a class="qn-file" href="/api/images/' + esc(m.id) + '" target="_blank" rel="noopener noreferrer">' + ic('paperclip') + '<span>' + esc(m.alt || (m.kind === 'pdf' ? 'PDF' : '附件')) + '</span></a>';
    }).join('') + '</div>';
  }
  function renderPlain(text) {
    const sp = splitMedia(text);
    let h = mediaHTML(sp.media), k = 0;
    const lines = sp.text ? sp.text.split('\n') : [];
    h += '<div class="qn-text">' + lines.map(function (l) {
      const m = TASK_RE.exec(l);
      if (m) {
        const done = m[2] !== ' ', t = l.replace(TASK_RE, '').replace(/^\s/, '');
        return '<label class="qn-check' + (done ? ' is-done' : '') + '"><input type="checkbox" class="task-check" data-task="' + (k++) + '"' + (done ? ' checked' : '') + '><span>' + inlineHTML(t) + '</span></label>';
      }
      if (!l.trim()) return '<div class="qn-line qn-line-empty"><br></div>';
      return '<div class="qn-line">' + inlineHTML(l) + '</div>';
    }).join('') + '</div>';
    return h;
  }
  // ---- 行編輯器：文字跟勾選項目可以混在一起（使用者要的：「文字、清單可以混在一起那種」）----
  // 每一行是一列：純文字列，或 勾選框＋文字 的清單列，順序就是內容的順序。Enter 在游標處切成兩列（同一種），
  // 行首 Backspace 併回上一列（清單列先變回文字），滑過去右邊有「變成勾選項目／變成文字」跟刪除。
  // 存的時候文字列原樣、清單列是 `- [ ] 文字`，所以卡片、搜尋、備份都不用改。
  function parseLines(text) {
    const lines = String(text || '').split('\n').map(function (l) {
      const m = TASK_RE.exec(l);
      return m ? { type: 'task', done: m[2] !== ' ', text: l.replace(TASK_RE, '').replace(/^\s/, '') } : { type: 'text', text: l };
    });
    while (lines.length > 1 && lines[lines.length - 1].type === 'text' && !lines[lines.length - 1].text.trim()) lines.pop();
    return lines.length ? lines : [{ type: 'text', text: '' }];
  }
  function linesToText(lines) {
    const out = lines.map(function (r) { return r.type === 'task' ? '- [' + (r.done ? 'x' : ' ') + '] ' + r.text : r.text; });
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n');
  }
  function linesPlain(lines) { return lines.map(function (r) { return r.text; }).join('\n'); }
  function hasTaskLines(lines) { return lines.some(function (r) { return r.type === 'task'; }); }
  // 整篇切換：有清單列 → 全部變文字；都是文字 → 有字的行變清單（Keep 的「顯示／隱藏勾選框」）
  function toggleLinesChecklist(lines) {
    if (hasTaskLines(lines)) return lines.map(function (r) { return { type: 'text', text: r.text }; });
    return lines.map(function (r) { return r.text.trim() ? { type: 'task', done: false, text: r.text } : r; });
  }
  function makeLineEditor(lines, onChange, o) {
    o = o || {};
    const box = el('div', 'qn-lines');
    let focusAt = null;   // { i, pos }
    function autosizeRow(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
    function row(r, i) {
      const el0 = el('div', 'qn-row qn-row-' + r.type + (r.done ? ' is-done' : ''));
      if (r.type === 'task') {
        const cb = el('input', 'qn-item-cb'); cb.type = 'checkbox'; cb.checked = !!r.done;
        cb.addEventListener('change', function () { r.done = cb.checked; el0.classList.toggle('is-done', r.done); onChange(); });
        el0.appendChild(cb);
      }
      const ta = el('textarea', 'qn-row-input'); ta.rows = 1; ta.value = r.text;
      ta.placeholder = r.type === 'task' ? '清單項目' : (i === 0 && lines.length === 1 ? (o.placeholder || '記點什麼…') : '');
      ta.addEventListener('input', function () { r.text = ta.value; autosizeRow(ta); onChange(); });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.isComposing) {
          e.preventDefault();
          const pos = ta.selectionStart, before = ta.value.slice(0, pos), after = ta.value.slice(ta.selectionEnd);
          r.text = before;
          const n = r.type === 'task' ? { type: 'task', done: false, text: after } : { type: 'text', text: after };
          lines.splice(i + 1, 0, n);
          focusAt = { i: i + 1, pos: 0 }; onChange(); draw();
        } else if (e.key === 'Backspace' && ta.selectionStart === 0 && ta.selectionEnd === 0) {
          if (r.type === 'task') { e.preventDefault(); lines[i] = { type: 'text', text: r.text }; focusAt = { i: i, pos: 0 }; onChange(); draw(); return; }
          if (i > 0) {
            e.preventDefault();
            const prev = lines[i - 1], at = prev.text.length;
            prev.text += r.text; lines.splice(i, 1);
            focusAt = { i: i - 1, pos: at }; onChange(); draw();
          }
        } else if (e.key === 'ArrowUp' && i > 0 && ta.selectionStart === 0) { e.preventDefault(); focusAt = { i: i - 1, pos: lines[i - 1].text.length }; focusNow(); }
        else if (e.key === 'ArrowDown' && i < lines.length - 1 && ta.selectionEnd === ta.value.length) { e.preventDefault(); focusAt = { i: i + 1, pos: lines[i + 1].text.length }; focusNow(); }
        else if (e.key === 'Escape') { e.stopPropagation(); ta.blur(); }
      });
      // 貼多行：切成好幾列（像 - [ ] 的行變清單列）
      ta.addEventListener('paste', function (e) {
        const t = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
        if (t.indexOf('\n') < 0) return;
        e.preventDefault();
        const parts = t.replace(/\r/g, '').split('\n');
        const pos = ta.selectionStart, before = ta.value.slice(0, pos), after = ta.value.slice(ta.selectionEnd);
        r.text = before + parts[0];
        const extra = parseLines(parts.slice(1).join('\n'));
        extra[extra.length - 1].text += after;
        lines.splice.apply(lines, [i + 1, 0].concat(extra));
        focusAt = { i: i + extra.length, pos: extra[extra.length - 1].text.length - after.length }; onChange(); draw();
      });
      el0.appendChild(ta);
      const tools = el('span', 'qn-row-tools');
      const kind = iconBtn('qn-row-btn', r.type === 'task' ? 'type' : 'check-square', r.type === 'task' ? '變成文字' : '變成勾選項目');
      kind.addEventListener('click', function () { lines[i] = r.type === 'task' ? { type: 'text', text: r.text } : { type: 'task', done: false, text: r.text }; focusAt = { i: i, pos: r.text.length }; onChange(); draw(); });
      tools.appendChild(kind);
      if (lines.length > 1) {
        const del = iconBtn('qn-row-btn', 'x', '刪除這一行');
        del.addEventListener('click', function () { lines.splice(i, 1); focusAt = { i: Math.min(i, lines.length - 1), pos: 0 }; onChange(); draw(); });
        tools.appendChild(del);
      }
      el0.appendChild(tools);
      return el0;
    }
    function focusNow() {
      if (!focusAt) return;
      const tas = box.querySelectorAll('.qn-row-input');
      const ta = tas[focusAt.i];
      if (ta) { ta.focus(); const p = Math.min(focusAt.pos, ta.value.length); ta.setSelectionRange(p, p); }
      focusAt = null;
    }
    function draw() {
      box.innerHTML = '';
      lines.forEach(function (r, i) { box.appendChild(row(r, i)); });
      box.querySelectorAll('.qn-row-input').forEach(autosizeRow);
      focusNow();
    }
    draw();
    box.redraw = draw;
    box.focusLast = function () { focusAt = { i: lines.length - 1, pos: lines[lines.length - 1].text.length }; focusNow(); };
    box.focusFirst = function () { focusAt = { i: 0, pos: lines[0].text.length }; focusNow(); };
    box.autosize = function () { box.querySelectorAll('.qn-row-input').forEach(autosizeRow); };
    return box;
  }
  // 編輯中的圖片列：每張可以 ✕ 掉
  function makeMediaStrip(media, onChange) {
    const strip = el('div', 'qn-media qn-media-edit');
    media.forEach(function (m) {
      const w = el('span', 'qn-media-item');
      if (m.kind === 'img') { const img = document.createElement('img'); img.setAttribute('data-img-id', m.id); img.alt = m.alt; w.appendChild(img); }
      else w.appendChild(el('span', 'qn-file', ic('paperclip') + '<span>' + esc(m.alt || (m.kind === 'pdf' ? 'PDF' : '附件')) + '</span>'));
      const x = iconBtn('qn-media-del', 'x', '移除');
      x.addEventListener('click', function () { media.splice(media.indexOf(m), 1); onChange(); });
      w.appendChild(x); strip.appendChild(w);
    });
    if (global.MD && MD.resolveImages) MD.resolveImages(strip);
    strip.hidden = !media.length;
    return strip;
  }

  // ---- 一張卡片（牆上唯讀）----------------------------------------------------
  function makeCard(note, o) {
    const card = el('div', 'qn-card' + (colorOf(note) ? ' qn-c-' + colorOf(note) : ''));
    card.dataset.id = note.id;

    card.appendChild(makePin(isPinned(note), function () { o.onPatch(note, { pinned: !isPinned(note) }); }));
    if (realTitle(note)) card.appendChild(el('div', 'qn-title', esc(note.title)));
    const body = el('div', 'qn-body');
    body.innerHTML = renderPlain(note.content || '');
    // 勾選框直接可以勾（Keep 卡片上就能勾）：第 N 個框對應內文第 N 個「- [ ]」
    body.querySelectorAll('input.task-check').forEach(function (cb, k) {
      cb.addEventListener('click', function (e) {
        e.stopPropagation();
        o.onEdit(note, { content: toggleTaskLine(note.content, k) });
      });
    });
    card.appendChild(body);
    if (global.MD && MD.resolveImages) MD.resolveImages(body);
    card.appendChild(makeToolbar({
      color: function () { return colorOf(note); },
      setColor: function (k) { o.onPatch(note, { color: k || null }); },
      archived: function () { return isArchived(note); },
      toggleArchive: function () { o.onPatch(note, { archived: !isArchived(note) }); },
      addMedia: o.onUpload ? function (files) {
        o.onUpload(files).then(function (mds) { o.onEdit(note, { content: prependMedia(note.content || '', mds) }); });
      } : null,
      more: [
        { icon: 'trash', label: '刪除筆記', danger: true, fn: function () { o.onDelete(note); } },
        { icon: 'copy', label: '建立副本', fn: function () { o.onDuplicate(note); } },
        { icon: 'list-checks', label: hasTasks(note.content) ? '隱藏勾選框' : '顯示勾選框', fn: function () { o.onEdit(note, { content: toggleChecklist(note.content) }); } }
      ]
    }));

    card.addEventListener('click', function (e) {
      // 卡片裡的連結要能點：外部網址開新分頁，[[筆記]] 開那篇，#標籤 回首頁篩選
      const a = e.target.closest('a');
      if (a) {
        if (a.classList.contains('note-link')) { e.preventDefault(); if (o.onOpenNote) o.onOpenNote(a); return; }
        if (a.classList.contains('hashtag')) { e.preventDefault(); if (o.onTag) o.onTag(a.getAttribute('data-tag')); return; }
        return;   // 一般網址：瀏覽器自己開（新分頁）
      }
      if (e.target.closest('.qn-toolbar, .qn-pin-corner, .task-check, .qn-check, button')) return;
      openModal(note, o);
    });
    return card;
  }

  // ---- 點卡片：放大成對話框編輯（Keep 的開啟方式）-------------------------------
  // 內文是行編輯器（文字列與勾選列混在一起，見 makeLineEditor）；圖片在上面一條可以 ✕ 的列
  function openModal(note, o) {
    document.querySelectorAll('.qn-modal-overlay').forEach(function (m) { m.remove(); });
    const overlay = el('div', 'qn-modal-overlay');
    const modal = el('div', 'qn-modal qn-card' + (colorOf(note) ? ' qn-c-' + colorOf(note) : ''));
    overlay.appendChild(modal);

    let pinned = isPinned(note);
    let pin = makePin(pinned, function () { pinned = !pinned; o.onPatch(note, { pinned: pinned }); pin.classList.toggle('on', pinned); pin.title = pinned ? '取消釘選' : '釘選'; });
    modal.appendChild(pin);
    const mediaBox = el('div', 'qn-modal-media');
    modal.appendChild(mediaBox);
    const title = el('input', 'qn-modal-title');
    title.type = 'text'; title.placeholder = '標題'; title.value = realTitle(note);
    modal.appendChild(title);
    const bodyBox = el('div', 'qn-modal-bodybox');
    modal.appendChild(bodyBox);

    const sp0 = splitMedia(note.content || '');
    const media = sp0.media.slice();
    let lines = parseLines(sp0.text);
    let editor = null;
    function currentContent() { return joinMedia(media, linesToText(lines)); }
    function drawMedia() { mediaBox.innerHTML = ''; mediaBox.appendChild(makeMediaStrip(media, function () { drawMedia(); scheduleSave(); })); }
    function drawBody() {
      bodyBox.innerHTML = '';
      editor = makeLineEditor(lines, function () { scheduleSave(); linksSoon(); });
      bodyBox.appendChild(editor);
    }

    // 內文裡的網址、[[筆記]]、#標籤 列在下面，點得到
    const linksBox = el('div', 'qn-modal-links');
    modal.appendChild(linksBox);
    let linkTimer = null;
    function linksSoon() { clearTimeout(linkTimer); linkTimer = setTimeout(renderLinks, 300); }
    function renderLinks() {
      linksBox.innerHTML = '';
      const text = linesPlain(lines);
      const seen = {};
      const urlRe = /https?:\/\/[^\s<>()\[\]"']+/g;
      let m;
      while ((m = urlRe.exec(text))) {
        const u = m[0].replace(/[.,;:!?）」』]+$/, '');
        if (seen[u]) continue; seen[u] = 1;
        const a = el('a', 'qn-link-chip', ic('link') + '<span>' + esc(u.replace(/^https?:\/\//, '').slice(0, 60)) + '</span>');
        a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.title = u;
        linksBox.appendChild(a);
      }
      const wikiRe = /\[\[([^\]\n]+)\]\]/g;
      while ((m = wikiRe.exec(text))) {
        const t = m[1].split('|')[0].trim();
        if (!t || seen['[[' + t]) continue; seen['[[' + t] = 1;
        const a = el('a', 'qn-link-chip note-link', ic('file-text') + '<span>' + esc(t) + '</span>');
        a.href = '#'; a.setAttribute('data-note-title', t);
        a.addEventListener('click', function (e) { e.preventDefault(); if (o.onOpenNote) { close(); o.onOpenNote(a); } });
        linksBox.appendChild(a);
      }
      ((global.MD && MD.extractTags) ? MD.extractTags(text) : []).forEach(function (t) {
        const a = el('a', 'qn-link-chip hashtag', '<span>#' + esc(t) + '</span>');
        a.href = '#'; a.setAttribute('data-tag', t);
        a.addEventListener('click', function (e) { e.preventDefault(); if (o.onTag) { close(); o.onTag(t); } });
        linksBox.appendChild(a);
      });
      linksBox.hidden = !linksBox.children.length;
    }
    const meta = el('div', 'qn-modal-meta', esc(timeLabel(note.updatedAt)));
    modal.appendChild(meta);

    let saveTimer = null, closed = false;
    function fields() {
      const f = {};
      if (title.value !== realTitle(note)) f.title = title.value;
      const c = currentContent();
      if (c !== (note.content || '')) f.content = c;
      return f;
    }
    function flush() {
      clearTimeout(saveTimer);
      const f = fields();
      if (Object.keys(f).length) o.onEdit(note, f);
    }
    function scheduleSave() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 500); }
    function close() {
      if (closed) return;
      closed = true;
      flush();
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      o.onClosed && o.onClosed();
    }
    title.addEventListener('input', scheduleSave);
    title.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); editor.focusFirst(); } });

    const foot = el('div', 'qn-modal-foot');
    foot.appendChild(makeToolbar({
      color: function () { return colorOf(note); },
      setColor: function (k) {
        o.onPatch(note, { color: k || null });
        modal.className = 'qn-modal qn-card' + (k ? ' qn-c-' + k : '');
      },
      archived: function () { return isArchived(note); },
      toggleArchive: function () { o.onPatch(note, { archived: !isArchived(note) }); close(); },
      addMedia: o.onUpload ? function (files) {
        o.onUpload(files).then(function (mds) { mediaFromMarkdown(mds).forEach(function (m) { media.push(m); }); drawMedia(); scheduleSave(); });
      } : null,
      more: [
        { icon: 'trash', label: '刪除筆記', danger: true, fn: function () { closed = true; overlay.remove(); document.removeEventListener('keydown', onKey, true); o.onDelete(note); } },
        { icon: 'copy', label: '建立副本', fn: function () { flush(); o.onDuplicate(Object.assign({}, note, { title: title.value, content: currentContent() })); } },
        { icon: 'list-checks', label: function () { return hasTaskLines(lines) ? '隱藏勾選框' : '顯示勾選框'; }, fn: function () {
          lines = toggleLinesChecklist(lines);
          drawBody(); editor.focusLast(); scheduleSave(); renderLinks();
        } }
      ]
    }));
    const closeBtn = el('button', 'qn-close-btn', '關閉');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', close);
    foot.appendChild(closeBtn);
    modal.appendChild(foot);

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', function (e) {
      if (e.target === overlay) { e.preventDefault(); close(); }
    });
    document.body.appendChild(overlay);
    drawMedia();
    drawBody();
    renderLinks();
    setTimeout(function () { editor.autosize(); editor.focusLast(); }, 0);
  }

  // ---- 新增列：Keep 的「記點什麼…」——聚焦就展開成一張卡片 --------------------
  // 收合時是一行輸入框；展開後是同一個行編輯器（文字與勾選列可以混）
  function makeComposer(o) {
    const box = el('div', 'qn-composer');
    let open = false;
    let color = '', pinned = false, archived = false;
    const media = [];
    let lines = null, editor = null;

    const mediaBox = el('div', 'qn-modal-media');
    const bar = el('div', 'qn-composer-bar');
    const ta = el('textarea', 'qn-composer-input');
    ta.rows = 1; ta.placeholder = '記點什麼…';
    const edBox = el('div', 'qn-composer-lines'); edBox.hidden = true;
    bar.appendChild(ta); bar.appendChild(edBox);
    const quick = el('div', 'qn-composer-quick');
    const listBtn = iconBtn('qn-tbtn', 'list-checks', '新清單');
    const imgBtn = iconBtn('qn-tbtn', 'image', '新增圖片');
    quick.appendChild(listBtn); quick.appendChild(imgBtn);
    bar.appendChild(quick);

    const pin = makePin(false, function () { pinned = !pinned; pin.classList.toggle('on', pinned); pin.title = pinned ? '取消釘選' : '釘選'; });
    const title = el('input', 'qn-composer-title');
    title.type = 'text'; title.placeholder = '標題';
    const foot = el('div', 'qn-composer-foot');
    function drawMedia() { mediaBox.innerHTML = ''; mediaBox.appendChild(makeMediaStrip(media, drawMedia)); }
    function drawEditor() {
      edBox.innerHTML = '';
      editor = makeLineEditor(lines, function () {}, { placeholder: '記點什麼…' });
      edBox.appendChild(editor);
    }
    const tools = makeToolbar({
      color: function () { return color; },
      setColor: function (k) { color = k || ''; box.className = 'qn-composer is-open' + (color ? ' qn-c-' + color : ''); },
      archived: function () { return archived; },
      toggleArchive: function () { archived = true; commit(); },   // Keep：展開中按封存＝存起來並封存
      addMedia: o.onUpload ? function (files) {
        o.onUpload(files).then(function (mds) { expand(); mediaFromMarkdown(mds).forEach(function (m) { media.push(m); }); drawMedia(); });
      } : null,
      more: [
        { icon: 'list-checks', label: '顯示或隱藏勾選框', fn: function () { expand(); lines = toggleLinesChecklist(lines); drawEditor(); editor.focusLast(); } }
      ]
    });
    foot.appendChild(tools);
    const closeBtn = el('button', 'qn-close-btn', '關閉');
    closeBtn.type = 'button';
    closeBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    closeBtn.addEventListener('click', commit);
    foot.appendChild(closeBtn);

    box.appendChild(pin); box.appendChild(mediaBox); box.appendChild(title); box.appendChild(bar); box.appendChild(foot);

    // 展開：一行輸入框換成行編輯器（把已經打的字帶過去）
    function expand(focusEditor) {
      if (open) return;
      open = true;
      box.className = 'qn-composer is-open' + (color ? ' qn-c-' + color : '');
      lines = parseLines(ta.value);
      drawEditor();
      ta.hidden = true; edBox.hidden = false;
      if (focusEditor !== false) setTimeout(function () { editor.autosize(); editor.focusLast(); }, 0);
      document.addEventListener('mousedown', onOutside, true);
    }
    function reset() {
      open = false; color = ''; pinned = false; archived = false;
      media.length = 0; drawMedia();
      lines = null; editor = null; edBox.innerHTML = ''; edBox.hidden = true;
      ta.hidden = false; ta.value = ''; title.value = ''; autosize(ta);
      pin.classList.remove('on'); pin.title = '釘選';
      box.className = 'qn-composer';
      document.removeEventListener('mousedown', onOutside, true);
    }
    // 關閉＝存檔（有內容才建立），空的直接收合——Keep 沒有「新增」鈕
    function commit() {
      const body = lines ? linesToText(lines) : ta.value.trim();
      const content = joinMedia(media, body), t = title.value.trim();
      const meta = {};
      if (color) meta.color = color;
      if (pinned) meta.pinned = true;
      if (archived) meta.archived = true;
      reset();
      ta.blur();
      if (content || t) o.onCreate({ title: t, content: content, meta: meta });
    }
    function onOutside(e) {
      if (box.contains(e.target) || e.target.closest('.qn-palette, .qn-menu')) return;
      commit();
    }
    ta.addEventListener('focus', function () { expand(); });
    title.addEventListener('focus', function () { expand(false); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); commit(); }
    });
    title.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); commit(); }
      if (e.key === 'Enter') { e.preventDefault(); if (editor) editor.focusFirst(); }
    });
    edBox.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !e.defaultPrevented) { commit(); } });
    // 新清單：展開，最後一列空的就變成勾選列，不然加一列勾選列
    listBtn.addEventListener('click', function () {
      expand(false);
      const last = lines[lines.length - 1];
      if (last.type === 'text' && !last.text.trim()) lines[lines.length - 1] = { type: 'task', done: false, text: '' };
      else lines.push({ type: 'task', done: false, text: '' });
      drawEditor(); editor.focusLast();
    });
    imgBtn.addEventListener('click', function () { if (o.onUpload) pickFiles(function (fs) { o.onUpload(fs).then(function (mds) { expand(); mediaFromMarkdown(mds).forEach(function (m) { media.push(m); }); drawMedia(); }); }); });
    drawMedia();
    return box;
  }

  // ---- 平衡欄卡片牆：每張新卡片放進「目前最短的那一欄」------------------------
  // 不是 CSS column-width——那種先把一欄由上到下排滿才換下一欄，跟卡片本身的順序
  // （釘選／更新時間）對不起來，Keep 是照最短欄放。欄數看容器寬度即時算，用
  // ResizeObserver 而不是 window resize：側邊欄抽屜開合只是改 .quick-page 的 padding，
  // 不會觸發 window 的 resize 事件，但容器寬度確實變了。
  const COL_WIDTH = 240;   // Keep 的卡片寬
  let roList = [];
  // 可用寬度量的是整頁（.quick-page 的內容框），不是牆本身——牆包在 fit-content 的
  // .qn-section 裡，自己的寬度是由欄數反推出來的，量它會是循環。
  function pageOf(grid) { return grid.closest('.quick-page') || grid.parentElement; }
  function availWidth(grid) {
    const host = pageOf(grid);
    const cs = getComputedStyle(host);
    return host.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
  }
  function layoutMasonry(grid, cardEls, width) {
    grid.innerHTML = '';
    width = width || availWidth(grid) || COL_WIDTH;
    const gap = 16;
    const cols = Math.max(1, Math.min(6, Math.floor((width + gap) / (COL_WIDTH + gap))));
    // 手機（放不下兩欄）：單欄吃滿可用寬度（最多 600，跟輸入列一樣寬）；其餘照 Keep 的 240
    const colW = cols === 1 ? Math.max(200, Math.min(width, 600)) : COL_WIDTH;
    // 牆的寬度＝欄數決定，整段（含小標）靠 .qn-section 的 fit-content 置中
    grid.style.width = (cols * colW + (cols - 1) * gap) + 'px';
    const colEls = [];
    for (let i = 0; i < cols; i++) {
      const c = el('div', 'qn-col');
      c.style.flexBasis = c.style.width = colW + 'px';
      grid.appendChild(c);
      colEls.push(c);
    }
    cardEls.forEach(function (card) {
      let shortest = colEls[0];
      for (let i = 1; i < colEls.length; i++) {
        if (colEls[i].offsetHeight < shortest.offsetHeight) shortest = colEls[i];
      }
      shortest.appendChild(card);
    });
  }
  // 這一次 render 的所有牆（已釘選＋其他）一起重排：兩牆各自量寬的話，第一牆排完
  // 內容變高、捲軸出現、可用寬度少了 14px，第二牆量到的就跟第一牆不一樣，兩段卡片
  // 一寬一窄還撐出橫向捲軸。一支 ResizeObserver 觀察整頁的內容框（視窗縮放、抽屜
  // 開合、捲軸出現都會改它），寬度變了就全部重排。
  let grids = [];
  // 量一次寬度、所有牆用同一個數字：牆在清空重排的瞬間會讓捲軸出現或消失，各自量會量到
  // 不一樣的值。
  function relayoutAll() {
    if (!grids.length) return;
    const w = availWidth(grids[0].grid);
    grids.forEach(function (g) { layoutMasonry(g.grid, g.cards, w); });
  }
  function buildGrid(container, cardEls) {
    const grid = el('div', 'qn-grid');
    container.appendChild(grid); // 先插進文件，量寬度才準
    grids.push({ grid: grid, cards: cardEls });
    layoutMasonry(grid, cardEls);
    return grid;
  }
  function watchPage(page) {
    let last = -1;
    const ro = new ResizeObserver(function () {
      const cs = getComputedStyle(page);
      const w = page.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
      if (w !== last) { last = w; relayoutAll(); }
    });
    ro.observe(page);
    roList.push(ro);
  }

  function render(container, opts) {
    lastOpts = { container: container, opts: opts };
    roList.forEach(function (ro) { ro.disconnect(); });
    roList = [];
    grids = [];
    container.innerHTML = '';
    watchPage(container);

    // Keep 沒有大標題：頂上只有一個小小的定位字跟「封存」切換，第一眼看到的是輸入列
    const head = el('div', 'qn-head');
    head.appendChild(el('div', 'qn-title-h', ic(showArchived ? 'folder' : 'pin') + '<span>' + (showArchived ? '封存' : '隨筆') + '</span>'));
    const toggle = el('button', 'qn-archive-toggle' + (showArchived ? ' on' : ''),
      ic(showArchived ? 'arrow-left' : 'folder') + '<span>' + (showArchived ? '回到隨筆' : '封存') + '</span>');
    toggle.type = 'button';
    toggle.addEventListener('click', function () { showArchived = !showArchived; render(container, opts); });
    head.appendChild(toggle);
    container.appendChild(head);

    if (!showArchived) container.appendChild(makeComposer(opts));

    const notes = opts.notes.filter(function (n) { return isArchived(n) === showArchived; });
    if (!notes.length) {
      container.appendChild(el('div', 'qn-empty', ic(showArchived ? 'folder' : 'pin') + '<span>' + (showArchived ? '封存的隨筆會顯示在這裡。' : '你新增的隨筆會顯示在這裡。') + '</span>'));
      return;
    }
    const pinned = notes.filter(isPinned);
    const rest = notes.filter(function (n) { return !isPinned(n); });
    function sortByTime(a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }
    pinned.sort(sortByTime); rest.sort(sortByTime);

    // 每一段（小標＋牆）包成 .qn-section：fit-content 置中，小標就貼齊牆的左緣
    function section(label, list) {
      const sec = el('div', 'qn-section');
      if (label) sec.appendChild(el('div', 'qn-section-head', esc(label)));
      container.appendChild(sec);
      buildGrid(sec, list.map(function (n) { return makeCard(n, opts); }));
    }
    if (pinned.length) section('已釘選', pinned);
    if (rest.length) section(pinned.length ? '其他' : '', rest);
  }

  global.QuickNotes = {
    render: render,
    refresh: function (opts) { if (lastOpts) render(lastOpts.container, opts); },
    // 從側邊欄點一則隨筆：跟點卡片一樣用對話框開。找不到（已刪除、還沒畫過）回傳 false
    open: function (id) {
      if (!lastOpts || !lastOpts.opts) return false;
      const n = (lastOpts.opts.notes || []).filter(function (x) { return x.id === id; })[0];
      if (!n) return false;
      openModal(n, lastOpts.opts);
      return true;
    },
    reset: function () {
      roList.forEach(function (ro) { ro.disconnect(); });
      roList = [];
      document.querySelectorAll('.qn-modal-overlay, .qn-palette, .qn-menu').forEach(function (m) { m.remove(); });
      showArchived = false; lastOpts = null;
    }
  };
})(window);

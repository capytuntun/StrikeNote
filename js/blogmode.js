/* blogmode.js — Blog mode：像 Notion／Medium 一樣，直接在排版好的頁面上寫。
 *
 * 跟 分割／編輯／預覽 並列的第四種檢視模式，每一篇一般 Markdown 筆記都能用。
 * 內容仍然是 Markdown，#editor 的值是唯一的真實來源——自動存檔、協作合併、
 * 搜尋、PDF、電子書、版本歷史全部照舊，這個模組只是換一種編輯它的方式：
 *
 *   - 頁面切成頂層區塊，切法直接用 LineSync.sourceBlocks()（marked 的 lexer，
 *     含 callout／:::／RISK／[toc] 擴充），每個區塊各自 MD.render()。
 *   - 點一下區塊，那一塊原地換成一個只裝這段 Markdown 的 textarea（.blog-src），
 *     字級跟排版後的樣子一致；打的語法和 MD 編輯器完全相同，editor.js 的自動完成、
 *     / 指令、清單延續也掛在這個 textarea 上。點別處、Esc、方向鍵走出區塊就排版回去。
 *   - 每次輸入只把這個區塊佔的那幾行換進整份原始碼、交回 app.js（onChange），
 *     其他行一個字元都不動，所以協作的逐行合併和版本差異看到的只有真的改了的行。
 *   - 遠端更新由 app.js 呼叫 update()：在新內容裡找回正在編輯的那幾行，保住游標，
 *     其他區塊重新排版；找不到（同一段被別人改掉了）才放下編輯。
 *
 * 每個區塊單獨渲染，所以 RISK 弱點編號、標題錨點在這個模式裡是各區塊自己算的；
 * [toc] 例外，它需要整份筆記的標題，才整份渲染一次取出來。PDF／電子書照舊整份渲染。
 */
(function (global) {
  'use strict';

  let root = null;        // article#blog-doc
  let scroller = null;    // .blog-scroll
  let opts = {};
  let src = '';
  let blocks = [];        // LineSync.sourceBlocks(src)：{ kind, start, end }，1-based、含頭尾
  let ta = null;          // 唯一的編輯框，在區塊之間搬
  // 編輯中的區塊。原始碼第 line0 行起的 count 行屬於它：prefix + 編輯框的每一行 + suffix。
  // prefix／suffix 是新區塊前後補的空行，打了字才一起寫進去。
  // index = 它在 blocks 裡的位置（新區塊是 -1），after = 它後面第一個區塊的位置。
  let ed = null;
  let readOnly = false;
  let composing = false;

  function splitLines(s) { return s === '' ? [] : s.split('\n'); }

  function blockText(b) { return splitLines(src).slice(b.start - 1, b.end).join('\n'); }

  function elOf(i) { return root.querySelector('.blog-block[data-i="' + i + '"]'); }

  // ---- 排版 ----------------------------------------------------------------
  function render() {
    if (!root) return;
    const keep = scroller ? scroller.scrollTop : 0;
    const ls = splitLines(src);
    blocks = (global.LineSync && LineSync.sourceBlocks) ? LineSync.sourceBlocks(src) : [];
    const frag = document.createDocumentFragment();
    let tocHtml = null;
    blocks.forEach(function (b, i) {
      const el = document.createElement('div');
      el.className = 'blog-block';
      el.setAttribute('data-i', i);
      if (b.kind === 'toc') {
        if (tocHtml === null) {
          const tpl = document.createElement('template');
          tpl.innerHTML = MD.render(src);
          const nav = tpl.content.querySelector('.md-toc');
          tocHtml = nav ? nav.outerHTML : '';
        }
        el.innerHTML = tocHtml;
      } else {
        el.innerHTML = MD.render(ls.slice(b.start - 1, b.end).join('\n'));
      }
      frag.appendChild(el);
    });
    if (!blocks.length) {
      const empty = document.createElement('div');
      empty.className = 'blog-block blog-block-empty';
      empty.textContent = readOnly ? '這篇筆記還是空的' : '從這裡開始寫…　語法和 Markdown 一樣，輸入 / 可以插入區塊';
      frag.appendChild(empty);
    }
    root.innerHTML = '';
    root.appendChild(frag);
    root.classList.toggle('is-readonly', readOnly);
    MD.resolveImages(root);
    if (scroller) scroller.scrollTop = keep;
  }

  // ---- 編輯框 --------------------------------------------------------------
  // 依第一行猜區塊種類，讓編輯框的字級、字型跟排版後的樣子接近。
  function styleSource() {
    const first = ta.value.split('\n', 1)[0] || '';
    let cls = 'blog-src';
    let m;
    if ((m = first.match(/^(#{1,6})\s/))) cls += ' is-h' + m[1].length;
    else if (/^\s*(```|~~~)/.test(first) || /^( {4}|\t)/.test(first)) cls += ' is-code';
    else if (/^\s*\|/.test(first)) cls += ' is-table';
    else if (/^\s*>/.test(first) || /^:::/.test(first)) cls += ' is-quote';
    if (ta.className !== cls) ta.className = cls;
  }

  function autosize() {
    const keep = scroller ? scroller.scrollTop : 0;
    ta.style.height = 'auto';
    ta.style.height = (ta.scrollHeight + ta.offsetHeight - ta.clientHeight) + 'px';
    if (scroller) scroller.scrollTop = keep;
  }

  function reveal(el, atTop) {
    if (!scroller || !el) return;
    const r = el.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    if (atTop ? r.top < s.top : r.top < s.top && r.bottom < s.bottom) scroller.scrollTop -= (s.top - r.top) + 24;
    else if (r.bottom > s.bottom && !(atTop && r.top > s.top && r.top < s.bottom - 48)) {
      scroller.scrollTop += Math.min(r.bottom - s.bottom + 24, r.top - s.top - 24);
    }
  }

  function mount(el, text, caret) {
    el.classList.add('editing');
    el.innerHTML = '';
    el.appendChild(ta);
    ta.value = text;
    styleSource();
    autosize();
    try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
    let pos = text.length;
    if (caret === 'start') pos = 0;
    else if (typeof caret === 'number') pos = Math.max(0, Math.min(text.length, caret));
    ta.setSelectionRange(pos, pos);
    reveal(el, caret !== 'end');
  }

  function detach() {
    ed = null;
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
  }

  function startEdit(i, caret) {
    const b = blocks[i];
    const el = b && elOf(i);
    if (!el || readOnly) return;
    ed = { index: i, after: i + 1, line0: b.start, count: b.end - b.start + 1, prefix: [], suffix: [], isNew: false };
    mount(el, blockText(b), caret);
  }

  // 在 blocks[i] 後面（i = -1 表示最前面）開一個空白的新區塊。原始碼要等真的打了字才改，
  // 什麼都沒打就離開則原封不動。
  function startNew(i) {
    if (readOnly || !root) return;
    const ls = splitLines(src);
    const prevEnd = i >= 0 && blocks[i] ? blocks[i].end : 0;
    const line0 = prevEnd + 1;
    const prev = prevEnd > 0 ? ls[prevEnd - 1] : null;
    const next = ls[line0 - 1];
    ed = {
      index: -1, after: i + 1, line0: line0, count: 0, isNew: true,
      // 前後有字就各空一行，不然新打的字會黏進上一段或下一段
      prefix: (prev != null && prev.trim() !== '') ? [''] : [],
      suffix: (next != null && next.trim() !== '') ? [''] : []
    };
    const el = document.createElement('div');
    el.className = 'blog-block';
    const empty = root.querySelector('.blog-block-empty');
    if (empty) root.replaceChild(el, empty);
    else root.insertBefore(el, elOf(i + 1));
    mount(el, '', 'start');
  }

  // 把編輯框的內容換回整份原始碼：只動這個區塊佔的那幾行。清空的區塊整段拿掉。
  function commitText(text) {
    const ls = splitLines(src);
    const body = text === '' ? [] : ed.prefix.concat(text.split('\n'), ed.suffix);
    Array.prototype.splice.apply(ls, [ed.line0 - 1, ed.count].concat(body));
    const delta = body.length - ed.count;
    ed.count = body.length;
    if (delta) {
      for (let k = ed.after; k < blocks.length; k++) { blocks[k].start += delta; blocks[k].end += delta; }
    }
    const next = ls.join('\n');
    if (next === src) return;
    src = next;
    if (opts.onChange) opts.onChange(src);
  }

  // 程式碼區塊或 ::: 容器還沒關起來：這時空行是內容，Enter 不能拿來切段落。
  function unclosed(text) {
    let fence = false, box = false;
    text.split('\n').forEach(function (l) {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      else if (!fence && /^:::/.test(l)) box = !box;
    });
    return fence || box;
  }

  // 放下編輯框、排版回去。回傳原始碼在這個區塊之後的行號位移（清掉區塊時是負的），
  // 呼叫端拿它校正事先記下的行號。
  function finish() {
    if (!ed) return 0;
    let text = ta.value;
    if (!unclosed(text)) text = text.replace(/\n+$/, '');   // 結尾多按的 Enter 不留
    if (text.trim() === '') text = '';
    const before = ed.count;
    commitText(text);
    let delta = ed.count - before;
    if (text === '' && before > 0) {
      // 拿掉一整個區塊後，前後的空行接在一起就收成一個；文件開頭不留空行
      const ls = splitLines(src);
      const at = ed.line0 - 1;
      let changed = false;
      if (at > 0 && ls[at - 1] === '' && ls[at] === '') { ls.splice(at, 1); delta--; changed = true; }
      if (at === 0) while (ls.length && ls[0] === '') { ls.shift(); delta--; changed = true; }
      if (changed) {
        src = ls.join('\n');
        if (opts.onChange) opts.onChange(src);
      }
    }
    detach();
    render();
    return delta;
  }

  // 編輯 line 這一行所在的區塊（行號落在兩個區塊之間就取下一個）。
  function editAtLine(line, caret) {
    for (let k = 0; k < blocks.length; k++) {
      if (blocks[k].end >= line) { startEdit(k, caret); return; }
    }
    if (blocks.length) startEdit(blocks.length - 1, caret);
  }

  // 走到上一個／下一個區塊。沒有就回 false，讓按鍵照原本的行為走。
  function go(dir) {
    const i = dir < 0 ? (ed.isNew ? ed.after - 1 : ed.index - 1) : (ed.isNew ? ed.after : ed.index + 1);
    if (i < 0 || i >= blocks.length) return false;
    const line = blocks[i].start;
    const at = ed.line0;
    const shift = finish();
    editAtLine(line > at ? line + shift : line, dir < 0 ? 'end' : 'start');
    return true;
  }

  // 段落最後一行是空行時再按 Enter：這段到此為止，在它後面開新區塊（Notion 的按兩次 Enter）。
  function splitHere() {
    const trimmed = ta.value.replace(/\n+$/, '');
    const n = trimmed === '' ? 0 : trimmed.split('\n').length;
    const textEnd = ed.line0 + (ed.isNew ? ed.prefix.length : 0) + n - 1;
    ta.value = trimmed;
    finish();
    let k = -1;
    for (let i = 0; i < blocks.length && blocks[i].start <= textEnd; i++) k = i;
    startNew(k);
  }

  // ---- 事件 ----------------------------------------------------------------
  function onInput() {
    if (!ed) return;
    styleSource();
    autosize();
    commitText(ta.value);
  }

  function onKeyDown(e) {
    // editor.js 先處理（自動完成選單的上下鍵、Enter、清單延續、Tab），它處理掉的就不管
    if (!ed || e.defaultPrevented || composing || e.isComposing || e.keyCode === 229) return;
    const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (opts.onSave) opts.onSave();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); finish(); return; }
    if (mod || e.shiftKey || e.altKey || s !== en) return;

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const up = e.key === 'ArrowUp';
      const edge = up ? 0 : v.length;
      const edgeLine = up ? v.lastIndexOf('\n', s - 1) < 0 : v.indexOf('\n', s) < 0;
      if (!edgeLine) return;
      if (s === edge) { if (go(up ? -1 : 1)) e.preventDefault(); return; }
      // 長段落會折行：先讓瀏覽器照畫面上的行移動。游標若因此跑到最前／最後，代表原本就在
      // 最上／最下那一行，這時才走到隔壁區塊。
      const session = ed;
      setTimeout(function () {
        if (ed === session && ta.selectionStart === edge && ta.selectionEnd === edge) go(up ? -1 : 1);
      }, 0);
      return;
    }
    if (e.key === 'Backspace' && s === 0 && v === '') { e.preventDefault(); go(-1); return; }
    if (e.key === 'Enter' && s === v.length && /\n$/.test(v) && !unclosed(v)) {
      e.preventDefault();
      splitHere();
    }
  }

  function onPaste(e) {
    const items = (e.clipboardData || {}).items;
    if (!items || !opts.uploadImage || !ed) return;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      if (it.kind !== 'file' || it.type.indexOf('image/') !== 0) continue;
      e.preventDefault();
      // 上傳要走一趟網路，插入位置在貼上的當下就記住
      const session = ed, s = ta.selectionStart, en = ta.selectionEnd;
      opts.uploadImage(it.getAsFile()).then(function (id) {
        if (ed !== session) { if (opts.toast) opts.toast('圖片已上傳，但已經離開那個區塊，沒有插入'); return; }
        const v = ta.value, ins = '![貼上的圖片](img:' + id + ')';
        ta.value = v.slice(0, s) + ins + v.slice(en);
        ta.setSelectionRange(s + ins.length, s + ins.length);
        onInput();
      }).catch(function (err) {
        if (opts.toast) opts.toast('圖片上傳失敗：' + (err && err.message || err));
      });
      return;
    }
  }

  // 點在排版後的哪個字上 → 原始碼裡的位置：依序比對非空白字元，原始碼裡多出來的語法符號
  // （# * ` [ ]( 網址 ) 之類）直接略過。對不上時放在最後。
  function matchOffset(source, plain) {
    const want = plain.replace(/\s+/g, '');
    if (!want) return 0;
    let j = 0;
    for (let i = 0; i < source.length; i++) {
      const c = source[i];
      if (c === ' ' || c === '\t' || c === '\n') continue;
      if (c === want[j] && ++j === want.length) return i + 1;
    }
    return source.length;
  }

  function caretFromPoint(el, text, x, y) {
    let node = null, offset = 0;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { node = r.startContainer; offset = r.startOffset; }
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { node = p.offsetNode; offset = p.offset; }
    }
    if (!node || !el.contains(node)) return 'end';
    // 程式碼區塊只算 <pre> 裡的字：表頭的「複製」和語言標籤不在原始碼裡
    const pre = el.querySelector('pre');
    const scope = pre && pre.contains(node) ? pre : el;
    const range = document.createRange();
    range.selectNodeContents(scope);
    try { range.setEnd(node, offset); } catch (e) { return 'end'; }
    let base = 0;
    if (scope === pre && /^\s*(```|~~~)/.test(text)) base = text.indexOf('\n') + 1;
    return base + matchOffset(text.slice(base), range.toString());
  }

  function copyCode(btn) {
    const block = btn.closest('.code-block');
    if (!block || !opts.copyText) return;
    const lines = block.querySelectorAll('.code-lines > li');
    const text = lines.length
      ? Array.prototype.map.call(lines, function (li) { return li.textContent; }).join('\n')
      : (block.querySelector('pre code') || {}).textContent;
    if (text != null) opts.copyText(text, btn);
  }

  // 待辦勾選框：改寫它所在區塊裡第 n 個 - [ ]（跳過程式碼區塊），跟預覽的做法一樣。
  function onTask(e, box) {
    if (readOnly) { e.preventDefault(); return; }
    const el = box.closest('.blog-block');
    const b = el ? blocks[Number(el.getAttribute('data-i'))] : null;
    if (!b) return;
    const n = Array.prototype.indexOf.call(el.querySelectorAll('.task-check'), box);
    const checked = box.checked;
    let line = b.start;
    if (ed) { const at = ed.line0; const shift = finish(); if (line > at) line += shift; }
    const k = blocks.findIndex(function (x) { return x.start <= line && x.end >= line; });
    if (k < 0) { render(); return; }
    const ls = splitLines(src);
    let seq = -1, fence = false;
    for (let li = blocks[k].start - 1; li < blocks[k].end; li++) {
      if (/^\s*(```|~~~)/.test(ls[li])) { fence = !fence; continue; }
      if (fence) continue;
      const m = ls[li].match(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/);
      if (m && ++seq === n) {
        ls[li] = m[1] + (checked ? 'x' : ' ') + m[3];
        src = ls.join('\n');
        if (opts.onChange) opts.onChange(src);
        break;
      }
    }
    render();
  }

  function onClick(e) {
    const t = e.target;
    if (!t.closest || t === ta) return;
    const task = t.closest('.task-check');
    if (task) { onTask(e, task); return; }
    const link = t.closest('.note-link');
    if (link) { e.preventDefault(); if (opts.onNoteLink) opts.onNoteLink(link); return; }
    const tag = t.closest('.hashtag');
    if (tag) { e.preventDefault(); if (opts.onTag) opts.onTag(tag.getAttribute('data-tag')); return; }
    const anno = t.closest('.img-annotate');
    if (anno) { e.preventDefault(); if (opts.onAnnotate) opts.onAnnotate(anno.getAttribute('data-annotate')); return; }
    const copy = t.closest('.code-copy');
    if (copy) { e.preventDefault(); copyCode(copy); return; }
    const tocToggle = t.closest('.md-toc-toggle');
    if (tocToggle) {
      e.preventDefault();
      const li = tocToggle.closest('li');
      if (li) li.classList.toggle('open');
      return;
    }
    const tocLink = t.closest('.md-toc a[href^="#"]');
    if (tocLink) {
      e.preventDefault();
      const id = decodeURIComponent(tocLink.getAttribute('href').slice(1));
      const h = id && root.querySelector('[id="' + id.replace(/"/g, '\\"') + '"]');
      if (h) h.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // 其他連結、按鈕、嵌入的 PDF 照常運作，不進入編輯
    if (t.closest('a[href], button, input, select, iframe, summary, audio, video')) return;
    // 正在選字（要複製），不是要編輯
    const sel = global.getSelection && global.getSelection();
    if (sel && !sel.isCollapsed && root.contains(sel.anchorNode)) return;
    if (readOnly) return;
    const el = t.closest('.blog-block');
    if (!el || !root.contains(el) || el.classList.contains('editing')) return;
    if (el.classList.contains('blog-block-empty')) { startNew(-1); return; }
    const b = blocks[Number(el.getAttribute('data-i'))];
    if (!b) return;
    const caret = caretFromPoint(el, blockText(b), e.clientX, e.clientY);
    if (!ed) { editAtLine(b.start, caret); return; }
    const at = ed.line0;
    const shift = finish();
    editAtLine(b.start > at ? b.start + shift : b.start, caret);
  }

  // 點在最後一個區塊下面的空白：在最後開一個新區塊（Notion 點頁面底部的行為）。
  function onScrollerClick(e) {
    if (readOnly || (e.target !== scroller && e.target !== root)) return;
    const last = root.lastElementChild;
    if (last && e.clientY < last.getBoundingClientRect().bottom) return;   // 左右兩側的留白
    if (ed && ed.isNew && ed.after >= blocks.length) { ta.focus(); return; }
    if (ed) finish();
    startNew(blocks.length - 1);
  }

  // 點到頁面以外（側邊欄、頂列、別的面板）就結束編輯；自動完成選單不算。
  function onDocDown(e) {
    if (!ed || !scroller) return;
    const t = e.target;
    if (scroller.contains(t) || (t.closest && t.closest('.ac-popup'))) return;
    finish();
  }

  // 在新內容裡找回正在編輯的那幾行（離原本位置最近的一處）。
  function findLines(hay, needle, near) {
    if (!needle.length) return Math.max(0, Math.min(near, hay.length));
    let best = -1;
    for (let k = 0; k + needle.length <= hay.length; k++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) { if (hay[k + j] !== needle[j]) { ok = false; break; } }
      if (ok && (best < 0 || Math.abs(k - near) < Math.abs(best - near))) best = k;
    }
    return best;
  }

  // 內容被別處換掉之後重新排版，把編輯框放回它那幾行所在的位置，游標不動。
  function remount(caret) {
    const e = ed;
    ed = null;
    render();
    ed = e;
    const first = e.line0 + e.prefix.length;
    const last = e.line0 + e.count - 1 - e.suffix.length;
    let el = null, idx = -1, after = blocks.length;
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      if (b.end < first) continue;
      if (e.count > 0 && b.start <= last) {
        // 落在編輯範圍裡的區塊：第一個放編輯框，其餘的由編輯框代表
        const bel = elOf(k);
        if (!el) { el = bel; idx = k; } else if (bel) bel.remove();
        continue;
      }
      after = k;
      break;
    }
    e.after = after;
    e.index = e.isNew ? -1 : idx;
    if (!el) {
      el = document.createElement('div');
      el.className = 'blog-block';
      const empty = root.querySelector('.blog-block-empty');
      if (empty) root.replaceChild(el, empty);
      else root.insertBefore(el, elOf(after));
    }
    el.classList.add('editing');
    el.innerHTML = '';
    el.appendChild(ta);
    autosize();
    try { ta.focus({ preventScroll: true }); } catch (x) { ta.focus(); }
    ta.setSelectionRange(caret, caret);
  }

  // ---- 對外 ----------------------------------------------------------------
  function init(docEl, o) {
    root = docEl;
    scroller = docEl.parentElement;
    opts = o || {};
    ta = document.createElement('textarea');
    ta.className = 'blog-src';
    ta.spellcheck = false;
    ta.setAttribute('rows', '1');
    // editor.js 要先掛：它處理自動完成選單時會 preventDefault，下面的 keydown 才看得到
    if (global.Editor) Editor.attach(ta);
    ta.addEventListener('keydown', onKeyDown);
    ta.addEventListener('input', onInput);
    ta.addEventListener('paste', onPaste);
    ta.addEventListener('compositionstart', function () { composing = true; });
    ta.addEventListener('compositionend', function () { composing = false; });
    root.addEventListener('click', onClick);
    scroller.addEventListener('click', onScrollerClick);
    document.addEventListener('mousedown', onDocDown, true);
    global.addEventListener('resize', function () { if (ed) autosize(); });
  }

  // 打開一篇筆記（或切進這個模式）：丟掉之前的編輯狀態，整份重新排版。
  function show(text, ro) {
    detach();
    readOnly = !!ro;
    src = String(text || '');
    render();
  }

  // 離開這個模式：正在編輯的區塊收尾（可能清掉空區塊，會經 onChange 回報）。
  function hide() { if (ed) finish(); }

  // 內容在別處變了（協作者的更新、存檔回覆的合併結果）。
  function update(text, ro) {
    text = String(text || '');
    const roChanged = ro != null && !!ro !== readOnly;
    if (ro != null) readOnly = !!ro;
    if (text === src && !roChanged) return;
    if (!ed || readOnly) { detach(); src = text; render(); return; }
    const caret = ta.selectionStart;
    const body = ta.value === '' ? [] : ed.prefix.concat(ta.value.split('\n'), ed.suffix);
    const at = findLines(splitLines(text), body, ed.line0 - 1);
    src = text;
    if (at < 0) { detach(); render(); return; }   // 這一段被別人改掉了：放下編輯，顯示新內容
    ed.line0 = at + 1;
    remount(caret);
  }

  global.BlogMode = {
    init: init,
    show: show,
    hide: hide,
    reset: detach,
    update: update,
    isEditing: function () { return !!ed; }
  };
})(window);

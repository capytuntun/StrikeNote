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
  let gridFocus = null;   // 排版後要打開的表格儲存格 { idx, r, c, sel }（js/tablegrid.js）

  function splitLines(s) { return s === '' ? [] : s.split('\n'); }

  function blockText(b) { return splitLines(src).slice(b.start - 1, b.end).join('\n'); }

  function elOf(i) { return root.querySelector('.blog-block[data-i="' + i + '"]'); }

  // ---- 排版 ----------------------------------------------------------------
  function render() {
    if (!root) return;
    if (global.TableGrid) TableGrid.closeAll();   // 丟掉舊表格的疊層與就地編輯框，等一下重建
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
    applyTableWidths();
    if (scroller) scroller.scrollTop = keep;
    if (opts.onRender) opts.onRender();   // app.js 重建旁邊的目錄
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
    hideBubble();
    if (global.TableGrid) TableGrid.closeAll();
    if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
  }

  function startEdit(i, caret) {
    const b = blocks[i];
    const el = b && elOf(i);
    if (!el || readOnly) return;
    const text = blockText(b);
    // 空段落（見 blankHere）編輯時是空的框，不讓人看到 &nbsp;
    const blank = text.trim() === BLANK;
    ed = { index: i, after: i + 1, line0: b.start, count: b.end - b.start + 1, prefix: [], suffix: [], isNew: false, blank: blank };
    mount(el, blank ? '' : text, blank ? 'start' : caret);
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

  // 空段落在原始碼裡的樣子。Markdown 會把連續的空行併成一個，排版後完全不佔高度，所以在 Blog
  // 裡一直按 Enter 要往下長，每一下都得留下一個真的段落——一行 &nbsp;，排版出來是一段空白。
  const BLANK = '&nbsp;';

  // 把編輯框的內容換回整份原始碼：只動這個區塊佔的那幾行。清空的區塊整段拿掉——
  // 空段落例外：它清空了還是空段落，要按 Backspace 才會拿掉（ed.blank 先被清掉）。
  function commitText(text) {
    if (text === '' && ed.blank) text = BLANK;
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
    if (text === '' && before > 0 && !ed.blank) {
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
    if (e.key === 'Backspace' && s === 0 && v === '') {
      e.preventDefault();
      // 空段落要在這裡才真的拿掉；其他空區塊本來就還沒寫進原始碼，直接走到上一段
      if (ed.blank) {
        ed.blank = false;
        if (!go(-1)) finish();
        return;
      }
      go(-1);
      return;
    }
    // 空的區塊上按 Enter：留下一個空段落、在它後面開新區塊，連按就一直往下
    if (e.key === 'Enter' && v.trim() === '') {
      e.preventDefault();
      blankHere();
      return;
    }
    if (e.key === 'Enter' && s === v.length && /\n$/.test(v) && !unclosed(v)) {
      e.preventDefault();
      splitHere();
    }
  }

  function blankHere() {
    ta.value = BLANK;
    onInput();
    const at = ed.line0 + ed.prefix.length;   // 那一行 &nbsp; 在原始碼裡的行號
    finish();
    let k = -1;
    for (let i = 0; i < blocks.length; i++) if (blocks[i].start <= at) k = i;
    startNew(k);
  }

  // ---- 上傳：貼上、拖進頁面、/file ------------------------------------------
  // opts.uploadFiles(files, how) 由 app.js 提供：上傳每個檔案，回傳各自的 Markdown
  // （圖片 ![…](img:)、PDF、其他附件 […](file:)）。
  function hasFiles(e) {
    const t = e.dataTransfer && e.dataTransfer.types;
    return !!t && Array.prototype.indexOf.call(t, 'Files') >= 0;
  }
  function note(msg) { if (opts.toast) opts.toast(msg); }

  function onPaste(e) {
    const items = (e.clipboardData || {}).items;
    if (!items || !opts.uploadFiles || !ed) return;
    const files = [];
    for (let k = 0; k < items.length; k++) {
      if (items[k].kind !== 'file') continue;
      const f = items[k].getAsFile();
      if (f) files.push(f);
    }
    if (!files.length) return;
    e.preventDefault();
    uploadAtCaret(files, { pasted: true });
  }

  function upload(files, how) {
    if (opts.onStatus) opts.onStatus('上傳中…');
    return opts.uploadFiles(files, how || {}).then(function (mds) {
      if (opts.onStatus) opts.onStatus('');
      return mds;
    }, function (err) {
      if (opts.onStatus) opts.onStatus('');
      note('上傳失敗：' + (err && err.message || err));
      return null;
    });
  }

  // 上傳要走一趟網路，插入位置（哪個區塊、游標在哪）在動作的當下就記住
  function uploadAtCaret(files, how) {
    const session = ed, s = ta.selectionStart, en = ta.selectionEnd;
    upload(files, how).then(function (mds) {
      if (!mds) return;
      if (ed !== session) { note('檔案已上傳，但已經離開那個區塊，沒有插入'); return; }
      placeAtCaret(mds, s, en);
    });
  }

  // 貼上一張圖不該看到一行 ![…](img:…)：圖片、PDF、附件各自成一個區塊，放好就排版出來，
  // 游標接到它下面繼續寫。游標在清單、引言、表格那一行時，拆開會弄壞結構，就原地插入後結束
  // 編輯（一樣馬上看得到圖）；在還沒關起來的程式碼區塊裡則照原樣插入文字、繼續編輯。
  function placeAtCaret(mds, s, en) {
    const v = ta.value;
    const before = v.slice(0, s), after = v.slice(en);
    if (unclosed(before)) {
      const ins = mds.join('\n');
      ta.value = before + ins + after;
      ta.setSelectionRange(s + ins.length, s + ins.length);
      onInput();
      return;
    }
    const nl = after.indexOf('\n');
    const line = before.slice(before.lastIndexOf('\n') + 1) + (nl < 0 ? after : after.slice(0, nl));
    if (/^\s*(?:[-*+]|\d+[.)])\s|^\s*>|^\s*\|/.test(line)) {
      ta.value = before + mds.join(' ') + after;
      onInput();
      finish();
      return;
    }
    const head = before.replace(/\s+$/, ''), tail = after.replace(/^\s+/, '');
    const parts = head ? [head, ''] : [];
    mds.forEach(function (m, i) { if (i) parts.push(''); parts.push(m); });
    const lastMd = parts.length - 1;
    if (tail) parts.push('', tail);
    ta.value = parts.join('\n');
    onInput();
    const at = ed.line0 + ed.prefix.length + lastMd;   // 最後一個檔案那一行在原始碼裡的行號
    finish();
    let k = -1;
    for (let i = 0; i < blocks.length; i++) if (blocks[i].start <= at) k = i;
    if (tail && blocks[k + 1]) startEdit(k + 1, 'start');
    else startNew(k);
  }

  // 插在原始碼第 line 行之後（0 = 最前面），前後補空行讓它自成區塊。
  function insertAfterLine(line, mds) {
    const ls = splitLines(src);
    const n = Math.max(0, Math.min(line, ls.length));
    const ins = [];
    if (n > 0 && ls[n - 1].trim() !== '') ins.push('');
    mds.forEach(function (m, i) { if (i) ins.push(''); ins.push(m); });
    if (n < ls.length && ls[n].trim() !== '') ins.push('');
    Array.prototype.splice.apply(ls, [n, 0].concat(ins));
    src = ls.join('\n');
    if (opts.onChange) opts.onChange(src);
    render();
  }

  function onDragOver(e) {
    if (readOnly || !opts.uploadFiles || !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    scroller.classList.add('drag-over');
  }
  function onDragLeave(e) {
    if (!e.relatedTarget || !scroller.contains(e.relatedTarget)) scroller.classList.remove('drag-over');
  }
  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    scroller.classList.remove('drag-over');
    if (readOnly || !opts.uploadFiles) return;
    const files = Array.prototype.slice.call(e.dataTransfer.files || []);
    if (!files.length) return;
    if (ed && e.target === ta) { uploadAtCaret(files); return; }
    // 放在滑鼠底下那個區塊後面，落在頁面空白處就接在最後。上傳回來時內容可能已經變了
    // （協作者、還在打字），所以記下那個區塊的文字，回來再找一次位置，不信任舊行號。
    const el = e.target.closest && e.target.closest('.blog-block[data-i]');
    const b = el ? blocks[Number(el.getAttribute('data-i'))] : null;
    const anchor = b ? blockText(b).split('\n') : null;
    upload(files).then(function (mds) {
      if (!mds) return;
      if (ed) finish();
      const ls = splitLines(src);
      let line = ls.length;
      if (anchor) {
        const hit = findLines(ls, anchor, b.start - 1);
        if (hit >= 0) line = hit + anchor.length;
      }
      insertAfterLine(line, mds);
    });
  }

  // 從外面來的上傳（/file 指令）：正在編輯就放在游標處，否則接在文章最後。
  function insertFiles(files) {
    if (readOnly || !opts.uploadFiles || !files || !files.length) return;
    if (ed) { uploadAtCaret(files); return; }
    upload(files).then(function (mds) { if (mds) insertAfterLine(splitLines(src).length, mds); });
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
    if (t.closest('.blog-col-grip')) return;   // 拉表格欄寬，不是要編輯這個區塊
    if (t.closest('table.tg')) return;         // Obsidian 風格表格：點格、把手都交給 TableGrid
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

  // 點到頁面以外（側邊欄、頂列、別的面板）就結束編輯；自動完成選單、格式工具列不算，
  // 不然按格式鈕的那一下會先把編輯收掉、選取消失。
  function onDocDown(e) {
    if (!ed || !scroller) return;
    const t = e.target;
    if (scroller.contains(t) || (t.closest && t.closest('.ac-popup, .blog-fmt'))) return;
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

  // ---- 選取格式工具列（反白文字後浮出，像 Notion／Medium）----------------------
  // 只掛在 Blog 的編輯框 ta 上。反白一段文字後浮出一排鈕：粗體／斜體／刪除線／行內碼／
  // 連結改的是選取的字，標題／引言／清單／程式碼區塊改的是整行。每個動作都只是改 ta.value
  // 再走 onInput() 回寫原始碼，跟手打語法完全同一條路——所以自動存檔、合併、版本都不用管它。
  let bubble = null;
  const INLINE = [
    { icon: 'bold', title: '粗體', mark: '**' },
    { icon: 'italic', title: '斜體', mark: '*' },
    { icon: 'strikethrough', title: '刪除線', mark: '~~' },
    { icon: 'code', title: '行內程式碼', mark: '`' }
  ];
  const BLOCK = [
    { icon: 'heading-1', title: '標題 1', prefix: '# ' },
    { icon: 'heading-2', title: '標題 2', prefix: '## ' },
    { icon: 'heading-3', title: '標題 3', prefix: '### ' },
    { icon: 'quote', title: '引言', prefix: '> ' },
    { icon: 'list', title: '清單', prefix: '- ' }
  ];

  function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.className = 'blog-fmt';
    bubble.hidden = true;
    function add(spec) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'blog-fmt-btn';
      b.title = spec.title;
      b.innerHTML = (global.Icons && Icons.svg(spec.icon)) || spec.title;
      // 不搶焦點：mousedown 就 preventDefault，textarea 的選取才不會消失
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) { e.preventDefault(); apply(spec); });
      bubble.appendChild(b);
    }
    INLINE.forEach(add);
    add({ icon: 'link', title: '連結', link: true });
    const sep = document.createElement('span');
    sep.className = 'blog-fmt-sep';
    bubble.appendChild(sep);
    BLOCK.forEach(add);
    add({ icon: 'square-code', title: '程式碼區塊', codeblock: true });
    document.body.appendChild(bubble);   // body 子元素一律 fixed（見 CLAUDE.md 的殼層不捲動規則）
    return bubble;
  }

  // 換掉 ta 的一段內容、設定新的選取、回寫原始碼、重新定位工具列。
  function replaceSel(from, to, text, selStart, selEnd) {
    const v = ta.value;
    ta.value = v.slice(0, from) + text + v.slice(to);
    try { ta.focus({ preventScroll: true }); } catch (e) { ta.focus(); }
    ta.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
    onInput();
    positionBubble();
  }

  // 選取的字兩邊包上 mark（粗體 ** 之類）；已經有這個格式就拆掉（切換）。
  // 數兩側緊接的相同記號字元有幾個，判斷這一層在不在：星號要分奇偶（* 斜體是奇數、** 粗體是
  // 至少兩顆），所以「粗體字裡面再按斜體」是 ** → ***（加一層），「粗斜體按斜體」是 *** → **
  // （拆一層），都不會把 ** 誤拆成 *。` 與 ~~ 不會這樣疊，單純看夠不夠一層。
  function wrapInline(mark) {
    const v = ta.value, ch = mark[0], ml = mark.length;
    let s = ta.selectionStart, e = ta.selectionEnd;
    while (e > s && v[s] === ch) s++;          // 選取邊緣連記號一起選到時，先剝到只剩核心文字
    while (e > s && v[e - 1] === ch) e--;
    const core = v.slice(s, e);
    let lb = 0; while (v[s - 1 - lb] === ch) lb++;
    let la = 0; while (v[e + la] === ch) la++;
    const run = Math.min(lb, la);              // 兩側成對、拆得掉的層數
    let present;
    if (ch === '*' && ml === 1) present = run % 2 === 1;
    else if (ch === '*' && ml === 2) present = run >= 2;
    else present = run >= ml;
    const delta = present ? -ml : ml;
    const left = Math.max(0, lb + delta), right = Math.max(0, la + delta);
    const next = v.slice(0, s - lb) + ch.repeat(left) + core + ch.repeat(right) + v.slice(e + la);
    const selStart = (s - lb) + left;
    replaceSel(0, v.length, next, selStart, selStart + core.length);
  }

  function makeLink() {
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = ta.value.slice(s, e) || '文字';
    const text = '[' + sel + '](url)';
    const urlAt = s + 1 + sel.length + 2;   // 把 url 三個字選起來，直接貼網址取代
    replaceSel(s, e, text, urlAt, urlAt + 3);
  }

  // 選取碰到的整行（含只碰一部分的頭尾兩行）。LEAD 抓行首縮排 + 既有的標題／引言／清單記號。
  const LEAD = /^(\s*)(#{1,6}\s|>\s?|(?:[-*+]|\d+[.)])\s)?/;
  function lineRange() {
    const v = ta.value;
    const start = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
    let end = v.indexOf('\n', ta.selectionEnd);
    if (end < 0) end = v.length;
    return { start: start, end: end, block: v.slice(start, end) };
  }
  // 每一行換上 prefix；本來就都是這個 prefix 就拿掉（切換）。換前先剝掉舊的標題／引言／清單記號，
  // 所以「標題 1」點成「標題 2」是替換，不是疊加。
  function togglePrefix(prefix) {
    const r = lineRange();
    const lines = r.block.split('\n');
    const has = lines.every(function (l) { return (l.match(LEAD)[2] || '') === prefix; });
    const next = lines.map(function (l) {
      const m = l.match(LEAD);
      const bare = l.slice(m[0].length);
      return has ? m[1] + bare : m[1] + prefix + bare;
    }).join('\n');
    replaceSel(r.start, r.end, next, r.start, r.start + next.length);
  }
  function toggleCodeBlock() {
    const r = lineRange();
    const lines = r.block.split('\n');
    if (lines.length >= 2 && lines[0].trim().indexOf('```') === 0 && lines[lines.length - 1].trim() === '```') {
      const inner = lines.slice(1, -1).join('\n');
      replaceSel(r.start, r.end, inner, r.start, r.start + inner.length);
    } else {
      const next = '```\n' + r.block + '\n```';
      replaceSel(r.start, r.end, next, r.start, r.start + next.length);
    }
  }

  function apply(spec) {
    if (!ed || readOnly) return;
    if (spec.mark) wrapInline(spec.mark);
    else if (spec.link) makeLink();
    else if (spec.prefix) togglePrefix(spec.prefix);
    else if (spec.codeblock) toggleCodeBlock();
  }

  function positionBubble() {
    if (!bubble || bubble.hidden || !ed || !ta || !Editor || !Editor.caretCoords) return;
    const rect = ta.getBoundingClientRect();
    const a = Editor.caretCoords(ta, ta.selectionStart);
    const z = Editor.caretCoords(ta, ta.selectionEnd);
    const sameLine = Math.abs(z.top - a.top) < 2;   // 同一行就置中在選取正上方，跨行對齊起點
    const cx = sameLine ? rect.left + (a.left + z.left) / 2 : rect.left + a.left;
    const w = bubble.offsetWidth, h = bubble.offsetHeight;
    let left = Math.max(8, Math.min(cx - w / 2, global.innerWidth - w - 8));
    let top = rect.top + a.top - h - 8;
    if (top < 56) top = rect.top + a.top + a.height + 8;   // 上面被頂列擋住就放到選取下方
    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }

  function updateBubble() {
    if (!ed || readOnly || composing || document.activeElement !== ta ||
        ta.selectionStart === ta.selectionEnd || document.querySelector('.ac-popup')) {
      hideBubble();
      return;
    }
    ensureBubble().hidden = false;
    positionBubble();
  }
  function hideBubble() { if (bubble) bubble.hidden = true; }

  // ---- 表格拉欄寬（像 Notion）------------------------------------------------
  // 欄寬存在 note.meta（app.js 的 getTableWidths/onTableWidths），依表格在整份筆記裡的順序
  // 索引。每次排版把存下的欄寬套回每個 <table>（MD.setTableCols 注入 <colgroup>、改成 fixed
  // 版面），再在每個欄邊界放一條可拉的細條。拉的時候即時改 colgroup，放開才寫回 meta。
  function applyTableWidths() {
    if (!root) return;
    const widths = (opts.getTableWidths && opts.getTableWidths()) || null;
    const tables = root.querySelectorAll('table');
    for (let i = 0; i < tables.length; i++) {
      if (widths && widths[i]) MD.setTableCols(tables[i], widths[i]);
      if (!readOnly) attachTableResize(tables[i], i);
      if (!readOnly && global.TableGrid) attachGrid(tables[i], i);
    }
    gridFocus = null;   // 這一輪要打開的格已經套用了，別讓之後不相關的排版又打開
  }

  // ---- Obsidian 風格表格編輯（js/tablegrid.js）------------------------------
  // 只掛在「整塊就是一張表」的區塊（kind === 'table'）上；:::info 之類容器裡的表格不算，
  // 那種當作一般區塊編原始碼。表格用它在整份 <table> 裡的順序 idx 定位（跟欄寬共用），
  // 這個順序在加欄／加列時不變，所以排版後還是同一張表。
  function tableBlockOf(table) {
    const el = table.closest && table.closest('.blog-block[data-i]');
    const b = el ? blocks[Number(el.getAttribute('data-i'))] : null;
    return (b && b.kind === 'table') ? b : null;
  }
  function tableBlockByIdx(idx) {
    const t = root.querySelectorAll('table')[idx];
    return t ? tableBlockOf(t) : null;
  }

  // 把整張表的新 Markdown 寫回原始碼，只動這張表佔的那幾行。rerender 時重排並打開 focus 指的格；
  // 打字（softWrite）不重排，讓就地編輯框留著。
  function writeTable(idx, text, focus, rerender) {
    const b = tableBlockByIdx(idx);
    if (!b) return;
    const ls = splitLines(src);
    const old = b.end - b.start + 1;
    const newLines = text.split('\n');
    Array.prototype.splice.apply(ls, [b.start - 1, old].concat(newLines));
    const next = ls.join('\n');
    if (next !== src) {
      const delta = newLines.length - old;
      if (delta) {   // 不重排時後面區塊的行號要跟著位移（重排會整份重算，多算也無妨）
        for (let k = 0; k < blocks.length; k++) if (blocks[k].start > b.start) { blocks[k].start += delta; blocks[k].end += delta; }
        b.end += delta;
      }
      src = next;
      if (opts.onChange) opts.onChange(src);
    } else if (!rerender) return;
    if (rerender) { gridFocus = focus ? { idx: idx, r: focus.r, c: focus.c, sel: focus.sel } : null; render(); }
  }

  function attachGrid(table, idx) {
    const b = tableBlockOf(table);
    if (!b) return;
    TableGrid.attach(table, {
      readOnly: readOnly,
      source: blockText(b),
      pendingFocus: (gridFocus && gridFocus.idx === idx) ? { r: gridFocus.r, c: gridFocus.c, sel: gridFocus.sel } : null,
      softWrite: function (t) { writeTable(idx, t, null, false); },
      commit: function (t, focus) { writeTable(idx, t, focus, true); }
    });
  }

  // 目前每一欄佔整表寬度的百分比（沒設過欄寬的表格就是照內容量出來的當前比例）。
  function currentPct(table) {
    const cells = table.rows[0].cells;
    const raw = Array.prototype.map.call(cells, function (c) { return c.getBoundingClientRect().width; });
    const sum = raw.reduce(function (a, b) { return a + b; }, 0) || 1;
    return raw.map(function (w) { return 100 * w / sum; });
  }

  function attachTableResize(table, idx) {
    const block = table.closest('.blog-block');
    if (!block || !table.rows[0] || table.rows[0].cells.length < 2) return;
    function relayout() {
      block.querySelectorAll('.blog-col-grip[data-t="' + idx + '"]').forEach(function (g) { g.remove(); });
      const brect = block.getBoundingClientRect();
      const trect = table.getBoundingClientRect();
      const cells = table.rows[0].cells;
      for (let c = 0; c < cells.length - 1; c++) {
        const cr = cells[c].getBoundingClientRect();
        const grip = document.createElement('div');
        grip.className = 'blog-col-grip';
        grip.setAttribute('data-t', idx);
        grip.style.left = Math.round(cr.right - brect.left) + 'px';
        grip.style.top = Math.round(trect.top - brect.top) + 'px';
        grip.style.height = Math.round(trect.height) + 'px';
        (function (col) {
          grip.addEventListener('mousedown', function (e) { startColDrag(e, table, idx, col, relayout); });
        })(c);
        block.appendChild(grip);
      }
    }
    table._gripLayout = relayout;
    relayout();
  }

  function startColDrag(e, table, idx, col, relayout) {
    e.preventDefault();
    e.stopPropagation();   // 不要進入這個區塊的編輯
    const total = table.getBoundingClientRect().width || 1;
    const pct = currentPct(table);
    const startX = e.clientX;
    const origL = pct[col], pair = pct[col] + pct[col + 1];
    const MIN = 6;   // 每一欄至少留 6%，兩欄之間拉的差額由右邊那欄吸收，整表寬度不變
    document.body.classList.add('col-resizing');
    function move(ev) {
      const dx = 100 * (ev.clientX - startX) / total;
      const l = Math.max(MIN, Math.min(pair - MIN, origL + dx));
      pct[col] = l;
      pct[col + 1] = pair - l;
      MD.setTableCols(table, pct);
      relayout();
    }
    function up() {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('col-resizing');
      if (opts.onTableWidths) opts.onTableWidths(idx, pct.map(function (x) { return Math.round(x * 10) / 10; }));
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
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
    // 反白文字後浮出格式工具列（updateBubble）。selectionchange 涵蓋鍵盤選取；mouseup 涵蓋
    // 滑鼠拖選放開的那一刻（拖選過程中 selectionchange 也會連續觸發，位置跟著更新）。
    ta.addEventListener('mouseup', function () { setTimeout(updateBubble, 0); });
    document.addEventListener('selectionchange', function () { if (document.activeElement === ta) updateBubble(); });
    root.addEventListener('click', onClick);
    scroller.addEventListener('click', onScrollerClick);
    scroller.addEventListener('scroll', function () { if (bubble && !bubble.hidden) positionBubble(); });
    scroller.addEventListener('dragover', onDragOver);
    scroller.addEventListener('dragleave', onDragLeave);
    scroller.addEventListener('drop', onDrop);
    document.addEventListener('mousedown', onDocDown, true);
    // PDF「檔案｜預覽」、連結「連結｜預覽卡片」的切換鈕（js/embedswitch.js）。正在編輯的區塊是
    // textarea，不會出現；改寫走 update()，開在別的區塊的編輯框原地保留。
    if (global.EmbedSwitch) EmbedSwitch.attach(root, {
      rangeOf: function (el) {
        const b = el.closest('.blog-block[data-i]');
        if (!b || b.classList.contains('editing')) return null;
        const blk = blocks[Number(b.getAttribute('data-i'))];
        return blk ? { start: blk.start, end: blk.end } : null;
      },
      getText: function () { return src; },
      setText: function (t) { update(t); if (opts.onChange) opts.onChange(src); },
      canEdit: function () { return !readOnly; },
      onPdfPref: function (v) { if (opts.onPdfPref) opts.onPdfPref(v); }
    });
    global.addEventListener('resize', function () {
      if (ed) autosize();
      // 視窗變寬變窄，欄邊界的位置也變了，把每個表格的拉條重新擺一次
      if (root) root.querySelectorAll('table').forEach(function (t) { if (t._gripLayout) t._gripLayout(); if (t.__tgLayout) t.__tgLayout(); });
    });
  }

  // 打開一篇筆記（或切進這個模式）：丟掉之前的編輯狀態，整份重新排版。
  function show(text, ro) {
    detach();
    readOnly = !!ro;
    src = String(text || '');
    render();
    // 一開筆記／切進 Blog 就直接進入編輯，不用先點一下（跟分割編輯器一開就 editorEl.focus()
    // 一致）：有內容就把游標放到第一個區塊的最前面，空白筆記就開一個空區塊。唯讀筆記（別人
    // 分享的）維持純閱讀，不進編輯。
    if (readOnly) return;
    // 第一個區塊是表格就不自動進區塊編輯——表格改用 Obsidian 風格（點格才編），
    // 自動打開會變成整張表的原始碼框，不是我們要的。
    if (blocks.length && blocks[0].kind !== 'table') startEdit(0, 'start');
    else if (!blocks.length) startNew(-1);
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
    insertFiles: insertFiles,
    isEditing: function () { return !!ed; }
  };
})(window);

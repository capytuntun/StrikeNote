/* multicursor.js — HackMD 式的多行編輯（多游標／直欄選取）給原生 textarea 的編輯器。
 *
 *   Alt + 拖曳       直欄（矩形）選取：拖過的每一行各一個游標
 *   Alt + 點一下     在那裡加一個游標（點已經有游標的地方就拿掉）
 *   Ctrl+Alt+↑/↓    在上／下一行加一個游標
 *   Ctrl+D           選起下一個一樣的字（連按就一個一個往下加）
 *   Esc／一般點一下   回到單一游標
 *
 * 瀏覽器的 textarea 只有一個選取，所以「主游標」仍然是原生的那一個（連閃爍、捲動跟隨都是
 * 瀏覽器在做），其餘游標是自己量位置畫上去的（Editor.caretCoords + 編輯區的疊層）。打字、
 * 刪除、貼上時，同一個編輯由前往後依序套用到每一個位置——每一步都走
 * document.execCommand，所以瀏覽器原生的復原（Ctrl+Z）不會壞掉，autosave／預覽／語法上色
 * 也照常收到 input 事件，不需要為多游標另外開一條寫入路徑。
 *
 * 位置全部用「值裡的位移」表示；外面（例如協作合併）換掉整份內容時呼叫 remap()，
 * 用跟游標同一套 Merge.mapOffset 把每個游標移到新文字上對應的位置。
 */
(function (global) {
  'use strict';

  const INDENT = '    ';   // 跟 editor.js 的一個縮排層級一樣

  function lineStartOf(v, pos) { return v.lastIndexOf('\n', pos - 1) + 1; }
  function lineEndOf(v, pos) { const i = v.indexOf('\n', pos); return i < 0 ? v.length : i; }
  function lineNoOf(v, pos) { let n = 0; for (let i = v.indexOf('\n'); i >= 0 && i < pos; i = v.indexOf('\n', i + 1)) n++; return n; }
  function lineOffsets(v) {
    const out = [0];
    for (let i = v.indexOf('\n'); i >= 0; i = v.indexOf('\n', i + 1)) out.push(i + 1);
    return out;
  }
  function wordAt(v, pos) {
    // 一個「字」：英數底線、中日文（CJK 與假名的區間）、連字號
    const isWord = function (c) { return c && /[\w一-鿿぀-ヿ-]/.test(c); };
    let s = pos, e = pos;
    while (s > 0 && isWord(v[s - 1])) s--;
    while (e < v.length && isWord(v[e])) e++;
    return s === e ? null : { s: s, e: e };
  }

  function attach(ta, opts) {
    opts = opts || {};
    const area = (ta.closest && ta.closest('.editor-area')) || ta.parentNode;
    let layer = null;
    let extras = [];          // 額外的選取 [{s, e}]（不含 textarea 自己的那一個）
    let altDrag = null;       // Alt 拖曳中：{ sel } 按下去之前的選取
    let composing = null;     // 輸入法組字中：{ extras, primary }
    let applying = false;     // 自己正在寫入（execCommand 會再觸發 beforeinput，不能又被自己接走）

    // ---- 狀態 ----------------------------------------------------------------
    function norm(x) { return x.s <= x.e ? { s: x.s, e: x.e } : { s: x.e, e: x.s }; }
    function primary() { return { s: ta.selectionStart, e: ta.selectionEnd }; }
    function all() {          // 主要的＋額外的，依位置排序，記下哪一個是主要的
      const list = extras.map(function (x) { return { s: x.s, e: x.e, main: false }; });
      const p = primary();
      list.push({ s: p.s, e: p.e, main: true });
      list.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
      // 位置一樣的只留一個（主要的優先）
      const out = [];
      list.forEach(function (x) {
        const prev = out[out.length - 1];
        if (prev && prev.s === x.s && prev.e === x.e) { prev.main = prev.main || x.main; return; }
        out.push(x);
      });
      return out;
    }
    function setAll(list) {   // list: [{s, e, main}]
      const main = list.filter(function (x) { return x.main; })[0] || list[list.length - 1];
      extras = list.filter(function (x) { return x !== main; }).map(norm);
      ta.setSelectionRange(main.s, main.e);
      render();
      notify();
    }
    function clear(silent) {
      if (!extras.length) return;
      extras = [];
      render();
      if (!silent) notify();
    }
    function notify() { if (opts.onChange) opts.onChange(extras.length ? extras.length + 1 : 0); }

    // ---- 畫出額外的游標與選取 --------------------------------------------------
    function ensureLayer() {
      if (layer && layer.isConnected) return layer;
      layer = document.createElement('div');
      layer.className = 'mc-layer';
      layer.setAttribute('aria-hidden', 'true');
      area.appendChild(layer);
      return layer;
    }
    function coordsAt(pos) {
      if (!global.Editor || !Editor.caretCoords) return null;
      const c = Editor.caretCoords(ta, pos);
      return { left: c.left, top: c.top - ta.scrollTop, height: c.height };
    }
    function box(cls, left, top, width, height) {
      const d = document.createElement('div');
      d.className = cls;
      d.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
      if (width != null) d.style.width = Math.max(1, Math.round(width)) + 'px';
      d.style.height = Math.round(height) + 'px';
      return d;
    }
    function render() {
      if (!extras.length) { if (layer) layer.innerHTML = ''; return; }
      const el = ensureLayer();
      el.innerHTML = '';
      const v = ta.value, h = ta.clientHeight;
      extras.forEach(function (sel) {
        if (sel.s !== sel.e) {
          // 一行一個方塊（跨行的選取就切成好幾段）
          let from = sel.s;
          while (from < sel.e) {
            const to = Math.min(sel.e, lineEndOf(v, from));
            const a = coordsAt(from), b = coordsAt(to);
            if (a && b) {
              if (a.top === b.top) el.appendChild(box('mc-sel', a.left, a.top, b.left - a.left, a.height));
              else el.appendChild(box('mc-sel', a.left, a.top, ta.clientWidth - a.left - 24, a.height));   // 換行了：畫到行尾
            }
            from = to + 1;
          }
        }
        const c = coordsAt(sel.e);
        if (c && c.top > -c.height && c.top < h) el.appendChild(box('mc-caret', c.left, c.top, null, c.height));
      });
    }

    // ---- 編輯：同一件事套用到每一個游標 ------------------------------------------
    // 由前往後做，每做完一個就把後面的位移補上（前面的不受影響）。每一步都是
    // execCommand，原生復原因此照常運作。
    function applyAll(fn) {
      const list = all();
      if (list.length < 2) return false;
      const out = [];
      let shift = 0;
      applying = true;
      ta.focus();
      for (let i = 0; i < list.length; i++) {
        const sel = list[i];
        const s = sel.s + shift, e = sel.e + shift;
        const v = ta.value;
        const op = fn({ s: s, e: e, v: v, index: i }) || {};
        const from = op.from == null ? s : op.from + shift;
        const to = op.to == null ? e : op.to + shift;
        const text = op.text == null ? '' : op.text;
        ta.setSelectionRange(from, to);
        if (from !== to) document.execCommand('delete');
        if (text) document.execCommand('insertText', false, text);
        const pos = from + text.length;
        out.push({ s: pos, e: pos, main: sel.main });
        shift += text.length - (to - from);
      }
      applying = false;
      setAll(out);
      return true;
    }
    function insertAtAll(text, perCursor) {
      return applyAll(function (c) { return { text: perCursor ? perCursor(c.index) : text }; });
    }
    function deleteAll(forward) {
      return applyAll(function (c) {
        if (c.s !== c.e) return { text: '' };
        if (forward) return { from: c.s, to: Math.min(c.v.length, c.s + 1), text: '' };
        return { from: Math.max(0, c.s - 1), to: c.s, text: '' };
      });
    }

    // ---- 移動 ----------------------------------------------------------------
    function moveAll(fn, extend) {
      const list = all().map(function (sel) {
        const p = fn(sel);
        return { s: extend ? sel.s : p, e: p, main: sel.main };
      });
      setAll(list.map(function (x) { return { s: Math.min(x.s, x.e), e: Math.max(x.s, x.e), main: x.main }; }));
    }
    function verticalPos(v, pos, dir) {
      const ls = lineStartOf(v, pos), col = pos - ls;
      if (dir < 0) {
        if (ls === 0) return pos;
        const prevStart = lineStartOf(v, ls - 1);
        return Math.min(prevStart + col, ls - 1);
      }
      const le = lineEndOf(v, pos);
      if (le >= v.length) return pos;
      const nextStart = le + 1;
      return Math.min(nextStart + col, lineEndOf(v, nextStart));
    }

    // ---- 加游標 ---------------------------------------------------------------
    function addCursorVertically(dir) {
      const v = ta.value;
      const list = all();
      const edge = dir < 0 ? list[0] : list[list.length - 1];
      const pos = verticalPos(v, edge.e, dir);
      if (pos === edge.e) return;
      // 新加的那個變成主要的（跟 Sublime／HackMD 一樣，畫面跟著它走）
      const rest = list.map(function (x) { return { s: x.s, e: x.e, main: false }; });
      rest.push({ s: pos, e: pos, main: true });
      setAll(rest);
    }
    function selectNextOccurrence() {
      const v = ta.value;
      let p = primary();
      if (p.s === p.e) {                       // 還沒選字：先選游標所在的那個字
        const w = wordAt(v, p.s);
        if (!w) return;
        extras = [];
        ta.setSelectionRange(w.s, w.e);
        render(); notify();
        return;
      }
      const needle = v.slice(p.s, p.e);
      if (!needle) return;
      const taken = all().map(function (x) { return x.s + ':' + x.e; });
      let from = Math.max.apply(null, all().map(function (x) { return x.e; }));
      let at = v.indexOf(needle, from);
      if (at < 0) at = v.indexOf(needle);                       // 繞回開頭
      while (at >= 0 && taken.indexOf(at + ':' + (at + needle.length)) >= 0) {
        at = v.indexOf(needle, at + 1);
      }
      if (at < 0) return;
      const list = all().map(function (x) { return { s: x.s, e: x.e, main: false }; });
      list.push({ s: at, e: at + needle.length, main: true });
      setAll(list);
    }
    // Alt + 拖曳放開：把「從按下到放開」的線性選取改成矩形——每一行一個選取
    function columnFrom(anchor, head) {
      const v = ta.value, offs = lineOffsets(v);
      const la = lineNoOf(v, anchor), lh = lineNoOf(v, head);
      const ca = anchor - offs[la], ch = head - offs[lh];
      const c1 = Math.min(ca, ch), c2 = Math.max(ca, ch);
      const from = Math.min(la, lh), to = Math.max(la, lh);
      const list = [];
      for (let n = from; n <= to; n++) {
        const ls = offs[n], le = lineEndOf(v, ls);
        const s = Math.min(ls + c1, le), e = Math.min(ls + c2, le);
        list.push({ s: s, e: e, main: n === lh });
      }
      return list;
    }

    // ---- 事件 ----------------------------------------------------------------
    function onKeyDown(e) {
      if (e.target !== ta || e.isComposing || e.keyCode === 229) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      if (mod && e.altKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
        e.preventDefault(); e.stopPropagation();
        addCursorVertically(key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && (key === 'd' || key === 'D')) {
        e.preventDefault(); e.stopPropagation();
        selectNextOccurrence();
        return;
      }
      if (!extras.length) return;

      if (key === 'Escape') { e.preventDefault(); e.stopPropagation(); clear(); return; }
      // 復原／重做、全選：位置會整個對不上，先回到單一游標再交給瀏覽器
      if (mod && (key === 'z' || key === 'Z' || key === 'y' || key === 'Y' || key === 'a' || key === 'A')) { clear(); return; }
      if (mod) return;                                  // 其他 Ctrl 組合維持原本行為（只作用在主游標）

      const v = ta.value;
      if (key === 'Enter') { e.preventDefault(); e.stopPropagation(); insertAtAll('\n'); return; }
      if (key === 'Tab') { e.preventDefault(); e.stopPropagation(); insertAtAll(INDENT); return; }
      if (key === 'Backspace') { e.preventDefault(); e.stopPropagation(); deleteAll(false); return; }
      if (key === 'Delete') { e.preventDefault(); e.stopPropagation(); deleteAll(true); return; }
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault(); e.stopPropagation();
        const d = key === 'ArrowRight' ? 1 : -1;
        moveAll(function (sel) {
          if (sel.s !== sel.e && !e.shiftKey) return d > 0 ? sel.e : sel.s;
          return Math.max(0, Math.min(v.length, sel.e + d));
        }, e.shiftKey);
        return;
      }
      if (key === 'ArrowUp' || key === 'ArrowDown') {
        e.preventDefault(); e.stopPropagation();
        moveAll(function (sel) { return verticalPos(v, sel.e, key === 'ArrowDown' ? 1 : -1); }, e.shiftKey);
        return;
      }
      if (key === 'Home' || key === 'End') {
        e.preventDefault(); e.stopPropagation();
        moveAll(function (sel) { return key === 'Home' ? lineStartOf(v, sel.e) : lineEndOf(v, sel.e); }, e.shiftKey);
        return;
      }
      if (key.length === 1 && !e.altKey) {               // 一般打字
        e.preventDefault(); e.stopPropagation();
        insertAtAll(key);
        return;
      }
    }

    // keydown 只攔得到真人按鍵。beforeinput 是所有輸入（含程式插入、拖進來的文字、
    // 死鍵）共同的入口，所以真正的寫入攔在這裡；按鍵那邊已經 preventDefault 的就不會再進來。
    function onBeforeInput(e) {
      if (applying || !extras.length) return;
      const t = e.inputType;
      if (t === 'insertText' && e.data != null) { e.preventDefault(); e.stopPropagation(); insertAtAll(e.data); return; }
      if (t === 'insertLineBreak' || t === 'insertParagraph') { e.preventDefault(); e.stopPropagation(); insertAtAll('\n'); return; }
      if (t === 'deleteContentBackward') { e.preventDefault(); e.stopPropagation(); deleteAll(false); return; }
      if (t === 'deleteContentForward') { e.preventDefault(); e.stopPropagation(); deleteAll(true); return; }
      if (t === 'historyUndo' || t === 'historyRedo') { clear(); return; }   // 位置會對不上，先收掉
    }

    // 輸入法：組字中只有主游標會收到字，組完再補到其他游標上
    function onCompositionStart() { if (extras.length) composing = { extras: extras.slice(), primary: primary() }; }
    function onCompositionEnd(e) {
      const c = composing; composing = null;
      if (!c || !e.data) return;
      const text = e.data, at = c.primary.s;
      // 主游標那邊瀏覽器已經插好了；其他游標依序補上（在主游標之後的要加上位移）
      const list = c.extras.map(function (x) {
        const d = x.s > at ? text.length : 0;
        return { s: x.s + d, e: x.e + d, main: false };
      });
      extras = list.map(norm);
      let shift = 0;
      const out = [];
      const p = primary();
      const merged = extras.map(function (x) { return { s: x.s, e: x.e, main: false }; }).concat([{ s: p.s, e: p.e, main: true }])
        .sort(function (a, b) { return a.s - b.s; });
      ta.focus();
      merged.forEach(function (sel) {
        const s = sel.s + shift, en = sel.e + shift;
        if (sel.main) { out.push({ s: s, e: en, main: true }); return; }   // 已經有字了
        ta.setSelectionRange(s, en);
        if (s !== en) document.execCommand('delete');
        document.execCommand('insertText', false, text);
        out.push({ s: s + text.length, e: s + text.length, main: false });
        shift += text.length - (en - s);
      });
      setAll(out);
    }

    function onPaste(e) {
      if (!extras.length) return;
      const text = (e.clipboardData || global.clipboardData).getData('text');
      if (text == null) return;
      e.preventDefault(); e.stopPropagation();
      const lines = text.split(/\r?\n/);
      const n = all().length;
      // 行數剛好跟游標數一樣：一個游標貼一行（跟 CodeMirror／Sublime 一樣）
      if (lines.length === n && n > 1) insertAtAll(null, function (i) { return lines[i]; });
      else insertAtAll(text);
    }
    function onCopyCut(e) {
      if (!extras.length) return;
      const v = ta.value;
      const parts = all().map(function (sel) { return v.slice(sel.s, sel.e); });
      if (parts.every(function (p) { return p === ''; })) return;
      e.preventDefault(); e.stopPropagation();
      e.clipboardData.setData('text/plain', parts.join('\n'));
      if (e.type === 'cut') applyAll(function () { return { text: '' }; });
    }

    function onMouseDown(e) {
      if (e.button !== 0) return;
      if (e.altKey) { altDrag = { sel: primary() }; return; }   // 交給瀏覽器去選，放開再換算
      clear();                                                  // 一般點一下：回到單一游標
    }
    // 放開的時候滑鼠常常已經拖出編輯器外（拖到邊緣、自動捲動），所以這個掛在整份文件上：
    // 掛在 textarea 上的話那一次拖曳就不會變成直欄選取，而是留著一般的整段選取——接著打字
    // 會把中間那幾行整個換掉。
    function onMouseUp(e) {
      const drag = altDrag;
      altDrag = null;
      if (!drag) return;
      if (!e.altKey && ta.selectionStart === ta.selectionEnd) return;   // Alt 中途放開又只是點一下：當一般點擊
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      if (s === en) {
        // 點一下：這裡加一個游標（原本那個留著）；點在已經有游標的地方就拿掉
        const hit = extras.filter(function (x) { return x.s === x.e && x.s === s; });
        if (hit.length) { extras = extras.filter(function (x) { return hit.indexOf(x) < 0; }); render(); notify(); return; }
        const list = all().map(function (x) { return { s: x.s, e: x.e, main: false }; });
        if (drag.sel.s !== s || drag.sel.e !== s) list.push({ s: drag.sel.s, e: drag.sel.e, main: false });
        list.push({ s: s, e: s, main: true });
        setAll(list);
        return;
      }
      const backward = ta.selectionDirection === 'backward';
      setAll(columnFrom(backward ? en : s, backward ? s : en));
    }

    function onScrollOrResize() { if (extras.length) render(); }
    function onInput() { if (extras.length) render(); }
    function onBlur() { render(); }

    document.addEventListener('keydown', onKeyDown, true);
    ta.addEventListener('beforeinput', onBeforeInput, true);
    ta.addEventListener('paste', onPaste, true);
    ta.addEventListener('copy', onCopyCut, true);
    ta.addEventListener('cut', onCopyCut, true);
    ta.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp, true);
    ta.addEventListener('dragstart', function (e) { if (altDrag) e.preventDefault(); });
    ta.addEventListener('compositionstart', onCompositionStart);
    ta.addEventListener('compositionend', onCompositionEnd);
    ta.addEventListener('scroll', onScrollOrResize);
    ta.addEventListener('input', onInput);
    ta.addEventListener('blur', onBlur);
    global.addEventListener('resize', onScrollOrResize);

    return {
      clear: function () { clear(); },
      count: function () { return extras.length ? extras.length + 1 : 0; },
      // 內容被整份換掉（協作合併、切換筆記）：游標跟著搬到新文字上對應的位置
      remap: function (oldText, newText) {
        if (!extras.length) return;
        if (!global.Merge || !Merge.mapOffset) { clear(); return; }
        extras = extras.map(function (x) {
          return { s: Merge.mapOffset(oldText, newText, x.s), e: Merge.mapOffset(oldText, newText, x.e) };
        });
        render();
      }
    };
  }

  global.MultiCursor = { attach: attach };
})(window);

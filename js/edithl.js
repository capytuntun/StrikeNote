/* edithl.js — syntax-highlight overlay + line-number gutter for the markdown textarea */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function inlineHl(line) {
    let s = escapeHtml(line);
    s = s.replace(/^(\s*)([-*+]|\d+[.)])(\s)/, function (m, a, b, c) {
      return a + '<span class="e-mark">' + b + '</span>' + c;
    });
    s = s.replace(/`[^`]+`/g, function (m) { return '<span class="e-icode">' + m + '</span>'; });
    s = s.replace(/\*\*[^*]+\*\*/g, function (m) { return '<span class="e-bold">' + m + '</span>'; });
    // #標籤（需有前置邊界；至少含一個字母，排除純數字）
    s = s.replace(
      /(^|[\s(\[（【「'"])(#[0-9A-Za-z_/À-ɏ一-鿿぀-ヿ-]*[A-Za-z_À-ɏ一-鿿぀-ヿ][0-9A-Za-z_/À-ɏ一-鿿぀-ヿ-]*)/g,
      function (m, pre, tag) { return pre + '<span class="e-tag">' + tag + '</span>'; }
    );
    return s;
  }

  function highlightLines(value) {
    const lines = value.split('\n');
    let inFence = false;
    return lines.map(function (line) {
      // A blank line inside a fence used to come out as <span class="e-code"></span>:
      // no text, so no line box, so the row collapsed to the gutter's height (28px)
      // instead of the 31.5px the textarea gives that same line — 3.5px of drift for
      // every blank line in every code block, accumulating down the note until the
      // caret and the highlighted row visibly disagree. The zero-width space keeps a
      // line box without painting anything. (build()'s `|| '​'` only covered
      // lines whose whole HTML was empty, not an empty span.)
      if (!line.trim()) return escapeHtml(line) + '​';
      if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return '<span class="e-code">' + escapeHtml(line) + '</span>'; }
      if (inFence) return '<span class="e-code">' + escapeHtml(line) + '</span>';
      if (/^\s{0,3}#{1,6}\s/.test(line)) return '<span class="e-head">' + escapeHtml(line) + '</span>';
      if (/^\s{0,3}\[toc\]\s*$/i.test(line)) return '<span class="e-toc">' + escapeHtml(line) + '</span>';
      if (/^\s{0,3}:::/.test(line)) return '<span class="e-container">' + escapeHtml(line) + '</span>';
      if (/^\s{0,3}>/.test(line)) return '<span class="e-quote">' + escapeHtml(line) + '</span>';
      if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return '<span class="e-hr">' + escapeHtml(line) + '</span>';
      return inlineHl(line);
    });
  }

  function attach(ta, backdrop) {
    let lines = backdrop.querySelector('.cm-lines');
    if (!lines) { lines = document.createElement('div'); lines.className = 'cm-lines'; backdrop.appendChild(lines); }

    // ta's own scrollbar, measured live off the real element — the same technique
    // app.js's caret-mirror uses for this textarea (syncMirrorStyle). A generic
    // throwaway <div>'s scrollbar can be a pixel narrower/wider than the textarea's
    // actual one (subpixel/DPI/overlay-scrollbar differences) or simply wrong when
    // the note is short enough that ta has no scrollbar at all yet. One line that
    // wraps differently because of that pixel throws every row below it out of
    // alignment with the real caret — invisible near the top of a note, a full
    // line of drift by a few hundred lines down. Recomputed on every render so it
    // tracks the scrollbar actually appearing/disappearing as content changes.
    function syncScrollbarWidth() {
      backdrop.style.setProperty('--sbw', (ta.offsetWidth - ta.clientWidth) + 'px');
    }

    function build() {
      syncScrollbarWidth();
      const arr = highlightLines(ta.value);
      let out = '';
      for (let i = 0; i < arr.length; i++) {
        out += '<div class="cm-row"><span class="cm-gutter">' + (i + 1) + '</span><span class="cm-text">' +
          (arr[i] || '​') + '</span></div>';
      }
      lines.innerHTML = out;
    }
    function sync() { lines.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)'; }
    function render() { build(); sync(); updateActive(); }

    function updateActive() {
      const caret = ta.selectionStart;
      const ln = (ta.value.slice(0, caret).match(/\n/g) || []).length;
      const rows = lines.children;
      for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('active', i === ln);
    }

    ta.addEventListener('input', render);
    ta.addEventListener('scroll', sync);
    ta.addEventListener('keyup', updateActive);
    ta.addEventListener('click', updateActive);
    document.addEventListener('selectionchange', function () { if (document.activeElement === ta) updateActive(); });
    // Dragging the split-pane divider or resizing the window changes ta's width —
    // and therefore where long lines wrap — without firing 'input'.
    if (window.ResizeObserver) new ResizeObserver(render).observe(ta);

    ta._hlRefresh = render;
    render();
  }

  global.EditorHL = { attach: attach };
})(window);

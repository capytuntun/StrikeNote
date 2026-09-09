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

  function scrollbarWidth() {
    const d = document.createElement('div');
    d.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll';
    document.body.appendChild(d);
    const w = d.offsetWidth - d.clientWidth;
    d.remove();
    return w;
  }

  function attach(ta, backdrop) {
    let lines = backdrop.querySelector('.cm-lines');
    if (!lines) { lines = document.createElement('div'); lines.className = 'cm-lines'; backdrop.appendChild(lines); }

    const sbw = scrollbarWidth();
    backdrop.style.setProperty('--sbw', sbw + 'px');

    function build() {
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

    ta._hlRefresh = render;
    render();
  }

  global.EditorHL = { attach: attach };
})(window);

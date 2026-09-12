/* linesync.js — click a line in the MD editor and the matching text in the
 * preview gets underlined, or the other way round: click text in the preview
 * and its source line underlines in the editor.
 *
 * This is deliberately a companion pass that runs AFTER markdown.js has
 * already produced and sanitized the preview HTML — it never changes
 * markdown.js, MD.render(), or any renderer/extension, so it cannot affect
 * PDF export, the published e-book, or search, none of which call it. It
 * works by:
 *   1. Scanning the raw source text into an ordered list of blocks (heading,
 *      paragraph, list, table, code fence, quote/callout/container/RISK
 *      finding, hr) with a start/end source-line range each — a plain regex
 *      scan, independent of marked's own tokenizer.
 *   2. Querying the ALREADY-RENDERED preview DOM for the matching element
 *      types, in document order, and pairing them 1:1 with the scanned
 *      blocks by position (heading #3 in the source pairs with the 3rd
 *      <h1..h6> in the preview, and so on) — the same "same type, same
 *      order" idea app.js already uses for the editor/preview scroll anchors
 *      (see editorBlocks()/previewBlocks() in app.js).
 *   3. For paragraphs, list items and line-numbered code, splitting the
 *      block's own rendered HTML at each <br> (breaks:true turns every
 *      source newline into one) into one <span data-line0 data-line1> per
 *      source line, so a 5-line paragraph highlights exactly the line you
 *      clicked rather than the whole paragraph.
 *   4. For blockquote/callout/RISK-finding, un-numbered code, and mindmap
 *      blocks, tagging the WHOLE block with one range instead — a `>` or
 *      `:::` block isn't addressable line-by-line the way plain text is, so
 *      clicking any line inside one highlights/underlines the whole thing.
 *
 * Every element gets `data-line0`/`data-line1` set directly (coarse
 * containers AND, where refined, the inner per-line spans within them), so
 * a preview click is always just `e.target.closest('[data-line0]')` — the
 * closest one is naturally the most specific match.
 *
 * The editor side has no per-line DOM of its own to attach attributes to —
 * but edithl.js already renders one `.cm-row` per source line (index i =
 * line i+1) for syntax highlighting, kept in step with the textarea. This
 * module reuses those same rows purely as a paint target for the underline,
 * without touching edithl.js.
 */
(function (global) {
  'use strict';

  // ---- 1) scan the raw source into ordered blocks ------------------------
  function isBlank(s) { return !s || !s.trim(); }
  const RE_FENCE = /^ {0,3}(`{3,}|~{3,})/;
  const RE_CONTAINER = /^ {0,3}:::/;
  const RE_QUOTE = /^ {0,3}>/;
  const RE_HEADING = /^ {0,3}#{1,6}\s/;
  const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
  const RE_LIST = /^( {0,3})([-*+]|\d{1,9}[.)])\s/;
  const RE_TABLE_ROW = /^ {0,3}\|/;
  const RE_TABLE_SEP = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function sourceBlocks(text) {
    const lines = String(text || '').split('\n');
    const n = lines.length;
    const blocks = [];
    let i = 0;
    while (i < n) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }

      const fence = RE_FENCE.exec(line);
      if (fence) {
        const marker = fence[1].charAt(0) === '`' ? '`' : '~';
        const minLen = fence[1].length;
        const closeRe = new RegExp('^ {0,3}' + marker + '{' + minLen + ',}\\s*$');
        const start = i + 1;
        i++;
        while (i < n && !closeRe.test(lines[i])) i++;
        if (i < n) i++; // consume the closing fence line
        blocks.push({ kind: 'code', start: start, end: i });
        continue;
      }
      if (RE_CONTAINER.test(line)) {
        const start = i + 1;
        i++;
        while (i < n && lines[i].trim() !== ':::') i++;
        if (i < n) i++;
        blocks.push({ kind: 'quote', start: start, end: i });
        continue;
      }
      if (RE_QUOTE.test(line)) {
        const start = i + 1;
        while (i < n && RE_QUOTE.test(lines[i])) i++;
        blocks.push({ kind: 'quote', start: start, end: i });
        continue;
      }
      if (RE_HEADING.test(line)) { blocks.push({ kind: 'heading', start: i + 1, end: i + 1 }); i++; continue; }
      if (RE_HR.test(line) && !RE_LIST.test(line)) { blocks.push({ kind: 'hr', start: i + 1, end: i + 1 }); i++; continue; }
      if (RE_TABLE_ROW.test(line) && i + 1 < n && RE_TABLE_SEP.test(lines[i + 1])) {
        const start = i + 1;
        i += 2; // header + separator (separator has no own row in the render)
        let rows = 0;
        while (i < n && RE_TABLE_ROW.test(lines[i])) { rows++; i++; }
        blocks.push({ kind: 'table', start: start, end: start + 1 + rows });
        continue;
      }
      const listM = RE_LIST.exec(line);
      if (listM) {
        const indent = listM[1].length;
        const blockStart = i;
        const items = [];
        let itemStart = i;
        i++;
        while (i < n) {
          if (isBlank(lines[i])) {
            let j = i;
            while (j < n && isBlank(lines[j])) j++;
            if (j >= n) { i = j; break; }
            const nm = RE_LIST.exec(lines[j]);
            const contIndent = (lines[j].match(/^\s*/) || [''])[0].length;
            if (nm && nm[1].length === indent) { items.push({ start: itemStart + 1, end: i }); itemStart = j; i = j; continue; }
            if (contIndent > indent) { i = j; continue; }
            items.push({ start: itemStart + 1, end: i }); i = j; break;
          }
          const nm = RE_LIST.exec(lines[i]);
          if (nm && nm[1].length === indent) { items.push({ start: itemStart + 1, end: i }); itemStart = i; i++; continue; }
          const contIndent = (lines[i].match(/^\s*/) || [''])[0].length;
          if (nm || contIndent > indent) { i++; continue; } // wrapped continuation, or a nested (deeper) list/para
          break;
        }
        items.push({ start: itemStart + 1, end: i });
        blocks.push({ kind: 'list', start: blockStart + 1, end: i, items: items });
        continue;
      }
      // plain paragraph: consecutive lines that don't open anything above
      const pStart = i;
      while (i < n && !isBlank(lines[i]) && !RE_FENCE.test(lines[i]) && !RE_CONTAINER.test(lines[i]) &&
        !RE_QUOTE.test(lines[i]) && !RE_HEADING.test(lines[i]) && !RE_TABLE_ROW.test(lines[i]) && !RE_LIST.test(lines[i])) i++;
      blocks.push({ kind: 'para', start: pStart + 1, end: i });
    }
    return blocks;
  }

  // ---- 2) split a block's OWN rendered HTML at <br> into per-line spans -
  // Void elements (img, input — inline images, task checkboxes) are emitted
  // but never pushed onto the open-tag stack, since they have no closing tag
  // and would otherwise "leak" into every following line.
  const VOID_TAGS = { img: 1, input: 1, br: 1, hr: 1, area: 1, base: 1, col: 1, embed: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };

  function splitByBr(html) {
    const openTags = [];
    const lines = [];
    let cur = '';
    const re = /<br\s*\/?>|<([a-zA-Z][\w-]*)\b[^>]*>|<\/([a-zA-Z][\w-]*)>|[^<]+/g;
    let m;
    while ((m = re.exec(html))) {
      const tok = m[0];
      if (/^<br/i.test(tok)) {
        for (let j = openTags.length - 1; j >= 0; j--) cur += '</' + openTags[j].name + '>';
        lines.push(cur);
        cur = '';
        for (let j = 0; j < openTags.length; j++) cur += openTags[j].open;
      } else if (m[1]) {
        cur += tok;
        if (!VOID_TAGS[m[1].toLowerCase()]) openTags.push({ name: m[1], open: tok });
      } else if (m[2]) {
        cur += tok;
        openTags.pop();
      } else {
        cur += tok;
      }
    }
    lines.push(cur);
    return lines;
  }

  // Nested block-level content inside a top-level <li> (a sub-list) is left
  // completely untouched — split only the li's OWN text, up to that point.
  const NESTED_BLOCK_RE = /<(ul|ol|blockquote|pre|table)[ >]/;

  function wrapOwnLines(el, startLine) {
    const html = el.innerHTML;
    const cut = NESTED_BLOCK_RE.exec(html);
    const ownHtml = cut ? html.slice(0, cut.index) : html;
    const restHtml = cut ? html.slice(cut.index) : '';
    const lines = splitByBr(ownHtml);
    const wrapped = lines.map(function (lineHtml, i) {
      const ln = startLine + i;
      return '<span class="sync-ln" data-line0="' + ln + '" data-line1="' + ln + '">' + lineHtml + '</span>';
    }).join('<br>');
    el.innerHTML = wrapped + restHtml;
    return lines.length;
  }

  // ---- 3) pair scanned blocks with the rendered preview DOM --------------
  function tag(el, start, end) {
    if (!el) return;
    el.setAttribute('data-line0', start);
    el.setAttribute('data-line1', end);
  }

  function buildRanges(previewEl, blocks) {
    const groups = {
      heading: previewEl.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6'),
      hr: previewEl.querySelectorAll(':scope > hr'),
      table: previewEl.querySelectorAll(':scope > table'),
      code: previewEl.querySelectorAll(':scope > .code-block, :scope > .mindmap-block'),
      quote: previewEl.querySelectorAll(':scope > blockquote, :scope > .callout, :scope > .finding'),
      list: previewEl.querySelectorAll(':scope > ul, :scope > ol'),
      para: previewEl.querySelectorAll(':scope > p, :scope > a.page-card')
    };
    const idx = { heading: 0, hr: 0, table: 0, code: 0, quote: 0, list: 0, para: 0 };
    const ranges = [];

    blocks.forEach(function (b) {
      const arr = groups[b.kind];
      if (!arr) return;
      const el = arr[idx[b.kind]++];
      if (!el) return;

      if (b.kind === 'heading' || b.kind === 'hr') {
        tag(el, b.start, b.end);
        ranges.push({ start: b.start, end: b.end, el: el });
      } else if (b.kind === 'table') {
        el.querySelectorAll('tr').forEach(function (tr, i) {
          const ln = i === 0 ? b.start : (b.start + 1 + i);
          tag(tr, ln, ln);
          ranges.push({ start: ln, end: ln, el: tr });
        });
      } else if (b.kind === 'code') {
        // `data-ln` is the GUTTER number the ```lang=N syntax asked to display
        // (often reset to 1, independent of where the fence actually sits in
        // the note) — not the source line. The real source line is simply the
        // fence's own start plus this <li>'s position among its siblings.
        const numbered = el.querySelectorAll('li[data-ln]');
        if (numbered.length) {
          numbered.forEach(function (li, i) {
            const ln = b.start + 1 + i;
            tag(li, ln, ln); ranges.push({ start: ln, end: ln, el: li });
          });
        } else {
          tag(el, b.start, b.end);
          ranges.push({ start: b.start, end: b.end, el: el });
        }
      } else if (b.kind === 'quote') {
        tag(el, b.start, b.end);
        ranges.push({ start: b.start, end: b.end, el: el });
      } else if (b.kind === 'para') {
        tag(el, b.start, b.end);
        ranges.push({ start: b.start, end: b.end, el: el }); // fallback if the split below undercounts
        wrapOwnLines(el, b.start);
        el.querySelectorAll(':scope > .sync-ln').forEach(function (sp) {
          const ln = parseInt(sp.getAttribute('data-line0'), 10);
          ranges.push({ start: ln, end: ln, el: sp });
        });
      } else if (b.kind === 'list') {
        const lis = el.querySelectorAll(':scope > li');
        b.items.forEach(function (item, i) {
          const li = lis[i];
          if (!li) return;
          tag(li, item.start, item.end);
          ranges.push({ start: item.start, end: item.end, el: li });
          wrapOwnLines(li, item.start);
          li.querySelectorAll(':scope > .sync-ln').forEach(function (sp) {
            const ln = parseInt(sp.getAttribute('data-line0'), 10);
            ranges.push({ start: ln, end: ln, el: sp });
          });
        });
      }
    });

    ranges.sort(function (a, b) { return a.start - b.start || (a.end - a.start) - (b.end - b.start); });
    return ranges;
  }

  function rangeFor(ranges, line) {
    // Prefer the narrowest range that contains `line` (a refined single-line
    // span over the coarse block it sits inside).
    let best = null;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (r.start > line) break;
      if (r.end >= line) { if (!best || (r.end - r.start) < (best.end - best.start)) best = r; }
    }
    return best;
  }

  // ---- 4) wiring: two click/caret listeners, one underline each side -----
  let editorEl = null, previewEl = null, ranges = [];
  let curPreviewEl = null;
  let curRowStart = -1, curRowEnd = -1;

  function clearPreviewHit() {
    if (curPreviewEl) { curPreviewEl.classList.remove('sync-hit'); curPreviewEl = null; }
  }
  function clearEditorHit() {
    if (curRowStart < 0) return;
    const lines = document.querySelectorAll('#editor-backdrop .cm-lines .cm-row');
    for (let i = curRowStart; i <= curRowEnd && i < lines.length; i++) lines[i].classList.remove('sync-hit');
    curRowStart = curRowEnd = -1;
  }

  function lineAtCaret() {
    const caret = editorEl.selectionStart;
    return (editorEl.value.slice(0, caret).match(/\n/g) || []).length + 1;
  }

  function onEditorMove() {
    if (!ranges.length) { clearPreviewHit(); return; }
    const r = rangeFor(ranges, lineAtCaret());
    clearPreviewHit();
    if (!r || !r.el) return;
    r.el.classList.add('sync-hit');
    curPreviewEl = r.el;
  }

  function onPreviewClick(e) {
    const hit = e.target.closest && e.target.closest('[data-line0]');
    clearEditorHit();
    if (!hit) return;
    const start = parseInt(hit.getAttribute('data-line0'), 10);
    const end = parseInt(hit.getAttribute('data-line1'), 10) || start;
    const lines = document.querySelectorAll('#editor-backdrop .cm-lines .cm-row');
    if (!lines.length) return;
    curRowStart = Math.max(0, start - 1);
    curRowEnd = Math.min(lines.length - 1, end - 1);
    for (let i = curRowStart; i <= curRowEnd; i++) lines[i].classList.add('sync-hit');
  }

  function rebuild(sourceText) {
    if (!previewEl) return;
    ranges = buildRanges(previewEl, sourceBlocks(sourceText));
    // A fresh render wiped out any element the previous highlight pointed at.
    curPreviewEl = null;
  }

  function init(ed, pv) {
    editorEl = ed; previewEl = pv;
    editorEl.addEventListener('click', onEditorMove);
    editorEl.addEventListener('keyup', onEditorMove);
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === editorEl) onEditorMove();
    });
    previewEl.addEventListener('click', onPreviewClick);
  }

  global.LineSync = { init: init, rebuild: rebuild };
})(window);

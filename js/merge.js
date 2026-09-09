/* merge.js — line-based 3-way merge for collaborative editing (browser copy).
 *
 * Mirrors server/merge.js exactly so the client resolves a conflict the same way
 * the server does and the two always converge. See that file for the rationale.
 *   window.Merge.merge3(base, mine, theirs) -> merged string ("mine" wins ties).
 *
 * merge3 and its LCS helpers must stay identical to server/merge.js. diffLines
 * and diffStat at the bottom are browser-only additions for the version-history
 * viewer — they read the same LCS but have no server counterpart, so leave them
 * out when comparing the two files.
 */
(function (global) {
  'use strict';

  function lcsPairs(a, b) {
    const m = a.length, n = b.length;
    const dp = [];
    for (let i = 0; i <= m; i++) dp.push(new Int32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const pairs = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
      else j++;
    }
    return pairs;
  }

  function diffHunks(base, other) {
    const pairs = lcsPairs(base, other);
    pairs.push([base.length, other.length]);
    const out = [];
    let bi = 0, oi = 0;
    for (let k = 0; k < pairs.length; k++) {
      const pb = pairs[k][0], po = pairs[k][1];
      if (pb > bi || po > oi) out.push({ s: bi, e: pb, rep: other.slice(oi, po) });
      bi = pb + 1; oi = po + 1;
    }
    return out;
  }

  function overlaps(m, t) {
    const s = Math.max(m.s, t.s), e = Math.min(m.e, t.e);
    if (s < e) return true;
    if (m.e > m.s && t.s >= m.s && t.s < m.e) return true;
    if (t.e > t.s && m.s >= t.s && m.s < t.e) return true;
    return false;
  }

  function merge3(base, mine, theirs) {
    if (mine === theirs) return mine;
    if (base === mine) return theirs;
    if (base === theirs) return mine;

    const bl = String(base).split('\n');
    const ml = String(mine).split('\n');
    const tl = String(theirs).split('\n');

    const mineH = diffHunks(bl, ml);
    const theirsH = diffHunks(bl, tl).filter(function (t) {
      return !mineH.some(function (m) { return overlaps(m, t); });
    });

    const all = mineH.concat(theirsH).sort(function (a, b) {
      return a.s - b.s || a.e - b.e;
    });
    const out = [];
    let i = 0, k = 0;
    while (i <= bl.length) {
      if (k < all.length && all[k].s === i) {
        const h = all[k++];
        for (let r = 0; r < h.rep.length; r++) out.push(h.rep[r]);
        if (h.e > i) i = h.e;
        continue;
      }
      if (i < bl.length) out.push(bl[i]);
      i++;
    }
    return out.join('\n');
  }

  // Line diff for the version-history viewer. Built on the same LCS the merge
  // uses, so "what changed" on screen is decided exactly the way a conflict is —
  // there is no second, subtly different notion of a changed line in this app.
  //
  // Returns rows of { type: 'ctx' | 'del' | 'add', text, a, b } where `a`/`b` are
  // 1-based line numbers in the old/new text (null on the side that lacks the
  // line). Deletions are emitted before the additions that replace them.
  function diffLines(oldText, newText) {
    const a = String(oldText == null ? '' : oldText).split('\n');
    const b = String(newText == null ? '' : newText).split('\n');
    const pairs = lcsPairs(a, b);
    pairs.push([a.length, b.length]);
    const rows = [];
    let ai = 0, bi = 0;
    for (let k = 0; k < pairs.length; k++) {
      const pa = pairs[k][0], pb = pairs[k][1];
      while (ai < pa) { rows.push({ type: 'del', text: a[ai], a: ai + 1, b: null }); ai++; }
      while (bi < pb) { rows.push({ type: 'add', text: b[bi], a: null, b: bi + 1 }); bi++; }
      if (pa < a.length && pb < b.length) {
        rows.push({ type: 'ctx', text: a[pa], a: pa + 1, b: pb + 1 });
        ai = pa + 1; bi = pb + 1;
      }
    }
    return rows;
  }

  // Counts for a one-line "+12 −3" summary without rendering the whole diff.
  function diffStat(oldText, newText) {
    let added = 0, removed = 0;
    diffLines(oldText, newText).forEach(function (r) {
      if (r.type === 'add') added++;
      else if (r.type === 'del') removed++;
    });
    return { added: added, removed: removed };
  }

  global.Merge = { merge3: merge3, diffLines: diffLines, diffStat: diffStat };
})(window);

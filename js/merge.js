/* merge.js — 3-way merge for collaborative note editing, ONE copy for both sides.
 *
 *   merge3(base, mine, theirs) -> merged string
 *
 * The browser loads this file as a script (window.Merge); the server requires the
 * very same file (server/merge.js is a one-line re-export). Client and server have
 * to resolve every conflict identically or two editors never converge, and two
 * hand-synced copies had already drifted apart once — so there is only one now.
 *
 * How it merges. First by line: base→mine and base→theirs as line hunks; hunks that
 * don't touch are both applied. Where they do touch (two people in the same line or
 * paragraph), that region is merged again by character, so two people typing in
 * the same line at different places both keep what they typed — before this, the
 * whole line went to whoever saved last and the other person watched their own
 * words disappear. Only an edit to the very same characters still has a winner:
 * "mine" (the save being applied).
 *
 * Both typing at the very same spot: both are kept, mine first — see sameSpot()
 * for the rules that stop this from ever duplicating text that one side already
 * has (a save measured against a stale base "inserts" text the server already
 * holds; keeping both of those once snowballed a note from ~15 KB to 1.5 MB).
 *
 * diffLines / diffStat at the bottom serve the version-history viewer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Merge = api;
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  const CELLS = 4000000;        // LCS table budget for one diff, after trimming
  const BOTH_CHARS = 400;       // same-spot typing: both kept up to this many characters each
  const BOTH_LINES = 60;        // same-spot new lines: both kept up to this many lines each…
  const BOTH_LINE_CHARS = 6000; // …and this many characters each

  // Longest common subsequence of two arrays → matched [i, j] index pairs.
  function lcsPairs(a, b) {
    const m = a.length, n = b.length;
    // dp[i][j] = LCS length of a[i:] and b[j:]
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

  // base→other as hunks: base[s..e) is replaced by `rep`. An insertion is a zero-
  // width hunk (s === e); a deletion has rep === []. Works on arrays of lines or of
  // characters. The common start and end are trimmed first — an edit touches a few
  // lines of a long note, so the O(n·m) LCS only ever sees the middle (it used to run
  // on the whole note, under the row lock, on every save). A middle still too big
  // for the budget becomes a single hunk.
  function diffHunks(base, other) {
    const bl = base.length, ol = other.length;
    let p = 0;
    while (p < bl && p < ol && base[p] === other[p]) p++;
    let q = 0;
    while (q < bl - p && q < ol - p && base[bl - 1 - q] === other[ol - 1 - q]) q++;
    const bm = base.slice(p, bl - q), om = other.slice(p, ol - q);
    if (!bm.length && !om.length) return [];
    if (!bm.length || !om.length || bm.length * om.length > CELLS) return [{ s: p, e: bl - q, rep: om }];
    const pairs = lcsPairs(bm, om);
    pairs.push([bm.length, om.length]);   // sentinel closes any trailing gap
    const out = [];
    let bi = 0, oi = 0;
    for (let k = 0; k < pairs.length; k++) {
      const pb = pairs[k][0], po = pairs[k][1];
      if (pb > bi || po > oi) out.push({ s: p + bi, e: p + pb, rep: om.slice(oi, po) });
      bi = pb + 1; oi = po + 1;
    }
    return out;
  }

  // An insertion or deletion next to repeated text can sit in several places with the
  // same result ("ab" + "b" inserted: after the a, or after the b). The LCS picks one
  // arbitrarily — often mid-word, where it cuts across what the person actually typed.
  // Slide each pure insertion/deletion to the place with the most natural boundaries
  // on both sides (line breaks, then spaces, then punctuation), like diff-match-patch's
  // semantic cleanup. Two people inserting at the same place then really land on the
  // same spot and are kept whole side by side, instead of as interleaved pieces.
  function slideHunks(base, hunks, edge) {
    for (let k = 0; k < hunks.length; k++) {
      const h = hunks[k];
      const lo = k ? hunks[k - 1].e : 0, hi = k + 1 < hunks.length ? hunks[k + 1].s : base.length;
      const ins = h.s === h.e && h.rep.length, del = h.s < h.e && !h.rep.length;
      if (!ins && !del) continue;
      // walk all the way left, then score every position walking right
      let s = h.s, e = h.e, rep = h.rep.slice();
      if (ins) {
        while (s > lo && base[s - 1] === rep[rep.length - 1]) { rep.unshift(base[s - 1]); rep.pop(); s--; }
        e = s;
      } else {
        while (s > lo && base[s - 1] === base[e - 1]) { s--; e--; }
      }
      let best = null;
      for (;;) {
        const score = ins
          ? edge(base[s - 1], rep[0]) + edge(rep[rep.length - 1], base[s])
          : edge(base[s - 1], base[s]) + edge(base[e - 1], base[e]);
        if (!best || score > best.score) best = { score: score, s: s, e: e, rep: rep.slice() };
        if (ins) {
          if (s < hi && base[s] === rep[0]) { rep.push(base[s]); rep.shift(); s++; e++; } else break;
        } else {
          if (e < hi && base[e] === base[s]) { s++; e++; } else break;
        }
      }
      hunks[k] = { s: best.s, e: best.e, rep: ins ? best.rep : [] };
    }
    // Sliding can bring two hunks of the same side together (an inserted "\n" and the
    // words typed after it, both slid to one spot). Nothing lies between them, so they
    // are one edit: join them, or the pair would count as two conflicting hunks.
    const out = [];
    hunks.forEach(function (h) {
      const prev = out[out.length - 1];
      if (prev && h.s === prev.e) out[out.length - 1] = { s: prev.s, e: h.e, rep: prev.rep.concat(h.rep) };
      else out.push(h);
    });
    return out;
  }
  // Boundary quality between two neighbouring tokens / lines (undefined = the edge).
  function tokenEdge(a, b) {
    if (a === undefined || b === undefined) return 6;
    if (a === '\n' || b === '\n') return 5;
    if (/^\s+$/.test(a) || /^\s+$/.test(b)) return 3;
    if (!/^\w+$/.test(a) || !/^\w+$/.test(b)) return 2;
    return 0;
  }
  function lineEdge(a, b) {
    if (a === undefined || b === undefined) return 6;
    if (!a.trim() || !b.trim()) return 5;
    return 1;
  }
  // Line hunks separated only by a weak match — a single line, or up to three blank /
  // near-blank lines ("", "```", "---") — are one edit. Markdown is full of blank
  // lines, and the LCS happily pairs a blank line with some other blank line and then
  // describes "edited these two lines" as "deleted them here, re-inserted edited
  // copies further down". If the other person edited the same lines, that shape
  // turned into both copies being kept (duplication) or the deletion winning (their
  // edit lost). As one replacement, the region goes to the token merge, which lines
  // the two edits up word by word instead.
  function coarsenLines(base, hunks) {
    const out = [];
    hunks.forEach(function (h) {
      const prev = out[out.length - 1];
      if (prev) {
        const gap = base.slice(prev.e, h.s);
        const weak = gap.length <= 1 || (gap.length <= 3 && gap.every(function (l) { return l.trim().length <= 3; }));
        if (weak) { out[out.length - 1] = { s: prev.s, e: h.e, rep: prev.rep.concat(gap, h.rep) }; return; }
      }
      out.push(h);
    });
    return out;
  }
  function lineHunks(base, other) { return coarsenLines(base, slideHunks(base, diffHunks(base, other), lineEdge)); }

  // Words, runs of spaces, line breaks, and every other character (CJK, punctuation,
  // emoji — whole code points) each as one token. Merging token by token keeps what
  // someone typed in one piece; merging character by character let the LCS pair the
  // letters of a new word with those of an old one next to it and cut both apart.
  function tokenize(s) { return s.match(/[A-Za-z0-9_]+|[ \t]+|\n|[\s\S]/gu) || []; }

  // Do two hunks (same base coordinates) touch? Genuinely overlapping ranges do; so
  // do two insertions at the same point (their intersection is empty by definition,
  // so this has to be said explicitly — without it both were kept blindly, which is
  // the stale-base duplication described at the top), and an insertion strictly
  // inside the other side's replaced range.
  function overlaps(m, t) {
    const s = Math.max(m.s, t.s), e = Math.min(m.e, t.e);
    if (s < e) return true;
    if (m.s === m.e && t.s === t.e && m.s === t.s) return true;
    if (m.e > m.s && t.s >= m.s && t.s < m.e) return true;
    if (t.e > t.s && m.s >= t.s && m.s < t.e) return true;
    return false;
  }

  // Apply non-overlapping hunks to an array.
  function apply(base, hunks) {
    const hs = hunks.slice().sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    const out = [];
    let i = 0, k = 0;
    while (i <= base.length) {
      if (k < hs.length && hs[k].s === i) {
        const h = hs[k++];
        for (let r = 0; r < h.rep.length; r++) out.push(h.rep[r]);
        if (h.e > i) i = h.e;             // consume the replaced base items
        continue;                          // another hunk may start here too
      }
      if (i < base.length) out.push(base[i]);
      i++;
    }
    return out;
  }
  function shift(hunks, d) {
    return hunks.map(function (h) { return { s: h.s + d, e: h.e + d, rep: h.rep }; });
  }

  // Apply both sides' hunks. Hunks that touch are grouped, transitively, into one
  // conflict over base[s..e); resolve(mineRegion, theirsRegion, baseRegion) returns
  // what replaces it. Everything else goes in as is.
  function combine(base, mineH, theirsH, resolve) {
    const nM = mineH.length;
    const all = mineH.concat(theirsH);
    const parent = all.map(function (_, i) { return i; });
    function find(i) { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; }
    for (let i = 0; i < nM; i++) {
      for (let j = 0; j < theirsH.length; j++) {
        if (theirsH[j].s > mineH[i].e) break;            // both lists are sorted by s
        if (overlaps(mineH[i], theirsH[j])) {
          const a = find(i), b = find(nM + j);
          if (a !== b) parent[a] = b;
        }
      }
    }
    const groups = {};
    all.forEach(function (h, i) {
      const r = find(i);
      const g = groups[r] || (groups[r] = { mine: [], theirs: [] });
      (i < nM ? g.mine : g.theirs).push(h);
    });
    const final = [];
    Object.keys(groups).forEach(function (key) {
      const g = groups[key];
      if (!g.mine.length || !g.theirs.length) { g.mine.concat(g.theirs).forEach(function (h) { final.push(h); }); return; }
      let s = Infinity, e = -Infinity;
      g.mine.concat(g.theirs).forEach(function (h) { if (h.s < s) s = h.s; if (h.e > e) e = h.e; });
      const region = base.slice(s, e);
      final.push({ s: s, e: e, rep: resolve(apply(region, shift(g.mine, -s)), apply(region, shift(g.theirs, -s)), region) });
    });
    // Belt and braces: the replacements must not overlap each other (they can't, since
    // a group's range is covered by its own hunks — but if that ever broke, applying
    // them would scramble the text). Fall back to the old rule then: drop every hunk
    // of theirs that touches one of mine.
    final.sort(function (a, b) { return a.s - b.s || a.e - b.e; });
    for (let k = 1; k < final.length; k++) {
      const a = final[k - 1], b = final[k];
      if (b.s < a.e || (b.s === a.s && a.s === a.e && b.s === b.e)) {
        return apply(base, mineH.concat(theirsH.filter(function (t) {
          return !mineH.some(function (m) { return overlaps(m, t); });
        })));
      }
    }
    return apply(base, final);
  }

  // Both sides inserted at the very same spot (arrays of lines or characters). Two
  // people typing there: keep both, mine first. Except:
  //  - one side already contains the other's text → that side. A save built on a
  //    stale base re-sends text the server already has; this is what keeps it from
  //    being added a second time;
  //  - they share a real run of text at the start and/or end (SHARED or more) — the
  //    same content arriving twice, plus each side's own change: the shared part is
  //    kept once and only the differing middles are both kept. A short shared run
  //    (both typed a space, a "- ", a blank line) is not that: factoring it out would
  //    splice two different sentences together ("the cat" + "the dog" → "the catdog");
  //  - the parts are bigger than two people typing → mine wins, the old rule.
  const SHARED = 20;
  function sameSpot(m, t, lines) {
    const sep = lines ? '\n' : '';
    // lines: whole-line containment only ("a" is not inside the line "abc")
    const wrap = function (x) { return lines ? '\n' + x + '\n' : x; };
    function contains(big, small) { return wrap(big.join(sep)).indexOf(wrap(small.join(sep))) >= 0; }
    if (contains(t, m)) return t;
    if (contains(m, t)) return m;
    let p = 0;
    while (p < m.length && p < t.length && m[p] === t[p]) p++;
    let q = 0;
    while (q < m.length - p && q < t.length - p && m[m.length - 1 - q] === t[t.length - 1 - q]) q++;
    const shared = m.slice(0, p).concat(m.slice(m.length - q));
    const weight = shared.reduce(function (n, x) { return n + String(x).replace(/\s+/g, '').length; }, 0);
    let pre = [], post = [], mm = m, tt = t;
    if (weight >= SHARED) {
      pre = m.slice(0, p); post = m.slice(m.length - q);
      mm = m.slice(p, m.length - q); tt = t.slice(p, t.length - q);
      if (!mm.length || contains(tt, mm)) return t;
      if (!tt.length || contains(mm, tt)) return m;
    }
    const ms = mm.join(sep), ts = tt.join(sep);
    const small = lines
      ? mm.length <= BOTH_LINES && tt.length <= BOTH_LINES && ms.length <= BOTH_LINE_CHARS && ts.length <= BOTH_LINE_CHARS
      : mm.length <= BOTH_CHARS && tt.length <= BOTH_CHARS;
    if (!small) return m;
    // Characters: a part that ends a line (someone opened a new line right here) goes
    // first, so the other person's text stays on the line it was typed on.
    let first = mm, second = tt;
    if (!lines && tt[tt.length - 1] === '\n' && mm[mm.length - 1] !== '\n') { first = tt; second = mm; }
    return pre.concat(first, second, post);
  }

  // Token-level merge of one conflicting line region (see tokenize). Where both sides
  // changed the same word(s), that little region is merged once more, character by
  // character — "b" → "Xb" and "b" → "bY" is "XbY", not one of the two.
  function mergeChars(base, mine, theirs) {
    if (mine === theirs) return mine;
    if (base === mine) return theirs;
    if (base === theirs) return mine;
    const b = tokenize(base), m = tokenize(mine), t = tokenize(theirs);
    return combine(b, slideHunks(b, diffHunks(b, m), tokenEdge), slideHunks(b, diffHunks(b, t), tokenEdge), function (mr, tr, br) {
      if (!br.length) return sameSpot(mr, tr, false);
      return Array.from(mergeLetters(br.join(''), mr.join(''), tr.join('')));
    }).join('');
  }
  // Character-level merge of a few words both sides touched. Only here does an edit
  // of the very same characters still have a winner: mine — unless one side merely
  // deleted there. Then both deletions stand and the other side's new text goes in,
  // which is what an operation-based editor does with "delete" against "retype": two
  // people removing the same lines while one also typed at the edge of them keep
  // what was typed (it used to be dropped along with the deleted lines).
  function mergeLetters(base, mine, theirs) {
    if (mine === theirs) return mine;
    if (base === mine) return theirs;
    if (base === theirs) return mine;
    const b = Array.from(base), m = Array.from(mine), t = Array.from(theirs);   // code points, not UTF-16 halves
    return combine(b, slideHunks(b, diffHunks(b, m), tokenEdge), slideHunks(b, diffHunks(b, t), tokenEdge), function (mr, tr, br) {
      if (!br.length) return sameSpot(mr, tr, false);
      const mh = diffHunks(br, mr), th = diffHunks(br, tr);
      const onlyDeletes = function (hs) { return hs.every(function (h) { return !h.rep.length; }); };
      if (!onlyDeletes(mh) && !onlyDeletes(th)) return mr;
      const gone = [], ins = {};
      mh.concat(th).forEach(function (h) {
        for (let i = h.s; i < h.e; i++) gone[i] = true;
        if (h.rep.length) (ins[h.s] = ins[h.s] || []).push(h.rep);
      });
      const out = [];
      for (let i = 0; i <= br.length; i++) {
        if (ins[i]) ins[i].forEach(function (r) { for (let k = 0; k < r.length; k++) out.push(r[k]); });
        if (i < br.length && !gone[i]) out.push(br[i]);
      }
      return out;
    }).join('');
  }

  function merge3(base, mine, theirs) {
    base = base == null ? '' : String(base);
    mine = mine == null ? '' : String(mine);
    theirs = theirs == null ? '' : String(theirs);
    if (mine === theirs) return mine;
    if (base === mine) return theirs;     // I made no change → take theirs wholesale
    if (base === theirs) return mine;     // they made no change → keep mine

    const bl = base.split('\n'), ml = mine.split('\n'), tl = theirs.split('\n');
    return combine(bl, lineHunks(bl, ml), lineHunks(bl, tl), function (mr, tr, br) {
      if (!br.length) return sameSpot(mr, tr, true);
      return fromText(mergeChars(toText(br), toText(mr), toText(tr)));
    }).join('\n');
  }
  // A run of lines as text for the character merge, every line WITH its newline, so
  // "no lines" ('') and "one empty line" ('\n') stay different — joined the plain way
  // both were '', and two people deleting the same line left an empty line behind.
  function toText(lines) { return lines.length ? lines.join('\n') + '\n' : ''; }
  function fromText(s) {
    if (s === '') return [];
    return (s.charAt(s.length - 1) === '\n' ? s.slice(0, -1) : s).split('\n');
  }

  // ---- Where does a caret go? ---------------------------------------------------
  // mapOffset(oldText, newText, offset): the offset (UTF-16, as textarea selections
  // count) in newText of the spot that was `offset` in oldText — used when a merge
  // replaces the editor's text, for my own caret and for everyone else's. Only
  // comparing the common start and end is not enough: with edits both above and
  // below the caret (two other people typing), the caret fell back to the start of
  // the first edit, and the next keystrokes landed there, in the middle of someone
  // else's words. By line first; within a changed line, token by token. A caret
  // right where text was inserted stays in front of it; one inside a replaced run
  // goes to its end.
  function mapOffset(a, b, off) {
    a = String(a); b = String(b);
    if (a === b) return off;
    off = Math.max(0, Math.min(off, a.length));
    const al = a.split('\n'), bl = b.split('\n');
    let line = 0, start = 0;
    while (line < al.length - 1 && start + al[line].length < off) { start += al[line].length + 1; line++; }
    const col = off - start;
    const hunks = lineHunks(al, bl);
    let shift = 0;   // how many lines were added (or removed) above the caret's line
    for (let k = 0; k < hunks.length; k++) {
      const h = hunks[k];
      if (h.s === h.e) {                                       // lines inserted…
        if (h.s <= line) { shift += h.rep.length; continue; }  // …above: the caret's line moves down
        break;                                                 // …below
      }
      if (h.e <= line) { shift += h.rep.length - (h.e - h.s); continue; }   // a block above
      if (h.s > line) break;                                                 // a block below
      // the caret's own line is in a changed block: map within that block
      let inOld = col;
      for (let i = h.s; i < line; i++) inOld += al[i].length + 1;
      let newStart = 0;
      for (let i = 0; i < h.s + shift; i++) newStart += bl[i].length + 1;
      return newStart + mapInText(al.slice(h.s, h.e).join('\n'), h.rep.join('\n'), inOld);
    }
    const nl = line + shift;
    let pos = 0;
    for (let i = 0; i < nl && i < bl.length; i++) pos += bl[i].length + 1;
    return Math.min(b.length, pos + Math.min(col, (bl[nl] || '').length));
  }
  function mapInText(x, y, o) {
    const xt = tokenize(x), yt = tokenize(y);
    const hs = slideHunks(xt, diffHunks(xt, yt), tokenEdge);
    let xi = 0, xpos = 0, ypos = 0;   // token index in x; UTF-16 offsets in x and y
    const len = function (arr, from, to) { let n = 0; for (let i = from; i < to; i++) n += arr[i].length; return n; };
    for (let k = 0; k < hs.length; k++) {
      const h = hs[k];
      const eqLen = len(xt, xi, h.s);
      if (o < xpos + eqLen) return ypos + (o - xpos);             // in the unchanged run before this hunk
      xpos += eqLen; ypos += eqLen;
      const oldStr = xt.slice(h.s, h.e).join(''), newStr = h.rep.join('');
      if (o <= xpos + oldStr.length) {                              // at or inside this hunk
        const rel = o - xpos;
        if (!oldStr.length) return ypos;                            // text inserted right here: stay in front of it
        // A word both sides touched is one token; line the letters up inside it, so
        // "hello|" → "helloZZZ" keeps the caret after "hello", not after "ZZZ".
        let p = 0;
        while (p < oldStr.length && p < newStr.length && oldStr[p] === newStr[p]) p++;
        let q = 0;
        while (q < oldStr.length - p && q < newStr.length - p && oldStr[oldStr.length - 1 - q] === newStr[newStr.length - 1 - q]) q++;
        if (rel <= p) return ypos + rel;
        if (rel >= oldStr.length - q) return ypos + newStr.length - (oldStr.length - rel);
        return ypos + newStr.length - q;                            // inside what was replaced → after it
      }
      xpos += oldStr.length; ypos += newStr.length; xi = h.e;
    }
    return Math.min(y.length, ypos + (o - xpos));
  }

  // ---- Version-history viewer -------------------------------------------------
  // Line diff for the version viewer, on the same LCS as the merge.
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

  return { merge3: merge3, mapOffset: mapOffset, diffLines: diffLines, diffStat: diffStat };
});

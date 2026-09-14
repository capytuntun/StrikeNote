/* merge.js — line-based 3-way merge for collaborative note editing.
 *
 * merge3(base, mine, theirs) reconciles two edits that both started from `base`.
 * Non-overlapping line changes from each side are combined; when both sides
 * touched the same lines, "mine" wins (last-write-wins, per the product rule).
 *
 * The exact same algorithm ships to the browser as js/merge.js so the client and
 * server always resolve a conflict identically and therefore converge.
 */
'use strict';

// Longest common subsequence of two line arrays → matched [i, j] index pairs.
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

// Express base→other as hunks: base[s..e) is replaced by the `rep` lines.
// An insertion is a zero-width hunk (s === e); a deletion has rep === [].
function diffHunks(base, other) {
  const pairs = lcsPairs(base, other);
  pairs.push([base.length, other.length]);   // sentinel closes any trailing gap
  const out = [];
  let bi = 0, oi = 0;
  for (let k = 0; k < pairs.length; k++) {
    const pb = pairs[k][0], po = pairs[k][1];
    if (pb > bi || po > oi) out.push({ s: bi, e: pb, rep: other.slice(oi, po) });
    bi = pb + 1; oi = po + 1;
  }
  return out;
}

// Do two hunks (in the same base coordinate system) touch the same base lines?
// Two insertions at DIFFERENT points don't conflict — both are kept. Two
// insertions at the exact SAME point do conflict: `s < e` is never true for a
// zero-width/zero-width pair (their intersection is empty by definition), so
// without this check both sides' inserted lines were kept side by side. That
// silently duplicated whatever the two sides happened to insert identically
// (e.g. both saves carry the same unchanged header when merging against a
// stale/empty base) and, worse, compounds every time a save goes out against
// a base that has fallen behind: each such save re-embeds the *other* side's
// entire already-merged text as one more "insertion at the same point",
// growing the note without bound (confirmed: a few dozen stale-base saves on
// one note inflated it from ~3.5 KB to 1.5 MB — see the load-test findings).
function overlaps(m, t) {
  const s = Math.max(m.s, t.s), e = Math.min(m.e, t.e);
  if (s < e) return true;                                  // ranges genuinely overlap
  if (m.s === m.e && t.s === t.e && m.s === t.s) return true;   // same insertion point
  if (m.e > m.s && t.s >= m.s && t.s < m.e) return true;   // theirs sits inside mine's range
  if (t.e > t.s && m.s >= t.s && m.s < t.e) return true;   // mine sits inside theirs' range
  return false;
}

function merge3(base, mine, theirs) {
  if (mine === theirs) return mine;
  if (base === mine) return theirs;     // I made no change → take theirs wholesale
  if (base === theirs) return mine;     // they made no change → keep mine

  const bl = String(base).split('\n');
  const ml = String(mine).split('\n');
  const tl = String(theirs).split('\n');

  const mineH = diffHunks(bl, ml);
  // Drop any of their hunks that collide with one of mine — mine wins on conflict.
  const theirsH = diffHunks(bl, tl).filter(function (t) {
    return !mineH.some(function (m) { return overlaps(m, t); });
  });

  // Walk the base lines, applying whichever hunk starts here (mine first).
  const all = mineH.concat(theirsH).sort(function (a, b) {
    return a.s - b.s || a.e - b.e;
  });
  const out = [];
  let i = 0, k = 0;
  while (i <= bl.length) {
    if (k < all.length && all[k].s === i) {
      const h = all[k++];
      for (let r = 0; r < h.rep.length; r++) out.push(h.rep[r]);
      if (h.e > i) i = h.e;               // consume the replaced base lines
      continue;                            // re-check: another hunk may start here too
    }
    if (i < bl.length) out.push(bl[i]);
    i++;
  }
  return out.join('\n');
}

module.exports = { merge3: merge3 };

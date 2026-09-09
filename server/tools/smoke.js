#!/usr/bin/env node
/* smoke.js — end-to-end exercise of the HTTP API against a *scratch* server.
 *
 * Two jobs:
 *   1. Build a synthetic fixture on the old SQLite server (`--old` skips the
 *      endpoints/behaviours that only the MariaDB build has), so the migration
 *      tool has something realistic — CJK/emoji text, images, a 20 MB PDF,
 *      versions, shares, book versions, share links — to move.
 *   2. Verify the MariaDB build end to end.
 *
 * Never point this at a real instance: it registers users and writes data.
 *
 *   BASE_URL=http://127.0.0.1:8090 ADMIN_PASSWORD=... node server/tools/smoke.js [--old]
 */
'use strict';

const crypto = require('node:crypto');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8090';
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PW = process.env.ADMIN_PASSWORD || 'scratchpass123';
const BOB = 'bob';
const BOB_PW = 'bob-password-123';
const OLD = process.argv.includes('--old');
const BODY_LIMIT = parseInt(process.env.MAX_BODY_BYTES || '', 10) || 25 * 1024 * 1024;
const CSRF = { 'X-Requested-With': 'report-notes' };

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else {
    fail++;
    console.log('  FAIL  ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 300) : ''));
  }
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

function jar() {
  let cookie = '';
  return {
    absorb(res) {
      const sc = res.headers.get('set-cookie');
      if (!sc) return;
      const m = sc.match(/rn_session=([^;]*)/);
      if (m) cookie = m[1] ? 'rn_session=' + m[1] : '';
    },
    header() { return cookie; }
  };
}

async function call(session, method, path, body, opts) {
  opts = opts || {};
  const headers = Object.assign({}, CSRF, opts.headers || {});
  if (session && session.header()) headers.Cookie = session.header();
  let payload;
  if (opts.raw) { payload = body; headers['Content-Type'] = opts.contentType || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(BASE + path, { method: method, headers: headers, body: payload, redirect: 'manual' });
  if (session) session.absorb(res);
  let data = null;
  if (opts.buffer) data = Buffer.from(await res.arrayBuffer());
  else if ((res.headers.get('content-type') || '').includes('json')) data = await res.json().catch(() => null);
  else data = await res.text();
  return { status: res.status, data: data, headers: res.headers };
}

// A valid 1×1 PNG (red pixel).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

async function login(session, username, password) {
  return call(session, 'POST', '/api/login', { username: username, password: password });
}

async function main() {
  console.log('smoke → ' + BASE + (OLD ? '  (old server: new-only checks skipped)' : ''));
  const admin = jar(), bob = jar(), anon = jar();

  if (!OLD) {
    section('health');
    const h = await call(null, 'GET', '/api/health');
    ok(h.status === 200 && h.data && h.data.ok === true, '/api/health is 200 {ok:true}', h.data);
  }

  section('accounts');
  let r = await login(admin, ADMIN, ADMIN_PW);
  ok(r.status === 200 && r.data.user && r.data.user.username === ADMIN, 'admin login', r.data);
  r = await call(bob, 'POST', '/api/register', { username: BOB, password: BOB_PW, invite: '' });
  if (r.status !== 200) r = await login(bob, BOB, BOB_PW);
  ok(r.status === 200 && r.data.user && r.data.user.username === BOB, 'bob registered/logged in', r.data);
  const bobId = r.data.user.id;
  r = await call(bob, 'GET', '/api/me');
  ok(r.status === 200 && r.data.user && r.data.user.id === bobId, '/api/me reflects bob', r.data);
  r = await call(anon, 'GET', '/api/notes');
  ok(r.status === 401, 'anonymous /api/notes is 401', r.status);
  r = await call(admin, 'POST', '/api/notes', {}, { headers: { 'X-Requested-With': 'nope' } });
  ok(r.status === 403, 'wrong CSRF header is 403', r.status);

  section('folders');
  r = await call(admin, 'POST', '/api/folders', { name: '專案 A' });
  ok(r.status === 200 && r.data.folder && r.data.folder.id, 'create folder', r.data);
  const fid = r.data.folder.id;
  r = await call(admin, 'POST', '/api/folders', { name: '子資料夾', parentId: fid });
  const subId = r.data.folder.id;
  r = await call(admin, 'PUT', '/api/folders/' + fid, { name: '專案 A（改名）', parentId: null, isBook: true });
  ok(r.status === 200 && r.data.folder.isBook === true && r.data.folder.name === '專案 A（改名）', 'rename + isBook', r.data);
  r = await call(admin, 'PUT', '/api/folders/' + fid, { name: '專案 A（改名）', parentId: null });
  ok(r.status === 200 && r.data.folder.isBook === true, 'rename without isBook leaves the flag alone', r.data);
  r = await call(bob, 'PUT', '/api/folders/' + fid, { name: 'hijack' });
  ok(r.status === 404, "bob cannot touch admin's folder", r.status);

  section('notes');
  const texts = [
    '# 01 前言\n\n這是滲透測試報告的前言，含 emoji 🚀 與 `<script>alert(1)</script>`。\n\n#lab #oscp',
    "# 02 主機\n\n```bash\nsqlmap -u 'http://t/?id=1' --dbs\n```\n\n' OR 1=1 -- \n\n[[03 附錄]]",
    '# 03 附錄\n\n| a | b |\n|---|---|\n| 中文 | 表格 |\n\n> [!NOTE]\n> callout'
  ];
  const noteIds = [];
  for (let i = 0; i < texts.length; i++) {
    r = await call(admin, 'POST', '/api/notes', { title: '0' + (i + 1) + ' 章', content: texts[i], folderId: fid });
    ok(r.status === 200 && r.data.note && r.data.note.folderId === fid, 'create chapter ' + (i + 1), r.data);
    noteIds.push(r.data.note.id);
  }
  r = await call(admin, 'POST', '/api/notes', { title: '散裝筆記', content: 'loose #lab' });
  const looseId = r.data.note.id;
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0]);
  ok(r.status === 200 && r.data.note.content === texts[0], 'round-trips CJK/emoji/markdown exactly');
  const n0 = r.data.note;
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[0], {
    title: n0.title, content: texts[0] + '\n\n第二段。', baseContent: n0.content, baseRev: n0.rev, folderId: fid,
    meta: { pinned: true }
  });
  ok(r.status === 200 && r.data.note.rev === n0.rev + 1 && r.data.note.meta && r.data.note.meta.pinned === true,
    'save bumps rev and stores meta', r.data);
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[0], {
    title: n0.title, content: r.data.note.content, baseContent: r.data.note.content, folderId: fid, meta: { pinned: true }
  });
  ok(r.status === 200 && r.data.note.rev === n0.rev + 1, 'no-op save does not bump rev', r.data.note.rev);
  // Three-way merge: two clients edit different lines from the same base.
  const base = (await call(admin, 'GET', '/api/notes/' + noteIds[1])).data.note;
  const lines = base.content.split('\n');
  const a = lines.slice(); a[0] = '# 02 主機（A 改標題行）';
  const b = lines.slice(); b.push('B 加了一行');
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: base.title, content: a.join('\n'), baseContent: base.content, folderId: fid });
  ok(r.status === 200, 'merge: first save');
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: base.title, content: b.join('\n'), baseContent: base.content, folderId: fid });
  ok(r.status === 200 && r.data.note.content.includes('A 改標題行') && r.data.note.content.includes('B 加了一行'),
    'merge: second save keeps both edits', r.data.note && r.data.note.content);

  section('shares + site-wide access');
  r = await call(bob, 'GET', '/api/notes/' + noteIds[0]);
  ok(r.status === 404, 'bob cannot see an unshared note', r.status);
  r = await call(admin, 'POST', '/api/notes/' + noteIds[0] + '/shares', { username: BOB, perm: 'read' });
  ok(r.status === 200 && r.data.perm === 'read', 'share read', r.data);
  r = await call(admin, 'POST', '/api/notes/' + noteIds[0] + '/shares', { username: BOB, perm: 'edit' });
  ok(r.status === 200 && r.data.perm === 'edit', 'share upsert → edit', r.data);
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/shares');
  ok(r.status === 200 && r.data.shares.length === 1 && r.data.shares[0].perm === 'edit', 'one share row after upsert', r.data);
  r = await call(bob, 'GET', '/api/notes/' + noteIds[0]);
  ok(r.status === 200 && r.data.note.perm === 'edit' && r.data.note.sharedBy === ADMIN, 'bob sees it with edit', r.data);
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[2] + '/access', { mode: 'site', perm: 'read' });
  ok(r.status === 200 && r.data.access === 'site', 'site-wide read', r.data);
  r = await call(bob, 'GET', '/api/notes');
  ok(r.status === 200 && r.data.notes.some(n => n.id === noteIds[2] && n.viaSite === true), 'bob lists the site-wide note', r.data && r.data.notes.length);
  r = await call(bob, 'PUT', '/api/notes/' + noteIds[2], { title: 'x', content: 'x' });
  ok(r.status === 403, 'site-wide read is not edit', r.status);
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[2] + '/access', { mode: 'restricted', perm: 'read' });
  ok(r.status === 200, 'back to restricted');

  section('versions (coalesce, label, restore, prune)');
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/versions');
  ok(r.status === 200 && r.data.versions.some(v => v.label === '啟用版本歷史前') && r.data.versions.length === 2,
    'first save left prehistory + one open row', r.data && r.data.versions.map(v => v.label));
  r = await call(admin, 'POST', '/api/notes/' + noteIds[0] + '/versions', { label: '里程碑' });
  ok(r.status === 200 && r.data.version && r.data.version.label === '里程碑', 'labelled version', r.data);
  const milestoneId = r.data.version.id;
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[0] + '/versions/' + milestoneId, { label: '里程碑 v2' });
  ok(r.status === 200 && r.data.label === '里程碑 v2', 'rename label', r.data);
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/versions/' + milestoneId);
  ok(r.status === 200 && typeof r.data.version.content === 'string' && r.data.version.chars === r.data.version.content.length,
    'get version has content and matching chars', r.data);
  // Alternate authors so coalescing cannot merge the rows: 70 saves → 70
  // unlabelled versions → prune keeps 60.
  let cur = (await call(admin, 'GET', '/api/notes/' + noteIds[0])).data.note;
  for (let i = 0; i < 70; i++) {
    const who = i % 2 ? bob : admin;
    const next = cur.content + '\n行 ' + i;
    r = await call(who, 'PUT', '/api/notes/' + noteIds[0], { title: cur.title, content: next, baseContent: cur.content, folderId: fid });
    if (r.status !== 200) { ok(false, 'save #' + i, r); break; }
    cur = r.data.note;
  }
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/versions');
  const unl = r.data.versions.filter(v => !v.label).length;
  const lab = r.data.versions.filter(v => v.label).length;
  ok(unl === 60 && lab >= 2, 'prune keeps 60 unlabelled, labelled untouched', { unlabelled: unl, labelled: lab });
  r = await call(admin, 'POST', '/api/notes/' + noteIds[0] + '/versions/' + milestoneId + '/restore');
  ok(r.status === 200 && r.data.note && !r.data.note.content.includes('行 69'), 'restore rewinds the text', r.data);
  r = await call(admin, 'GET', '/api/notes/' + noteIds[0] + '/versions');
  ok(r.data.versions.some(v => v.label === '還原前'), 'restore left a 還原前 snapshot');
  r = await call(admin, 'DELETE', '/api/notes/' + noteIds[0] + '/versions/' + milestoneId);
  ok(r.status === 200, 'delete labelled version');

  section('images + PDF');
  r = await call(admin, 'POST', '/api/images', PNG, { raw: true, contentType: 'image/png' });
  ok(r.status === 200 && r.data.id, 'upload png', r.data);
  const imgId = r.data.id;
  r = await call(admin, 'GET', '/api/images/' + imgId, undefined, { buffer: true });
  ok(r.status === 200 && r.data.equals(PNG) && r.headers.get('content-type') === 'image/png', 'png round-trips byte for byte');
  // Bob has no note embedding it yet → 404; embed it in the shared note → 200.
  r = await call(bob, 'GET', '/api/images/' + imgId, undefined, { buffer: true });
  ok(r.status === 404, 'image hidden from a user with no note referencing it', r.status);
  cur = (await call(admin, 'GET', '/api/notes/' + noteIds[0])).data.note;
  r = await call(admin, 'PUT', '/api/notes/' + noteIds[0], { title: cur.title, content: cur.content + '\n\n![img](img:' + imgId + ')', baseContent: cur.content, folderId: fid });
  r = await call(bob, 'GET', '/api/images/' + imgId, undefined, { buffer: true });
  ok(r.status === 200, 'image visible once a shared note embeds it', r.status);
  r = await call(admin, 'PUT', '/api/images/' + imgId, {
    mime: 'image/png', data: PNG.toString('base64'), original: PNG.toString('base64'),
    shapes: [{ type: 'rect', x: 1, y: 1, w: 2, h: 2, color: '#f00' }]
  });
  ok(r.status === 200, 'annotate (data + original + shapes)', r.data);
  r = await call(admin, 'GET', '/api/images/' + imgId + '/meta');
  ok(r.status === 200 && r.data.hasOriginal === true && r.data.shapes.length === 1 && r.data.canAnnotate === true, 'meta after annotate', r.data);
  r = await call(bob, 'PUT', '/api/images/' + imgId, { mime: 'image/png', data: PNG.toString('base64') });
  ok(r.status === 403, 'only the owner may annotate', r.status);
  r = await call(admin, 'GET', '/api/images/' + imgId + '/original', undefined, { buffer: true });
  ok(r.status === 200 && r.data.equals(PNG), '/original serves the original');
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n%synthetic\n'), crypto.randomBytes(20 * 1024 * 1024)]);
  r = await call(admin, 'POST', '/api/images', pdf, { raw: true, contentType: 'application/pdf' });
  ok(r.status === 200 && r.data.id, 'upload 20 MB pdf', r.status);
  const pdfId = r.data.id;
  r = await call(admin, 'GET', '/api/images/' + pdfId, undefined, { buffer: true });
  ok(r.status === 200 && sha(r.data) === sha(pdf) && r.headers.get('content-type') === 'application/pdf', '20 MB pdf round-trips');
  cur = (await call(admin, 'GET', '/api/notes/' + noteIds[2])).data.note;
  await call(admin, 'PUT', '/api/notes/' + noteIds[2], { title: cur.title, content: cur.content + '\n\n![report](pdf:' + pdfId + ')', baseContent: cur.content, folderId: fid });
  r = await call(admin, 'POST', '/api/images', Buffer.from('nope'), { raw: true, contentType: 'text/plain' });
  ok(r.status === 400, 'text/plain upload rejected', r.status);

  section('book versions');
  r = await call(admin, 'POST', '/api/books/' + fid + '/versions', { title: '專案 A', label: '初版', chapters: noteIds });
  ok(r.status === 200 && r.data.version && r.data.version.chapters === 3, 'create book version', r.data);
  const bvId = r.data.version.id;
  r = await call(admin, 'GET', '/api/books/' + fid + '/versions');
  ok(r.status === 200 && r.data.versions.length === 1 && r.data.versions[0].id === bvId, 'list book versions', r.data);
  r = await call(admin, 'GET', '/api/book-versions/' + bvId);
  ok(r.status === 200 && r.data.version.chapters.length === 3 && r.data.version.chapters.every(c => !c.missing), 'get book version', r.data);
  r = await call(admin, 'GET', '/api/book-versions/' + bvId + '/chapters/' + noteIds[1]);
  ok(r.status === 200 && r.data.chapter.content.includes('A 改標題行'), 'chapter content pinned', r.data);
  cur = (await call(admin, 'GET', '/api/notes/' + noteIds[1])).data.note;
  await call(admin, 'PUT', '/api/notes/' + noteIds[1], { title: cur.title, content: 'overwritten', baseContent: cur.content, folderId: fid });
  r = await call(admin, 'POST', '/api/book-versions/' + bvId + '/restore');
  ok(r.status === 200 && r.data.restored === 1, 'restore book restores the changed chapter only', r.data);
  r = await call(admin, 'GET', '/api/notes/' + noteIds[1]);
  ok(r.data.note.content.includes('A 改標題行'), 'chapter text is back');
  r = await call(admin, 'POST', '/api/books/' + fid + '/versions', { title: '專案 A', chapters: [noteIds[0], noteIds[1]] });
  const bv2 = r.data.version.id;
  r = await call(bob, 'GET', '/api/book-versions/' + bvId);
  ok(r.status === 404, "bob cannot read admin's book version", r.status);
  r = await call(admin, 'DELETE', '/api/book-versions/' + bv2);
  ok(r.status === 200, 'delete second book version');
  r = await call(admin, 'GET', '/api/notes/' + noteIds[2] + '/versions');
  ok(r.data.versions.filter(v => v.label === '電子書版本').length === 1, 'pinned versions of the deleted book released, the other kept',
    r.data.versions.filter(v => v.label === '電子書版本').length);

  section('public share links');
  const html = '<!doctype html><html><head><meta charset="utf-8"><title>專案 A</title></head><body>' +
    '<h1>專案 A</h1><p>' + 'x'.repeat(2 * 1024 * 1024) + '</p><script>console.log("inline")</script></body></html>';
  r = await call(admin, 'POST', '/api/books/' + fid + '/links', { title: '專案 A', html: html, chapters: 3, expiresDays: 0 });
  ok(r.status === 200 && /^[0-9a-f]{64}$/.test(r.data.link.token) && r.data.link.expiresAt === null, 'create share link', r.data);
  const tok = r.data.link.token;
  r = await call(anon, 'GET', '/s/' + tok);
  ok(r.status === 200 && r.data === html, 'anonymous GET serves the exact snapshot');
  ok((r.headers.get('content-security-policy') || '').includes("default-src 'none'") && !r.headers.get('set-cookie'),
    'snapshot has its own CSP and sets no cookie');
  r = await call(admin, 'PUT', '/api/book-links/' + tok, { html: html.replace('inline', 'updated'), chapters: 3, expiresDays: 30 });
  ok(r.status === 200 && r.data.link.expiresAt > Date.now(), 'refresh link + expiry', r.data);
  r = await call(anon, 'GET', '/s/' + tok);
  ok(r.status === 200 && r.data.includes('updated'), 'same URL serves the new snapshot');
  r = await call(admin, 'GET', '/api/books/' + fid + '/links');
  ok(r.status === 200 && r.data.links.length === 1 && r.data.links[0].views >= 2 && r.data.links[0].html === undefined, 'list: views counted, html not shipped', r.data);
  r = await call(admin, 'POST', '/api/books/' + fid + '/links', { title: '第二條', html: html, chapters: 3, expiresDays: 7 });
  const tok2 = r.data.link.token;
  r = await call(admin, 'DELETE', '/api/book-links/' + tok2);
  ok(r.status === 200, 'revoke second link');
  r = await call(anon, 'GET', '/s/' + tok2);
  ok(r.status === 404, 'revoked link is 404', r.status);
  r = await call(anon, 'GET', '/s/' + 'f'.repeat(64));
  ok(r.status === 404, 'unknown token is 404', r.status);
  r = await call(bob, 'POST', '/api/books/' + fid + '/links', { html: html });
  ok(r.status === 404, "bob cannot share admin's folder", r.status);

  section('SSE');
  {
    const ac = new AbortController();
    const res = await fetch(BASE + '/api/notes/' + noteIds[0] + '/events', { headers: { Cookie: admin.header() }, signal: ac.signal });
    ok(res.status === 200 && (res.headers.get('content-type') || '').includes('text/event-stream'), 'stream opens');
    const reader = res.body.getReader();
    let got = '';
    const waiter = (async function () {
      const dec = new TextDecoder();
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r({ done: false, value: null }), 500))]);
        if (chunk.done) break;
        if (chunk.value) got += dec.decode(chunk.value);
        if (/event: update/.test(got)) break;
      }
    })();
    await new Promise(r => setTimeout(r, 300));
    cur = (await call(bob, 'GET', '/api/notes/' + noteIds[0])).data.note;
    await call(bob, 'PUT', '/api/notes/' + noteIds[0], { title: cur.title, content: cur.content + '\nfrom bob', baseContent: cur.content });
    await waiter;
    ok(/event: update/.test(got) && /"by":"bob"/.test(got), "bob's save arrives on admin's stream", got.slice(0, 200));
    ac.abort();
  }

  section('admin');
  r = await call(bob, 'GET', '/api/admin/users');
  ok(r.status === 403, 'non-admin is 403', r.status);
  r = await call(admin, 'GET', '/api/admin/users');
  ok(r.status === 200 && r.data.users.length === 2 && r.data.users.every(u => typeof u.notes === 'number'), 'list users with numeric counts', r.data);
  r = await call(admin, 'POST', '/api/admin/users/' + bobId + '/disabled', { disabled: true });
  ok(r.status === 200 && r.data.disabled === true, 'disable bob', r.data);
  r = await call(bob, 'GET', '/api/notes');
  ok(r.status === 401, "bob's session died with the disable", r.status);
  r = await login(bob, BOB, BOB_PW);
  ok(r.status === 403, 'disabled bob cannot log in', r.status);
  r = await call(admin, 'POST', '/api/admin/users/' + bobId + '/disabled', { disabled: false });
  ok(r.status === 200, 're-enable bob');
  r = await login(bob, BOB, BOB_PW);
  ok(r.status === 200, 'bob logs in again');
  r = await call(admin, 'POST', '/api/admin/users/' + bobId + '/role', { role: 'admin' });
  ok(r.status === 200 && r.data.role === 'admin', 'promote bob');
  r = await call(admin, 'POST', '/api/admin/users/' + bobId + '/role', { role: 'user' });
  ok(r.status === 200 && r.data.role === 'user', 'demote bob');
  const me = (await call(admin, 'GET', '/api/me')).data.user;
  r = await call(admin, 'POST', '/api/admin/users/' + me.id + '/role', { role: 'user' });
  ok(r.status === 400, 'cannot demote self', r.status);
  r = await call(admin, 'GET', '/api/admin/storage');
  ok(r.status === 200 && r.data.images.count >= 2 && r.data.images.bytes > 20 * 1024 * 1024 && r.data.notes.count >= 4 &&
     r.data.versions.count > 0 && r.data.links.count === 1 && Array.isArray(r.data.perUser) && typeof r.data.dbBytes === 'number',
    'storage panel numbers', r.data && { images: r.data.images, notes: r.data.notes, links: r.data.links, dbBytes: r.data.dbBytes, dataDir: r.data.dataDir });

  if (!OLD) {
    section('request limits and static allow-list (MariaDB build only)');
    const big = JSON.stringify({ title: 'x', content: 'y'.repeat(BODY_LIMIT + 1024) });
    r = await call(admin, 'POST', '/api/notes', big, { raw: true, contentType: 'application/json' });
    ok(r.status === 413, 'oversize body is 413', r.status);
    r = await call(admin, 'POST', '/api/notes', '{bad json', { raw: true, contentType: 'application/json' });
    ok(r.status === 400, 'bad JSON is 400', r.status);
    const expect = [
      ['/', 200], ['/index.html', 200], ['/app.css', 200], ['/js/store.js', 200], ['/logo.png', 200],
      ['/vendor/fonts/fonts.css', 200], ['/vendor/marked.min.js', 200],
      ['/README.md', 404], ['/CLAUDE.md', 404], ['/docs/interface.png', 404], ['/app.css.orig', 404],
      ['/.git/HEAD', 404], ['/server/db.js', 404], ['/vendor/../server/db.js', 404], ['/package.json', 404],
      ['/%', 400]
    ];
    for (const [p, want] of expect) {
      const s = await fetch(BASE + p, { redirect: 'manual' });
      await s.arrayBuffer();
      ok(s.status === want, 'static ' + p + ' → ' + want, s.status);
    }
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });

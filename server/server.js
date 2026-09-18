/* server.js — HTTP server: static front-end + /api, on MariaDB.
 *
 * Run:  node server/server.js
 * Env:  see deploy/env.example (PORT, HOST, DB_*, REGISTER_MODE, INVITE_CODE,
 *       TRUST_PROXY, REQUIRE_HTTPS, MAX_BODY_BYTES, ...)
 *
 * Meant to sit behind a TLS-terminating proxy (cloudflared, nginx, Caddy) with
 * HOST=127.0.0.1 and TRUST_PROXY=1; it speaks plain HTTP itself.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const auth = require('./auth');
const api = require('./api');
const dbmod = require('./db');
const hub = require('./hub');
const linkpreview = require('./linkpreview');
const settings = require('./settings');
const backup = require('./backup');

// A crash is better than limping on with unknown state; systemd (or whoever
// supervises the process) restarts it. Log first so the reason is in the journal.
process.on('uncaughtException', function (e) {
  console.error('[fatal] uncaught exception:', e && e.stack || e);
  process.exit(1);
});
process.on('unhandledRejection', function (e) {
  console.error('[fatal] unhandled rejection:', e && e.stack || e);
  process.exit(1);
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf'
};

// The front-end never loads anything off-site, so the policy can be tight.
// script-src stays free of 'unsafe-inline': the print document builds its
// paged.js config from the parent frame instead of an inline <script>.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  // Allow embedding same-origin PDFs (/api/images/:id) in an <iframe>; still blocks
  // any cross-origin framing, in either direction.
  "frame-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

// Did this request reach the proxy over TLS? Only trusted when TRUST_PROXY=1,
// because anyone can send these headers straight to the app otherwise.
// cloudflared sends X-Forwarded-Proto; Cloudflare also sends CF-Visitor
// ({"scheme":"https"}), accepted as a second opinion.
function isSecure(req) {
  if (config.trustProxy) {
    const xfp = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (xfp === 'https') return true;
    const cf = req.headers['cf-visitor'];
    if (cf) {
      try { return JSON.parse(String(cf)).scheme === 'https'; } catch (e) { return false; }
    }
    return false;
  }
  return !!req.socket.encrypted;
}

function securityHeaders(req, res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // HSTS is only meaningful on a response that actually travelled over TLS.
  if (config.requireHttps && isSecure(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function json(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, extraHeaders || {});
  res.writeHead(status, headers);
  res.end(body);
}

// Reads the whole body into memory (uploads are posted raw and stored whole).
// Past the limit the request is paused rather than destroyed, so the 413 can
// still be written; Node then closes the connection because the request was
// never fully consumed.
function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0, done = false;
    const chunks = [];
    req.on('data', function (c) {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.pause();
        const err = new Error('payload too large');
        err.status = 413;
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    req.on('error', function (e) { if (!done) { done = true; reject(e); } });
  });
}

async function readJSON(req) {
  const buf = await readBody(req, config.maxBodyBytes);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch (e) {
    const err = new Error('bad json');
    err.status = 400;
    throw err;
  }
}

// ---------------- uploads ----------------
// An upload is stored with whatever type the browser claimed, but only types
// that are inert when opened on this origin are ever served as themselves:
// raster images, PDF (the in-note viewer needs it inline) and SVG under a
// sandbox policy. Everything else — HTML, JavaScript, anything unknown — goes
// out as an octet-stream attachment. Served as-is, an uploaded .js would satisfy
// script-src 'self' and an uploaded page would run inside the app's origin.
const INLINE_UPLOAD = /^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|svg\+xml)|application\/pdf)$/;

function uploadMime(header) {
  const t = String(header || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][\w!#$&^.+-]{0,62}\/[a-z0-9][\w!#$&^.+-]{0,126}$/.test(t) ? t : 'application/octet-stream';
}

// X-File-Name carries encodeURIComponent(file.name), since a raw header cannot
// hold CJK. Path separators and control characters never survive.
function uploadName(header) {
  if (!header) return null;
  let s;
  try { s = decodeURIComponent(String(header)); } catch (e) { return null; }
  s = s.replace(/[\u0000-\u001f\u007f\\/]+/g, '_').trim().slice(0, 200);
  return s || null;
}

function sendUpload(res, row, buf) {
  const mime = String(row.mime || '').toLowerCase();
  const headers = {
    'Content-Length': buf.length,
    'Cache-Control': 'private, no-cache',
    'X-Content-Type-Options': 'nosniff'
  };
  if (INLINE_UPLOAD.test(mime)) {
    headers['Content-Type'] = mime;
    if (mime === 'image/svg+xml') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
  } else {
    const name = row.name || row.id;
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const utf8 = encodeURIComponent(name).replace(/['()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Disposition'] = 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + utf8;
    headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
  }
  res.writeHead(200, headers);
  return res.end(buf);
}

// ---------------- static ----------------
//
// The static root is the repo root, which also holds the server code, docs,
// git metadata and whatever else lives next to index.html. Rather than
// blacklisting, only the files the front-end actually loads are served: the
// page, its stylesheet, the logo/favicon, js/*.js and the pinned vendor tree.
// A path segment may not start with "." so dotfiles and ".." never match.
const STATIC_ALLOW = new RegExp(
  '^/(?:index\\.html|app\\.css|logo\\.png|favicon\\.(?:ico|png)' +
  '|js/[\\w-][\\w.-]*\\.js' +
  '|vendor/(?:[\\w-][\\w.-]*/)*[\\w-][\\w.-]*\\.(?:js|css|woff2|woff|ttf|png|svg))$');

function serveStatic(req, res, urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); }
  catch (e) { return json(res, 400, { error: 'bad request' }); }
  if (rel === '/') rel = '/index.html';
  if (!STATIC_ALLOW.test(rel)) return json(res, 404, { error: 'not found' });

  const full = path.resolve(config.staticDir, '.' + rel);
  // Belt and braces: the allow-list already excludes traversal, but confirm the
  // resolved path is still inside the root.
  if (full !== config.staticDir && !full.startsWith(config.staticDir + path.sep)) {
    return json(res, 403, { error: 'forbidden' });
  }
  fs.stat(full, function (err, st) {
    if (err || !st.isFile()) { json(res, 404, { error: 'not found' }); return; }
    const ext = path.extname(full).toLowerCase();
    // The app's own code must never come from cache: `no-store` is the only
    // value that stops "I updated the CSS but the page didn't change".
    // vendor/ holds pinned third-party assets (libraries, the bundled webfonts)
    // that change only when they are deliberately replaced, so those may be
    // cached for a day — by the browser and by a CDN edge in front of us.
    const isVendor = rel.startsWith('/vendor/');
    const own = !isVendor && (ext === '.html' || ext === '.css' || ext === '.js');
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': own ? 'no-store, no-cache, must-revalidate'
        : (isVendor ? 'public, max-age=86400' : 'no-cache'),
      'Last-Modified': st.mtime.toUTCString()
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full).pipe(res);
  });
}

// ---------------- API ----------------
function requireUser(req) {
  const cookies = auth.parseCookies(req.headers.cookie);
  return auth.userFromToken(cookies[auth.COOKIE]);
}

// SameSite=Strict already blocks cross-site cookie attachment; requiring a custom
// header on writes is a second lock, since a simple cross-origin form cannot set it.
function csrfOk(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  return req.headers['x-requested-with'] === 'report-notes';
}

// Only feeds the login throttle. Behind Cloudflare the real address is in
// CF-Connecting-IP; a generic proxy puts it first in X-Forwarded-For.
function clientIp(req) {
  if (config.trustProxy) {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || '';
}

// Liveness for the operator: does the process answer and can it reach the DB?
// No session, no redirect, and bounded so a hung pool cannot hang the check.
async function health(res) {
  let ok = false, timer = null;
  try {
    const r = await Promise.race([
      dbmod.q.ping.get(),
      new Promise(function (_, reject) { timer = setTimeout(function () { reject(new Error('timeout')); }, 2000); })
    ]);
    ok = !!(r && r.ok);
  } catch (e) { ok = false; }
  if (timer) clearTimeout(timer);
  json(res, ok ? 200 : 503, { ok: ok });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (!csrfOk(req)) return json(res, 403, { error: 'CSRF check failed' });

  // ---- public endpoints ----
  if (p === '/api/register' && method === 'POST') {
    const body = await readJSON(req);
    const r = await auth.createUser(body.username, body.password, body.invite);
    if (r.error) return json(res, 400, { error: r.error });
    const token = await auth.createSession(r.user.id);
    return json(res, 200, { user: r.user }, { 'Set-Cookie': auth.sessionCookie(token, isSecure(req)) });
  }

  if (p === '/api/login' && method === 'POST') {
    const body = await readJSON(req);
    const ip = clientIp(req);
    const wait = auth.isLockedOut(body.username, ip);
    if (wait) return json(res, 429, { error: '嘗試次數過多，請於 ' + wait + ' 秒後再試' });
    const user = await auth.verifyPassword(String(body.username || ''), String(body.password || ''));
    if (!user) {
      auth.noteFailure(body.username, ip);
      // Same message either way: never reveal whether the account exists.
      return json(res, 401, { error: '帳號或密碼錯誤' });
    }
    if (user.disabled) return json(res, 403, { error: '此帳號已被停用，請聯絡管理員' });
    auth.noteSuccess(body.username, ip);
    const token = await auth.createSession(user.id);
    return json(res, 200, { user: user }, { 'Set-Cookie': auth.sessionCookie(token, isSecure(req)) });
  }

  if (p === '/api/logout' && method === 'POST') {
    const cookies = auth.parseCookies(req.headers.cookie);
    await auth.destroySession(cookies[auth.COOKIE]);
    return json(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(isSecure(req)) });
  }

  if (p === '/api/me' && method === 'GET') {
    const user = await requireUser(req);
    return json(res, 200, {
      user: user ? {
        id: user.id, username: user.username, role: user.role,
        mustChangePassword: !!user.must_change_pw
      } : null,
      registerMode: settings.get().registerMode
    });
  }

  // ---- everything below needs a session ----
  const user = await requireUser(req);
  if (!user) return json(res, 401, { error: '請先登入' });

  // api.* results are `{status, error}` for failures and the payload otherwise.
  // A forgotten `await` would hand a Promise here — truthy, no `.status` — and
  // serialise as `{}` with a 200, so refuse it loudly instead.
  const send = function (r) {
    if (r && typeof r.then === 'function') throw new Error('send() got a Promise — missing await');
    return (r && r.status) ? json(res, r.status, { error: r.error || 'error' }) : json(res, 200, r);
  };

  // 小說區：重新輸入目前帳號的密碼，通過就把這個 session 標記為已解鎖（js/app.js
  // promptNovelPassword）。跟一般 API 錯誤不同：這裡的失敗一律回一句「密碼不正確」，
  // 不分帳號是否存在——帳號本來就是自己的，不用假裝不知道。失敗一定是 403，不是
  // 401——這裡的登入 session 本身完全沒事，401 會被 js/store.js 的 req() 當成
  // 「session 過期」，跳出「請重新登入」的 alert() 把使用者整個登出，那是要處理
  // 完全不同的錯（session cookie 失效），不是「小說第二層密碼打錯了」。
  if (p === '/api/novel/unlock' && method === 'POST') {
    const body = await readJSON(req);
    const cookies = auth.parseCookies(req.headers.cookie);
    const r = await auth.unlockNovel(cookies[auth.COOKIE], user, body.password, clientIp(req));
    return r.error ? json(res, 403, { error: r.error }) : json(res, 200, { ok: true });
  }

  if (p === '/api/change-password' && method === 'POST') {
    const body = await readJSON(req);
    const check = await auth.verifyPassword(user.username, String(body.current || ''));
    if (!check || check.disabled) return json(res, 401, { error: '目前的密碼不正確' });
    if (String(body.next || '') === String(body.current || '')) {
      return json(res, 400, { error: '新密碼不能與目前的密碼相同' });
    }
    const r = await auth.setPassword(user.id, String(body.next || ''));
    if (r.error) return json(res, 400, { error: r.error });
    return json(res, 200, { ok: true });
  }

  // ---- admin only ----
  if (p.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return json(res, 403, { error: '需要管理員權限' });

    if (p === '/api/admin/users' && method === 'GET') return json(res, 200, await api.adminListUsers(user));
    if (p === '/api/admin/storage' && method === 'GET') return json(res, 200, await api.adminStorage());
    // Registration mode and invite code (server/settings.js).
    if (p === '/api/admin/settings' && method === 'GET') return json(res, 200, settings.get());
    if (p === '/api/admin/settings' && method === 'PUT') {
      const r = await settings.update(await readJSON(req), user);
      return r.error ? json(res, 400, { error: r.error }) : json(res, 200, r);
    }

    let am;
    if ((am = p.match(/^\/api\/admin\/users\/(\d+)\/disabled$/)) && method === 'POST') {
      const body = await readJSON(req);
      return send(await api.adminSetDisabled(user, am[1], !!body.disabled));
    }
    if ((am = p.match(/^\/api\/admin\/users\/(\d+)\/role$/)) && method === 'POST') {
      const body = await readJSON(req);
      return send(await api.adminSetRole(user, am[1], String(body.role || '')));
    }
    if ((am = p.match(/^\/api\/admin\/users\/(\d+)$/)) && method === 'DELETE') {
      return send(await api.adminDeleteUser(user, am[1]));
    }
    return json(res, 404, { error: 'not found' });
  }

  if (p === '/api/notes' && method === 'GET') return json(res, 200, { notes: await api.listNotes(user) });
  if (p === '/api/notes' && method === 'POST') {
    const r = await api.createNote(user, await readJSON(req));
    return r && r.status ? send(r) : json(res, 200, { note: r });
  }

  let m;
  if ((m = p.match(/^\/api\/notes\/([\w.-]+)$/))) {
    const id = m[1];
    if (method === 'GET') {
      const note = await api.getNote(user, id);
      return note ? json(res, 200, { note }) : json(res, 404, { error: 'not found' });
    }
    if (method === 'PUT') return send(await api.updateNote(user, id, await readJSON(req)));
    if (method === 'DELETE') return send(await api.deleteNote(user, id));
  }

  // Trash: owner-only. DELETE /api/notes/:id above only moves a note here; these
  // are the only routes that can see a trashed row again.
  if (p === '/api/trash' && method === 'GET') return json(res, 200, await api.listTrash(user));
  if (p === '/api/trash' && method === 'DELETE') return send(await api.emptyTrash(user));
  if ((m = p.match(/^\/api\/trash\/([\w.-]+)$/)) && method === 'DELETE') return send(await api.purgeNote(user, m[1]));
  if ((m = p.match(/^\/api\/notes\/([\w.-]+)\/restore$/)) && method === 'POST') return send(await api.restoreNote(user, m[1]));

  // Live-collaboration event stream (Server-Sent Events). Held open; the client's
  // EventSource reconnects on its own if the socket drops. The 25 s keepalive
  // ping in hub.js stays under Cloudflare's idle timeout.
  if ((m = p.match(/^\/api\/notes\/([\w.-]+)\/events$/)) && method === 'GET') {
    if (!(await api.getNote(user, m[1]))) return json(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'          // stop nginx buffering the stream
    });
    res.write('retry: 3000\n\n');
    const unsubscribe = hub.subscribe(m[1], res, user);
    req.on('close', unsubscribe);
    return;                              // keep the response open
  }

  if ((m = p.match(/^\/api\/notes\/([\w.-]+)\/access$/)) && method === 'PUT') {
    return send(await api.setAccess(user, m[1], await readJSON(req)));
  }
  // Live caret relay for collaborative editing (transient, never stored).
  if ((m = p.match(/^\/api\/notes\/([\w.-]+)\/cursor$/)) && method === 'POST') {
    return send(await api.broadcastCursor(user, m[1], await readJSON(req)));
  }

  // Version history. The list is read-only for anyone who can read the note;
  // restoring needs edit rights and renaming/deleting a version needs ownership,
  // all enforced in api.js rather than here.
  if ((m = p.match(/^\/api\/notes\/([\w.-]+)\/versions$/))) {
    if (method === 'GET') return send(await api.listVersions(user, m[1]));
    if (method === 'POST') return send(await api.createVersion(user, m[1], await readJSON(req)));
  }
  if ((m = p.match(/^\/api\/notes\/([\w.-]+)\/versions\/(\d+)$/))) {
    if (method === 'GET') return send(await api.getVersion(user, m[1], m[2]));
    if (method === 'PUT') return send(await api.renameVersion(user, m[1], m[2], await readJSON(req)));
    if (method === 'DELETE') return send(await api.deleteVersion(user, m[1], m[2]));
  }
  if ((m = p.match(/^\/api\/notes\/([\w.-]+)\/versions\/(\d+)\/restore$/)) && method === 'POST') {
    return send(await api.restoreVersion(user, m[1], m[2]));
  }

  // E-book versions are keyed by the folder that is the book.
  if ((m = p.match(/^\/api\/books\/([\w.-]+)\/versions$/))) {
    if (method === 'GET') return send(await api.listBookVersions(user, m[1]));
    if (method === 'POST') return send(await api.createBookVersion(user, m[1], await readJSON(req)));
  }
  if ((m = p.match(/^\/api\/book-versions\/(\d+)$/))) {
    if (method === 'GET') return send(await api.getBookVersion(user, m[1]));
    if (method === 'DELETE') return send(await api.deleteBookVersion(user, m[1]));
  }
  if ((m = p.match(/^\/api\/book-versions\/(\d+)\/restore$/)) && method === 'POST') {
    return send(await api.restoreBookVersion(user, m[1]));
  }
  if ((m = p.match(/^\/api\/book-versions\/(\d+)\/chapters\/([\w.-]+)$/)) && method === 'GET') {
    return send(await api.getBookVersionChapter(user, m[1], m[2]));
  }

  // Public share links. Creating and refreshing one carries the whole packed
  // book in the JSON body, so MAX_BODY_BYTES is the real ceiling on book size.
  if ((m = p.match(/^\/api\/books\/([\w.-]+)\/links$/))) {
    if (method === 'GET') return send(await api.listBookLinks(user, m[1]));
    if (method === 'POST') return send(await api.createBookLink(user, m[1], await readJSON(req)));
  }
  if ((m = p.match(/^\/api\/book-links\/([0-9a-f]{64})$/))) {
    if (method === 'PUT') return send(await api.updateBookLink(user, m[1], await readJSON(req)));
    if (method === 'DELETE') return send(await api.deleteBookLink(user, m[1]));
  }

  if ((m = p.match(/^\/api\/notes\/([\w.-]+)\/shares$/))) {
    if (method === 'GET') return send(await api.listShares(user, m[1]));
    if (method === 'POST') return send(await api.addShare(user, m[1], await readJSON(req)));
  }
  if ((m = p.match(/^\/api\/notes\/([\w.-]+)\/shares\/([\w.-]+)$/))) {
    if (method === 'DELETE') return send(await api.removeShare(user, m[1], m[2]));
  }

  if (p === '/api/folders' && method === 'GET') return json(res, 200, { folders: await api.listFolders(user) });
  if (p === '/api/folders' && method === 'POST') {
    const r = await api.createFolder(user, await readJSON(req));
    return r && r.status ? send(r) : json(res, 200, { folder: r });
  }
  if ((m = p.match(/^\/api\/folders\/([\w.-]+)$/))) {
    if (method === 'PUT') return send(await api.updateFolder(user, m[1], await readJSON(req)));
    if (method === 'DELETE') return send(await api.deleteFolder(user, m[1]));
  }

  // File library (js/imagelib.js): the caller's uploads, metadata only, each with the notes that embed it.
  if (p === '/api/images' && method === 'GET') return json(res, 200, await api.listImages(user));
  if (p === '/api/images' && method === 'POST') {
    // Any file. Images and PDFs are embedded in notes (img: / pdf:), anything
    // else is an attachment link (file:). What a stored file is allowed to do
    // when it is served back is sendUpload's decision, not the uploader's.
    const mime = uploadMime(req.headers['content-type']);
    const name = uploadName(req.headers['x-file-name']);
    const buf = await readBody(req, config.maxBodyBytes);
    return json(res, 200, await api.createImage(user, mime, buf, name));
  }
  if ((m = p.match(/^\/api\/images\/([\w.-]+)$/))) {
    const id = m[1];
    if (method === 'GET') {
      const row = await api.getImage(user, id);
      if (!row) return json(res, 404, { error: 'not found' });
      return sendUpload(res, row, row.data);
    }
    if (method === 'PUT') return send(await api.saveImage(user, id, await readJSON(req)));
    if (method === 'DELETE') return send(await api.deleteImage(user, id));
  }
  if ((m = p.match(/^\/api\/images\/([\w.-]+)\/meta$/))) {
    if (method === 'GET') {
      const row = await api.getImage(user, m[1]);
      if (!row) return json(res, 404, { error: 'not found' });
      return json(res, 200, {
        id: row.id, mime: row.mime,
        shapes: row.shapes ? JSON.parse(row.shapes) : [],
        hasOriginal: !!row.original,
        canAnnotate: row.owner_id === user.id
      });
    }
  }
  if ((m = p.match(/^\/api\/images\/([\w.-]+)\/original$/))) {
    if (method === 'GET') {
      const row = await api.getImage(user, m[1]);
      if (!row) return json(res, 404, { error: 'not found' });
      return sendUpload(res, row, row.original || row.data);
    }
  }

  // Manual order (js/sorting.js): one folder level's complete order after a drag.
  if (p === '/api/order' && method === 'PUT') return send(await api.saveOrder(user, await readJSON(req)));

  // Backup and restore (server/backup.js, js/backup.js). The zip streams straight
  // out; a restore comes in as chunks into a temp file and runs as a job.
  if (p === '/api/backup' && method === 'GET') {
    const scope = url.searchParams.get('scope') === 'site' ? 'site' : 'mine';
    if (scope === 'site' && user.role !== 'admin') return json(res, 403, { error: '整個站台的備份需要管理員權限' });
    return backup.exportZip(user, scope, req, res);
  }
  if (p === '/api/backup/upload' && method === 'POST') return json(res, 200, backup.createUpload(user));
  if ((m = p.match(/^\/api\/backup\/upload\/([0-9a-f]{24})$/))) {
    if (method === 'GET') return send(backup.uploadStatus(user, m[1]));
    if (method === 'PUT') {
      const buf = await readBody(req, config.maxBodyBytes);
      return send(await backup.appendUpload(user, m[1], Number(url.searchParams.get('offset')), buf));
    }
    if (method === 'DELETE') return send(backup.dropUpload(user, m[1]));
  }
  if ((m = p.match(/^\/api\/backup\/upload\/([0-9a-f]{24})\/inspect$/)) && method === 'POST') {
    return send(backup.inspectUpload(user, m[1]));
  }
  if ((m = p.match(/^\/api\/backup\/upload\/([0-9a-f]{24})\/restore$/)) && method === 'POST') {
    return send(backup.startRestore(user, m[1], await readJSON(req)));
  }
  if ((m = p.match(/^\/api\/backup\/jobs\/([0-9a-f]{24})$/)) && method === 'GET') return send(backup.jobStatus(user, m[1]));

  // Link preview cards. Errors are 200 { error } — an unreachable site is an
  // ordinary answer for a card, which then just shows the address.
  if (p === '/api/link-preview' && method === 'GET') {
    if (!config.linkPreview) return json(res, 200, { error: '連結預覽已停用' });
    const info = await linkpreview.preview(url.searchParams.get('url'));
    return json(res, 200, info, info.error ? {} : { 'Cache-Control': 'private, max-age=3600' });
  }
  if (p === '/api/link-preview/image' && method === 'GET') {
    if (!config.linkPreview) return json(res, 404, { error: 'not found' });
    const img = await linkpreview.image(url.searchParams.get('url'));
    if (img.error) return json(res, 404, { error: img.error });
    res.writeHead(200, {
      'Content-Type': img.type,
      'Content-Length': img.body.length,
      'Cache-Control': 'private, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    });
    return res.end(img.body);
  }

  return json(res, 404, { error: 'not found' });
}

// ---------------- entry ----------------
const server = http.createServer(function (req, res) {
  securityHeaders(req, res);

  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch (e) { return json(res, 400, { error: 'bad request' }); }

  // The health check comes before the HTTPS redirect so a plain
  // `curl 127.0.0.1:8080/api/health` from the box itself gets an answer.
  if (url.pathname === '/api/health') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    health(res).catch(function () { if (!res.headersSent) json(res, 503, { ok: false }); });
    return;
  }

  if (config.requireHttps && config.trustProxy && !isSecure(req)) {
    const host = String(req.headers.host || '').replace(/[^\w.:-]/g, '');
    res.writeHead(301, { Location: 'https://' + host + req.url });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(function (e) {
      if (res.headersSent) return;
      // Client-side faults get their own status; never leak a stack trace.
      if (e && e.status === 413) {
        return json(res, 413, { error: '內容太大（上限 ' + Math.round(config.maxBodyBytes / 1048576) + ' MB）' },
          { Connection: 'close' });
      }
      if (e && e.status === 400) return json(res, 400, { error: 'bad request' });
      console.error('[api]', req.method, url.pathname, '-', e && e.message);
      // A locked row or a database that is restarting is transient and the
      // client can retry — say so instead of a generic failure it cannot act on.
      if (dbmod.isBusy(e)) {
        return json(res, 503, { error: '資料庫忙碌中，請稍後再試' }, { 'Retry-After': '1' });
      }
      json(res, 500, { error: 'server error' });
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });

  // The one route that answers without a session: a shared e-book snapshot.
  // It serves a stored, self-contained HTML file and nothing else, under its own
  // locked-down policy — no network access of any kind is granted to that page,
  // so even if a note contained something hostile it could not call home.
  const share = url.pathname.match(/^\/s\/([0-9a-f]{64})$/);
  if (share) {
    serveSharedBook(req, res, share[1]).catch(function (e) {
      console.error('[share]', e && e.message);
      if (!res.headersSent) sharePage(res, 500, '伺服器錯誤', '請稍後再試。');
    });
    return;
  }

  serveStatic(req, res, url.pathname);
});

// cloudflared (and most reverse proxies) keep idle upstream connections around to
// reuse them — cloudflared for 90 s by default — while Node closes an idle one
// after 5 s. When the two cross, the proxy sends a request down a socket Node is
// just closing: it retries a GET by itself, but a POST (new folder, autosave)
// comes back as a 502. Outlasting the proxy means the proxy always closes first.
server.keepAliveTimeout = 95 * 1000;
server.headersTimeout = 100 * 1000;   // must exceed keepAliveTimeout

async function serveSharedBook(req, res, token) {
  const row = await api.publicBook(token);
  if (!row) return sharePage(res, 404, '找不到這本書', '這個分享連結不存在，或已經被取消。');
  if (row.expired) return sharePage(res, 410, '連結已過期', '請向分享者索取新的連結。');

  const body = Buffer.from(row.html, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    // Everything the page needs is already inside it, so nothing may be fetched.
    'Content-Security-Policy': [
      "default-src 'none'",
      "img-src data: blob:",
      "media-src data:",
      "font-src data:",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    // A shared link is not meant to end up in a search index.
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Cache-Control': 'private, no-store'
  });
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

// A plain page for the share route's own errors. The app's index.html would be
// wrong here: whoever followed the link has no account and nothing to log into.
function sharePage(res, status, title, message) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<title>' + esc(title) + '</title><style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'background:#f6f7f9;color:#171a21;font:16px/1.7 -apple-system,"Segoe UI","Microsoft JhengHei",sans-serif}' +
    'main{max-width:420px;padding:32px;background:#fff;border:1px solid #e3e6ec;text-align:center}' +
    'h1{margin:0 0 10px;font-size:20px}p{margin:0;color:#5a6675}' +
    '@media(prefers-color-scheme:dark){body{background:#13161c;color:#e4e8ef}' +
    'main{background:#191d24;border-color:#2b3038}p{color:#8d95a3}}' +
    '</style></head><body><main><h1>' + esc(title) + '</h1><p>' + esc(message) + '</p></main></body></html>';
  const buf = Buffer.from(html, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

// Close the pool cleanly on exit. Open SSE streams keep server.close() from
// completing, so the 3 s watchdog is the usual exit path.
let closing = false, finished = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log('\n收到 ' + signal + '，正在關閉…');
  const finish = function () {
    if (finished) return;
    finished = true;
    dbmod.close().catch(function () {}).then(function () {
      console.log('已安全關閉');
      process.exit(0);
    });
  };
  server.close(finish);
  setTimeout(finish, 3000).unref();
}
['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'].forEach(function (s) {
  try { process.on(s, () => shutdown(s)); } catch (e) {}
});

// Low-disk watch: one line at startup and then hourly, so an operator tailing
// the log hears about it before saves start failing. Admins also see it in-app.
function checkStorage() {
  try {
    const s = api.storageSummary();
    if (s.low && s.disk) {
      console.warn('[storage] ⚠ 磁碟剩餘空間不足：剩 ' + (s.disk.free / 1048576).toFixed(0) + ' MB / ' +
        (s.disk.total / 1073741824).toFixed(1) + ' GB（門檻 ' + config.storageWarnMb + ' MB 或 ' + config.storageWarnPct + '%）');
    }
  } catch (e) { /* statfs unsupported here */ }
}

// Trash retention: notes in the bin longer than TRASH_KEEP_DAYS are deleted for
// good — the same hard delete as emptying the bin — at startup and then hourly.
function purgeTrash() {
  api.purgeExpiredTrash().then(function (n) {
    if (n) console.log('[trash] 已永久刪除 ' + n + ' 篇在垃圾桶超過 ' + config.trashKeepDays + ' 天的筆記');
  }).catch(function (e) { console.warn('[trash] 清理失敗：' + (e && e.message || e)); });
}

function start() {
  auth.startHousekeeping();
  backup.startHousekeeping();
  checkStorage();
  setInterval(checkStorage, 3600000).unref();
  purgeTrash();
  setInterval(purgeTrash, 3600000).unref();
  server.listen(config.port, config.host, function () {
    console.log('StrikeNote — http://' + config.host + ':' + config.port);
    console.log('  資料庫:   MariaDB ' + (config.db.socket ? config.db.socket : config.db.host + ':' + config.db.port) +
      '/' + config.db.name);
    const reg = settings.get();
    console.log('  註冊模式: ' + reg.registerMode + '（管理員可在「帳號管理」切換）');
    if (reg.registerMode === 'invite') {
      console.log('  邀請碼:   ' + (inviteGenerated
        ? reg.inviteCode + '   ← 新產生，已存進資料庫，重啟不會變；之後在「帳號管理」查看或更換'
        : '在「帳號管理」查看'));
    }
    if (config.requireHttps && !config.trustProxy) {
      console.log('  ⚠ REQUIRE_HTTPS=1 但 TRUST_PROXY=0：若非本機測試，請放在 HTTPS 反向代理後並設 TRUST_PROXY=1');
    }
    if (!config.requireHttps) {
      console.log('  ⚠ REQUIRE_HTTPS=0：Cookie 不會加 Secure 旗標，僅適合 localhost 測試');
    }
    if (config.adminPassword) {
      console.log('  ⚠ ADMIN_PASSWORD 由環境變數指定 — 請確認它夠強，且沒有寫進版本控制');
    }
  });
}

// Connect, create/upgrade the schema, make sure an admin exists, then listen.
// Set when settings.load() had to create the invite code, so start() prints it once.
let inviteGenerated = false;
dbmod.init().then(function () {
  return settings.load();
}).then(function (loaded) {
  inviteGenerated = !!(loaded && loaded.generated);
  return auth.ensureAdmin();
}).then(function (created) {
  if (created) {
    console.log('');
    console.log('  ┌─ 已建立管理員帳號 ─────────────────────────');
    console.log('  │  帳號: ' + created.username);
    console.log('  │  密碼: ' + created.password);
    if (created.generated) {
      console.log('  │');
      console.log('  │  ⚠ 這是隨機產生的密碼，只會顯示這一次。');
      console.log('  │    首次登入時會要求你立刻更改。');
      console.log('  │    想自己指定請設 ADMIN_PASSWORD 環境變數。');
    }
    console.log('  └────────────────────────────────────────────');
  }
  start();
}).catch(function (e) {
  console.error('啟動失敗:', e && e.message);
  if (e && (e.code === 'ECONNREFUSED' || e.code === 'ER_ACCESS_DENIED_ERROR' || e.code === 'ER_BAD_DB_ERROR')) {
    console.error('  請確認 MariaDB 已啟動、DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD 正確（見 deploy/env.example）。');
  }
  process.exit(1);
});

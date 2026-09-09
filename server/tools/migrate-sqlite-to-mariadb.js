#!/usr/bin/env node
/* migrate-sqlite-to-mariadb.js — one-shot copy of a StrikeNote SQLite database
 * into MariaDB, preserving every id.
 *
 *   node server/tools/migrate-sqlite-to-mariadb.js --sqlite <path/to/data.db> [--dry-run] [--force] [--skip-orphans]
 *
 * The target comes from the same DB_* environment variables the server uses
 * (see deploy/env.example). The source is copied with VACUUM INTO (which folds
 * in any -wal) to a temp file that is opened read-only and deleted afterwards;
 * no row of the source is ever modified. (Closing the source may checkpoint
 * its -wal into data.db — SQLite's normal housekeeping, same bytes either way.)
 * Stop the old server first anyway, so the copy is of a quiescent database.
 *
 * Steps: snapshot → pre-flight checks → target must be empty (or --force) →
 * copy table by table in foreign-key order → verify counts and checksums.
 * `sessions` is not copied: everyone signs in again.
 *
 * --dry-run does everything except the copy and prints what would happen.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const args = (function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--skip-orphans') out.skipOrphans = true;
    else if (a === '--sqlite') out.sqlite = argv[++i];
    else if (a === '--batch-bytes') out.batchBytes = parseInt(argv[++i], 10);
    else if (a === '-h' || a === '--help') out.help = true;
    else out._.push(a);
  }
  return out;
})(process.argv.slice(2));

if (args.help || !args.sqlite) {
  console.log('用法: node server/tools/migrate-sqlite-to-mariadb.js --sqlite <data.db> [--dry-run] [--force] [--skip-orphans]');
  console.log('目標資料庫由 DB_HOST/DB_PORT/DB_SOCKET/DB_NAME/DB_USER/DB_PASSWORD 決定（見 deploy/env.example）。');
  process.exit(args.help ? 0 : 2);
}

const BATCH_BYTES = args.batchBytes > 0 ? args.batchBytes : 4 * 1024 * 1024;
const BATCH_ROWS = 200;

// Column lists are the MariaDB schema's; a source row missing a column that was
// added later (rev, access, is_book, ...) gets that column's default.
const TABLES = [
  { name: 'users', cols: ['id', 'username', 'pw_hash', 'pw_salt', 'created_at', 'role', 'disabled', 'must_change_pw', 'last_login'],
    defaults: { role: 'user', disabled: 0, must_change_pw: 0, last_login: null }, autoinc: true },
  { name: 'folders', cols: ['id', 'owner_id', 'name', 'parent_id', 'created_at', 'is_book'],
    defaults: { parent_id: null, is_book: 0 } },
  { name: 'notes', cols: ['id', 'owner_id', 'folder_id', 'title', 'content', 'meta', 'created_at', 'updated_at', 'rev', 'access', 'access_perm'],
    defaults: { folder_id: null, meta: null, rev: 0, access: 'restricted', access_perm: 'read' } },
  { name: 'images', cols: ['id', 'owner_id', 'mime', 'data', 'original', 'shapes', 'created_at'],
    defaults: { original: null, shapes: null } },
  { name: 'shares', cols: ['note_id', 'user_id', 'perm', 'created_at'], defaults: {} },
  { name: 'note_versions', cols: ['id', 'note_id', 'rev', 'title', 'content', 'meta', 'author', 'label', 'created_at'],
    defaults: { meta: null, label: null, author: '' }, autoinc: true },
  { name: 'book_versions', cols: ['id', 'folder_id', 'owner_id', 'title', 'label', 'manifest', 'created_at'],
    defaults: { label: null }, autoinc: true },
  { name: 'book_links', cols: ['token', 'folder_id', 'owner_id', 'title', 'html', 'chapters', 'created_at', 'updated_at', 'expires_at', 'views'],
    defaults: { chapters: 0, expires_at: null, views: 0 } }
];

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function toBuf(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) return Buffer.from(v);
  return v;
}
function sizeOf(v) {
  if (v == null) return 8;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return v.length;
  if (typeof v === 'string') return v.length * 3;
  return 8;
}
function sha(list) {
  const h = crypto.createHash('sha256');
  for (const x of list) h.update(x);
  return h.digest('hex');
}

// ---- snapshot ----
function snapshot(src) {
  if (!fs.existsSync(src)) { console.error('找不到 SQLite 檔案: ' + src); process.exit(2); }
  const tmp = path.join(os.tmpdir(), 'strikenote-migrate-' + process.pid + '.db');
  const live = new DatabaseSync(src);
  try {
    live.exec('PRAGMA busy_timeout = 10000');
    live.exec("VACUUM INTO '" + tmp.replace(/'/g, "''") + "'");
  } finally { live.close(); }
  return { tmp: tmp, db: new DatabaseSync(tmp, { readOnly: true }) };
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
function columnsOf(db, name) {
  return db.prepare('PRAGMA table_info(' + name + ')').all().map(c => c.name);
}

// ---- pre-flight ----
function preflight(db) {
  const problems = [];
  const warnings = [];
  for (const t of TABLES) {
    if (!hasTable(db, t.name)) { warnings.push('來源沒有資料表 ' + t.name + '（視為空）'); continue; }
    const missing = t.cols.filter(c => !(c in t.defaults) && !columnsOf(db, t.name).includes(c));
    if (missing.length) problems.push(t.name + ' 缺少必要欄位: ' + missing.join(', '));
  }
  let orphans = [];
  try { orphans = db.prepare('PRAGMA foreign_key_check').all(); } catch (e) { /* older sqlite */ }
  if (orphans.length) {
    const msg = 'foreign_key_check 找到 ' + orphans.length + ' 筆孤兒列（例如 ' +
      orphans.slice(0, 3).map(o => o.table + ' rowid ' + o.rowid + ' → ' + o.parent).join('; ') + '）';
    if (args.skipOrphans) warnings.push(msg + '，--skip-orphans：這些列會被略過'); else problems.push(msg + '。加 --skip-orphans 略過它們');
  }
  if (hasTable(db, 'users')) {
    const dup = db.prepare('SELECT LOWER(username) AS u, COUNT(*) AS n FROM users GROUP BY LOWER(username) HAVING n > 1').all();
    if (dup.length) problems.push('帳號名稱只差大小寫的重複（MariaDB 不分大小寫）: ' + dup.map(d => d.u).join(', ') + '。請先改名其中一個');
    const longU = db.prepare('SELECT id, username FROM users WHERE LENGTH(username) > 64').all();
    if (longU.length) problems.push('username 超過 64 字元: ' + longU.map(u => u.id).join(', '));
    const badRole = db.prepare("SELECT id, role FROM users WHERE role NOT IN ('user','admin')").all();
    if (badRole.length) problems.push('users.role 不在 user/admin: ' + badRole.map(u => u.id + '=' + u.role).join(', '));
  }
  if (hasTable(db, 'images')) {
    const longMime = db.prepare('SELECT id FROM images WHERE LENGTH(mime) > 255').all();
    if (longMime.length) problems.push('images.mime 超過 255 字元: ' + longMime.map(i => i.id).join(', '));
  }
  if (hasTable(db, 'note_versions')) {
    const longA = db.prepare('SELECT id FROM note_versions WHERE LENGTH(author) > 64 OR LENGTH(label) > 255').all();
    if (longA.length) problems.push('note_versions.author/label 過長: ' + longA.map(v => v.id).join(', '));
  }
  if (hasTable(db, 'notes')) {
    const cols = columnsOf(db, 'notes');
    if (cols.includes('access')) {
      const bad = db.prepare("SELECT id FROM notes WHERE access NOT IN ('restricted','site') OR access_perm NOT IN ('read','edit')").all();
      if (bad.length) problems.push('notes.access/access_perm 值不合法: ' + bad.map(n => n.id).join(', '));
    }
  }
  if (hasTable(db, 'shares')) {
    const bad = db.prepare("SELECT note_id FROM shares WHERE perm NOT IN ('read','edit')").all();
    if (bad.length) problems.push('shares.perm 值不合法: ' + bad.map(s => s.note_id).join(', '));
  }
  return { problems, warnings, orphans };
}

// ---- checksums (computed the same way on both sides) ----
function sqliteStats(db) {
  const out = {};
  for (const t of TABLES) {
    if (!hasTable(db, t.name)) { out[t.name] = { count: 0 }; continue; }
    const s = { count: db.prepare('SELECT COUNT(*) AS n FROM ' + t.name).get().n };
    if (t.autoinc) s.maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM ' + t.name).get().m;
    out[t.name] = s;
  }
  out.notes.hash = sha(db.prepare('SELECT id, content FROM notes ORDER BY id').all().map(r => r.id + '|' + r.content + '\n'));
  out.images.hash = sha(db.prepare('SELECT id, data FROM images ORDER BY id').all().flatMap(r => [r.id + '|', toBuf(r.data), '\n']));
  out.images.bytes = db.prepare('SELECT COALESCE(SUM(LENGTH(data)), 0) + COALESCE(SUM(LENGTH(original)), 0) AS b FROM images').get().b;
  if (hasTable(db, 'note_versions')) {
    out.note_versions.hash = sha(db.prepare('SELECT id, content FROM note_versions ORDER BY id').all().map(r => r.id + '|' + r.content + '\n'));
  }
  if (hasTable(db, 'book_links')) {
    out.book_links.hash = sha(db.prepare('SELECT token, html FROM book_links ORDER BY token').all().map(r => r.token + '|' + r.html + '\n'));
  }
  return out;
}

async function mariaStats(dbmod) {
  const out = {};
  for (const t of TABLES) {
    const s = { count: (await dbmod.query('SELECT COUNT(*) AS n FROM `' + t.name + '`'))[0].n };
    if (t.autoinc) s.maxId = (await dbmod.query('SELECT COALESCE(MAX(id), 0) AS m FROM `' + t.name + '`'))[0].m;
    out[t.name] = s;
  }
  out.notes.hash = sha((await dbmod.query('SELECT id, content FROM notes ORDER BY id')).map(r => r.id + '|' + r.content + '\n'));
  out.images.hash = sha((await dbmod.query('SELECT id, data FROM images ORDER BY id')).flatMap(r => [r.id + '|', r.data, '\n']));
  out.images.bytes = (await dbmod.query('SELECT COALESCE(SUM(LENGTH(data)), 0) + COALESCE(SUM(LENGTH(original)), 0) AS b FROM images'))[0].b;
  out.note_versions.hash = sha((await dbmod.query('SELECT id, content FROM note_versions ORDER BY id')).map(r => r.id + '|' + r.content + '\n'));
  out.book_links.hash = sha((await dbmod.query('SELECT token, html FROM book_links ORDER BY token')).map(r => r.token + '|' + r.html + '\n'));
  return out;
}

// ---- copy ----
async function copyTable(dbmod, src, t, orphanKeys) {
  if (!hasTable(src, t.name)) return { rows: 0, batches: 0, bytes: 0 };
  const rows = src.prepare('SELECT * FROM ' + t.name).all();
  const cols = t.cols;
  const sqlHead = 'INSERT INTO `' + t.name + '` (' + cols.map(c => '`' + c + '`').join(', ') + ') VALUES ';
  const tuple = '(' + cols.map(() => '?').join(', ') + ')';
  let batch = [], batchBytes = 0, batches = 0, total = 0, skipped = 0;

  async function flush() {
    if (!batch.length) return;
    const params = [];
    batch.forEach(r => params.push(...r));
    await dbmod.exec(sqlHead + batch.map(() => tuple).join(', '), params);
    batches++;
    batch = []; batchBytes = 0;
  }

  await dbmod.tx(async function () {
    for (const r of rows) {
      if (orphanKeys && orphanKeys.has(t.name + ':' + r.rowid)) { skipped++; continue; }
      const vals = cols.map(function (c) {
        let v = (c in r) ? r[c] : t.defaults[c];
        if (v === undefined) v = t.defaults[c];
        return toBuf(v);
      });
      const size = vals.reduce((a, v) => a + sizeOf(v), 0) + 64;
      if (batch.length && (batchBytes + size > BATCH_BYTES || batch.length >= BATCH_ROWS)) await flush();
      batch.push(vals); batchBytes += size; total += size;
    }
    await flush();
  }, 'migrate:' + t.name);
  return { rows: rows.length - skipped, skipped: skipped, batches: batches, bytes: total };
}

async function main() {
  console.log('來源 SQLite: ' + path.resolve(args.sqlite));
  const snap = snapshot(args.sqlite);
  const src = snap.db;
  let dbmod = null;
  try {
    // 1. pre-flight
    const pf = preflight(src);
    pf.warnings.forEach(w => console.log('  ⚠ ' + w));
    if (pf.problems.length) {
      console.error('\n預檢失敗，未做任何寫入：');
      pf.problems.forEach(p => console.error('  ✗ ' + p));
      process.exit(1);
    }
    const before = sqliteStats(src);
    console.log('\n來源內容：');
    for (const t of TABLES) console.log('  ' + t.name.padEnd(14) + String(before[t.name].count).padStart(7) + ' 列');
    console.log('  images        ' + fmtBytes(before.images.bytes).padStart(10) + ' 的圖片/PDF');

    // 2. target
    dbmod = require('../db');
    await dbmod.init();
    const counts = {};
    let nonEmpty = false;
    for (const t of TABLES) {
      counts[t.name] = (await dbmod.query('SELECT COUNT(*) AS n FROM `' + t.name + '`'))[0].n;
      if (counts[t.name] > 0) nonEmpty = true;
    }
    if (nonEmpty && !args.force) {
      console.error('\n目標資料庫不是空的（' + Object.keys(counts).filter(k => counts[k]).map(k => k + '=' + counts[k]).join(', ') +
        '）。加 --force 會先清空這些資料表再搬。未做任何寫入。');
      process.exit(1);
    }
    if (args.dryRun) {
      console.log('\n--dry-run：目標 ' + (nonEmpty ? '非空（--force 會清空）' : '是空的') + '，預檢通過。要正式搬遷請去掉 --dry-run。');
      return;
    }
    if (nonEmpty) {
      console.log('\n--force：清空目標資料表…');
      await dbmod.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of TABLES.slice().reverse()) await dbmod.query('TRUNCATE TABLE `' + t.name + '`');
      await dbmod.query('TRUNCATE TABLE `sessions`');
      await dbmod.query('SET FOREIGN_KEY_CHECKS = 1');
    }

    // 3. copy
    const orphanKeys = args.skipOrphans ? new Set(pf.orphans.map(o => o.table + ':' + o.rowid)) : null;
    console.log('\n搬遷中：');
    for (const t of TABLES) {
      const r = await copyTable(dbmod, src, t, orphanKeys);
      console.log('  ' + t.name.padEnd(14) + String(r.rows).padStart(7) + ' 列  ' + String(r.batches).padStart(4) + ' 批  ' +
        fmtBytes(r.bytes).padStart(10) + (r.skipped ? '  （略過 ' + r.skipped + ' 筆孤兒）' : ''));
    }

    // 4. verify
    console.log('\n驗證：');
    const after = await mariaStats(dbmod);
    let bad = 0;
    for (const t of TABLES) {
      const a = before[t.name], b = after[t.name];
      const skippedHere = orphanKeys ? pf.orphans.filter(o => o.table === t.name).length : 0;
      const countOk = a.count - skippedHere === b.count;
      const idOk = !t.autoinc || skippedHere ? true : a.maxId === b.maxId;
      const hashOk = !a.hash || skippedHere ? true : a.hash === b.hash;
      const okAll = countOk && idOk && hashOk;
      if (!okAll) bad++;
      console.log('  ' + (okAll ? '✓' : '✗') + ' ' + t.name.padEnd(14) + '筆數 ' + a.count + ' → ' + b.count +
        (t.autoinc ? '  max(id) ' + a.maxId + ' → ' + b.maxId : '') +
        (a.hash ? '  內容雜湊 ' + (hashOk ? '相同' : '不同') : ''));
    }
    const bytesOk = before.images.bytes === after.images.bytes;
    if (!bytesOk) bad++;
    console.log('  ' + (bytesOk ? '✓' : '✗') + ' images 位元組 ' + before.images.bytes + ' → ' + after.images.bytes);
    if (bad) { console.error('\n✗ 有 ' + bad + ' 項不符，請檢查。'); process.exit(1); }
    console.log('\n✓ 搬遷完成。sessions 未搬，所有人重新登入即可。');
  } finally {
    try { src.close(); } catch (e) {}
    try { fs.unlinkSync(snap.tmp); } catch (e) {}
    if (dbmod) await dbmod.close().catch(function () {});
  }
}

main().catch(function (e) {
  console.error('\n搬遷失敗:', e && e.stack || e);
  process.exit(1);
});

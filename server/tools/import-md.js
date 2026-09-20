#!/usr/bin/env node
/* import-md.js — 把一個資料夾的 Markdown（含圖片）批次匯入 StrikeNote。
 *
 * 用途：讓 Claude Code 之類的工具在本機把網站／文件轉成一堆 .md 之後，一次全部搬進站上，
 * 圖片一併處理好——相對路徑的圖片上傳、外部網址的圖片先抓下來再上傳、內嵌的 base64 圖片
 * 解出來上傳，然後把文章裡的連結改寫成站上的寫法（img: / pdf: / file:）。
 * 「掃引用、改寫連結」跟瀏覽器裡的匯入是同一份程式（js/mdimport.js）。
 *
 * 外部網址是在「你自己的電腦」上抓的，不是叫伺服器去抓，所以沒有 SSRF 那類問題；
 * 伺服器只收到已經上傳好的檔案。
 *
 *   node server/tools/import-md.js --dir ./out --url https://notes.example.com --user me
 *
 * 常用選項（--help 有完整說明）：
 *   --area course|knowledge|quick     匯到哪個區域（預設：所有筆記）
 *   --into "第一週/講義"               匯到哪個資料夾底下（沒有就建）
 *   --flat                            不重建子資料夾
 *   --files referenced|all|none       其他檔案：只上傳被引用到的（預設）／全部／都不要
 *   --no-remote                       不要下載外部網址的圖片
 *   --skip-existing                   同資料夾同標題的筆記就略過（重跑不會變兩份）
 *   --dry-run                         只印出會做什麼
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const MdImport = require('../../js/mdimport.js');

const MD_EXT = /\.(md|markdown)$/i;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.vscode', '__pycache__']);
const DIRECT_LIMIT = 20 * 1024 * 1024;     // 超過這個大小就走分塊上傳（跟瀏覽器端同一條線）

function parseArgs(argv) {
  const o = {
    dir: null, url: process.env.STRIKENOTE_URL || 'http://127.0.0.1:8080',
    user: process.env.STRIKENOTE_USER || null, password: process.env.STRIKENOTE_PASSWORD || null,
    area: null, into: null, flat: false, remote: true, files: 'referenced',
    skipExisting: false, dryRun: false, maxRemote: 50 * 1024 * 1024, timeout: 20000
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], next = function () { return argv[++i]; };
    if (a === '--dir' || a === '-d') o.dir = next();
    else if (a === '--url') o.url = next();
    else if (a === '--user' || a === '-u') o.user = next();
    else if (a === '--password' || a === '-p') o.password = next();
    else if (a === '--area') o.area = next();
    else if (a === '--into') o.into = next();
    else if (a === '--flat') o.flat = true;
    else if (a === '--no-remote') o.remote = false;
    else if (a === '--files') o.files = next();
    else if (a === '--skip-existing') o.skipExisting = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--max-remote-mb') o.maxRemote = Math.max(1, parseInt(next(), 10) || 50) * 1024 * 1024;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!o.dir && a[0] !== '-') o.dir = a;
    else { console.error('不認得的參數：' + a); process.exit(2); }
  }
  return o;
}

function help() {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 25)
    .map(function (l) { return l.replace(/^ \*\/?/, '').replace(/^ /, ''); }).join('\n'));
}

// ---- 站台 API ---------------------------------------------------------------
function makeClient(base) {
  let cookie = '';
  async function call(method, p, body, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'X-Requested-With': 'report-notes' }, opts.headers || {});
    if (cookie) headers.Cookie = cookie;
    let payload = body;
    if (body !== undefined && !opts.raw) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(base.replace(/\/+$/, '') + p, { method: method, headers: headers, body: payload, redirect: 'manual' });
    const sc = res.headers.get('set-cookie');
    if (sc) { const m = /rn_session=([^;]*)/.exec(sc); if (m) cookie = 'rn_session=' + m[1]; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(function () { return null; }) : await res.text();
    if (res.status === 301 || res.status === 302) {
      throw new Error('站台把請求轉址了（' + res.headers.get('location') + '）。網址請用 https:// 開頭的那一個。');
    }
    if (!res.ok) throw new Error(method + ' ' + p + ' → ' + res.status + ' ' + (data && data.error ? data.error : '').slice(0, 120));
    return data;
  }
  return {
    call: call,
    login: function (username, password) { return call('POST', '/api/login', { username: username, password: password }); },
    // 小檔一次送；大檔走分塊（跟 js/store.js 的 uploadFile 同一套）
    upload: async function (bytes, name, mime) {
      if (bytes.length <= DIRECT_LIMIT) {
        const r = await call('POST', '/api/images', Buffer.from(bytes), {
          raw: true, headers: { 'Content-Type': mime || 'application/octet-stream', 'X-File-Name': encodeURIComponent(name || 'file') }
        });
        return r.id;
      }
      const up = await call('POST', '/api/uploads', { name: name, mime: mime, size: bytes.length });
      for (let seq = 0; seq < up.chunks; seq++) {
        const from = seq * up.chunkSize, to = Math.min(bytes.length, from + up.chunkSize);
        await call('PUT', '/api/uploads/' + up.id + '/' + seq, Buffer.from(bytes.subarray(from, to)),
          { raw: true, headers: { 'Content-Type': 'application/octet-stream' } });
      }
      await call('POST', '/api/uploads/' + up.id + '/finish', {});
      return up.id;
    }
  };
}

// ---- 掃描資料夾 --------------------------------------------------------------
async function walk(root) {
  const out = [];
  async function rec(dir, rel) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await rec(path.join(dir, e.name), rel.concat([e.name]));
      } else if (e.isFile()) {
        out.push({ abs: path.join(dir, e.name), rel: rel.concat([e.name]), path: rel.concat([e.name]).join('/') });
      }
    }
  }
  await rec(root, []);
  return out;
}

async function fetchRemote(url, o) {
  const ctl = new AbortController();
  const timer = setTimeout(function () { ctl.abort(); }, o.timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len && len > o.maxRemote) throw new Error('檔案太大（' + Math.round(len / 1048576) + ' MB）');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > o.maxRemote) throw new Error('檔案太大（' + Math.round(buf.length / 1048576) + ' MB）');
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim();
    let name = decodeURIComponent((new URL(url).pathname.split('/').pop() || 'image').trim()) || 'image';
    if (!/\.[a-z0-9]{1,5}$/i.test(name)) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'application/pdf': 'pdf' }[mime];
      if (ext) name += '.' + ext;
    }
    return { bytes: buf, mime: mime || MdImport.mimeOf(name), name: name };
  } finally { clearTimeout(timer); }
}

async function main() {
  const o = parseArgs(process.argv);
  if (o.help || !o.dir) { help(); process.exit(o.dir ? 0 : 2); }
  const root = path.resolve(o.dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error('找不到資料夾：' + root); process.exit(2);
  }
  if (['referenced', 'all', 'none'].indexOf(o.files) < 0) { console.error('--files 只能是 referenced / all / none'); process.exit(2); }

  const all = await walk(root);
  const mds = all.filter(function (f) { return MD_EXT.test(f.path); })
    .sort(function (a, b) { return a.path.localeCompare(b.path, 'zh-Hant', { numeric: true }); });
  const assets = all.filter(function (f) { return !MD_EXT.test(f.path); });
  if (!mds.length) { console.error('這個資料夾裡沒有 .md 檔：' + root); process.exit(1); }

  const byPath = new Map(), byName = new Map();
  assets.forEach(function (a) {
    byPath.set(a.path, a);
    if (!byName.has(a.rel[a.rel.length - 1])) byName.set(a.rel[a.rel.length - 1], a);
  });

  // 1) 讀檔、掃出每篇引用到什麼
  const notes = [];
  const wantLocal = new Map();    // 資產 → 用到它的篇數
  const wantRemote = new Map();   // 網址 → 同上
  let dataCount = 0, unresolved = 0, externalLeft = 0;
  for (const f of mds) {
    const raw = await fsp.readFile(f.abs, 'utf8');
    const fm = MdImport.frontMatter(raw);
    const dirs = f.rel.slice(0, -1);
    const refs = MdImport.scan(fm.body);
    refs.forEach(function (ref) {
      if (ref.kind === 'local') {
        const p = MdImport.resolvePath(dirs, ref.target);
        const hit = byPath.get(p) || byName.get(p.split('/').pop());
        if (hit) wantLocal.set(hit, (wantLocal.get(hit) || 0) + 1);
        else unresolved++;
      } else if (ref.kind === 'remote') {
        // 只抓「圖片」：![](網址) 或 <img src>。一般的外部連結在站上本來就能用，留著就好。
        if (!ref.embed) return;
        if (o.remote) wantRemote.set(ref.target, (wantRemote.get(ref.target) || 0) + 1);
        else externalLeft++;
      } else if (ref.kind === 'data') dataCount++;
    });
    notes.push({ file: f, dirs: dirs, title: fm.title || f.rel[f.rel.length - 1].replace(MD_EXT, ''), body: fm.body });
  }

  const extraFiles = o.files === 'all' ? assets.filter(function (a) { return !wantLocal.has(a); }) : [];
  console.log('來源：' + root);
  console.log('  ' + mds.length + ' 篇筆記、' + wantLocal.size + ' 個本機圖片／檔案被引用、' +
    wantRemote.size + ' 個外部網址' + (o.remote ? '（會下載）' : '（保持原樣）') + '、' + dataCount + ' 個內嵌圖片' +
    (extraFiles.length ? '、' + extraFiles.length + ' 個其他檔案一起匯入' : ''));
  console.log('  目的地：' + o.url + (o.area ? '　區域：' + o.area : '') + (o.into ? '　資料夾：' + o.into : ''));
  if (unresolved) console.log('  ⚠ ' + unresolved + ' 個圖片在資料夾裡找不到檔案，連結會原樣保留');
  if (o.dryRun) {
    notes.slice(0, 20).forEach(function (n) { console.log('   · ' + (n.dirs.concat([n.title]).join('/'))); });
    if (notes.length > 20) console.log('   · …共 ' + notes.length + ' 篇');
    console.log('(--dry-run：沒有連上伺服器)');
    return;
  }

  // 2) 登入
  const api = makeClient(o.url);
  if (!o.user || !o.password) { console.error('請給 --user 與 --password（或設 STRIKENOTE_USER / STRIKENOTE_PASSWORD）'); process.exit(2); }
  await api.login(o.user, o.password);
  console.log('已登入：' + o.user);

  // 3) 上傳圖片與檔案
  const ids = new Map();          // 資產或網址 → { id, scheme, name }
  let done = 0, failedUploads = 0, failedRemote = 0;
  const total = wantLocal.size + wantRemote.size + extraFiles.length;
  function progress(label) {
    done++;
    process.stdout.write('\r上傳中 ' + done + '/' + total + '  ' + label.slice(0, 48) + '                    ');
  }
  for (const a of wantLocal.keys()) {
    try {
      const bytes = await fsp.readFile(a.abs);
      const mime = MdImport.mimeOf(a.path);
      const id = await api.upload(bytes, a.rel[a.rel.length - 1], mime);
      ids.set(a.path, { id: id, scheme: MdImport.schemeFor(mime, a.path), name: a.rel[a.rel.length - 1] });
      progress(a.path);
    } catch (e) { failedUploads++; console.log('\n  ⚠ 上傳失敗 ' + a.path + '：' + e.message); }
  }
  for (const url of wantRemote.keys()) {
    try {
      const got = await fetchRemote(url, o);
      const id = await api.upload(got.bytes, got.name, got.mime);
      ids.set(url, { id: id, scheme: MdImport.schemeFor(got.mime, got.name), name: got.name });
      progress(url);
    } catch (e) { failedRemote++; console.log('\n  ⚠ 抓不到 ' + url + '：' + e.message + '（連結原樣保留）'); }
  }
  if (total) process.stdout.write('\r' + ' '.repeat(72) + '\r');

  // 4) 資料夾
  const existingFolders = (await api.call('GET', '/api/folders')).folders || [];
  const folderId = new Map();     // '第一週/講義' → id
  function findFolder(name, parentId) {
    return existingFolders.filter(function (f) {
      return f.name === name && (f.parentId || null) === (parentId || null) && (f.area || null) === (o.area || null);
    })[0];
  }
  async function ensureFolder(parts) {
    if (!parts.length) return null;
    const key = parts.join('/');
    if (folderId.has(key)) return folderId.get(key);
    const parent = await ensureFolder(parts.slice(0, -1));
    const name = parts[parts.length - 1];
    let f = findFolder(name, parent);
    if (!f) {
      f = (await api.call('POST', '/api/folders', { name: name, parentId: parent, area: o.area || undefined })).folder;
      existingFolders.push(f);
    }
    folderId.set(key, f.id);
    return f.id;
  }
  const basePath = o.into ? o.into.split('/').filter(Boolean) : [];

  // 5) 建立筆記（內容先改寫）
  const existingNotes = o.skipExisting ? ((await api.call('GET', '/api/notes')).notes || []) : [];
  let made = 0, skipped = 0, failedNotes = 0, dataUploaded = 0;
  for (const n of notes) {
    let dataIndex = 0;
    const dirs = o.flat ? [] : n.dirs;
    let content = n.body;
    // 內嵌的 base64 圖片：解出來上傳（不然一張圖會在內文裡佔掉幾十 KB 的亂碼）
    const dataRefs = MdImport.scan(content).filter(function (r) { return r.kind === 'data'; });
    const dataIds = new Map();
    for (const ref of dataRefs) {
      if (dataIds.has(ref.target)) continue;
      const dec = MdImport.decodeDataUri(ref.target, dataIndex++);
      if (!dec) continue;
      try {
        const id = await api.upload(dec.bytes, dec.name, dec.mime);
        dataIds.set(ref.target, { id: id, scheme: MdImport.schemeFor(dec.mime, dec.name), name: dec.name });
        dataUploaded++;
      } catch (e) { console.log('  ⚠ 內嵌圖片上傳失敗：' + e.message); }
    }
    content = MdImport.rewrite(content, function (ref) {
      if (ref.kind === 'local') {
        const p = MdImport.resolvePath(n.dirs, ref.target);
        return ids.get(p) || ids.get((byName.get(p.split('/').pop()) || {}).path) || null;
      }
      if (ref.kind === 'remote') return ids.get(ref.target) || null;
      if (ref.kind === 'data') return dataIds.get(ref.target) || null;
      return null;
    });
    try {
      const parent = await ensureFolder(basePath.concat(dirs));
      if (o.skipExisting && existingNotes.some(function (x) { return x.title === n.title && (x.folderId || null) === (parent || null); })) { skipped++; continue; }
      const body = { title: n.title, folderId: parent, content: content };
      if (o.area) body.area = o.area;
      await api.call('POST', '/api/notes', body);
      made++;
      process.stdout.write('\r建立筆記 ' + made + '/' + notes.length + '  ' + n.title.slice(0, 40) + '                    ');
    } catch (e) { failedNotes++; console.log('\n  ⚠ 建立失敗 ' + n.title + '：' + e.message); }
  }
  process.stdout.write('\r' + ' '.repeat(72) + '\r');

  // 6) 沒被引用到的檔案（--files all）：在課程筆記裡就是「檔案」，其他區域沒有這個概念
  let fileNotes = 0;
  if (extraFiles.length) {
    if (o.area === 'course') {
      for (const a of extraFiles) {
        try {
          const bytes = await fsp.readFile(a.abs);
          const name = a.rel[a.rel.length - 1];
          const mime = MdImport.mimeOf(a.path);
          const id = await api.upload(bytes, name, mime);
          const scheme = MdImport.schemeFor(mime, name);
          const ref = MdImport.siteRef({ alt: name, embed: true }, { id: id, scheme: scheme, name: name });
          const parent = await ensureFolder(basePath.concat(o.flat ? [] : a.rel.slice(0, -1)));
          await api.call('POST', '/api/notes', {
            title: name, folderId: parent, area: 'course', content: ref + '\n',
            meta: { file: { id: id, name: name, mime: mime, size: bytes.length } }
          });
          fileNotes++;
        } catch (e) { failedUploads++; console.log('  ⚠ 檔案匯入失敗 ' + a.path + '：' + e.message); }
      }
    } else {
      console.log('  ℹ --files all 只有 --area course 有檔案列表可以放，這次略過 ' + extraFiles.length + ' 個檔案');
    }
  }

  console.log('完成：' + made + ' 篇筆記' +
    (folderId.size ? '、' + folderId.size + ' 個資料夾' : '') +
    (ids.size ? '、' + ids.size + ' 個圖片／檔案' : '') +
    (dataUploaded ? '、' + dataUploaded + ' 個內嵌圖片' : '') +
    (fileNotes ? '、' + fileNotes + ' 個檔案' : ''));
  if (skipped) console.log('  略過 ' + skipped + ' 篇已存在的筆記（--skip-existing）');
  if (unresolved) console.log('  ⚠ ' + unresolved + ' 個圖片在資料夾裡找不到，連結原樣保留');
  if (externalLeft) console.log('  ⚠ ' + externalLeft + ' 個外部網址沒有下載（--no-remote），這些圖在站上不會顯示');
  if (failedRemote) console.log('  ⚠ ' + failedRemote + ' 個外部圖片抓不到，連結原樣保留');
  if (failedUploads || failedNotes) {
    console.log('  ⚠ ' + failedUploads + ' 個檔案、' + failedNotes + ' 篇筆記失敗');
    process.exitCode = 1;
  }
}

main().catch(function (e) {
  console.error('\n錯誤：' + (e && e.message || e));
  process.exit(1);
});

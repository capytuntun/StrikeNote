/* api.js — notes / folders / images / shares.
 *
 * Authorization rule for the whole file: the caller's identity comes from their
 * session, never from the request body. Any owner_id in client JSON is ignored.
 *
 * Everything here is async (MariaDB via db.js). Two requests for the same note
 * can now interleave between awaits — something the synchronous SQLite version
 * made impossible — so every read-merge-write on a note re-reads the row with
 * `q.noteByIdForUpdate` inside its transaction and computes from that locked
 * copy. Side effects (hub broadcasts) are collected inside the transaction and
 * fired after it commits; see the rules at the top of db.js.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const dbmod = require('./db');
const { q, tx } = dbmod;
const hub = require('./hub');
const config = require('./config');
const { merge3 } = require('./merge');

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
}

// ---------------- permissions ----------------
async function permFor(user, note) {
  // A trashed note does not exist as far as every normal route is concerned —
  // reading, saving, versions, shares, images all 404. Only the trash endpoints
  // (listTrash / restoreNote / purgeNote) look at those rows, owner-only.
  if (!note || note.deleted_at) return null;
  if (note.owner_id === user.id) return 'owner';
  const s = await q.shareFor.get(note.id, user.id);
  if (s) return s.perm;              // 'read' | 'edit'
  // "General access": the owner opened the note to every signed-in user.
  if (note.access === 'site') return note.access_perm === 'edit' ? 'edit' : 'read';
  return null;
}
const canRead = p => p === 'owner' || p === 'read' || p === 'edit';
const canEdit = p => p === 'owner' || p === 'edit';

function shapeNote(row, perm, ownerName, viaSite) {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    content: row.content,
    meta: row.meta ? JSON.parse(row.meta) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rev: row.rev || 0,                // revision counter for live collaboration
    perm: perm,                       // so the UI can go read-only
    sharedBy: ownerName || undefined,
    access: row.access || 'restricted',          // owner's "general access" setting
    accessPerm: row.access_perm || 'read',
    viaSite: viaSite ? true : undefined          // reached through site-wide access, not a share
  };
}

// ---------------- notes ----------------
async function listNotes(user) {
  const own = (await q.notesOwned.all(user.id)).map(r => shapeNote(r, 'owner'));
  const shared = (await q.notesSharedWith.all(user.id)).map(r => shapeNote(r, r.share_perm, r.owner_name));
  const site = (await q.notesSiteWide.all(user.id, user.id)).map(r => shapeNote(r, r.share_perm, r.owner_name, true));
  return own.concat(shared, site);
}

async function getNote(user, id) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return null;
  const owner = perm === 'owner' ? null : await q.userById.get(row.owner_id);
  const viaSite = perm !== 'owner' && !(await q.shareFor.get(row.id, user.id));
  return shapeNote(row, perm, owner && owner.username, viaSite);
}

// Owner-only: who else may open this note without an explicit share.
async function setAccess(user, id, body) {
  const row = await q.noteById.get(id);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  const mode = body.mode === 'site' ? 'site' : 'restricted';
  const perm = body.perm === 'edit' ? 'edit' : 'read';
  await q.setAccess.run(mode, perm, id);
  return { ok: true, access: mode, accessPerm: perm };
}

async function createNote(user, body) {
  const now = Date.now();
  const id = uid('note');
  await q.insertNote.run(
    id, user.id, body.folderId || null,
    String(body.title || '未命名筆記'), String(body.content || ''),
    body.meta ? JSON.stringify(body.meta) : null, now, now);
  return shapeNote(await q.noteById.get(id), 'owner');
}

// ---------------- note version history ----------------

// One row per editing *session*, not per save. The editor autosaves 500ms after
// you stop typing, so a row per save would bury a real earlier draft under two
// hundred near-identical rows. Consecutive saves by the same author inside this
// window collapse into the row that is already open.
const VERSION_COALESCE_MS = 5 * 60 * 1000;
// Automatic versions kept per note. Labelled versions are never counted here and
// never pruned — that is the whole point of labelling one.
const VERSION_KEEP = 60;
const VERSION_LIST_MAX = 200;
// Labels the system applies itself. Both mark a row that must survive pruning.
const LABEL_PREHISTORY = '啟用版本歷史前';
const LABEL_BOOK = '電子書版本';

function shapeVersion(row) {
  return {
    id: row.id,
    rev: row.rev,
    title: row.title,
    author: row.author || '',
    label: row.label || null,
    createdAt: row.created_at,
    chars: row.chars != null ? row.chars : (row.content ? row.content.length : 0)
  };
}

// Called inside the same transaction as the note write, with the note row
// locked. `row` is the note as it was *before* this save.
async function recordVersion(row, user, title, content, metaStr, rev, now) {
  const latest = await q.versionLatest.get(row.id);

  // First ever version of this note: also keep what it looked like before this
  // edit, otherwise the text that existed before history was switched on is lost
  // at the very first save. Its author is genuinely unknown — nothing recorded
  // who last wrote it — so the field is left empty rather than guessed at.
  if (!latest) {
    await q.insertVersion.run(row.id, row.rev || 0, row.title, row.content, row.meta,
      '', LABEL_PREHISTORY, row.updated_at || now);
  }

  const open = latest && latest.label == null && latest.author === user.username &&
    (now - latest.created_at) < VERSION_COALESCE_MS;
  if (open) await q.updateVersion.run(rev, title, content, metaStr, now, latest.id);
  else await q.insertVersion.run(row.id, rev, title, content, metaStr, user.username, null, now);

  await q.pruneVersions.run(row.id, row.id, VERSION_KEEP);
}

async function listVersions(user, id) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return { status: 404 };
  return {
    versions: (await q.versionList.all(id, VERSION_LIST_MAX)).map(shapeVersion),
    perm: perm,
    current: { rev: row.rev || 0, title: row.title, updatedAt: row.updated_at, chars: row.content.length }
  };
}

async function getVersion(user, id, versionId) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return { status: 404 };
  const v = await q.versionById.get(Number(versionId), id);
  if (!v) return { status: 404, error: '找不到這個版本' };
  const out = shapeVersion(v);
  out.content = v.content;
  out.meta = v.meta ? JSON.parse(v.meta) : undefined;
  return { version: out, current: { content: row.content, rev: row.rev || 0, title: row.title } };
}

// A named snapshot of the note as it stands. Never coalesced, never pruned.
async function createVersion(user, id, body) {
  const pre = await q.noteById.get(id);
  const perm = await permFor(user, pre);
  if (!canRead(perm)) return { status: 404 };
  if (!canEdit(perm)) return { status: 403, error: '你對這篇筆記只有唯讀權限' };
  const label = String((body && body.label) || '').trim().slice(0, 80) || '標記版本';
  const now = Date.now();
  const inserted = await tx(async function () {
    // Snapshot the row as it is at this instant, not as it was when we checked
    // permissions a moment ago.
    const row = await q.noteByIdForUpdate.get(id);
    if (!row) return null;
    const r = await q.insertVersion.run(id, row.rev || 0, row.title, row.content, row.meta,
      user.username, label, now);
    return q.versionById.get(r.insertId, id);
  }, 'createVersion');
  if (!inserted) return { status: 404 };
  return { version: shapeVersion(inserted) };
}

async function renameVersion(user, id, versionId, body) {
  const row = await q.noteById.get(id);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  const v = await q.versionById.get(Number(versionId), id);
  if (!v) return { status: 404, error: '找不到這個版本' };
  const raw = String((body && body.label) || '').trim().slice(0, 80);
  await q.labelVersion.run(raw || null, Number(versionId), id);
  return { ok: true, label: raw || null };
}

async function deleteVersion(user, id, versionId) {
  const row = await q.noteById.get(id);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  const v = await q.versionById.get(Number(versionId), id);
  if (!v) return { status: 404, error: '找不到這個版本' };
  if (v.label === LABEL_BOOK) {
    return { status: 409, error: '這個版本被某個電子書版本引用，請先刪除該電子書版本' };
  }
  await q.deleteVersion.run(Number(versionId), id);
  return { ok: true };
}

// Inside a transaction, with `note` freshly read FOR UPDATE. Restoring first
// snapshots the text being replaced, so a restore is itself undoable —
// otherwise picking the wrong version would destroy the current work. Returns
// the broadcast payload; the caller fires it after commit.
async function restoreNoteToVersion(user, note, v, now) {
  const rev = (note.rev || 0) + 1;
  await q.insertVersion.run(note.id, note.rev || 0, note.title, note.content, note.meta,
    user.username, '還原前', now - 1);
  await q.updateNote.run(note.folder_id, v.title, v.content, v.meta, now, rev, note.id);
  await q.pruneVersions.run(note.id, note.id, VERSION_KEEP);
  return { rev: rev, content: v.content, title: v.title, by: user.username, updatedAt: now };
}

async function restoreVersion(user, id, versionId) {
  const pre = await q.noteById.get(id);
  const perm = await permFor(user, pre);
  if (!canRead(perm)) return { status: 404 };
  if (!canEdit(perm)) return { status: 403, error: '你對這篇筆記只有唯讀權限' };

  const out = await tx(async function () {
    const note = await q.noteByIdForUpdate.get(id);
    if (!note) return { status: 404 };
    const v = await q.versionById.get(Number(versionId), id);
    if (!v) return { status: 404, error: '找不到這個版本' };
    if (v.content === note.content && v.title === note.title) {
      return { note: shapeNote(note, perm), unchanged: true };
    }
    return { payload: await restoreNoteToVersion(user, note, v, Date.now()) };
  }, 'restoreVersion');

  if (!out.payload) return out;
  hub.broadcastUpdate(id, out.payload);
  return { note: shapeNote(await q.noteById.get(id), perm) };
}

// ---------------- e-book version history ----------------
//
// A book is a folder, so there is nothing about the book itself to version. What
// gets recorded is the cast list: which notes were chapters, in what order, and
// which note version each one was pinned to. The chapter order comes from the
// client because the ordering rule (natural sort of the titles) lives in
// js/book.js and must not be reimplemented differently here.

async function bookNotesFor(user, folderId, ids) {
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const n = await q.noteById.get(String(ids[i]));
    // Only the owner's own notes in this exact folder can be chapters, which is
    // the same rule js/book.js applies when it builds the reader.
    if (!n || n.owner_id !== user.id || (n.folder_id || null) !== (folderId || null)) return null;
    out.push(n);
  }
  return out;
}

function parseManifest(row) {
  try { return JSON.parse(row.manifest) || []; } catch (e) { return []; }
}

async function listBookVersions(user, folderId) {
  const rows = await q.bookVersionList.all(folderId, user.id, VERSION_LIST_MAX);
  return {
    versions: rows.map(function (r) {
      const man = parseManifest(r);
      return {
        id: r.id, folderId: r.folder_id, title: r.title, label: r.label || null,
        createdAt: r.created_at, chapters: man.length
      };
    })
  };
}

async function createBookVersion(user, folderId, body) {
  const ids = Array.isArray(body && body.chapters) ? body.chapters : [];
  if (!ids.length) return { status: 400, error: '這本書還沒有任何章節' };
  const notes = await bookNotesFor(user, folderId, ids);
  if (!notes) return { status: 400, error: '章節清單與這個資料夾對不起來，請重新整理後再試' };

  const label = String((body && body.label) || '').trim().slice(0, 80) || null;
  const title = String((body && body.title) || '未命名電子書').slice(0, 200);
  const now = Date.now();

  const out = await tx(async function () {
    const manifest = [];
    for (const n of notes) {
      // Pin each chapter to a version row captured right now, labelled so the
      // automatic pruning can never delete the text this book version points at.
      const r = await q.insertVersion.run(n.id, n.rev || 0, n.title, n.content, n.meta,
        user.username, LABEL_BOOK, now);
      manifest.push({ noteId: n.id, title: n.title, versionId: r.insertId, rev: n.rev || 0 });
    }
    const b = await q.insertBookVersion.run(folderId, user.id, title, label, JSON.stringify(manifest), now);
    return { id: b.insertId, chapters: manifest.length };
  }, 'createBookVersion');

  return {
    version: {
      id: out.id, folderId: folderId, title: title, label: label,
      createdAt: now, chapters: out.chapters
    }
  };
}

async function getBookVersion(user, versionId) {
  const row = await q.bookVersionById.get(Number(versionId), user.id);
  if (!row) return { status: 404, error: '找不到這個電子書版本' };
  const man = parseManifest(row);
  const chapters = [];
  for (const c of man) {
    const v = await q.versionById.get(c.versionId, c.noteId);
    chapters.push({
      noteId: c.noteId,
      title: v ? v.title : c.title,
      versionId: c.versionId,
      rev: c.rev,
      chars: v ? v.content.length : 0,
      // A chapter note deleted since the snapshot still shows in the manifest,
      // flagged, rather than silently vanishing from the version.
      missing: v ? undefined : true
    });
  }
  return {
    version: {
      id: row.id, folderId: row.folder_id, title: row.title, label: row.label || null,
      createdAt: row.created_at, chapters: chapters
    }
  };
}

// The content of one chapter as it was in this book version.
async function getBookVersionChapter(user, versionId, noteId) {
  const row = await q.bookVersionById.get(Number(versionId), user.id);
  if (!row) return { status: 404, error: '找不到這個電子書版本' };
  const man = parseManifest(row);
  const entry = man.filter(function (c) { return c.noteId === String(noteId); })[0];
  if (!entry) return { status: 404, error: '這個版本裡沒有這一章' };
  const v = await q.versionById.get(entry.versionId, entry.noteId);
  if (!v) return { status: 404, error: '這一章的內容已經不在了' };
  return { chapter: { noteId: v.note_id, title: v.title, content: v.content, rev: v.rev } };
}

// One transaction for the whole book: either every chapter comes back to its
// pinned version or none does. The manifest order doubles as the lock order,
// so two restores of the same book queue up instead of deadlocking.
async function restoreBookVersion(user, versionId) {
  const row = await q.bookVersionById.get(Number(versionId), user.id);
  if (!row) return { status: 404, error: '找不到這個電子書版本' };
  const man = parseManifest(row);

  const out = await tx(async function () {
    const restored = [], skipped = [], pending = [];
    for (const c of man) {
      const note = await q.noteByIdForUpdate.get(c.noteId);
      const v = note ? await q.versionById.get(c.versionId, c.noteId) : null;
      if (!note || note.owner_id !== user.id || !v) { skipped.push(c.title); continue; }
      if (v.content === note.content && v.title === note.title) continue;
      pending.push({ id: note.id, payload: await restoreNoteToVersion(user, note, v, Date.now()) });
      restored.push(c.title);
    }
    return { restored: restored, skipped: skipped, pending: pending };
  }, 'restoreBookVersion');

  out.pending.forEach(function (p) { hub.broadcastUpdate(p.id, p.payload); });
  return { ok: true, restored: out.restored.length, skipped: out.skipped };
}

async function deleteBookVersion(user, versionId) {
  const row = await q.bookVersionById.get(Number(versionId), user.id);
  if (!row) return { status: 404, error: '找不到這個電子書版本' };
  const man = parseManifest(row);

  await tx(async function () {
    await q.deleteBookVersion.run(Number(versionId), user.id);
    // The note versions this book pinned were kept alive only for it. Release
    // any that no surviving book version still references, so deleting a book
    // version actually reclaims the space it was holding. (Two concurrent
    // deletes of different book versions can each see the other's manifest and
    // leave one labelled version un-released — a small leak, never a loss.)
    const others = await q.bookVersionList.all(row.folder_id, user.id, VERSION_LIST_MAX);
    const stillPinned = new Set();
    others.forEach(function (b) {
      parseManifest(b).forEach(function (c) { stillPinned.add(c.versionId); });
    });
    for (const c of man) {
      if (stillPinned.has(c.versionId)) continue;
      const v = await q.versionById.get(c.versionId, c.noteId);
      if (v && v.label === LABEL_BOOK) await q.deleteVersion.run(c.versionId, c.noteId);
    }
  }, 'deleteBookVersion');
  return { ok: true };
}

// ---------------- public e-book links ----------------
//
// The one door in this server that opens without a session, so it is built to be
// as small a door as possible:
//
//   * It serves a *snapshot*, not the live book. The client packs the whole book
//     into one self-contained HTML file (images already inlined as data URLs) and
//     that exact file is what gets stored and later handed out. Holding the link
//     therefore grants no API access, no other notes, and none of the owner's
//     later edits — those only appear if the owner deliberately refreshes it.
//   * The token is 32 random bytes. There is nothing to enumerate.
//   * Links can expire, and can be revoked at any time by deleting the row.
//   * Only the owner of the folder can create, refresh, list or revoke one.

const LINK_MAX_HTML = 40 * 1024 * 1024;   // a book with many photos is still one file
const LINK_MAX_DAYS = 3650;

function linkToken() { return crypto.randomBytes(32).toString('hex'); }

function shapeLink(row) {
  return {
    token: row.token,
    folderId: row.folder_id,
    title: row.title,
    chapters: row.chapters,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at || null,
    expired: !!(row.expires_at && row.expires_at < Date.now()),
    views: row.views || 0,
    chars: row.chars != null ? row.chars : (row.html ? row.html.length : 0)
  };
}

function expiryFrom(days) {
  const d = parseInt(days, 10);
  if (!d || d <= 0) return null;                       // 0 / missing = never expires
  return Date.now() + Math.min(d, LINK_MAX_DAYS) * 86400000;
}

// Only the folder's owner may share it, and only if it is actually theirs.
async function ownsFolder(user, folderId) {
  const f = await q.folderById.get(String(folderId));
  return !!(f && f.owner_id === user.id);
}

async function listBookLinks(user, folderId) {
  if (!(await ownsFolder(user, folderId))) return { status: 404 };
  return { links: (await q.linkList.all(String(folderId), user.id)).map(shapeLink) };
}

async function createBookLink(user, folderId, body) {
  if (!(await ownsFolder(user, folderId))) return { status: 404 };
  const html = String((body && body.html) || '');
  if (!html) return { status: 400, error: '沒有收到書的內容' };
  if (html.length > LINK_MAX_HTML) {
    return { status: 413, error: '這本書太大（超過 40 MB），無法建立分享連結' };
  }
  const now = Date.now();
  const token = linkToken();
  await q.insertLink.run(token, String(folderId), user.id,
    String((body && body.title) || '未命名電子書').slice(0, 200),
    html, parseInt(body && body.chapters, 10) || 0,
    now, now, expiryFrom(body && body.expiresDays));
  return { link: shapeLink(await q.linkByToken.get(token)) };
}

// Re-publish an existing link so the same URL starts serving the current book.
async function updateBookLink(user, token, body) {
  const row = await q.linkOwned.get(String(token), user.id);
  if (!row) return { status: 404, error: '找不到這個分享連結' };
  const html = String((body && body.html) || '');
  if (!html) return { status: 400, error: '沒有收到書的內容' };
  if (html.length > LINK_MAX_HTML) {
    return { status: 413, error: '這本書太大（超過 40 MB），無法更新分享連結' };
  }
  const expires = (body && body.expiresDays !== undefined)
    ? expiryFrom(body.expiresDays) : (row.expires_at || null);
  await q.updateLink.run(String((body && body.title) || row.title).slice(0, 200), html,
    parseInt(body && body.chapters, 10) || row.chapters, Date.now(), expires, row.token);
  return { link: shapeLink(await q.linkByToken.get(row.token)) };
}

async function deleteBookLink(user, token) {
  const row = await q.linkOwned.get(String(token), user.id);
  if (!row) return { status: 404, error: '找不到這個分享連結' };
  await q.deleteLink.run(row.token, user.id);
  return { ok: true };
}

// Called with no session at all. Returns the stored file, or null.
async function publicBook(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
  const row = await q.linkByToken.get(String(token));
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) return { expired: true };
  // An atomic `views = views + 1`; a view counter is not worth failing over.
  try { await q.bumpLinkViews.run(row.token); } catch (e) { /* ignore */ }
  return { html: row.html, title: row.title };
}

async function updateNote(user, id, body) {
  const pre = await q.noteById.get(id);
  const perm = await permFor(user, pre);
  if (!canRead(perm)) return { status: 404 };
  if (!canEdit(perm)) return { status: 403, error: '你對這篇筆記只有唯讀權限' };

  const incoming = String(body.content || '');
  const title = String(body.title || '未命名筆記');

  const out = await tx(async function () {
    // Everything below derives from the *locked* row, not from `pre`: between
    // the permission check and here another save may have landed, and merging
    // against a stale copy is exactly the lost update this lock exists for.
    const row = await q.noteByIdForUpdate.get(id);
    if (!row) return { status: 404 };
    // A recipient with edit rights may change content, but must not be able to
    // move someone else's note into their own folder tree.
    const folderId = perm === 'owner' ? (body.folderId || null) : row.folder_id;
    // Collaborative merge: `baseContent` is the text this client last had in sync
    // with the server. If someone else saved in the meantime (row.content moved
    // on), reconcile the two edits; on a same-line clash this save wins.
    const base = (body.baseContent != null) ? String(body.baseContent) : row.content;
    const merged = merge3(base, incoming, row.content);
    const metaStr = body.meta ? JSON.stringify(body.meta) : row.meta;

    // Two kinds of change: the text itself (bumps the revision, wakes the other
    // editors, moves "last updated") and bookkeeping — folder, pin/meta — which
    // must still be written but should not look like an edit. A save that
    // changes neither is a no-op autosave and is dropped here.
    const textChanged = merged !== row.content || title !== row.title;
    const metaChanged = (folderId || null) !== (row.folder_id || null) || metaStr !== row.meta;
    if (!textChanged && !metaChanged) return { note: shapeNote(row, perm) };

    const now = textChanged ? Date.now() : row.updated_at;
    const rev = textChanged ? (row.rev || 0) + 1 : (row.rev || 0);
    // The note write and its history entry land in this one transaction. Apart,
    // a crash between them leaves either a version of text that was never
    // stored or a save with no way back to what it replaced.
    await q.updateNote.run(folderId, title, merged, metaStr, now, rev, id);
    if (textChanged) await recordVersion(row, user, title, merged, metaStr, rev, now);
    return {
      changed: true,
      payload: textChanged ? { rev: rev, content: merged, title: title, by: user.username, updatedAt: now } : null
    };
  }, 'updateNote');

  if (!out.changed) return out;
  // Let everyone watching the note pull in the authoritative merged text. `by`
  // carries the saver's name so their own client can ignore the echo.
  if (out.payload) hub.broadcastUpdate(id, out.payload);
  return { note: shapeNote(await q.noteById.get(id), perm) };
}

// Relay a live caret position to the other people viewing this note. Nothing is
// stored — it is transient presence, gone the moment the editor moves or leaves.
async function broadcastCursor(user, id, body) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return { status: 404 };
  const pos = Math.max(0, parseInt(body && body.pos, 10) || 0);
  const end = Math.max(pos, parseInt(body && body.end, 10) || pos);
  hub.broadcastCursor(id, { by: user.username, pos: pos, end: end, ts: Date.now() });
  return { ok: true };
}

// "Delete" moves the note to the trash. The row stays in `notes` with deleted_at
// set, so shares, versions and images survive and a restore is a one-column
// update; it is deleted for good by purgeNote / emptyTrash / the retention sweep.
async function deleteNote(user, id) {
  const row = await q.noteById.get(id);
  const perm = await permFor(user, row);
  if (!canRead(perm)) return { status: 404 };
  if (perm !== 'owner') return { status: 403, error: '只有擁有者可以刪除筆記' };
  await q.trashNote.run(Date.now(), id);
  return { ok: true };
}

// ---------------- trash ----------------
const cfg = require('./config');
const trashKeepMs = () => cfg.trashKeepDays * 86400000;

async function listTrash(user) {
  const rows = await q.trashOf.all(user.id);
  return {
    keepDays: cfg.trashKeepDays,
    notes: rows.map(r => ({
      id: r.id, title: r.title, folderId: r.folder_id, chars: r.chars,
      updatedAt: r.updated_at, deletedAt: r.deleted_at, expiresAt: r.deleted_at + trashKeepMs()
    }))
  };
}

// Owner-only, and only for rows that are actually in the trash: a live note (or
// someone else's) is 404 here exactly as a trashed one is 404 everywhere else.
async function trashedRowOf(user, id) {
  const row = await q.noteById.get(id);
  return row && row.owner_id === user.id && row.deleted_at ? row : null;
}
async function restoreNote(user, id) {
  if (!(await trashedRowOf(user, id))) return { status: 404 };
  const r = await q.restoreNote.run(id);
  if (!r.affectedRows) return { status: 404 };
  return { note: shapeNote(await q.noteById.get(id), 'owner') };
}
async function purgeNote(user, id) {
  if (!(await trashedRowOf(user, id))) return { status: 404 };
  await q.deleteNote.run(id);
  return { ok: true };
}
async function emptyTrash(user) {
  const r = await q.purgeTrashOf.run(user.id);
  return { ok: true, purged: r.affectedRows };
}
// Retention sweep (server.js runs it at start and hourly). One hard delete per
// row so the FK cascades do the same work they do for a manual purge.
async function purgeExpiredTrash() {
  const rows = await q.trashExpired.all(Date.now() - trashKeepMs());
  for (const r of rows) await q.deleteNote.run(r.id);
  return rows.length;
}

// ---------------- folders ----------------
// Folders are private structure; they are never shared.
function shapeFolder(r) {
  return { id: r.id, name: r.name, parentId: r.parent_id, createdAt: r.created_at, isBook: !!r.is_book };
}
async function listFolders(user) {
  return (await q.foldersOf.all(user.id)).map(shapeFolder);
}
async function createFolder(user, body) {
  const id = uid('fld');
  await q.insertFolder.run(id, user.id, String(body.name || '新資料夾'), body.parentId || null, Date.now());
  return shapeFolder(await q.folderById.get(id));
}
async function updateFolder(user, id, body) {
  const r = await q.folderById.get(id);
  if (!r || r.owner_id !== user.id) return { status: 404 };
  await tx(async function () {
    await q.updateFolder.run(String(body.name || r.name), body.parentId || null, id, user.id);
    // isBook is optional so that a rename or a move leaves the bookshelf alone.
    if (body.isBook !== undefined) await q.setFolderBook.run(body.isBook ? 1 : 0, id, user.id);
  }, 'updateFolder');
  return { folder: shapeFolder(await q.folderById.get(id)) };
}
async function deleteFolder(user, id) {
  const r = await q.folderById.get(id);
  if (!r || r.owner_id !== user.id) return { status: 404 };
  await q.deleteFolder.run(id, user.id);
  return { ok: true };
}

// ---------------- images ----------------
async function createImage(user, mime, buf) {
  const id = uid('img');
  await q.insertImage.run(id, user.id, String(mime || 'image/png'), buf, null, null, Date.now());
  return { id: id };
}

async function getImage(user, id) {
  const row = await q.imageById.get(id);
  if (!row) return null;
  if (row.owner_id === user.id) return row;
  // Not the owner: only serve it if some note the caller can read embeds it,
  // either as an image (img:) or as a PDF attachment (pdf:).
  const visible = (await q.imageVisibleTo.get('img:' + id, user.id, user.id))
              || (await q.imageVisibleTo.get('pdf:' + id, user.id, user.id));
  return visible ? row : null;
}

async function saveImage(user, id, body) {
  const row = await q.imageById.get(id);
  if (!row) return { status: 404 };
  // Annotations rewrite pixels — only the owner may do that, even if a recipient
  // has edit rights on a note that happens to embed the image.
  if (row.owner_id !== user.id) return { status: 403, error: '只有圖片擁有者可以標註' };
  const data = Buffer.from(body.data, 'base64');
  const original = body.original ? Buffer.from(body.original, 'base64') : row.original;
  await q.updateImage.run(String(body.mime || row.mime), data, original,
    body.shapes ? JSON.stringify(body.shapes) : null, id);
  return { ok: true };
}

async function deleteImage(user, id) {
  await q.deleteImage.run(id, user.id);
  return { ok: true };
}

// ---------------- shares ----------------
async function listShares(user, noteId) {
  const row = await q.noteById.get(noteId);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  return {
    shares: (await q.sharesOfNote.all(noteId)).map(s => ({ username: s.username, perm: s.perm }))
  };
}

async function addShare(user, noteId, body) {
  const row = await q.noteById.get(noteId);
  if (!row || row.owner_id !== user.id) return { status: 404 };
  const perm = body.perm === 'edit' ? 'edit' : 'read';
  const target = await q.userByName.get(String(body.username || ''));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  if (target.id === user.id) return { status: 400, error: '不能分享給自己' };
  await q.insertShare.run(noteId, target.id, perm, Date.now());
  return { ok: true, username: target.username, perm: perm };
}

async function removeShare(user, noteId, username) {
  const row = await q.noteById.get(noteId);
  if (!row) return { status: 404 };
  const target = await q.userByName.get(String(username || ''));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  // The owner may revoke anyone; a recipient may drop their own share (leave),
  // but may not meddle with anyone else's access.
  const isOwner = row.owner_id === user.id;
  const isSelf = target.id === user.id && !!(await q.shareFor.get(noteId, user.id));
  if (!isOwner && !isSelf) return { status: 404 };
  await q.deleteShare.run(noteId, target.id);
  return { ok: true };
}

// ---------------- admin ----------------
//
// Scope note: an admin manages *accounts*, not content. There is deliberately no
// endpoint here that returns anyone's note text — only counts. Reading a
// colleague's report still requires them to share it.
async function adminListUsers(user) {
  return {
    users: (await q.listUsers.all()).map(function (u) {
      return {
        id: u.id, username: u.username, role: u.role,
        disabled: !!u.disabled, createdAt: u.created_at, lastLogin: u.last_login,
        notes: u.notes, folders: u.folders, images: u.images,
        sharedOut: u.shared_out, sharedIn: u.shared_in,
        self: u.id === user.id
      };
    })
  };
}

// The "last admin" guard rails below read the admin count with the rows locked
// inside the same transaction as the change, so two admins demoting or deleting
// each other at the same moment cannot both pass the check.
async function adminSetDisabled(user, id, disabled) {
  const target = await q.userById.get(Number(id));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  if (target.id === user.id) return { status: 400, error: '不能停用自己的帳號' };
  return tx(async function () {
    if (disabled && target.role === 'admin' && (await q.countAdminsLocked.get()).n <= 1) {
      return { status: 400, error: '這是最後一個啟用中的管理員，不能停用' };
    }
    await q.setDisabled.run(disabled ? 1 : 0, target.id);
    // Kill their sessions so a disable takes effect now, not when the cookie expires.
    if (disabled) await q.deleteSessionsOf.run(target.id);
    return { ok: true, disabled: !!disabled };
  }, 'setDisabled');
}

async function adminSetRole(user, id, role) {
  const target = await q.userById.get(Number(id));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  if (role !== 'admin' && role !== 'user') return { status: 400, error: '權限值不正確' };
  if (target.id === user.id) return { status: 400, error: '不能更改自己的權限' };
  return tx(async function () {
    if (role === 'user' && target.role === 'admin' && (await q.countAdminsLocked.get()).n <= 1) {
      return { status: 400, error: '這是最後一個管理員，不能取消其權限' };
    }
    await q.setRole.run(role, target.id);
    return { ok: true, role: role };
  }, 'setRole');
}

async function adminDeleteUser(user, id) {
  const target = await q.userById.get(Number(id));
  if (!target) return { status: 404, error: '找不到這個帳號' };
  if (target.id === user.id) return { status: 400, error: '不能刪除自己的帳號' };
  return tx(async function () {
    if (target.role === 'admin' && (await q.countAdminsLocked.get()).n <= 1) {
      return { status: 400, error: '這是最後一個管理員，不能刪除' };
    }
    // Their notes, folders, images and shares go with them (ON DELETE CASCADE).
    await q.deleteSessionsOf.run(target.id);
    await q.deleteUser.run(target.id);
    return { ok: true };
  }, 'deleteUser');
}

// ---------------- storage ----------------
//
// Disk headroom where MariaDB keeps its files, plus what the database is made
// of. Sizes and counts only — consistent with the admin scope note above, this
// never touches note text. The data directory comes from `SELECT @@datadir` at
// startup; statfs on it needs no permission on the directory itself, only on
// the path leading to it, and falls back up the tree when even that is denied.
function diskFor(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch (e) { return null; }
}
function storageSummary() {
  const dir = dbmod.datadir;
  let disk = null;
  const candidates = dir ? [dir, path.dirname(dir), '/'] : [];
  for (const c of candidates) { disk = diskFor(c); if (disk) break; }
  const warnBytes = config.storageWarnMb * 1024 * 1024;
  const low = !!disk && (disk.free < warnBytes || (disk.total > 0 && disk.free / disk.total * 100 < config.storageWarnPct));
  return { disk: disk, low: low, thresholds: { bytes: warnBytes, pct: config.storageWarnPct } };
}
async function adminStorage() {
  const dbBytes = (await q.dbBytes.get()).bytes;
  const img = await q.imageBytes.get();
  const notes = await q.noteBytes.get();
  // Version history keeps a full copy of the text per version, so on a note that
  // is edited daily it can outweigh the note itself. Reporting it separately is
  // the only way the number in the panel matches what is actually on disk.
  const versions = await q.versionBytes.get();
  // Each share link stores a whole packed book, images and all, so these are the
  // single largest rows in the database and have to be visible in the panel.
  const links = await q.linkBytes.get();
  const s = storageSummary();
  return {
    dataDir: dbmod.datadir || '',
    dbBytes: dbBytes,
    images: { count: img.n, bytes: img.bytes },
    notes: { count: notes.n, bytes: notes.bytes },
    versions: { count: versions.n, bytes: versions.bytes },
    links: { count: links.n, bytes: links.bytes },
    disk: s.disk, low: s.low, thresholds: s.thresholds,
    perUser: (await q.storagePerUser.all()).map(function (u) {
      return {
        id: u.id, username: u.username,
        notes: u.notes, noteBytes: u.note_bytes,
        versions: u.versions, versionBytes: u.version_bytes,
        images: u.images, imageBytes: u.image_bytes
      };
    })
  };
}

module.exports = {
  adminListUsers, adminSetDisabled, adminSetRole, adminDeleteUser, adminStorage, storageSummary,
  listNotes, getNote, createNote, updateNote, deleteNote, broadcastCursor, setAccess,
  listTrash, restoreNote, purgeNote, emptyTrash, purgeExpiredTrash,
  listVersions, getVersion, createVersion, renameVersion, deleteVersion, restoreVersion,
  listBookVersions, createBookVersion, getBookVersion, getBookVersionChapter,
  restoreBookVersion, deleteBookVersion,
  listBookLinks, createBookLink, updateBookLink, deleteBookLink, publicBook,
  listFolders, createFolder, updateFolder, deleteFolder,
  createImage, getImage, saveImage, deleteImage,
  listShares, addShare, removeShare
};

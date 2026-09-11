/* store.js — persistence via the server API.
 *
 * This module used to talk to IndexedDB. It now talks to /api, but deliberately
 * keeps the same promise-based shape (getNotes / createNote / putImage / …) so
 * the rest of the front-end did not have to change.
 *
 * Nothing here decides who may see what — the server does, on every request.
 */
(function (global) {
  'use strict';

  function uid(prefix) {
    uid._c = (uid._c || 0) + 1;
    return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + uid._c.toString(36);
  }

  // The custom header is what makes a cross-site form post fail our CSRF check.
  function headers(extra) {
    return Object.assign({ 'X-Requested-With': 'report-notes' }, extra || {});
  }

  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function req(method, path, body, opts, attempt) {
    const o = opts || {};
    const init = { method: method, headers: headers(o.headers), credentials: 'same-origin' };
    if (body !== undefined) {
      if (o.raw) init.body = body;
      else { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    }
    return fetch(path, init).then(function (r) {
      // 503 means the database was momentarily locked. It is transient by
      // definition, so retry rather than making the user notice it — otherwise an
      // autosave could sit unsaved until the next keystroke.
      if (r.status === 503 && (attempt || 0) < 2) {
        return delay(600 * ((attempt || 0) + 1))
          .then(function () { return req(method, path, body, opts, (attempt || 0) + 1); });
      }
      if (r.status === 401) {
        // Session gone (expired, or logged out in another tab) — bounce to login
        // rather than let the UI silently fail on every keystroke.
        if (global.Auth && global.Auth.onSessionLost) global.Auth.onSessionLost();
        throw new Error('請重新登入');
      }
      if (o.blob) {
        if (!r.ok) throw new Error('讀取失敗 (' + r.status + ')');
        return r.blob();
      }
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error(data.error || ('請求失敗 (' + r.status + ')'));
        return data;
      });
    });
  }

  // Notes arrive with a `perm` of owner | edit | read; the UI uses it to decide
  // whether to allow editing. The server enforces it regardless.
  const Store = {
    uid: uid,

    // Probe the backend before the app trusts it.
    //
    // A plain file server (python -m http.server, an IDE live-preview, nginx
    // serving the folder) will happily hand out index.html and then 404/501 every
    // /api call. That produced baffling "請求失敗 (501)" errors, so tell the
    // difference here and report which of the two is actually wrong.
    ready: function () {
      return fetch('/api/me', { headers: headers(), credentials: 'same-origin' })
        .then(function (r) {
          const ct = r.headers.get('content-type') || '';
          if (!r.ok || ct.indexOf('json') < 0) {
            const e = new Error('wrong-server');
            e.wrongServer = true;
            e.status = r.status;
            throw e;
          }
          return r.json().then(function (data) {
            if (!data || typeof data.registerMode !== 'string') {
              const e = new Error('wrong-server');
              e.wrongServer = true;
              e.status = r.status;
              throw e;
            }
            return data;
          });
        }, function () {
          const e = new Error('no-server');
          e.noServer = true;
          throw e;
        });
    },

    // Folders (private — never shared)
    getFolders: function () { return req('GET', '/api/folders').then(r => r.folders); },
    createFolder: function (name, parentId) {
      return req('POST', '/api/folders', { name: name || '新資料夾', parentId: parentId || null })
        .then(r => r.folder);
    },
    updateFolder: function (folder) {
      const body = { name: folder.name, parentId: folder.parentId || null };
      if (folder.isBook !== undefined) body.isBook = !!folder.isBook;
      return req('PUT', '/api/folders/' + folder.id, body).then(r => r.folder);
    },
    deleteFolder: function (id) { return req('DELETE', '/api/folders/' + id); },

    // Notes
    getNotes: function () { return req('GET', '/api/notes').then(r => r.notes); },
    getNote: function (id) { return req('GET', '/api/notes/' + id).then(r => r.note); },
    createNote: function (title, folderId) {
      return req('POST', '/api/notes', { title: title || '未命名筆記', folderId: folderId || null, content: '' })
        .then(r => r.note);
    },
    updateNote: function (note) {
      return req('PUT', '/api/notes/' + note.id, {
        title: note.title, content: note.content, folderId: note.folderId || null, meta: note.meta,
        // For collaborative merge: the revision/content this client was last in
        // sync with. The server reconciles against these if someone else saved.
        baseRev: note.baseRev, baseContent: note.baseContent
      }).then(function (r) {
        note.updatedAt = r.note.updatedAt;
        note.rev = r.note.rev;
        return r.note;   // authoritative note (may hold merged content)
      });
    },
    deleteNote: function (id) { return req('DELETE', '/api/notes/' + id); },

    // Trash. deleteNote above only moves a note into it; these are the way back
    // out (restore) or all the way out (purge). getTrash resolves to
    // { keepDays, notes: [{ id, title, folderId, chars, deletedAt, expiresAt }] }.
    getTrash: function () { return req('GET', '/api/trash'); },
    restoreNote: function (id) { return req('POST', '/api/notes/' + id + '/restore').then(r => r.note); },
    purgeNote: function (id) { return req('DELETE', '/api/trash/' + id); },
    emptyTrash: function () { return req('DELETE', '/api/trash'); },

    // Version history. The list never carries note bodies — only sizes — so
    // opening the panel on a long note stays cheap.
    getVersions: function (noteId) { return req('GET', '/api/notes/' + noteId + '/versions'); },
    getVersion: function (noteId, versionId) {
      return req('GET', '/api/notes/' + noteId + '/versions/' + versionId);
    },
    createVersion: function (noteId, label) {
      return req('POST', '/api/notes/' + noteId + '/versions', { label: label || '' }).then(r => r.version);
    },
    renameVersion: function (noteId, versionId, label) {
      return req('PUT', '/api/notes/' + noteId + '/versions/' + versionId, { label: label || '' });
    },
    deleteVersion: function (noteId, versionId) {
      return req('DELETE', '/api/notes/' + noteId + '/versions/' + versionId);
    },
    restoreVersion: function (noteId, versionId) {
      return req('POST', '/api/notes/' + noteId + '/versions/' + versionId + '/restore', {})
        .then(r => r.note);
    },

    // E-book versions. `chapters` is the ordered list of note ids as js/book.js
    // computed it — the server pins each one but does not re-derive the order.
    getBookVersions: function (folderId) {
      return req('GET', '/api/books/' + folderId + '/versions').then(r => r.versions);
    },
    createBookVersion: function (folderId, title, label, chapterIds) {
      return req('POST', '/api/books/' + folderId + '/versions',
        { title: title, label: label || '', chapters: chapterIds }).then(r => r.version);
    },
    getBookVersion: function (versionId) {
      return req('GET', '/api/book-versions/' + versionId).then(r => r.version);
    },
    getBookVersionChapter: function (versionId, noteId) {
      return req('GET', '/api/book-versions/' + versionId + '/chapters/' + noteId).then(r => r.chapter);
    },
    restoreBookVersion: function (versionId) {
      return req('POST', '/api/book-versions/' + versionId + '/restore', {});
    },
    deleteBookVersion: function (versionId) {
      return req('DELETE', '/api/book-versions/' + versionId);
    },

    // Public e-book links. `html` is the packed, self-contained book; the server
    // stores it verbatim and serves that exact file at /s/<token>, so a link
    // never exposes an API or anything outside the book it was made from.
    getBookLinks: function (folderId) {
      return req('GET', '/api/books/' + folderId + '/links').then(r => r.links);
    },
    createBookLink: function (folderId, payload) {
      return req('POST', '/api/books/' + folderId + '/links', payload).then(r => r.link);
    },
    updateBookLink: function (token, payload) {
      return req('PUT', '/api/book-links/' + token, payload).then(r => r.link);
    },
    deleteBookLink: function (token) { return req('DELETE', '/api/book-links/' + token); },

    // Sharing
    getShares: function (noteId) { return req('GET', '/api/notes/' + noteId + '/shares').then(r => r.shares); },
    addShare: function (noteId, username, perm) {
      return req('POST', '/api/notes/' + noteId + '/shares', { username: username, perm: perm });
    },
    removeShare: function (noteId, username) {
      return req('DELETE', '/api/notes/' + noteId + '/shares/' + encodeURIComponent(username));
    },
    // General access (owner only): 'restricted' | 'site', with 'read' | 'edit' for site
    setAccess: function (noteId, mode, perm) {
      return req('PUT', '/api/notes/' + noteId + '/access', { mode: mode, perm: perm });
    },

    // Live collaboration: subscribe to a note's Server-Sent-Events stream.
    // handlers = { onUpdate(payload), onPresence(users), onCursor(payload) }.
    openNoteStream: function (noteId, handlers) {
      if (typeof EventSource === 'undefined') return function () {};
      const es = new EventSource('/api/notes/' + noteId + '/events');
      es.addEventListener('update', function (e) {
        try { handlers.onUpdate && handlers.onUpdate(JSON.parse(e.data)); } catch (x) {}
      });
      es.addEventListener('presence', function (e) {
        try { handlers.onPresence && handlers.onPresence(JSON.parse(e.data).users || []); } catch (x) {}
      });
      es.addEventListener('cursor', function (e) {
        try { handlers.onCursor && handlers.onCursor(JSON.parse(e.data)); } catch (x) {}
      });
      return function close() { try { es.close(); } catch (x) {} };
    },
    // Report my caret position to the note's other editors (fire-and-forget).
    sendCursor: function (noteId, pos, end) {
      return req('POST', '/api/notes/' + noteId + '/cursor', { pos: pos, end: end });
    },

    // Images
    putImage: function (blob) {
      return req('POST', '/api/images', blob, { raw: true, headers: { 'Content-Type': blob.type || 'image/png' } })
        .then(r => r.id);
    },
    getImage: function (id) {
      return Promise.all([
        req('GET', '/api/images/' + id, undefined, { blob: true }),
        req('GET', '/api/images/' + id + '/meta')
      ]).then(function (res) {
        return { id: id, blob: res[0], type: res[1].mime, shapes: res[1].shapes, canAnnotate: res[1].canAnnotate };
      }).catch(function () { return null; });
    },
    // Kept separate so rendering a note does not drag the pre-annotation copy
    // of every screenshot over the wire.
    getImageOriginal: function (id) {
      return req('GET', '/api/images/' + id + '/original', undefined, { blob: true });
    },
    saveImage: function (rec) {
      return blobToBase64(rec.blob).then(function (data) {
        const payload = { data: data, mime: rec.type || 'image/png', shapes: rec.shapes || [] };
        if (rec.original) {
          return blobToBase64(rec.original).then(function (orig) {
            payload.original = orig;
            return req('PUT', '/api/images/' + rec.id, payload);
          });
        }
        return req('PUT', '/api/images/' + rec.id, payload);
      });
    },
    deleteImage: function (id) { return req('DELETE', '/api/images/' + id); },

    // Auth
    login: function (username, password) {
      return req('POST', '/api/login', { username: username, password: password });
    },
    changePassword: function (current, next) {
      return req('POST', '/api/change-password', { current: current, next: next });
    },

    // Admin (the server rejects these for non-admins regardless of the UI)
    adminListUsers: function () { return req('GET', '/api/admin/users').then(r => r.users); },
    adminSetDisabled: function (id, disabled) {
      return req('POST', '/api/admin/users/' + id + '/disabled', { disabled: !!disabled });
    },
    adminSetRole: function (id, role) {
      return req('POST', '/api/admin/users/' + id + '/role', { role: role });
    },
    adminDeleteUser: function (id) { return req('DELETE', '/api/admin/users/' + id); },
    adminStorage: function () { return req('GET', '/api/admin/storage'); },
    register: function (username, password, invite) {
      return req('POST', '/api/register', { username: username, password: password, invite: invite });
    },
    logout: function () { return req('POST', '/api/logout', {}); }
  };

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1]); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  global.Store = Store;
})(window);

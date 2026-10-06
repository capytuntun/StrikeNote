/* hub.js — in-memory Server-Sent-Events fan-out for live note collaboration.
 *
 * One channel per note id. Clients open GET /api/notes/:id/events and hang on the
 * response; the API broadcasts `update` events when a note is saved and `presence`
 * events when the set of connected editors changes. Nothing here is persisted —
 * if the process restarts, clients simply reconnect (EventSource does this for us).
 */
'use strict';

// noteId -> Set<client>, where client = { res, userId, username }
const channels = new Map();
let seq = 0;   // unique id per connection, so a user open in two tabs is counted once per tab

function write(client, event, data) {
  try {
    client.res.write('event: ' + event + '\n');
    client.res.write('data: ' + JSON.stringify(data) + '\n\n');
  } catch (e) { /* socket already gone; cleanup runs on 'close' */ }
}

// The list of distinct usernames currently watching a note.
function presenceList(noteId) {
  const set = channels.get(noteId);
  if (!set) return [];
  const names = [];
  set.forEach(function (c) { if (names.indexOf(c.username) < 0) names.push(c.username); });
  return names;
}

function broadcastPresence(noteId) {
  const set = channels.get(noteId);
  if (!set) return;
  const users = presenceList(noteId);
  set.forEach(function (c) { write(c, 'presence', { users: users }); });
}

// Register a live connection. Returns an unsubscribe fn to call on disconnect.
function subscribe(noteId, res, user) {
  let set = channels.get(noteId);
  if (!set) { set = new Set(); channels.set(noteId, set); }
  const client = { id: ++seq, res: res, userId: user.id, username: user.username };
  set.add(client);
  // Tell the newcomer who is already here, and tell everyone the newcomer arrived.
  write(client, 'presence', { users: presenceList(noteId) });
  broadcastPresence(noteId);
  return function unsubscribe() {
    const s = channels.get(noteId);
    if (!s) return;
    s.delete(client);
    if (s.size === 0) channels.delete(noteId);
    else broadcastPresence(noteId);
  };
}

// Push a saved-content event to everyone on the channel. `by` lets each client
// recognise (and skip) the echo of a save it made itself.
function broadcastUpdate(noteId, payload) {
  const set = channels.get(noteId);
  if (!set) return;
  set.forEach(function (c) { write(c, 'update', payload); });
}

// Push a live caret position to everyone on the channel. Recipients skip the
// echo of their own caret by comparing `by` to their username.
function broadcastCursor(noteId, payload) {
  const set = channels.get(noteId);
  if (!set) return;
  set.forEach(function (c) { write(c, 'cursor', payload); });
}

// Keep proxies and browsers from timing the idle stream out.
function ping() {
  channels.forEach(function (set) {
    set.forEach(function (c) {
      try { c.res.write(': ping\n\n'); } catch (e) { /* ignore */ }
    });
  });
}
setInterval(ping, 25000).unref();

// 系統監控用：現在有幾條 SSE 連線、幾篇筆記有人開著、幾個不同的人
function stats() {
  let conns = 0;
  const users = new Set();
  channels.forEach(function (set) { conns += set.size; set.forEach(function (c) { users.add(c.userId); }); });
  return { connections: conns, notesOpen: channels.size, users: users.size };
}

module.exports = { subscribe, broadcastUpdate, broadcastCursor, presenceList, stats };

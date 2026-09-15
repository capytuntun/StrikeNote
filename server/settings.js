/* settings.js — site settings an admin changes in 帳號管理 rather than in the
 * environment: who may register (open / invite / closed) and the invite code.
 *
 * Stored in the `settings` table and cached here (a single instance runs, so the
 * cache is the truth between saves). REGISTER_MODE / INVITE_CODE are only the
 * starting values: they apply until an admin saves a choice, and from then on
 * the stored setting wins on every restart. An invite-only site always has a
 * code — one is generated and stored the first time invite mode needs it, so it
 * no longer changes on every restart the way the old in-memory one did.
 */
'use strict';

const crypto = require('node:crypto');
const { q, tx } = require('./db');
const config = require('./config');

const MODES = ['open', 'invite', 'closed'];
const CODE_RE = /^[\x21-\x7e]{6,64}$/;

let current = { registerMode: 'invite', inviteCode: '' };

function newCode() { return crypto.randomBytes(9).toString('base64url'); }

function get() {
  return { registerMode: current.registerMode, inviteCode: current.inviteCode };
}

// Called once from server.js after db.init(). Resolves to { generated } so the
// startup banner can print a freshly made code exactly once.
async function load() {
  const saved = {};
  for (const r of await q.settingsAll.all()) saved[r.k] = r.v;
  const envMode = MODES.indexOf(config.registerMode) >= 0 ? config.registerMode : 'invite';
  current = {
    registerMode: MODES.indexOf(saved.register_mode) >= 0 ? saved.register_mode : envMode,
    inviteCode: saved.invite_code || config.inviteCode || ''
  };
  if (current.registerMode === 'invite' && !current.inviteCode) {
    // Only the code is stored here: writing the mode too would pin today's
    // REGISTER_MODE into the database before any admin has chosen anything.
    current.inviteCode = newCode();
    await q.setSetting.run('invite_code', current.inviteCode, Date.now());
    return { generated: true };
  }
  return { generated: false };
}

// body: { registerMode?, inviteCode?, regenerateInvite? }. Resolves to the new
// settings, or { error } for a value that cannot be saved.
async function update(body, who) {
  const b = body || {};
  const next = get();
  if (b.registerMode !== undefined) {
    if (MODES.indexOf(b.registerMode) < 0) return { error: '不支援的註冊方式' };
    next.registerMode = b.registerMode;
  }
  if (b.regenerateInvite) {
    next.inviteCode = newCode();
  } else if (b.inviteCode !== undefined) {
    const code = String(b.inviteCode).trim();
    if (!CODE_RE.test(code)) return { error: '邀請碼要 6–64 個字元，只能用英數字與符號，不能有空白或中文' };
    next.inviteCode = code;
  }
  if (next.registerMode === 'invite' && !next.inviteCode) next.inviteCode = newCode();

  const now = Date.now();
  await tx(async function () {
    await q.setSetting.run('register_mode', next.registerMode, now);
    await q.setSetting.run('invite_code', next.inviteCode, now);
  }, 'saveSettings');
  const changes = [];
  if (next.registerMode !== current.registerMode) changes.push('註冊方式改成 ' + next.registerMode);
  if (next.inviteCode !== current.inviteCode) changes.push('邀請碼已更換');
  current = next;
  // The operator's log records who opened registration; never the code itself.
  if (changes.length) console.log('[settings] ' + (who ? who.username : '?') + '：' + changes.join('、'));
  return get();
}

// Constant time, on bytes: comparing string lengths is not enough, because
// timingSafeEqual throws on buffers of different byte length and a CJK guess
// has more bytes than characters.
function inviteMatches(given) {
  const expect = Buffer.from(current.inviteCode || '');
  const got = Buffer.from(String(given || ''));
  return expect.length > 0 && got.length === expect.length && crypto.timingSafeEqual(got, expect);
}

module.exports = { MODES, load, get, update, inviteMatches };

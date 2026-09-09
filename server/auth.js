/* auth.js — registration, login, sessions. Built on node:crypto only.
 *
 * Passwords: scrypt with a per-user random salt, compared in constant time.
 * Sessions: a 256-bit random token given to the browser; only its SHA-256 hash
 * is stored, so a database leak does not hand out live sessions.
 */
'use strict';

const crypto = require('node:crypto');
const { q } = require('./db');
const config = require('./config');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const COOKIE = 'rn_session';

function scrypt(password, salt) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      function (err, key) { err ? reject(err) : resolve(key); });
  });
}

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

function validUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(u);
}

function isDup(e) { return !!e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062); }

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt);
  return { salt, hash };
}

async function setPassword(userId, password) {
  if (typeof password !== 'string' || password.length < config.minPasswordLength) {
    return { error: '密碼至少需 ' + config.minPasswordLength + ' 個字元' };
  }
  const { salt, hash } = await hashPassword(password);
  await q.setPassword.run(hash, salt, userId);
  return { ok: true };
}

// Bootstrap: make sure an admin exists on first run.
//
// A well-known password on an internet-facing host is the single most exploited
// weakness there is, so unless one is supplied explicitly we generate a random
// one, print it once, and force it to be changed at first login.
async function ensureAdmin() {
  const name = config.adminUsername;
  const existing = await q.userByName.get(name);
  if (existing) {
    if (existing.role !== 'admin') await q.setRole.run('admin', existing.id);
    return null;
  }
  const chosen = config.adminPassword;
  const password = chosen || crypto.randomBytes(12).toString('base64url');
  const { salt, hash } = await hashPassword(password);
  let r;
  try { r = await q.insertUser.run(name, hash, salt, Date.now(), 'admin'); }
  catch (e) {
    // Two instances booting at once: the other one won, and that is fine.
    if (isDup(e)) return null;
    throw e;
  }
  // A password the operator picked is their own decision; a generated one must
  // be replaced, because it has been printed to a log.
  await q.setMustChange.run(chosen ? 0 : 1, r.insertId);
  return { username: name, password: password, generated: !chosen };
}

async function createUser(username, password, inviteCode) {
  if (!validUsername(username)) {
    return { error: '帳號需為 3–32 個字元，僅能使用英數字與 _ . -' };
  }
  if (typeof password !== 'string' || password.length < config.minPasswordLength) {
    return { error: '密碼至少需 ' + config.minPasswordLength + ' 個字元' };
  }
  // The very first account is always allowed — otherwise a fresh invite-only
  // deployment could never be bootstrapped.
  const isFirst = (await q.countUsers.get()).n === 0;
  if (!isFirst) {
    if (config.registerMode === 'closed') return { error: '此站台已關閉註冊' };
    if (config.registerMode === 'invite') {
      const given = String(inviteCode || '');
      const expect = config.inviteCode;
      const okLen = given.length === expect.length;
      const ok = okLen && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expect));
      if (!ok) return { error: '邀請碼不正確' };
    }
  }
  if (await q.userByName.get(username)) return { error: '此帳號已被使用' };

  const { salt, hash } = await hashPassword(password);
  const now = Date.now();
  let r;
  // The name check above is only a fast path: two registrations for the same
  // name can interleave now that the DB is async, and the UNIQUE key is what
  // actually decides.
  try { r = await q.insertUser.run(username, hash, salt, now, 'user'); }
  catch (e) {
    if (isDup(e)) return { error: '此帳號已被使用' };
    throw e;
  }
  // Registering signs you straight in, so it counts as a login — otherwise the
  // admin panel shows "never logged in" for someone who is using the app.
  await q.touchLogin.run(now, r.insertId);
  return { user: { id: r.insertId, username: username, role: 'user' } };
}

async function verifyPassword(username, password) {
  const row = await q.userByName.get(username);
  if (!row) {
    // Hash anyway so a missing account is not detectably faster than a wrong password.
    await scrypt(String(password || ''), crypto.randomBytes(16));
    return null;
  }
  const hash = await scrypt(String(password || ''), Buffer.from(row.pw_salt));
  const stored = Buffer.from(row.pw_hash);
  if (hash.length !== stored.length || !crypto.timingSafeEqual(hash, stored)) return null;
  // Check disabled only after the password is verified, so the response cannot be
  // used to enumerate which accounts exist.
  if (row.disabled) return { disabled: true };
  await q.touchLogin.run(Date.now(), row.id);
  return { id: row.id, username: row.username, role: row.role, mustChangePassword: !!row.must_change_pw };
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  await q.insertSession.run(sha256(token), userId, now, now + config.sessionTtlDays * 86400000);
  return token;
}

async function userFromToken(token) {
  if (!token) return null;
  const row = await q.sessionByHash.get(sha256(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await q.deleteSession.run(row.token_hash);
    return null;
  }
  const user = await q.userById.get(row.user_id);
  if (!user) return null;
  // Disabling must bite straight away, not at the next login — an attacker with a
  // live session would otherwise keep it for the full two weeks.
  if (user.disabled) {
    await q.deleteSessionsOf.run(user.id);
    return null;
  }
  return user;
}

async function destroySession(token) {
  if (token) await q.deleteSession.run(sha256(token));
}

// ---------------- login throttling ----------------
// Keyed by username+IP so one attacker cannot lock out a real user globally.
// In-memory and per process: fine for the single instance this app runs as.
const attempts = new Map();
function throttleKey(username, ip) { return String(username).toLowerCase() + '|' + ip; }

function isLockedOut(username, ip) {
  const rec = attempts.get(throttleKey(username, ip));
  if (!rec) return 0;
  if (rec.until > Date.now()) return Math.ceil((rec.until - Date.now()) / 1000);
  if (rec.until) attempts.delete(throttleKey(username, ip));
  return 0;
}
function noteFailure(username, ip) {
  const k = throttleKey(username, ip);
  const rec = attempts.get(k) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= config.maxLoginAttempts) {
    rec.until = Date.now() + config.loginLockoutMs;
    rec.n = 0;
  }
  attempts.set(k, rec);
}
function noteSuccess(username, ip) { attempts.delete(throttleKey(username, ip)); }

// ---------------- cookies ----------------
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (part) {
    const i = part.indexOf('=');
    if (i < 0) return;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch (e) { /* malformed percent-escape: ignore that cookie */ }
  });
  return out;
}

function sessionCookie(token, secure) {
  const bits = [
    COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',              // unreadable from JS, so XSS cannot lift the session
    'SameSite=Strict',       // browser will not attach it to cross-site requests (CSRF)
    'Max-Age=' + (config.sessionTtlDays * 86400)
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}
function clearCookie(secure) {
  const bits = [COOKIE + '=', 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

// Housekeeping: drop expired rows hourly. Started by server.js once the pool is
// up (a timer at module load would fire before db.init()).
function startHousekeeping() {
  setInterval(function () {
    q.deleteExpiredSessions.run(Date.now()).catch(function () { /* next hour */ });
  }, 3600000).unref();
}

module.exports = {
  COOKIE, createUser, verifyPassword, createSession, userFromToken, destroySession,
  isLockedOut, noteFailure, noteSuccess, parseCookies, sessionCookie, clearCookie, validUsername,
  ensureAdmin, setPassword, hashPassword, startHousekeeping
};

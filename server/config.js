/* config.js — runtime settings, all overridable by environment variables.
 *
 * Defaults are chosen for a public deployment: registration is invite-only and
 * cookies are marked Secure unless you explicitly say the server is plain HTTP.
 */
'use strict';

const path = require('node:path');

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return v === '1' || String(v).toLowerCase() === 'true';
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const ROOT = path.resolve(__dirname, '..');

const config = {
  port: int(process.env.PORT, 8080),
  // 0.0.0.0 is the developer default. Behind cloudflared / a reverse proxy the
  // app should only be reachable from that proxy: set HOST=127.0.0.1.
  host: process.env.HOST || '0.0.0.0',

  // Static assets = the existing front-end, served from the repo root.
  staticDir: ROOT,

  // MariaDB. Either a TCP host/port or a unix socket path (DB_SOCKET wins).
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: int(process.env.DB_PORT, 3306),
    socket: process.env.DB_SOCKET || '',
    name: process.env.DB_NAME || 'strikenote',
    user: process.env.DB_USER || 'strikenote',
    password: process.env.DB_PASSWORD || ''
  },

  // 'open' | 'invite' | 'closed'. Invite-only by default — an open registration
  // endpoint on a public host means anyone can help themselves to an account.
  registerMode: process.env.REGISTER_MODE || 'invite',
  inviteCode: process.env.INVITE_CODE || '',

  // Set TRUST_PROXY=1 when running behind cloudflared/nginx/Caddy so the
  // forwarded-protocol and client-IP headers are honoured (Secure cookie flag,
  // HTTPS redirect, login throttling).
  trustProxy: bool(process.env.TRUST_PROXY, false),
  // Only turn this off for localhost testing. Over the public internet, a
  // session cookie without Secure is a session cookie you have given away.
  requireHttps: bool(process.env.REQUIRE_HTTPS, true),

  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 14),
  minPasswordLength: int(process.env.MIN_PASSWORD_LENGTH, 12),

  // Bootstrap admin. Leave ADMIN_PASSWORD unset to get a random one printed at
  // first start, which must then be changed on first login.
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // Login throttling, per username+IP.
  maxLoginAttempts: int(process.env.MAX_LOGIN_ATTEMPTS, 5),
  loginLockoutMs: int(process.env.LOGIN_LOCKOUT_MINUTES, 15) * 60 * 1000,

  // Images/PDFs are posted whole, and a packed share-book arrives as one JSON
  // body, so this is the real ceiling on both. Keep it under MariaDB's
  // max_allowed_packet (64M in deploy/mariadb/60-strikenote.cnf).
  maxBodyBytes: int(process.env.MAX_BODY_BYTES, 25 * 1024 * 1024),

  // Low-disk warning for admins (storage panel + startup/hourly log line):
  // trip when free space on the MariaDB data directory drops below either.
  storageWarnMb: int(process.env.STORAGE_WARN_MB, 1024),
  storageWarnPct: int(process.env.STORAGE_WARN_PCT, 10),

  // Deleting a note only moves it to the trash; it is deleted for good this many
  // days later (hourly sweep), or sooner if the owner empties the trash.
  trashKeepDays: int(process.env.TRASH_KEEP_DAYS, 30),

  // Files above MAX_BODY_BYTES (course videos, big decks) are uploaded in chunks and
  // stored as chunks (image_chunks); this caps one whole file. 0 turns chunked uploads off.
  uploadMaxBytes: int(process.env.UPLOAD_MAX_BYTES, 1024 * 1024 * 1024),

  // A backup zip being uploaded for restore is written to the temp directory in
  // chunks (each under MAX_BODY_BYTES); this caps the whole file.
  backupMaxBytes: int(process.env.BACKUP_MAX_BYTES, 4 * 1024 * 1024 * 1024),

  // Link preview cards ({%preview url %}) make the server fetch the linked page
  // (server/linkpreview.js). Set LINK_PREVIEW=0 on a host that must not make
  // outbound requests; cards then show just the address.
  linkPreview: bool(process.env.LINK_PREVIEW, true)
};

// Refuse to start against a password-less TCP account: that is never what a
// deployment wants, and the failure would otherwise surface as a confusing
// ER_ACCESS_DENIED at the first query.
if (!config.db.password && !config.db.socket) {
  console.error('DB_PASSWORD 未設定（或改用 DB_SOCKET 走 unix socket）。請見 deploy/env.example。');
  process.exit(1);
}

module.exports = config;

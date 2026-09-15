/* zip.js — a small ZIP writer and reader on node:zlib alone (no dependency).
 *
 * Writer: entries are handed over whole (a note, one image, one JSON index), so
 * every local header carries its real sizes and CRC — no data descriptors, which
 * keeps the file readable by every unzip tool and lets the reader trust the
 * central directory. Output goes to an async `write(buf)` sink so a backup can
 * stream straight into an HTTP response with back-pressure instead of being
 * assembled in memory. Zip64 records are emitted only when the archive actually
 * needs them (≥ 4 GB or ≥ 65535 entries). Names are UTF-8 (general-purpose bit 11).
 *
 * Reader: random access over an open file descriptor — the central directory is
 * read once, entries are inflated on demand with an output cap, so a hostile
 * archive can neither traverse paths (we only ever look names up) nor blow up
 * memory (inflateRawSync's maxOutputLength).
 */
'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

let TABLE = null;
function crcTable() {
  if (TABLE) return TABLE;
  TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    TABLE[n] = c;
  }
  return TABLE;
}
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  const t = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosTime(ms) {
  const d = new Date(ms);
  const y = d.getFullYear();
  if (!(y >= 1980)) return { date: (1 << 5) | 1, time: 0 };
  return {
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
  };
}

function zip64Extra(usize, csize, offset) {
  const b = Buffer.alloc(4 + 16 + (offset != null ? 8 : 0));
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(b.length - 4, 2);
  b.writeBigUInt64LE(BigInt(usize), 4);
  b.writeBigUInt64LE(BigInt(csize), 12);
  if (offset != null) b.writeBigUInt64LE(BigInt(offset), 20);
  return b;
}

const MAX32 = 0xFFFFFFFF;

class ZipWriter {
  // write: async (buffer) => void
  constructor(write) {
    this.write = write;
    this.offset = 0;
    this.entries = [];
  }

  async emit(buf) {
    await this.write(buf);
    this.offset += buf.length;
  }

  // opts: { deflate: bool (default true), level, mtime }
  async add(name, data, opts) {
    const o = opts || {};
    const nameBuf = Buffer.from(String(name), 'utf8');
    const crc = crc32(data);
    let method = 0, payload = data;
    if (o.deflate !== false && data.length > 0) {
      const z = zlib.deflateRawSync(data, { level: o.level == null ? 6 : o.level });
      if (z.length < data.length) { method = 8; payload = z; }
    }
    const t = dosTime(o.mtime || Date.now());
    const big = data.length >= MAX32 || payload.length >= MAX32;
    const extra = big ? zip64Extra(data.length, payload.length, null) : Buffer.alloc(0);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(big ? 45 : 20, 4);
    h.writeUInt16LE(0x0800, 6);
    h.writeUInt16LE(method, 8);
    h.writeUInt16LE(t.time, 10);
    h.writeUInt16LE(t.date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(big ? MAX32 : payload.length, 18);
    h.writeUInt32LE(big ? MAX32 : data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(extra.length, 28);
    const offset = this.offset;
    await this.emit(Buffer.concat([h, nameBuf, extra]));
    await this.emit(payload);
    this.entries.push({ nameBuf, method, time: t.time, date: t.date, crc, csize: payload.length, usize: data.length, offset });
  }

  async finish() {
    const cdStart = this.offset;
    let zip64 = this.entries.length >= 0xFFFF;
    for (const e of this.entries) {
      const big = e.offset >= MAX32 || e.csize >= MAX32 || e.usize >= MAX32;
      if (big) zip64 = true;
      const extra = big ? zip64Extra(e.usize, e.csize, e.offset) : Buffer.alloc(0);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0);
      c.writeUInt16LE(big ? 45 : 20, 4);
      c.writeUInt16LE(big ? 45 : 20, 6);
      c.writeUInt16LE(0x0800, 8);
      c.writeUInt16LE(e.method, 10);
      c.writeUInt16LE(e.time, 12);
      c.writeUInt16LE(e.date, 14);
      c.writeUInt32LE(e.crc, 16);
      c.writeUInt32LE(big ? MAX32 : e.csize, 20);
      c.writeUInt32LE(big ? MAX32 : e.usize, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt16LE(extra.length, 30);
      c.writeUInt16LE(0, 32);
      c.writeUInt16LE(0, 34);
      c.writeUInt16LE(0, 36);
      c.writeUInt32LE(0, 38);
      c.writeUInt32LE(big ? MAX32 : e.offset, 42);
      await this.emit(Buffer.concat([c, e.nameBuf, extra]));
    }
    const cdSize = this.offset - cdStart;
    if (zip64 || cdStart >= MAX32 || cdSize >= MAX32) {
      const at = this.offset;
      const r = Buffer.alloc(56);
      r.writeUInt32LE(0x06064b50, 0);
      r.writeBigUInt64LE(BigInt(44), 4);
      r.writeUInt16LE(45, 12);
      r.writeUInt16LE(45, 14);
      r.writeUInt32LE(0, 16);
      r.writeUInt32LE(0, 20);
      r.writeBigUInt64LE(BigInt(this.entries.length), 24);
      r.writeBigUInt64LE(BigInt(this.entries.length), 32);
      r.writeBigUInt64LE(BigInt(cdSize), 40);
      r.writeBigUInt64LE(BigInt(cdStart), 48);
      const l = Buffer.alloc(20);
      l.writeUInt32LE(0x07064b50, 0);
      l.writeUInt32LE(0, 4);
      l.writeBigUInt64LE(BigInt(at), 8);
      l.writeUInt32LE(1, 16);
      await this.emit(Buffer.concat([r, l]));
    }
    const e = Buffer.alloc(22);
    const n = Math.min(this.entries.length, 0xFFFF);
    e.writeUInt32LE(0x06054b50, 0);
    e.writeUInt16LE(0, 4);
    e.writeUInt16LE(0, 6);
    e.writeUInt16LE(n, 8);
    e.writeUInt16LE(n, 10);
    e.writeUInt32LE(Math.min(cdSize, MAX32), 12);
    e.writeUInt32LE(Math.min(cdStart, MAX32), 16);
    e.writeUInt16LE(0, 20);
    await this.emit(e);
  }
}

class ZipReader {
  constructor(fd, size) {
    this.fd = fd;
    this.size = size;
    this.entries = new Map();
  }

  static open(file) {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const r = new ZipReader(fd, size);
    try { r.readCentralDirectory(); }
    catch (e) { r.close(); throw e; }
    return r;
  }

  close() { try { fs.closeSync(this.fd); } catch (e) { /* already closed */ } }

  readAt(pos, len) {
    if (pos < 0 || pos + len > this.size) throw new Error('zip 檔案不完整');
    const b = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(this.fd, b, got, len - got, pos + got);
      if (!n) throw new Error('zip 檔案不完整');
      got += n;
    }
    return b;
  }

  readCentralDirectory() {
    const tailLen = Math.min(this.size, 0xFFFF + 22);
    if (tailLen < 22) throw new Error('這不是 zip 檔');
    const tailPos = this.size - tailLen;
    const tail = this.readAt(tailPos, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('這不是 zip 檔');
    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdStart = tail.readUInt32LE(eocd + 16);
    if (count === 0xFFFF || cdSize === MAX32 || cdStart === MAX32) {
      const locPos = tailPos + eocd - 20;
      if (locPos >= 0) {
        const loc = this.readAt(locPos, 20);
        if (loc.readUInt32LE(0) === 0x07064b50) {
          const z = this.readAt(Number(loc.readBigUInt64LE(8)), 56);
          if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 目錄損毀');
          count = Number(z.readBigUInt64LE(32));
          cdSize = Number(z.readBigUInt64LE(40));
          cdStart = Number(z.readBigUInt64LE(48));
        }
      }
    }
    const cd = this.readAt(cdStart, cdSize);
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 目錄損毀');
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
      const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
      const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
      for (let x = 0; x + 4 <= extra.length;) {
        const id = extra.readUInt16LE(x), len = extra.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let r = x + 4;
          const end = x + 4 + len;
          if (usize === MAX32 && r + 8 <= end) { usize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (csize === MAX32 && r + 8 <= end) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (offset === MAX32 && r + 8 <= end) { offset = Number(extra.readBigUInt64LE(r)); r += 8; }
        }
        x += 4 + len;
      }
      if (!name.endsWith('/')) this.entries.set(name, { name, method, crc, csize, usize, offset });
      p += 46 + nlen + xlen + clen;
    }
  }

  has(name) { return this.entries.has(name); }
  names() { return Array.from(this.entries.keys()); }
  sizeOf(name) { const e = this.entries.get(name); return e ? e.usize : -1; }

  // The entry's bytes, or null if there is no such entry. Throws when the entry
  // is larger than maxBytes, uses an unknown method, or fails its CRC.
  read(name, maxBytes) {
    const e = this.entries.get(name);
    if (!e) return null;
    if (maxBytes != null && e.usize > maxBytes) throw new Error('zip 裡的檔案太大：' + name);
    const lh = this.readAt(e.offset, 30);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('zip 項目損毀：' + name);
    const nlen = lh.readUInt16LE(26), xlen = lh.readUInt16LE(28);
    const raw = this.readAt(e.offset + 30 + nlen + xlen, e.csize);
    let out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = zlib.inflateRawSync(raw, maxBytes != null ? { maxOutputLength: Math.max(1, maxBytes) } : {});
    else throw new Error('不支援的壓縮方式：' + name);
    if (out.length !== e.usize || crc32(out) !== e.crc) throw new Error('zip 項目損毀：' + name);
    return out;
  }
}

module.exports = { ZipWriter, ZipReader, crc32 };

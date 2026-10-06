'use strict';
// 系統監控（帳號選單 → 系統監控，管理員）。CPU、記憶體、負載、溫度、磁碟、這個程序本身，
// 加上現在有幾個人連著。全部用 Node 內建的 os／process 讀，沒有新的依賴。
//
// CPU 使用率沒辦法「瞬間」讀：os.cpus() 給的是開機以來各狀態累計的時間，要兩次相減才是
// 這段時間的使用率。所以這裡每 SAMPLE_MS 自己量一次，留最近 HISTORY 筆給前端畫走勢；
// 端點回的是最後一筆跟歷史，不是打開面板那一刻才去量（那樣得等一秒才有數字）。
// 沒有管理員開著面板時也在量，但只是一次 os.cpus()，便宜到可以忽略。
const os = require('os');
const fs = require('fs');

const SAMPLE_MS = 5000;
const HISTORY = 120;          // 10 分鐘
const history = [];           // [{ t, cpu, mem, rd, wr }] cpu/mem 是 0..100，rd/wr 是 bytes/s（讀不到就沒有）
let lastTimes = null, lastProc = null, lastProcAt = 0, procCpu = 0;
let lastDisk = null, diskIo = null;   // diskIo = { read, write } bytes/s，Linux 以外是 null

// 磁碟讀寫：/proc/diskstats 每顆整顆硬碟（sda、nvme0n1、mmcblk0…，不算分割區，不然會重複算）
// 的累計扇區數，一個扇區 512 bytes，兩次相減除以時間就是速度。沒有這個檔（Windows、macOS）就是 null。
const DISK_RE = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+|hd[a-z]+)$/;
function diskTotals() {
  try {
    let rd = 0, wr = 0, any = false;
    fs.readFileSync('/proc/diskstats', 'utf8').split('\n').forEach(function (line) {
      const f = line.trim().split(/\s+/);
      if (f.length < 14 || !DISK_RE.test(f[2])) return;
      rd += parseInt(f[5], 10) * 512; wr += parseInt(f[9], 10) * 512; any = true;
    });
    return any ? { rd: rd, wr: wr } : null;
  } catch (e) { return null; }
}
let timer = null;

function cpuTimes() {
  let idle = 0, total = 0;
  os.cpus().forEach(function (c) {
    for (const k in c.times) total += c.times[k];
    idle += c.times.idle;
  });
  return { idle: idle, total: total };
}
function sample() {
  const now = cpuTimes();
  let cpu = null;
  if (lastTimes) {
    const dt = now.total - lastTimes.total, di = now.idle - lastTimes.idle;
    cpu = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
  }
  lastTimes = now;
  // 這個程序自己吃掉的 CPU：process.cpuUsage 是微秒的累計，除以經過的時間
  const pu = process.cpuUsage(), at = Date.now();
  if (lastProc && at > lastProcAt) {
    const used = (pu.user - lastProc.user + pu.system - lastProc.system) / 1000;   // ms
    procCpu = Math.max(0, Math.min(100 * os.cpus().length, used / (at - lastProcAt) * 100));
  }
  lastProc = pu; lastProcAt = at;
  const mem = (1 - os.freemem() / os.totalmem()) * 100;
  const disk = diskTotals();
  if (disk && lastDisk && at > lastDisk.at) {
    const dt = (at - lastDisk.at) / 1000;
    diskIo = { read: Math.max(0, Math.round((disk.rd - lastDisk.rd) / dt)), write: Math.max(0, Math.round((disk.wr - lastDisk.wr) / dt)) };
  }
  if (disk) lastDisk = { rd: disk.rd, wr: disk.wr, at: at };
  if (cpu != null) {
    const pt = { t: at, cpu: Math.round(cpu * 10) / 10, mem: Math.round(mem * 10) / 10 };
    if (diskIo) { pt.rd = diskIo.read; pt.wr = diskIo.write; }
    history.push(pt);
    if (history.length > HISTORY) history.shift();
  }
}
function start() {
  if (timer) return;
  sample();
  timer = setInterval(sample, SAMPLE_MS);
  if (timer.unref) timer.unref();   // 不要因為它讓程序關不掉
}

// 樹莓派／一般 Linux 的 CPU 溫度（millidegree）。沒有這個檔（Windows、macOS、容器）就是 null。
function temperature() {
  try {
    const t = parseInt(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8'), 10);
    return isFinite(t) ? Math.round(t / 100) / 10 : null;
  } catch (e) { return null; }
}
// Linux 的 /proc/meminfo 有 MemAvailable（比 free 準：快取算可用）跟 swap；其他平台用 os.freemem
function memInfo() {
  const total = os.totalmem();
  let available = os.freemem(), swapTotal = null, swapFree = null;
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const grab = function (k) { const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(txt); return m ? parseInt(m[1], 10) * 1024 : null; };
    const avail = grab('MemAvailable');
    if (avail != null) available = avail;
    swapTotal = grab('SwapTotal'); swapFree = grab('SwapFree');
  } catch (e) { /* not linux */ }
  return { total: total, available: available, used: total - available,
    swapTotal: swapTotal, swapUsed: swapTotal != null && swapFree != null ? swapTotal - swapFree : null };
}

// 給 /api/admin/system 的整包。extra 是 server.js 補的：連線數、資料庫那些
function snapshot(extra) {
  const last = history.length ? history[history.length - 1] : null;
  const cpus = os.cpus();
  const pm = process.memoryUsage();
  return Object.assign({
    at: Date.now(),
    host: { hostname: os.hostname(), platform: os.platform(), release: os.release(), arch: os.arch(),
      uptime: os.uptime(), model: cpus.length ? cpus[0].model : '', cores: cpus.length,
      load: os.loadavg(), temp: temperature() },
    cpu: last ? last.cpu : null,
    mem: memInfo(),
    io: diskIo,   // { read, write } bytes/s；Linux 以外 null
    history: history,
    proc: { pid: process.pid, node: process.version, uptime: process.uptime(), cpu: Math.round(procCpu * 10) / 10,
      rss: pm.rss, heapUsed: pm.heapUsed, heapTotal: pm.heapTotal, external: pm.external }
  }, extra || {});
}

module.exports = { start: start, snapshot: snapshot, SAMPLE_MS: SAMPLE_MS };

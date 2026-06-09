/**
 * chrome-pool.js
 * ──────────────────────────────────────────────────────────────────────────
 * Quản lý "Chrome thật riêng cho mỗi slot" + harvest cookie qua CDP + cookie pool.
 *
 * 3 phần:
 *   1. ChromeLauncher  — spawn 1 instance Chrome thật riêng cho mỗi slot
 *                        (user-data-dir riêng), điều khiển qua remote-debugging.
 *   2. CDP harvest     — mở site trong Chrome riêng, đợi cookie set tự nhiên,
 *                        grab toàn bộ cookie qua Storage.getCookies (browser ws).
 *   3. CookiePool      — lưu nhiều "identity" (bộ cookie sạch) theo domain,
 *                        xoay vòng: takeNextClean() / markBurned().
 *
 * Module này chạy trong MAIN process của Electron. Chỉ phụ thuộc: ws, node-fetch.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const WebSocket = require("ws");
const fetch = require("node-fetch");

// ── Logging ────────────────────────────────────────────────────────────────
let _logFn = (...a) => console.log("[chrome-pool]", ...a);
function setLogger(fn) { if (typeof fn === "function") _logFn = fn; }
function log(...a) { try { _logFn(...a); } catch (_) {} }

// ── Đường dẫn lưu trữ (set từ main qua init) ────────────────────────────────
let _baseDir = path.join(os.tmpdir(), "camp-detect");
function init(baseDir) {
  if (baseDir) _baseDir = baseDir;
  try { fs.mkdirSync(profilesDir(), { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(poolDir(), { recursive: true }); } catch (_) {}
}
function profilesDir() { return path.join(_baseDir, "chrome-profiles"); }
function poolDir() { return path.join(_baseDir, "cookie-pool"); }

// ── Parse chuỗi proxy về cấu trúc dùng chung ────────────────────────────────
// Hỗ trợ: "host:port", "scheme://host:port", "scheme://user:pass@host:port",
//          "host:port:user:pass" (định dạng nhà cung cấp hay dùng)
function parseProxy(input) {
  if (!input) return null;
  let s = String(input).trim();
  if (!s) return null;

  let scheme = "http";
  const m = s.match(/^(\w+):\/\//);
  if (m) { scheme = m[1].toLowerCase(); s = s.slice(m[0].length); }

  let username = "", password = "";
  // user:pass@host:port
  const at = s.lastIndexOf("@");
  if (at >= 0) {
    const cred = s.slice(0, at);
    s = s.slice(at + 1);
    const ci = cred.indexOf(":");
    if (ci >= 0) { username = cred.slice(0, ci); password = cred.slice(ci + 1); }
    else username = cred;
  }

  const parts = s.split(":");
  let host = parts[0];
  let port = parts[1];
  // host:port:user:pass
  if (parts.length === 4 && !username) {
    host = parts[0]; port = parts[1]; username = parts[2]; password = parts[3];
  }
  if (!host || !port) return null;

  // chuẩn hoá scheme socks
  if (scheme === "socks") scheme = "socks5";

  return {
    scheme, host, port: String(port), username, password,
    hasAuth: !!username,
    server: `${scheme}://${host}:${port}`,      // cho --proxy-server / Chrome
    electronRules: `${scheme}://${host}:${port}`, // cho ses.setProxy({proxyRules})
    redacted: `${scheme}://${username ? username + ":***@" : ""}${host}:${port}`,
  };
}

// ── Tìm Chrome executable ────────────────────────────────────────────────────
function findChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [];
  if (process.platform === "win32") {
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const pfx86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] || "";
    candidates.push(
      path.join(pf, "Google\\Chrome\\Application\\chrome.exe"),
      path.join(pfx86, "Google\\Chrome\\Application\\chrome.exe"),
      local ? path.join(local, "Google\\Chrome\\Application\\chrome.exe") : "",
      path.join(pf, "Google\\Chrome Beta\\Application\\chrome.exe"),
      path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe"),
      path.join(pfx86, "Microsoft\\Edge\\Application\\msedge.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else {
    candidates.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge"
    );
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// ── CDP: gọi 1 lệnh qua browser-level websocket ──────────────────────────────
// Mở /json/version để lấy webSocketDebuggerUrl, kết nối, gửi các lệnh rồi đóng.
async function cdpSession(port, fn, { timeoutMs = 30000 } = {}) {
  // Lấy webSocketDebuggerUrl (retry vì Chrome cần vài trăm ms để mở port)
  let wsUrl = null;
  const deadline = Date.now() + 15000;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { timeout: 2000 });
      const j = await r.json();
      if (j && j.webSocketDebuggerUrl) { wsUrl = j.webSocketDebuggerUrl; break; }
    } catch (err) { lastErr = err; }
    await delay(250);
  }
  if (!wsUrl) throw new Error(`CDP not reachable on port ${port}: ${lastErr && lastErr.message}`);

  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  let nextId = 1;
  const pending = new Map();

  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "CDP error"));
      else resolve(msg.result);
    }
  });

  function send(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, timeoutMs);
    });
  }

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("CDP ws open timeout")), 10000);
  });

  try {
    return await fn(send);
  } finally {
    try { ws.close(); } catch (_) {}
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── ChromeLauncher: 1 process Chrome riêng / slot ────────────────────────────
// chromeProcs: Map<slotId, { proc, port, profileDir }>
const chromeProcs = new Map();
const BASE_DEBUG_PORT = 9322;

function debugPortForSlot(slotId) { return BASE_DEBUG_PORT + (Number(slotId) || 1); }

// Cờ chống automation-detection cơ bản (hạn chế bị flag)
function chromeFlags(port, userDataDir, extra) {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=Translate,OptimizationHints,MediaRouter,IsolateOrigins,site-per-process",
    "--disable-background-networking",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-pings",
    "--password-store=basic",
    "--use-mock-keychain",
    "--start-maximized",
    // Chống rò rỉ IP thật qua WebRTC khi dùng proxy
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--webrtc-ip-handling-policy=disable_non_proxied_udp",
  ].concat(extra || []);
}

// Sinh extension MV3 để cấp credential cho proxy có auth (Chrome không nhận
// user:pass trong --proxy-server). Trả về đường dẫn thư mục extension.
function buildProxyAuthExtension(baseDir, proxy) {
  const dir = path.join(baseDir, "px-ext");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const manifest = {
    name: "px-auth",
    version: "1.0.0",
    manifest_version: 3,
    permissions: ["proxy", "webRequest", "webRequestAuthProvider"],
    host_permissions: ["<all_urls>"],
    background: { service_worker: "bg.js" },
    minimum_chrome_version: "108",
  };
  const bg = `
const cfg = {
  mode: "fixed_servers",
  rules: {
    singleProxy: { scheme: ${JSON.stringify(proxy.scheme)}, host: ${JSON.stringify(proxy.host)}, port: ${Number(proxy.port)} },
    bypassList: ["localhost", "127.0.0.1"]
  }
};
chrome.proxy.settings.set({ value: cfg, scope: "regular" });
chrome.webRequest.onAuthRequired.addListener(
  function () {
    return { authCredentials: { username: ${JSON.stringify(proxy.username)}, password: ${JSON.stringify(proxy.password)} } };
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);
`;
  try {
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "bg.js"), bg, "utf8");
  } catch (err) { log(`buildProxyAuthExtension error: ${err.message}`); return null; }
  return dir;
}

/**
 * Đảm bảo Chrome riêng của slot đang chạy. Trả về { port, profileDir, proc }.
 * persistent=true → dùng profile cố định của slot (chrome-profiles/slot<N>),
 * giữ identity ổn định. persistent=false → profile tạm (harvest fresh).
 */
function ensureChrome(slotId, { persistent = true, profileDir = null, headless = false, startUrl = null, proxy = null } = {}) {
  const id = Number(slotId) || 1;
  const existing = chromeProcs.get(id);
  if (persistent && existing && existing.proc && !existing.proc.killed) {
    return existing;
  }

  const px = typeof proxy === "string" ? parseProxy(proxy) : proxy;

  const chromePath = findChromePath();
  if (!chromePath) throw new Error("Không tìm thấy Chrome/Edge trên máy (set CHROME_PATH để chỉ định).");

  const port = debugPortForSlot(id) + (persistent ? 0 : 100); // tránh đụng port khi harvest
  const dir = profileDir
    || (persistent
      ? path.join(profilesDir(), `slot${id}`)
      : fs.mkdtempSync(path.join(profilesDir(), `harvest${id}-`)));
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}

  const extra = [];
  if (headless) extra.push("--headless=new", "--disable-gpu");

  // Proxy: --proxy-server cho mọi proxy; nếu có auth → kèm extension cấp credential
  if (px) {
    extra.push(`--proxy-server=${px.server}`);
    if (px.hasAuth) {
      const extDir = buildProxyAuthExtension(dir, px);
      if (extDir) {
        extra.push(`--load-extension=${extDir}`, `--disable-extensions-except=${extDir}`);
      }
    }
    log(`chrome slot ${id} proxy=${px.redacted}`);
  }

  // mở thẳng URL khi launch — đáng tin hơn /json/new (bị Chrome mới chặn)
  if (startUrl && /^https?:/i.test(startUrl)) extra.push(startUrl);

  const proc = spawn(chromePath, chromeFlags(port, dir, extra), {
    detached: false,
    stdio: "ignore",
    windowsHide: false,
  });
  proc.on("error", (err) => log(`chrome slot ${id} spawn error: ${err.message}`));
  proc.on("exit", (code) => {
    log(`chrome slot ${id} exited code=${code}`);
    const cur = chromeProcs.get(id);
    if (cur && cur.proc === proc) chromeProcs.delete(id);
  });

  const entry = { proc, port, profileDir: dir, persistent, proxy: px || null };
  if (persistent) chromeProcs.set(id, entry);
  log(`chrome launched slot=${id} port=${port} profile=${dir} persistent=${persistent}`);
  return entry;
}

function closeChrome(slotId) {
  const id = Number(slotId) || 1;
  const e = chromeProcs.get(id);
  if (e && e.proc) { try { e.proc.kill(); } catch (_) {} }
  chromeProcs.delete(id);
}

function closeAllChrome() {
  for (const [id, e] of chromeProcs) {
    if (e && e.proc) { try { e.proc.kill(); } catch (_) {} }
  }
  chromeProcs.clear();
}

// ── Chuẩn hoá cookie CDP → format Electron (giống injectSessionToWindow) ─────
function normalizeCdpCookies(cdpCookies, domainFilter) {
  const filterClean = (domainFilter || "").replace(/^\./, "").toLowerCase();
  const out = [];
  for (const c of cdpCookies || []) {
    const dom = String(c.domain || "").replace(/^\./, "").toLowerCase();
    if (!dom) continue;
    if (filterClean && !dom.includes(filterClean)) continue;
    const cookie = {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      secure: !!c.secure,
      httpOnly: !!c.httpOnly,
      sameSite: mapSameSite(c.sameSite),
    };
    // CDP expires: -1 = session cookie; số giây epoch nếu có
    if (typeof c.expires === "number" && c.expires > 0) {
      cookie.expirationDate = c.expires;
    }
    out.push(cookie);
  }
  return out;
}

function mapSameSite(s) {
  switch (String(s || "").toLowerCase()) {
    case "strict": return "strict";
    case "lax": return "lax";
    case "none": return "no_restriction";
    default: return "no_restriction";
  }
}

// Đọc URL của tab đang mở trong Chrome riêng của slot (để harvest không cần nhập lại URL)
async function getActiveUrl(slotId) {
  const id = Number(slotId) || 1;
  const e = chromeProcs.get(id);
  if (!e || !e.proc || e.proc.killed) return null;
  try {
    const r = await cdpSession(e.port, (send) => send("Target.getTargets", {}));
    const pages = (r && r.targetInfos ? r.targetInfos : [])
      .filter((t) => t.type === "page" && /^https?:/i.test(t.url || ""));
    if (!pages.length) return null;
    return pages[pages.length - 1].url; // tab mở gần nhất
  } catch (_) { return null; }
}

// ── Harvest: mở url trong Chrome riêng → đợi → grab cookie ────────────────────
/**
 * Harvest 1 bộ cookie sạch từ một Chrome thật.
 * @param {object} opts
 *   url           bắt buộc — trang để mở/đăng nhập tự nhiên
 *   slotId        slot gắn với harvest này (cho profile/port)
 *   waitMs        thời gian chờ cookie set (mặc định 8s)
 *   persistent    true → dùng profile cố định của slot; false → profile tạm fresh
 *   domainFilter  chỉ giữ cookie thuộc domain này (mặc định suy từ url)
 *   headless      chạy ẩn (mặc định false để giải captcha thủ công nếu cần)
 * @returns { cookies, domain, port }
 */
async function harvestCookies(opts = {}) {
  const slotId = Number(opts.slotId) || 1;
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 8000;
  const persistent = opts.persistent !== false;

  const explicitUrl = opts.url || "";
  const alreadyRunning = persistent && chromeProcs.has(slotId)
    && chromeProcs.get(slotId).proc && !chromeProcs.get(slotId).proc.killed;

  // Nếu không truyền URL nhưng Chrome đang mở → lấy URL từ tab hiện tại.
  let url = explicitUrl;
  if (!url && alreadyRunning) {
    url = await getActiveUrl(slotId);
    if (url) log(`harvest: dùng URL tab đang mở: ${url}`);
  }
  if (!url) {
    throw new Error("Chưa có URL: hãy bấm 'Mở Chrome' (hoặc nhập URL) trước khi harvest.");
  }

  let domain = opts.domainFilter || "";
  try {
    const u = new URL(url);
    if (!domain) {
      const parts = u.hostname.split(".");
      domain = parts.length >= 2 ? parts.slice(-2).join(".") : u.hostname;
    }
  } catch (_) {}

  // Chrome mới: mở URL ngay khi launch (đáng tin hơn /json/new).
  const entry = ensureChrome(slotId, {
    persistent,
    headless: !!opts.headless,
    startUrl: alreadyRunning ? null : url,
    proxy: opts.proxy || null,
  });
  const port = entry.port;

  // Chỉ điều hướng tab mới nếu user CHỦ ĐỘNG đưa URL khác (không tự lấy từ tab đang mở),
  // để không phá phiên đăng nhập hiện tại.
  if (alreadyRunning && explicitUrl) {
    try {
      await cdpSession(port, (send) => send("Target.createTarget", { url: explicitUrl }));
    } catch (err) {
      log(`harvest createTarget warn: ${err.message}`);
    }
  }

  // Nếu đã đăng nhập sẵn (lấy cookie từ tab đang mở) thì không cần chờ lâu.
  const effWait = (alreadyRunning && !explicitUrl) ? Math.min(waitMs, 1500) : waitMs;
  log(`harvest: chờ ${effWait}ms cho cookie set @ ${domain} (slot ${slotId}, port ${port})`);
  await delay(effWait);

  const cookies = await cdpSession(port, async (send) => {
    const res = await send("Storage.getCookies", {});
    return res && res.cookies ? res.cookies : [];
  });

  const normalized = normalizeCdpCookies(cookies, domain);
  log(`harvest: lấy ${normalized.length}/${cookies.length} cookie cho domain ${domain}`);

  // Profile tạm → đóng Chrome sau harvest để không tốn tài nguyên
  if (!persistent) {
    try { entry.proc.kill(); } catch (_) {}
    // dọn profile tạm
    try { fs.rmSync(entry.profileDir, { recursive: true, force: true }); } catch (_) {}
  }

  return { cookies: normalized, domain, port };
}

/**
 * Đảm bảo Chrome riêng của slot chạy và mở (hoặc điều hướng tới) url.
 * Dùng cho "Mở Chrome" để đăng nhập/giải captcha tay trước khi harvest.
 */
async function openInChrome(slotId, url, { headless = false, proxy = null } = {}) {
  const id = Number(slotId) || 1;
  const running = chromeProcs.has(id) && chromeProcs.get(id).proc && !chromeProcs.get(id).proc.killed;
  const entry = ensureChrome(id, {
    persistent: true,
    headless,
    startUrl: running ? null : url,
    proxy,
  });
  if (running && url && /^https?:/i.test(url)) {
    try {
      await cdpSession(entry.port, (send) => send("Target.createTarget", { url }));
    } catch (err) {
      log(`openInChrome createTarget warn: ${err.message}`);
    }
  }
  return { port: entry.port, profileDir: entry.profileDir };
}

// ── CookiePool: lưu identity theo domain, xoay vòng clean → used → burned ────
// File: cookie-pool/<domain>.json = { domain, identities: [ {id, cookies, status, createdAt, usedCount, lastUsedSlot} ] }
function poolPathFor(domain) {
  const safe = String(domain || "default").replace(/[^a-z0-9._-]/gi, "_").toLowerCase();
  return path.join(poolDir(), `${safe}.json`);
}

function loadPool(domain) {
  const p = poolPathFor(domain);
  try {
    if (!fs.existsSync(p)) return { domain, identities: [] };
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!j.identities) j.identities = [];
    return j;
  } catch (_) { return { domain, identities: [] }; }
}

function savePool(pool) {
  try {
    fs.writeFileSync(poolPathFor(pool.domain), JSON.stringify(pool, null, 2), "utf8");
  } catch (err) { log(`savePool error: ${err.message}`); }
}

let _idCounter = 0;
function genId() {
  // Không dùng Math.random/Date.now để bền với môi trường hạn chế — dùng hrtime + counter
  const t = process.hrtime.bigint().toString(36);
  return `id_${t}_${(_idCounter++).toString(36)}`;
}

/** Thêm 1 identity (bộ cookie) vào pool của domain. */
function addIdentity(domain, cookies, meta = {}) {
  const pool = loadPool(domain);
  const entry = {
    id: genId(),
    cookies: Array.isArray(cookies) ? cookies : [],
    status: "clean",
    createdAt: new Date().toISOString(),
    usedCount: 0,
    lastUsedSlot: null,
    ...meta,
  };
  pool.identities.push(entry);
  savePool(pool);
  log(`pool[${domain}]: +1 identity (${entry.cookies.length} cookie), tổng clean=${countClean(pool)}`);
  return entry;
}

function countClean(pool) {
  return pool.identities.filter((i) => i.status === "clean").length;
}

/** Lấy identity sạch kế tiếp (xoay vòng: ưu tiên chưa dùng, cũ nhất trước). */
function takeNextClean(domain, slotId) {
  const pool = loadPool(domain);
  const clean = pool.identities.filter((i) => i.status === "clean");
  if (!clean.length) return null;
  // ưu tiên usedCount thấp nhất, rồi createdAt cũ nhất
  clean.sort((a, b) => (a.usedCount - b.usedCount) || (a.createdAt < b.createdAt ? -1 : 1));
  const chosen = clean[0];
  chosen.status = "used";
  chosen.usedCount += 1;
  chosen.lastUsedSlot = slotId != null ? slotId : chosen.lastUsedSlot;
  savePool(pool);
  log(`pool[${domain}]: cấp identity ${chosen.id} cho slot ${slotId}; còn clean=${countClean(pool)}`);
  return chosen;
}

/** Đánh dấu identity bị flag/captcha → không tái sử dụng. */
function markBurned(domain, identityId) {
  if (!identityId) return false;
  const pool = loadPool(domain);
  const found = pool.identities.find((i) => i.id === identityId);
  if (!found) return false;
  found.status = "burned";
  found.burnedAt = new Date().toISOString();
  savePool(pool);
  log(`pool[${domain}]: burned identity ${identityId}; còn clean=${countClean(pool)}`);
  return true;
}

/** Thống kê pool cho UI. */
function poolStatus(domain) {
  if (domain) {
    const pool = loadPool(domain);
    return summarize(pool);
  }
  // tất cả domain
  const out = [];
  let files = [];
  try { files = fs.readdirSync(poolDir()).filter((f) => f.endsWith(".json")); } catch (_) {}
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(poolDir(), f), "utf8"));
      out.push(summarize(j));
    } catch (_) {}
  }
  return out;
}

function summarize(pool) {
  const by = { clean: 0, used: 0, burned: 0 };
  for (const i of pool.identities) by[i.status] = (by[i.status] || 0) + 1;
  return { domain: pool.domain, total: pool.identities.length, ...by };
}

/** Reset trạng thái 'used' về 'clean' (tái sử dụng identity chưa bị burn). */
function recycleUsed(domain) {
  const pool = loadPool(domain);
  let n = 0;
  for (const i of pool.identities) {
    if (i.status === "used") { i.status = "clean"; n++; }
  }
  savePool(pool);
  log(`pool[${domain}]: recycle ${n} used → clean`);
  return n;
}

function deleteIdentity(domain, identityId) {
  const pool = loadPool(domain);
  const before = pool.identities.length;
  pool.identities = pool.identities.filter((i) => i.id !== identityId);
  savePool(pool);
  return before - pool.identities.length;
}

module.exports = {
  init,
  setLogger,
  findChromePath,
  parseProxy,
  // chrome
  ensureChrome,
  openInChrome,
  getActiveUrl,
  closeChrome,
  closeAllChrome,
  debugPortForSlot,
  // harvest
  harvestCookies,
  // pool
  addIdentity,
  takeNextClean,
  markBurned,
  poolStatus,
  recycleUsed,
  deleteIdentity,
  loadPool,
};

const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const fetch = require("node-fetch");
const chromePool = require("./chrome-pool");

// Identity hiện tại của mỗi slot (để burn khi gặp captcha)
// slotId → { domain, identityId }
const slotIdentity = new Map();
// Chống reset chồng nhau: slotId → true khi đang reset
const slotResetting = new Set();
// Cấu hình captcha auto-reset toàn cục
const captchaConfig = {
  enabled: true,
  autoReset: true,
  autoHarvestOnEmpty: true,
  cooldownMs: 12000,
  harvestWaitMs: 8000,
  // pattern tuỳ chỉnh (ngoài default trong preload-web)
  customTextPatterns: [],
  customSrcPatterns: [],
  customUrlPatterns: [],
};

function captchaConfigPath() {
  return path.join(app.getPath("userData"), "captcha.json");
}
function loadCaptchaConfig() {
  try {
    const p = captchaConfigPath();
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) || {};
    for (const k of ["enabled", "autoReset", "autoHarvestOnEmpty"]) {
      if (typeof j[k] === "boolean") captchaConfig[k] = j[k];
    }
    for (const k of ["cooldownMs", "harvestWaitMs"]) {
      if (Number.isFinite(j[k])) captchaConfig[k] = j[k];
    }
    if (Array.isArray(j.customTextPatterns)) captchaConfig.customTextPatterns = j.customTextPatterns.map(String);
    if (Array.isArray(j.customSrcPatterns)) captchaConfig.customSrcPatterns = j.customSrcPatterns.map(String);
    if (Array.isArray(j.customUrlPatterns)) captchaConfig.customUrlPatterns = j.customUrlPatterns.map(String);
  } catch (err) { console.warn("[MAIN] loadCaptchaConfig error:", err && err.message); }
}
function saveCaptchaConfig() {
  try { fs.writeFileSync(captchaConfigPath(), JSON.stringify(captchaConfig, null, 2), "utf8"); }
  catch (err) { console.warn("[MAIN] saveCaptchaConfig error:", err && err.message); }
}
// Cấu hình đẩy xuống renderer (enabled/cooldown + pattern custom để merge)
function buildRendererCaptchaCfg() {
  return {
    enabled: captchaConfig.enabled,
    cooldownMs: captchaConfig.cooldownMs,
    textPatterns: captchaConfig.customTextPatterns,
    srcPatterns: captchaConfig.customSrcPatterns,
    urlPatterns: captchaConfig.customUrlPatterns,
  };
}

// ── Anti-detect: chặn rò rỉ IP thật qua WebRTC khi dùng proxy ────────────────
// Phải gọi TRƯỚC app ready.
try {
  app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");
  app.commandLine.appendSwitch("webrtc-ip-handling-policy", "disable_non_proxied_udp");
  app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");
} catch (_) {}

// ── Proxy state (IP riêng mỗi slot + xoay vòng) ──────────────────────────────
// slots: Map<slotId, parsedProxy>; pool: parsedProxy[]; rotateOnReset; poolIdx
const proxyState = {
  slots: new Map(),
  pool: [],
  rotateOnReset: true,
  poolIdx: 0,
};

function proxyConfigPath() {
  return path.join(app.getPath("userData"), "proxies.json");
}

function loadProxyConfig() {
  try {
    const p = proxyConfigPath();
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, "utf8")) || {};
    proxyState.rotateOnReset = j.rotateOnReset !== false;
    proxyState.pool = (Array.isArray(j.pool) ? j.pool : [])
      .map((s) => chromePool.parseProxy(s)).filter(Boolean);
    proxyState._poolRaw = Array.isArray(j.pool) ? j.pool : [];
    proxyState.slots.clear();
    if (j.slots && typeof j.slots === "object") {
      for (const k of Object.keys(j.slots)) {
        const px = chromePool.parseProxy(j.slots[k]);
        if (px) { px._raw = j.slots[k]; proxyState.slots.set(Number(k), px); }
      }
    }
  } catch (err) { console.warn("[MAIN] loadProxyConfig error:", err && err.message); }
}

function saveProxyConfig() {
  try {
    const slots = {};
    for (const [id, px] of proxyState.slots) slots[id] = px._raw || px.server;
    const out = {
      rotateOnReset: proxyState.rotateOnReset,
      pool: proxyState._poolRaw || proxyState.pool.map((p) => p.server),
      slots,
    };
    fs.writeFileSync(proxyConfigPath(), JSON.stringify(out, null, 2), "utf8");
  } catch (err) { console.warn("[MAIN] saveProxyConfig error:", err && err.message); }
}

// Áp proxy vào session của slot (partition persist:slotN). null = direct.
async function applyProxyToSlot(slotId, proxyStr) {
  const id = Number(slotId) || 1;
  const { session: electronSession } = require("electron");
  const ses = electronSession.fromPartition(`persist:slot${id}`);
  const px = proxyStr ? chromePool.parseProxy(proxyStr) : null;
  if (px) { px._raw = proxyStr; proxyState.slots.set(id, px); }
  else proxyState.slots.delete(id);
  try {
    if (px) {
      await ses.setProxy({ mode: "fixed_servers", proxyRules: px.electronRules, proxyBypassRules: "<local>" });
      log(`[proxy] slot ${id} ← ${px.redacted}`);
    } else {
      await ses.setProxy({ mode: "direct" });
      log(`[proxy] slot ${id} ← direct`);
    }
  } catch (err) { log(`[proxy] slot ${id} setProxy lỗi: ${err.message}`); }
  saveProxyConfig();
  return px;
}

// Lấy proxy kế tiếp từ pool (xoay vòng)
function nextPoolProxy() {
  if (!proxyState.pool.length) return null;
  const raw = (proxyState._poolRaw && proxyState._poolRaw.length)
    ? proxyState._poolRaw[proxyState.poolIdx % proxyState._poolRaw.length]
    : proxyState.pool[proxyState.poolIdx % proxyState.pool.length].server;
  proxyState.poolIdx = (proxyState.poolIdx + 1) % proxyState.pool.length;
  return raw;
}

// Login handler cho proxy có auth (407) — áp cho mọi session slot
function registerProxyLogin() {
  app.on("login", (event, webContents, _details, authInfo, callback) => {
    try {
      if (!authInfo || !authInfo.isProxy) return; // chỉ xử lý proxy auth
      const slotId = getSlotIdByWebContentsId(webContents && webContents.id);
      const px = slotId && proxyState.slots.get(slotId);
      if (px && px.hasAuth) {
        event.preventDefault();
        callback(px.username, px.password);
      }
    } catch (_) {}
  });
}

// Script stealth chống fingerprint cơ bản (chạy main world trước trang)
const STEALTH_JS = `
(function(){
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch(e){}
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch(e){}
  try {
    const q = navigator.permissions && navigator.permissions.query;
    if (q) navigator.permissions.query = (p) => (p && p.name === 'notifications')
      ? Promise.resolve({ state: (typeof Notification!=='undefined'?Notification.permission:'default') })
      : q(p);
  } catch(e){}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['vi-VN','vi','en-US','en'] }); } catch(e){}
  try { Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] }); } catch(e){}
})();
`;

let controlWin = null;
const previewWins = new Set(); // các cửa sổ preview nổi (có thể mở nhiều)

// ──────────────────────────────────────────────────
// Multi-slot web window management
// slotId: 1 | 2 | 3
// webSlots: Map<slotId, BrowserWindow>
// ──────────────────────────────────────────────────
const MAX_SLOTS = 3;
const webSlots = new Map();    // slotId → BrowserWindow
const popupSlots = new Map();  // slotId → BrowserWindow (popup con của slot)
const slotNotiRules = new Map(); // slotId → notiRules array (sync từ control)

const DEFAULT_CONTROL_BOUNDS = {
  width: 980,
  height: 800
};

const DEFAULT_WEB_BOUNDS = {
  width: 1200,
  height: 800,
  x: 1000
};

// Offset x cho mỗi slot để không chồng lên nhau
const SLOT_X_OFFSET = [1000, 1220, 1440];

const ZOOM_MAP = {
  "25": 0.25,
  "33": 0.33,
  "50": 0.5,
  "67": 0.67,
  "75": 0.75,
  "80": 0.8,
  "90": 0.9,
  "100": 1,
  "110": 1.1,
  "125": 1.25,
  "150": 1.5,
  "175": 1.75,
  "200": 2
};

function log(...args) {
  console.log("[MAIN]", ...args);
}

function sendToControl(channel, data) {
  try {
    if (controlWin && !controlWin.isDestroyed()) {
      controlWin.webContents.send(channel, data);
    }
  } catch (err) {
    console.warn("[MAIN] sendToControl error:", err);
  }
  // Forward đồng thời sang TẤT CẢ cửa sổ preview nổi đang mở
  for (const win of previewWins) {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch (err) {
      console.warn("[MAIN] sendToControl(preview) error:", err);
    }
  }
}

function sendToPreview(channel, data) {
  for (const win of previewWins) {
    try {
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch (err) {
      console.warn("[MAIN] sendToPreview error:", err);
    }
  }
}

function sendWebResult(data) {
  sendToControl("web:result", data);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return Math.round(n);
}

function normalizeZoomFactor(input) {
  if (input == null || input === "") return null;

  const raw = String(input).trim();
  if (!raw) return null;

  if (ZOOM_MAP[raw] != null) return ZOOM_MAP[raw];

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return null;

  if (numeric > 10) {
    return Math.min(Math.max(numeric / 100, 0.25), 3);
  }

  return Math.min(Math.max(numeric, 0.25), 3);
}

function ensureWebWindow(slotId) {
  const id = slotId || 1;
  const win = webSlots.get(id);
  if (win && !win.isDestroyed()) return win;
  return null;
}

// backward compat — slot 1
function ensureControlWindow() {
  if (controlWin && !controlWin.isDestroyed()) return controlWin;
  return null;
}

function getSlotIdByWebContentsId(wcId) {
  for (const [slotId, win] of webSlots) {
    if (!win.isDestroyed() && win.webContents.id === wcId) return slotId;
  }
  return null;
}

function getSafeWebBoundsFromPayload(payload = {}) {
return {
width: clampNumber(payload.width, 400, 2600, null),
height: clampNumber(payload.height, 300, 1800, null),
zoomFactor: normalizeZoomFactor(payload.zoom)
};
}

async function resolveFileInputInWebContents(webContents, payload = {}) {
const js = `
(function(payload){
function normalizeText(v) {
return typeof v === "string" ? v.trim() : "";
}
function safeQueryAll(selector) {
try {
return Array.from(document.querySelectorAll(selector));
} catch (_) {
return [];
}
}
function fixSelectorQuotes(sel) {
if (!sel || typeof sel !== "string") return sel;
try {
document.querySelector(sel);
return sel;
} catch (_) {
const fixed = sel.replace(
/\\[([\\w-]+)="([^\\]]+)"\\]/g,
(match, attr, val) => {
if (!val.includes("'")) {
return "[" + attr + "='" + val + "']";
}
return "[" + attr + "=\\"" + val.replace(/"/g, '\\\\\\"') + "\\"]";
}
);
try {
document.querySelector(fixed);
return fixed;
} catch (_) {
return sel;
}
}
}
function getElementsInRadius(cx, cy, radius) {
const all = Array.from(document.querySelectorAll("*"));
return all.filter(el => {
const r = el.getBoundingClientRect();
if (r.width === 0 && r.height === 0) return false;
const ex = r.left + r.width / 2;
const ey = r.top + r.height / 2;
return Math.sqrt((ex - cx) ** 2 + (ey - cy) ** 2) <= radius;
});
}
function resolveUploadInputFromElement(el) {
if (!el || el.nodeType !== 1) return null;
try {
if (
el.tagName &&
el.tagName.toLowerCase() === "input" &&
String(el.type || "").toLowerCase() === "file"
) {
return el;
}
} catch (_) {}
try {
const inside = el.querySelector && el.querySelector('input[type="file"]');
if (inside) return inside;
} catch (_) {}
try {
const closestLabel = typeof el.closest === "function" ? el.closest("label") : null;
const fromLabel = closestLabel && closestLabel.querySelector
? closestLabel.querySelector('input[type="file"]')
: null;
if (fromLabel) return fromLabel;
} catch (_) {}
try {
const parent = el.parentElement;
const sibling = parent && parent.querySelector
? parent.querySelector('input[type="file"]')
: null;
if (sibling) return sibling;
} catch (_) {}
return null;
}

function resolveUploadInputForPayload(payload) {
const selector = payload && payload.selector ? String(payload.selector) : "";
const target = findElementForStep(payload || {});
let input = resolveUploadInputFromElement(target);
if (input) return input;

if (selector) {
try {
const direct = document.querySelector(selector);
input = resolveUploadInputFromElement(direct);
if (input) return input;
} catch (_) {}
}

const allInputs = safeQueryAll('input[type="file"]');
if (allInputs.length === 1) return allInputs[0];

return null;
}

function findElementForStep(payload) {
const {
selector,
elementText,
containerTag,
x,
y
} = payload || {};

const fixedSelector = selector ? fixSelectorQuotes(selector) : null;
const hasPosition = typeof x === "number" && typeof y === "number";

if (hasPosition) {
const scrollX = x - window.innerWidth / 2;
const scrollY = y - window.innerHeight / 2;
window.scrollTo({
left: Math.max(0, scrollX),
top: Math.max(0, scrollY),
behavior: "instant"
});
}

function searchInRadius(radius) {
const vpX = hasPosition ? x - window.scrollX : window.innerWidth / 2;
const vpY = hasPosition ? y - window.scrollY : window.innerHeight / 2;

const pool = hasPosition
? getElementsInRadius(vpX, vpY, radius)
: Array.from(document.querySelectorAll("*"));

let results = pool;

if (fixedSelector) {
results = results.filter(el => {
try { return el.matches(fixedSelector); } catch (_) { return false; }
});
}

if (elementText) {
const eText = String(elementText).trim();
const eLower = eText.toLowerCase();
results = results.filter(el => {
const t = (el.innerText || el.value || el.textContent || "").trim();
return t === eText || t.toLowerCase() === eLower || t.toLowerCase().includes(eLower);
});
}

if (containerTag && !fixedSelector) {
const tag = String(containerTag).toLowerCase();
results = results.filter(el => el.tagName.toLowerCase() === tag);
}

return { results, vpX, vpY };
}

let { results } = searchInRadius(120);
if (results.length === 0) ({ results } = searchInRadius(400));
if (results.length === 0) ({ results } = searchInRadius(Infinity));
if (results.length === 0) return null;
if (results.length === 1) return results[0];

let best = results[0];
let bestDist = Infinity;
const vpX = hasPosition ? x - window.scrollX : window.innerWidth / 2;
const vpY = hasPosition ? y - window.scrollY : window.innerHeight / 2;
results.forEach(el => {
const r = el.getBoundingClientRect();
const ex = r.left + r.width / 2;
const ey = r.top + r.height / 2;
const d2 = (ex - vpX) ** 2 + (ey - vpY) ** 2;
if (d2 < bestDist) {
bestDist = d2;
best = el;
}
});
return best;
}

const target = findElementForStep(payload || {});
const input = resolveUploadInputForPayload(payload || {});
if (!target && !input) {
return { ok: false, reason: "target not found" };
}

if (!input) {
return { ok: false, reason: "input type=file not found" };
}

// Trả về thêm thông tin để main biết input thật là gì
const inputTag = input.tagName ? input.tagName.toLowerCase() : "input";
const inputClass = (input.className && typeof input.className === "string") ? input.className.trim() : "";
return {
  ok: true,
  resolvedTag: inputTag,
  resolvedClass: inputClass
};
})(${JSON.stringify(payload)});
`;
return await webContents.executeJavaScript(js, true);
}

/**
 * CDP trusted click — bypass isTrusted=false của synthetic events.
 * Dùng cho Google OAuth button, nút bảo mật cao.
 * Tìm element bằng selector/elementText, lấy center, rồi gửi
 * Input.dispatchMouseEvent qua CDP.
 */
async function cdpClickInWebWindow(payload = {}) {
  const slotId = Number(payload.slotId) || 1;
  const win = ensureWebWindow(slotId);
  if (!win) return { ok: false, reason: `slot ${slotId} not ready` };

  // Bước 1: resolve tọa độ center của element trong trang
  const resolveJs = `
(function(payload) {
  function fixSel(sel) {
    if (!sel) return sel;
    try { document.querySelector(sel); return sel; } catch(_) {
      const fixed = sel.replace(/\\[([\\w-]+)="([^\\]]+)"\\]/g, (m,a,v) =>
        !v.includes("'") ? "["+a+"='"+v+"']" : "["+a+'="'+v.replace(/"/g,'\\"')+'"]'
      );
      try { document.querySelector(fixed); return fixed; } catch(_) { return sel; }
    }
  }
  const sel = payload.selector ? fixSel(payload.selector) : null;
  const txt = payload.elementText ? String(payload.elementText).toLowerCase() : null;
  const lbl = payload.labelText ? String(payload.labelText).toLowerCase() : null;

  var el = null;

  // 1. Thử selector
  if (sel) {
    try { el = document.querySelector(sel); } catch(_) {}
  }

  // 2. Thử tìm input theo placeholder (vì contextIsolation=false, selector với placeholder có thể bị escape)
  if (!el && sel && sel.includes('placeholder')) {
    var m = sel.match(/placeholder[='"]+([^'"\\]]+)/);
    if (m) {
      var ph = m[1];
      var inputs = document.querySelectorAll('input, textarea');
      for (var i = 0; i < inputs.length; i++) {
        if ((inputs[i].placeholder || '').toLowerCase().includes(ph.toLowerCase())) {
          el = inputs[i]; break;
        }
      }
    }
  }

  // 3. Tìm theo elementText trong tất cả elements
  if (!el && txt) {
    var allEls = document.querySelectorAll("button,a,[role='button'],[tabindex],input,div,span");
    for (var i = 0; i < allEls.length; i++) {
      var node = allEls[i];
      var t = (node.innerText || node.textContent || node.placeholder || node.value || '').trim().toLowerCase();
      if (t.includes(txt)) { el = node; break; }
    }
  }

  // 4. Tìm theo labelText
  if (!el && lbl) {
    var allEls2 = document.querySelectorAll("label,span,div,p");
    for (var i = 0; i < allEls2.length; i++) {
      var node2 = allEls2[i];
      var t2 = (node2.innerText || node2.textContent || '').trim().toLowerCase();
      if (t2 === lbl || t2.includes(lbl)) {
        var inp = node2.querySelector('input') || node2.closest('[tabindex]');
        if (inp) { el = inp; break; }
      }
    }
  }

  if (!el) {
    console.log('[cdpClick] element not found, sel:', sel, 'txt:', txt);
    return { ok: false, reason: "element not found: " + (sel||txt||lbl||"(no selector)") };
  }

  console.log('[cdpClick] found:', el.tagName, el.className && typeof el.className === "string" ? el.className.slice(0,40) : '', el.placeholder||'');

  // Scroll vào view
  try { el.scrollIntoView({ behavior: "instant", block: "center" }); } catch(_) {}
  var _wait = Date.now(); while(Date.now() - _wait < 80) {}

  var r = el.getBoundingClientRect();
  var offsetX = payload.offsetX || 0;
  var offsetY = payload.offsetY || 0;
  var offsetEdge = payload.offsetEdge || "center";

  var cx, cy;
  if (offsetEdge === "right") cx = Math.round(r.right + offsetX);
  else if (offsetEdge === "left") cx = Math.round(r.left + offsetX);
  else cx = Math.round(r.left + r.width / 2 + offsetX);
  cy = Math.round(r.top + r.height / 2 + offsetY);

  console.log('[cdpClick] rect:', Math.round(r.left), Math.round(r.top), Math.round(r.right), '→ click:', cx, cy);
  return { ok: true, x: cx, y: cy };
})(${JSON.stringify(payload)})
`;

  let coords;
  try {
    coords = await win.webContents.executeJavaScript(resolveJs, true);
  } catch (err) {
    return { ok: false, reason: "resolveJs error: " + err.message };
  }

  if (!coords || !coords.ok) {
    return { ok: false, reason: coords && coords.reason ? coords.reason : "element not found" };
  }

  const { x, y } = coords;

  // Bước 2: CDP Input.dispatchMouseEvent — tạo trusted-like click
  const dbg = win.webContents.debugger;
  try {
    try { dbg.attach("1.3"); } catch (_) {}

    const base = { x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 };

    await dbg.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
    await dbg.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    // Nhỏ delay giữa down và up để trigger click handler
    await new Promise(r => setTimeout(r, 60));
    await dbg.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });

    try { dbg.detach(); } catch (_) {}
    log(`[cdpClick] slot ${slotId}: CDP click at (${x}, ${y})`);
    return { ok: true, x, y };
  } catch (err) {
    try { dbg.detach(); } catch (_) {}
    return { ok: false, reason: "CDP click error: " + err.message };
  }
}

async function setFileInputFilesForWebWindow(payload = {}) {
const slotId = Number(payload.slotId) || 1;
const win = ensureWebWindow(slotId);
if (!win) return { ok: false, reason: `slot ${slotId} not ready` };

const files = Array.isArray(payload.files) ? payload.files : [];
const localPaths = files
.map(item => String(item && item.localPath || "").trim())
.filter(Boolean);

if (!localPaths.length) {
return { ok: false, reason: "no valid localPath" };
}

for (const p of localPaths) {
if (!fs.existsSync(p)) {
return { ok: false, reason: "file not found: " + p };
}
}

const resolved = await resolveFileInputInWebContents(win.webContents, payload);
if (!resolved || resolved.ok !== true) {
return { ok: false, reason: (resolved && resolved.reason) || "input type=file not found" };
}

  try {
    const dbg = win.webContents.debugger;
    try { dbg.attach("1.3"); } catch (_) {}

    const docRes = await dbg.sendCommand("DOM.getDocument", { depth: 0 });
    const rootNodeId = docRes.root.nodeId;

    // Tìm input[type=file] thật theo thứ tự ưu tiên.
    // KHÔNG dùng payload.selector trực tiếp vì đó là selector của element
    // mà user click (span, div, ...), không phải input[type=file].
    const selectorCandidates = [
      // PubPower / NaiveUI upload input
      'input.n-upload-file-input[type="file"]',
      // Generic file input
      'input[type="file"]'
    ];

    let queryRes = null;
    for (const sel of selectorCandidates) {
      try {
        const res = await dbg.sendCommand("DOM.querySelector", {
          nodeId: rootNodeId,
          selector: sel
        });
        if (res && res.nodeId) {
          queryRes = res;
          log(`[setFileInput] Found input via selector: "${sel}"`);
          break;
        }
      } catch (_) {}
    }

    if (!queryRes || !queryRes.nodeId) {
      try { dbg.detach(); } catch (_) {}
      return { ok: false, reason: "CDP: input[type=file] nodeId not found" };
    }

    // Ép input cho phép chọn NHIỀU file. Nhiều upload component (NaiveUI, ...)
    // để input không có `multiple` → setFileInputFiles với >1 file sẽ chỉ nhận 1.
    if (localPaths.length > 1) {
      try {
        await dbg.sendCommand("DOM.setAttributeValue", {
          nodeId: queryRes.nodeId,
          name: "multiple",
          value: "true"
        });
        log("[setFileInput] forced multiple=true for " + localPaths.length + " files");
      } catch (e) {
        console.warn("[MAIN] setFileInput force multiple failed:", e && e.message);
      }
    }

    await dbg.sendCommand("DOM.setFileInputFiles", {
      files: localPaths,
      nodeId: queryRes.nodeId
    });

    log("[setFileInput] DOM.setFileInputFiles sent " + localPaths.length + " file(s): " + JSON.stringify(localPaths));

    try { dbg.detach(); } catch (_) {}
    return { ok: true, count: localPaths.length };
  } catch (err) {
    try { win.webContents.debugger.detach(); } catch (_) {}
    return { ok: false, reason: err && err.message ? err.message : "CDP setFileInputFiles failed" };
  }
}

async function applyWebWindowConfig(payload = {}) {
const win = ensureWebWindow(payload.slotId);
if (!win) {
sendWebResult({
type: "detectlab_status",
message: "Web window not ready",
slotId: payload.slotId || 1
});
return { ok: false, reason: "webWin not ready" };
}

  const { width, height, zoomFactor } = getSafeWebBoundsFromPayload(payload);

  try {
    if (width || height) {
      const current = win.getBounds();
      const nextWidth = width || current.width;
      const nextHeight = height || current.height;
      win.setSize(nextWidth, nextHeight, true);
      log("webWin resized:", nextWidth, nextHeight);
    }

    if (typeof zoomFactor === "number" && Number.isFinite(zoomFactor)) {
      await win.webContents.setZoomFactor(zoomFactor);
      log("webWin zoomFactor:", zoomFactor);
    }

    sendWebResult({
      type: "detectlab_status",
      message:
        "Applied window config" +
        (width || height ? ` (${width || "-"}x${height || "-"})` : "") +
        (zoomFactor ? ` zoom ${zoomFactor}` : "")
    });

    return {
      ok: true,
      width: width || null,
      height: height || null,
      zoomFactor: zoomFactor || null
    };
  } catch (err) {
    console.warn("[MAIN] applyWebWindowConfig error:", err);
    sendWebResult({
      type: "detectlab_status",
      message: "Failed to apply window config"
    });
    return { ok: false, reason: err.message || "unknown error" };
  }
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: DEFAULT_CONTROL_BOUNDS.width,
    height: DEFAULT_CONTROL_BOUNDS.height,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  controlWin.loadFile(path.join(__dirname, "control", "index.html"));

  controlWin.on("closed", () => {
    controlWin = null;
    // Đóng tất cả web slot khi control đóng
    for (const [, win] of webSlots) {
      if (!win.isDestroyed()) win.close();
    }
    webSlots.clear();
  });

  controlWin.webContents.on("did-finish-load", () => {
    log("controlWin loaded");
    sendWebResult({
      type: "detectlab_status",
      message: "Control window ready"
    });
  });

  // Capture renderer console output → /logs endpoint
  if (typeof attachConsoleCapture === "function") {
    attachConsoleCapture(controlWin.webContents, "control");
  }
}

// Cửa sổ preview nổi riêng — luôn on-top, có icon trên taskbar Windows.
// Cho phép mở nhiều cửa sổ tuỳ ý; mỗi lần gọi sẽ tạo MỚI một cửa sổ độc lập.
function createPreviewWindow() {
  // Offset vị trí dựa trên số cửa sổ đã mở để không xếp chồng hoàn toàn
  const idx = previewWins.size;
  const baseX = 200 + idx * 40;
  const baseY = 120 + idx * 40;
  const win = new BrowserWindow({
    width: 320,
    height: 680,
    x: baseX,
    y: baseY,
    minWidth: 180,
    minHeight: 200,
    title: "Slot Preview",
    alwaysOnTop: true,       // nổi trên cùng (level mặc định 'floating')
    skipTaskbar: false,      // hiện icon trên taskbar
    frame: false,            // bỏ khung/title bar gốc → tối giản, tự kéo bằng drag bar
    autoHideMenuBar: true,   // không hiện menu File/Edit
    backgroundColor: "#0b1220",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  // KHÔNG dùng level "screen-saver" — trên Windows nó biến cửa sổ thành tool window
  // và bị ẩn khỏi taskbar. Dùng alwaysOnTop mặc định + ép hiện taskbar.
  win.setAlwaysOnTop(true);
  win.setSkipTaskbar(false);
  win.setMenuBarVisibility(false);
  // Cho preview 1 appId riêng → có icon taskbar TÁCH BIỆT với cửa sổ control
  try {
    win.setAppDetails({
      appId: "com.detectlab.camp.preview",
      relaunchDisplayName: "Slot Preview"
    });
  } catch (_) {}
  win.loadFile(path.join(__dirname, "control", "preview-window.html"));
  win.once("ready-to-show", () => {
    win.show();
    win.setSkipTaskbar(false); // đảm bảo lần nữa sau khi show
  });
  previewWins.add(win);
  win.on("closed", () => { previewWins.delete(win); });
  log(`preview window created (total: ${previewWins.size})`);
  return win;
}

// Helper: lấy preview window đã phát IPC từ event.sender
function previewWinFromEvent(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && previewWins.has(win) && !win.isDestroyed()) return win;
  return null;
}

// IPC: bật/tắt always-on-top cho control window
ipcMain.handle("control:set-always-on-top", async (_event, payload) => {
  const flag = !!(payload && payload.flag);
  if (controlWin && !controlWin.isDestroyed()) {
    controlWin.setAlwaysOnTop(flag, "screen-saver");
  }
  return { ok: true, flag };
});

// IPC: đưa cửa sổ control lên trước (để thấy editor khi bấm phím tắt trên slot)
ipcMain.handle("control:focus", async () => {
  if (controlWin && !controlWin.isDestroyed()) {
    try { if (controlWin.isMinimized()) controlWin.restore(); } catch (_) {}
    controlWin.show();
    controlWin.focus();
  }
  return { ok: true };
});

// IPC: mở (hoặc focus) cửa sổ preview nổi
ipcMain.handle("preview:open-window", async () => {
  createPreviewWindow();
  return { ok: true };
});

// IPC: đóng cửa sổ preview nổi đã phát IPC (mỗi popout tự đóng chính nó)
ipcMain.handle("preview:close-window", async (event) => {
  const win = previewWinFromEvent(event);
  if (win) win.close();
  return { ok: true };
});

// IPC: thu nhỏ cửa sổ preview nổi đã phát IPC
ipcMain.handle("preview:minimize-window", async (event) => {
  const win = previewWinFromEvent(event);
  if (win) win.minimize();
  return { ok: true };
});

// IPC: ghim preview nổi TRÊN CẢ taskbar (level "screen-saver") — chỉ cho cửa sổ đã phát IPC
// flag=true: nổi trên mọi thứ kể cả taskbar/Start menu (nhưng mất icon taskbar riêng)
// flag=false: nổi bình thường (floating), vẫn ở trên taskbar list
ipcMain.handle("preview:set-above-taskbar", async (event, payload) => {
  const flag = !!(payload && payload.flag);
  const win = previewWinFromEvent(event);
  if (win) {
    if (flag) {
      win.setAlwaysOnTop(true, "screen-saver");
    } else {
      win.setAlwaysOnTop(true); // level mặc định 'floating'
      win.setSkipTaskbar(false);
    }
  }
  return { ok: true, flag };
});

// IPC: preview window gửi action (start/pause/open/close/show) → forward sang control
ipcMain.handle("preview:action", async (_event, payload) => {
  sendToControl("preview:action", payload || {});
  return { ok: true };
});

// IPC: control đẩy state các slot sang preview window để hiển thị label/status
ipcMain.handle("preview:push-states", async (_event, payload) => {
  sendToPreview("preview:states", payload || {});
  return { ok: true };
});

/**
 * Tạo hoặc mở lại web window cho slot chỉ định.
 * Nếu đã tồn tại và chưa bị destroy → giữ nguyên.
 */
function createWebWindowForSlot(slotId) {
  const id = slotId || 1;

  const existing = webSlots.get(id);
  if (existing && !existing.isDestroyed()) return existing;

  const xOffset = SLOT_X_OFFSET[id - 1] || (1000 + (id - 1) * 220);

  // Dùng persistent partition riêng cho mỗi slot
  // — giữ cookies/localStorage giữa các lần mở, giống browser thật
  const partition = `persist:slot${id}`;

  const win = new BrowserWindow({
    width: DEFAULT_WEB_BOUNDS.width,
    height: DEFAULT_WEB_BOUNDS.height,
    x: xOffset,
    title: `DetectLab Web — Slot ${id}`,
    webPreferences: {
      preload: path.join(__dirname, "preload-web.js"),
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      additionalArguments: [`--slot-id=${id}`],
      partition,
      allowRunningInsecureContent: false,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  // Set User-Agent giống Chrome thật
  const chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  win.webContents.setUserAgent(chromeUA);

  // Capture renderer console output → /logs endpoint
  if (typeof attachConsoleCapture === "function") {
    attachConsoleCapture(win.webContents, `slot:${id}`);
  }

  // Dùng CDP Page.addScriptToEvaluateOnNewDocument
  // Script này được Chrome inject vào MAIN WORLD trước bất kỳ JS nào của trang
  // Đây là cách duy nhất reliable để override window.confirm trong main world
  async function registerNotiScript() {
    const rules = slotNotiRules.get(id) || [];
    const script = STEALTH_JS + `
(function() {
  var _orig = window.confirm;
  var _origAlert = window.alert;
  window.__dlNotiRules = ${JSON.stringify(rules)};

  function matchRule(msg) {
    var r = window.__dlNotiRules || [];
    var low = String(msg||'').toLowerCase();
    for(var i=0;i<r.length;i++){
      if(r[i]&&r[i].pattern&&low.includes(r[i].pattern.toLowerCase()))return r[i];
    }
    return null;
  }

  window.confirm = function(msg) {
    var m = matchRule(msg);
    if(m){ var c=(m.choice||'ok').toLowerCase()==='cancel'; console.log('[DL] AUTO confirm('+!c+'):', String(msg).slice(0,80)); return !c; }
    console.log('[DL] no match (rules='+( window.__dlNotiRules||[]).length+'):', String(msg).slice(0,80));
    return _orig ? _orig.call(window,msg) : true;
  };
  window.alert = function(msg) {
    var m = matchRule(msg);
    if(m){console.log('[DL] AUTO alert suppressed');return;}
    if(_origAlert)_origAlert.call(window,msg);
  };
  window.__dlConfirmPatched = true;
  window.__dlUpdateNotiRules = function(nr){
    if(Array.isArray(nr)&&nr.length>0){window.__dlNotiRules=nr;console.log('[DL] rules updated:',nr.length);}
  };
  console.log('[DL] main world confirm override active, rules:', window.__dlNotiRules.length);
})();
`;
    try {
      const dbg = win.webContents.debugger;
      try { dbg.attach("1.3"); } catch(_) {}
      // addScriptToEvaluateOnNewDocument chạy trong main world trước trang
      await dbg.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
        source: script,
        worldName: "" // empty = main world
      });
      try { dbg.detach(); } catch(_) {}
      log(`[NotiHook] slot ${id}: CDP script registered, rules: ${rules.length}`);
    } catch(err) {
      log(`[NotiHook] slot ${id}: CDP register error: ${err.message}`);
    }
  }

  // Đăng ký ngay khi tạo window
  registerNotiScript();

  // Re-register khi rules thay đổi (gọi từ noti:sync-rules)
  win.__reRegisterNotiScript = registerNotiScript;

  // Cho phép third-party cookies trên session của slot này
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));

  // Không block third-party cookies
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: details.requestHeaders });
  });

  win.loadURL("about:blank");

  // ── Update noti rules vào noti-inject.js preload sau mỗi lần page load ──
  function updateNotiRules() {
    const rules = slotNotiRules.get(id) || [];
    if (!rules.length) return;
    const js = `if(typeof window.__dlUpdateNotiRules==='function'){window.__dlUpdateNotiRules(${JSON.stringify(rules)});}else{window.__dlNotiRules=${JSON.stringify(rules)};}`;
    try {
      const frame = win.webContents.mainFrame;
      if (frame && typeof frame.executeJavaScript === "function") {
        frame.executeJavaScript(js).catch(() => {});
      }
    } catch (_) {}
  }

  win.webContents.on("did-finish-load", () => {
    const url = win.webContents.getURL();
    log(`slot ${id} loaded:`, url);
    sendToControl("slot:page-loaded", { slotId: id, url });
    sendWebResult({ type: "detectlab_status", message: "Web page loaded", slotId: id });
    // noti-inject.js đã chạy trước trang, chỉ cần update rules
    updateNotiRules();
    // đồng bộ trạng thái captcha watcher (enabled/cooldown + pattern custom) sau mỗi lần load
    try {
      win.webContents.send("captcha:config", buildRendererCaptchaCfg());
    } catch (_) {}
  });

  win.webContents.on("did-navigate-in-page", () => { updateNotiRules(); });
  win.webContents.on("did-navigate", () => { updateNotiRules(); });
  win.webContents.setWindowOpenHandler(() => ({ action: "allow" }));

  win.webContents.on("did-create-window", (popupWin) => {
    log(`slot ${id}: popup opened, wcId=${popupWin.webContents.id}`);

    // Popup cũng dùng cùng UA
    popupWin.webContents.setUserAgent(chromeUA);

    const prev = popupSlots.get(id);
    if (prev && !prev.isDestroyed()) prev.close();
    popupSlots.set(id, popupWin);

    sendToControl("slot:popup-opened", { slotId: id });

    popupWin.on("closed", () => {
      if (popupSlots.get(id) === popupWin) popupSlots.delete(id);
      sendToControl("slot:popup-closed", { slotId: id });
      log(`slot ${id}: popup closed`);
    });

    popupWin.webContents.on("did-finish-load", () => {
      const url = popupWin.webContents.getURL();
      log(`slot ${id}: popup loaded:`, url);
      sendToControl("slot:popup-loaded", { slotId: id, url });
    });
  });
  // ────────────────────────────────────────────────────────────

  win.on("closed", () => {
    webSlots.delete(id);
    sendToControl("slot:closed", { slotId: id });
    sendWebResult({
      type: "detectlab_status",
      message: `Web window closed (slot ${id})`,
      slotId: id
    });
  });

  win.webContents.on("did-fail-load", (_event, code, desc, validatedURL) => {
    console.warn(`[MAIN] slot ${id} did-fail-load:`, code, desc, validatedURL);
    sendWebResult({
      type: "detectlab_status",
      message: `Load failed: ${desc || validatedURL || code}`,
      slotId: id
    });
  });

  win.webContents.on("paint", (_event, _dirty, image) => {
    if (!ensureControlWindow()) return;
    const dataUrl = image.toDataURL();
    sendToControl("slot:thumbnail", { slotId: id, dataUrl });
  });
  win.webContents.setFrameRate(2);

  // ── Chặn minimize gốc ─────────────────────────────────────────────
  // Khi user bấm nút minimize của cửa sổ web, Chromium SUSPEND rendering
  // → preview ở control đứng hình + scroll/elementFromPoint/inject JS chết.
  // Thay vào đó: restore lại + move ra ngoài màn hình + opacity 0.
  // → Cửa sổ vẫn render đầy đủ (slot chạy bình thường), chỉ không nhìn thấy,
  //   và preview ở control vẫn cập nhật.
  win.on("minimize", (e) => {
    try { if (e && typeof e.preventDefault === "function") e.preventDefault(); } catch (_) {}
    try { if (win.isMinimized()) win.restore(); } catch (_) {}
    try {
      const { screen } = require("electron");
      const displays = screen.getAllDisplays();
      const maxX = displays.reduce((m, d) => Math.max(m, d.bounds.x + d.bounds.width), 0);
      win.setPosition(maxX + 50, 0);
    } catch (_) {
      try { win.setPosition(9999, 0); } catch (_) {}
    }
    try { win.setOpacity(0); } catch (_) {}
    sendToControl("slot:minimized-to-preview", { slotId: id });
    log(`slot ${id}: minimize intercepted → moved off-screen (still running)`);
  });

  webSlots.set(id, win);
  log(`slot ${id} created, webContentsId=${win.webContents.id}, partition=${partition}`);
  return win;
}

function createWindows() {
  createControlWindow();
  // Khởi động sẵn slot 1
  createWebWindowForSlot(1);
}

// ── Slot lifecycle IPC ─────────────────────────────────────────────

// Tạo mới hoặc lấy lại slot
ipcMain.handle("slot:open", async (_event, { slotId }) => {
  const id = Number(slotId) || 1;
  if (id < 1 || id > MAX_SLOTS) return { ok: false, reason: "invalid slotId" };
  createWebWindowForSlot(id);
  return { ok: true, slotId: id };
});

// Đóng slot
ipcMain.handle("slot:close", async (_event, { slotId }) => {
  const id = Number(slotId) || 1;
  const win = webSlots.get(id);
  if (win && !win.isDestroyed()) win.close();
  return { ok: true, slotId: id };
});

// Show/hide slot window
ipcMain.handle("slot:set-visible", async (_event, { slotId, visible }) => {
  const win = ensureWebWindow(slotId);
  if (!win) return { ok: false, reason: "slot not open" };

  if (visible) {
    // Restore về vị trí thật
    const xOffset = SLOT_X_OFFSET[(slotId - 1)] || (1000 + (slotId - 1) * 220);
    try { if (win.isMinimized()) win.restore(); } catch (_) {}
    win.setPosition(xOffset, 0);
    win.setOpacity(1);
    win.setBounds({ x: xOffset, y: 0, width: DEFAULT_WEB_BOUNDS.width, height: DEFAULT_WEB_BOUNDS.height });
    win.show();
    win.focus();
  } else {
    // Move ra ngoài màn hình THAY VÌ hide()
    // hide() suspend Chromium rendering → scroll/elementFromPoint/inject JS không chạy được
    // Move ra ngoài + opacity=0 → window vẫn render đầy đủ, chỉ không nhìn thấy
    try {
      const { screen } = require("electron");
      const displays = screen.getAllDisplays();
      const maxX = displays.reduce((m, d) => Math.max(m, d.bounds.x + d.bounds.width), 0);
      win.setPosition(maxX + 50, 0);
    } catch (_) {
      win.setPosition(9999, 0);
    }
    win.setOpacity(0);
  }

  return { ok: true };
});

// Resize slot window (dùng để thu nhỏ thành thanh preview)
ipcMain.handle("slot:resize", async (_event, { slotId, width, height }) => {
  const win = ensureWebWindow(slotId);
  if (!win) return { ok: false, reason: "slot not open" };
  const w = clampNumber(width, 200, 2600, DEFAULT_WEB_BOUNDS.width);
  const h = clampNumber(height, 40, 1800, DEFAULT_WEB_BOUNDS.height);
  win.setSize(w, h, true);
  return { ok: true, width: w, height: h };
});

// Lấy danh sách slot hiện đang sống
ipcMain.handle("slot:list", async () => {
  const list = [];
  for (const [id, win] of webSlots) {
    if (!win.isDestroyed()) {
      list.push({
        slotId: id,
        url: win.webContents.getURL(),
        title: win.webContents.getTitle()
      });
    }
  }
  return { ok: true, slots: list };
});

// ── URL ────────────────────────────────────────────────────

ipcMain.handle("web:load-url", async (_event, payload) => {
  // backward compat: payload có thể là string (url) hoặc object { url, slotId }
  const isString = typeof payload === "string";
  const url = isString ? payload : (payload && payload.url) || "";
  const slotId = isString ? 1 : (payload && payload.slotId) || 1;

  const win = ensureWebWindow(slotId);
  if (!win) return { ok: false, reason: `slot ${slotId} not ready` };

  try {
    const cleanUrl = String(url || "").trim();
    if (!cleanUrl) return { ok: false, reason: "empty url" };

    await win.loadURL(cleanUrl);

    sendWebResult({
      type: "detectlab_status",
      message: "Opening " + cleanUrl,
      slotId
    });

    return { ok: true, url: cleanUrl, slotId };
  } catch (err) {
    console.warn("[MAIN] web:load-url error:", err);
    sendWebResult({
      type: "detectlab_status",
      message: "Open URL failed",
      slotId
    });
    return { ok: false, reason: err.message || "loadURL error" };
  }
});

// Sync noti rules từ control — để inject vào main world của web window
ipcMain.handle("noti:sync-rules", (_event, payload) => {
  const { slotId = 1, rules = [] } = payload || {};
  const id = Number(slotId);
  slotNotiRules.set(id, Array.isArray(rules) ? rules : []);
  log(`[noti:sync-rules] slot ${id}: ${rules.length} rules`);

  const win = webSlots.get(id);
  if (win && !win.isDestroyed()) {
    // Update rules trong trang đang mở ngay lập tức
    const rulesJson = JSON.stringify(rules);
    const js = `if(typeof window.__dlUpdateNotiRules==='function'){window.__dlUpdateNotiRules(${rulesJson});}else{window.__dlNotiRules=${rulesJson};}`;
    try {
      const frame = win.webContents.mainFrame;
      if (frame && typeof frame.executeJavaScript === "function") {
        frame.executeJavaScript(js).catch(() => {});
      }
    } catch (_) {}

    // Re-register CDP script để trang tiếp theo cũng có rules mới
    if (typeof win.__reRegisterNotiScript === "function") {
      win.__reRegisterNotiScript().catch(() => {});
    }
  }
  return { ok: true };
});

ipcMain.handle("web:exec", async (_event, payload) => {
const safePayload = payload || {};
const type = safePayload.type;
const slotId = safePayload.slotId || 1;

const win = ensureWebWindow(slotId);
if (!win) {
return { ok: false, reason: `slot ${slotId} not ready` };
}

const safePayloadWithSlot = { ...safePayload, slotId };

try {
if (!type) return { ok: false, reason: "missing type" };

if (type === "applyWindowConfig") {
return await applyWebWindowConfig(safePayloadWithSlot);
}

if (type === "gsiclick") {
  const js = `
(function() {
  try {
    // Không dùng prompt() — bị suppressed_by_user cooldown
    // Click thẳng vào container div bọc ngoài iframe GSI
    // Đây là cách trigger button click mà không qua One Tap dialog

    // Cách 1: Tìm iframe GSI và click parent container
    var iframe = document.querySelector(
      'iframe[src*="accounts.google.com/gsi/button"], iframe[allow*="identity-credentials-get"]'
    );
    if (iframe) {
      // Leo lên parent cho đến khi tìm được element clickable (có onClick hoặc role=button)
      var el = iframe.parentElement;
      while (el && el !== document.body) {
        var role = el.getAttribute && el.getAttribute('role');
        var hasClick = typeof el.onclick === 'function' || el.getAttribute('onclick');
        if (role === 'button' || hasClick) {
          el.click();
          return { ok: true, method: 'parent-role-button', tag: el.tagName };
        }
        el = el.parentElement;
      }
      // Fallback: click trực tiếp parent của iframe
      if (iframe.parentElement) {
        iframe.parentElement.click();
        return { ok: true, method: 'iframe-direct-parent' };
      }
    }

    // Cách 2: Click .g_id_signin wrapper
    var wrappers = document.querySelectorAll('.g_id_signin');
    if (wrappers.length > 0) {
      var btn = wrappers[0].querySelector('div[role="button"]') || wrappers[0];
      btn.click();
      return { ok: true, method: 'g_id_signin' };
    }

    // Cách 3: dispatchEvent MouseEvent trực tiếp lên iframe
    // (một số setup GSI lắng nghe mousedown trên iframe element)
    if (iframe) {
      var rect = iframe.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      ['mousedown','mouseup','click'].forEach(function(evName) {
        iframe.dispatchEvent(new MouseEvent(evName, {
          bubbles: true, cancelable: true, view: window,
          clientX: cx, clientY: cy, button: 0, buttons: 1
        }));
      });
      return { ok: true, method: 'iframe-mouse-event', x: cx, y: cy };
    }

    return { ok: false, reason: 'no GSI iframe found' };
  } catch(e) {
    return { ok: false, reason: e.message };
  }
})()
`;
  try {
    const result = await win.webContents.executeJavaScript(js, true);
    log(`[gsiclick] slot ${slotId} result:`, result);

    // Nếu tìm được iframe, dùng CDP click thẳng vào tọa độ trung tâm
    // CDP Input.dispatchMouseEvent chạy ở browser level, xuyên qua được iframe boundary
    if (result && result.ok) {
      // Lấy tọa độ iframe để CDP click
      const coordJs = `
(function() {
  var iframe = document.querySelector(
    'iframe[src*="accounts.google.com/gsi/button"], iframe[allow*="identity-credentials-get"]'
  );
  if (!iframe) return null;
  var r = iframe.getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
})()
`;
      const coords = await win.webContents.executeJavaScript(coordJs, true);
      if (coords && typeof coords.x === "number") {
        const dbg = win.webContents.debugger;
        try {
          try { dbg.attach("1.3"); } catch (_) {}
          const base = { x: coords.x, y: coords.y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 };
          await dbg.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
          await dbg.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
          await new Promise(r => setTimeout(r, 80));
          await dbg.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
          try { dbg.detach(); } catch (_) {}
          log(`[gsiclick] CDP click on iframe at (${coords.x}, ${coords.y})`);
        } catch (cdpErr) {
          try { dbg.detach(); } catch (_) {}
          log(`[gsiclick] CDP fallback error: ${cdpErr.message}`);
        }
      }
    }

    return { ok: true, forwarded: false, result, type, slotId };
  } catch (err) {
    return { ok: false, reason: "gsiclick executeJS error: " + err.message };
  }
}

if (type === "returnToSheet") {
const url = String(safePayload.url || "").trim();
if (!url) return { ok: false, reason: "missing return url" };

log("RETURN fetch →", url, `(slot ${slotId})`);
let res, text, json = null;

try {
res = await fetch(url, {
method: "GET",
headers: {
"User-Agent": "camp-detect-app/0.1.0",
"Accept": "application/json,text/plain,*/*"
}
});
text = await res.text();
try { json = JSON.parse(text); } catch (_) { json = null; }
} catch (err) {
console.warn("[MAIN] returnToSheet fetch error", err);
sendWebResult({
type: "detectlab_status",
message: "Return failed: " + (err.message || "fetch error"),
slotId
});
return { ok: false, reason: err.message || "fetch error" };
}

sendWebResult({
type: "detectlab_log",
message: "Return status " + res.status + (json && json.ok ? " (ok)" : " (body: " + text + ")"),
slotId
});

if (!res.ok) return { ok: false, status: res.status, body: text };
if (json && json.ok === false) return { ok: false, status: res.status, body: text, json };
return { ok: true, forwarded: true, status: res.status, body: text, json };
}

// Forward tới đúng web window của slot
win.webContents.send("web:exec", safePayloadWithSlot);
return { ok: true, forwarded: true, type, slotId };

} catch (err) {
console.warn("[MAIN] web:exec error:", err, safePayload);
sendWebResult({
type: "detectlab_status",
message: "web:exec failed for " + type,
slotId
});
return { ok: false, reason: err.message || "web:exec error" };
}
});

ipcMain.handle("web:set-file-input-files", async (_event, payload) => {
const safePayload = payload || {};
const senderSlotId = getSlotIdByWebContentsId(_event.sender && _event.sender.id) || 1;
const finalPayload = {
...safePayload,
slotId: Number(safePayload.slotId) || senderSlotId
};

try {
const result = await setFileInputFilesForWebWindow(finalPayload);
return result;
} catch (err) {
console.warn("[MAIN] web:set-file-input-files error:", err);
return {
ok: false,
reason: err && err.message ? err.message : "web:set-file-input-files error"
};
}
});

ipcMain.handle("web:cdp-click", async (_event, payload) => {
  const safePayload = payload || {};
  const senderSlotId = getSlotIdByWebContentsId(_event.sender && _event.sender.id) || 1;
  const finalPayload = {
    ...safePayload,
    slotId: Number(safePayload.slotId) || senderSlotId
  };
  try {
    return await cdpClickInWebWindow(finalPayload);
  } catch (err) {
    console.warn("[MAIN] web:cdp-click error:", err);
    return { ok: false, reason: err && err.message ? err.message : "cdp-click error" };
  }
});

// ── Popup exec: dùng executeJavaScript trực tiếp vì popup không có preload ──
ipcMain.handle("popup:exec", async (_event, payload) => {
  const safePayload = payload || {};
  const slotId = safePayload.slotId || 1;
  const action = safePayload.action || "";

  const popupWin = popupSlots.get(slotId);
  if (!popupWin || popupWin.isDestroyed()) {
    return { ok: false, reason: `No popup for slot ${slotId}` };
  }

  // ── Helper: CDP click tại tọa độ viewport (trusted event, xuyên qua React) ──
  async function cdpClickAt(x, y) {
    const dbg = popupWin.webContents.debugger;
    try {
      try { dbg.attach("1.3"); } catch (_) {}
      const base = { x, y, button: "left", buttons: 1, clickCount: 1, modifiers: 0 };
      await dbg.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mouseMoved" });
      await dbg.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
      await new Promise(r => setTimeout(r, 60));
      await dbg.sendCommand("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
      try { dbg.detach(); } catch (_) {}
      return { ok: true, x, y };
    } catch (err) {
      try { dbg.detach(); } catch (_) {}
      return { ok: false, reason: "CDP click error: " + err.message };
    }
  }

  // ── Helper: resolve tọa độ center của element trong popup ──
  async function resolveElementCenter(sel, txt) {
    const js = `
(function(sel, txt) {
  function findEl() {
    if (sel) {
      try { var e = document.querySelector(sel); if (e) return e; } catch(_) {}
    }
    if (txt) {
      var t = txt.toLowerCase();
      var all = document.querySelectorAll('button,a,div,span,li,label,input,[role="button"]');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if ((el.innerText || el.textContent || '').trim().toLowerCase().includes(t)) return el;
      }
    }
    return null;
  }
  var el = findEl();
  if (!el) return { ok: false, reason: 'element not found' };
  try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(_) {}
  var r = el.getBoundingClientRect();
  return { ok: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: el.tagName };
})(${JSON.stringify(sel)}, ${JSON.stringify(txt)})
`;
    return await popupWin.webContents.executeJavaScript(js, true);
  }

  try {
    let result = null;

    if (action === "click") {
      // Dùng CDP click để bypass React isTrusted check
      const sel = safePayload.selector || "";
      const txt = safePayload.elementText || "";
      if (!sel && !txt) return { ok: false, reason: "popup click needs selector or elementText" };

      const coords = await resolveElementCenter(sel, txt);
      if (!coords || !coords.ok) return { ok: false, reason: coords ? coords.reason : "element not found" };

      result = await cdpClickAt(coords.x, coords.y);

    } else if (action === "clickselector") {
      // Click bằng CDP sau khi tìm element theo selector/elementText
      const sel = safePayload.selector || "";
      const txt = safePayload.elementText || "";
      if (!sel && !txt) return { ok: false, reason: "clickselector needs selector or elementText" };

      const coords = await resolveElementCenter(sel, txt);
      if (!coords || !coords.ok) return { ok: false, reason: coords ? coords.reason : "element not found" };

      result = await cdpClickAt(coords.x, coords.y);

    } else if (action === "clickpoint") {
      // Click tại tọa độ viewport cố định
      const x = safePayload.x;
      const y = safePayload.y;
      if (typeof x !== "number" || typeof y !== "number") {
        return { ok: false, reason: "clickpoint requires x and y" };
      }
      result = await cdpClickAt(x, y);

    } else if (action === "input") {
      const sel = safePayload.selector || "input";
      const val = safePayload.value != null ? String(safePayload.value) : "";
      const js = `
(function(sel, val) {
  var el = document.querySelector(sel);
  if (!el) return { ok: false, reason: 'selector not found: ' + sel };
  try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch(_) {}
  try { el.focus(); } catch(_) {}
  // React native setter
  var tag = (el.tagName || '').toLowerCase();
  var proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) {
    desc.set.call(el, val);
  } else {
    el.value = val;
  }
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));
  try { el.blur(); } catch(_) {}
  try { el.focus(); } catch(_) {}
  return { ok: true, value: val };
})(${JSON.stringify(sel)}, ${JSON.stringify(val)})
`;
      result = await popupWin.webContents.executeJavaScript(js, true);

    } else if (action === "read") {
      const sel = safePayload.selector || "body";
      const js = `
(function(sel){
  var el = document.querySelector(sel);
  return el ? (el.innerText || el.textContent || '').trim() : '';
})(${JSON.stringify(sel)})
`;
      result = await popupWin.webContents.executeJavaScript(js, true);

    } else if (action === "wait") {
      const timeoutMs = safePayload.timeoutMs || 8000;
      result = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
        popupWin.webContents.once("did-finish-load", () => {
          clearTimeout(timer);
          resolve({ ok: true, url: popupWin.webContents.getURL() });
        });
        popupWin.webContents.executeJavaScript("document.readyState").then(state => {
          if (state === "complete") { clearTimeout(timer); resolve({ ok: true, alreadyLoaded: true }); }
        }).catch(() => {});
      });

    } else if (action === "wait-load") {
      const timeoutMs = safePayload.timeoutMs || 10000;
      result = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
        popupWin.webContents.once("did-finish-load", () => {
          clearTimeout(timer);
          resolve({ ok: true, url: popupWin.webContents.getURL() });
        });
        popupWin.webContents.once("dom-ready", () => {
          popupWin.webContents.executeJavaScript("document.readyState").then(state => {
            if (state === "complete") { clearTimeout(timer); resolve({ ok: true, url: popupWin.webContents.getURL() }); }
          }).catch(() => {});
        });
      });

    } else if (action === "get-url") {
      result = { ok: true, url: popupWin.webContents.getURL() };

    } else if (action === "keypress") {
      const sel = safePayload.selector || "";
      const key = safePayload.key || "Enter";
      const KEY_MAP = {
        Enter: 13, Tab: 9, Space: 32, Escape: 27, Backspace: 8,
        ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39
      };
      const keyCode = KEY_MAP[key] || key.charCodeAt(0);
      const js = `
(function(sel, key, keyCode){
  var el = sel ? document.querySelector(sel) : (document.activeElement || document.body);
  if (!el) return { ok: false, reason: 'element not found' };
  var opts = { key: key, keyCode: keyCode, which: keyCode, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
  return { ok: true };
})(${JSON.stringify(sel)}, ${JSON.stringify(key)}, ${keyCode})
`;
      result = await popupWin.webContents.executeJavaScript(js, true);

    } else if (action === "close") {
      popupWin.close();
      result = { ok: true };

    } else {
      return { ok: false, reason: `Unknown popup action: ${action}` };
    }

    log(`slot ${slotId}: popup:exec action=${action} result=`, result);
    return { ok: true, result };
  } catch (err) {
    console.warn("[MAIN] popup:exec error:", err);
    return { ok: false, reason: err.message || "popup:exec error" };
  }
});

// Inject pick overlay vào popup window để user click chọn tọa độ
ipcMain.handle("popup:pick-point", async (_event, payload) => {
  const slotId = (payload && payload.slotId) || 1;
  const popupWin = popupSlots.get(slotId);
  if (!popupWin || popupWin.isDestroyed()) {
    return { ok: false, reason: `No popup for slot ${slotId}` };
  }

  // Inject overlay pick vào popup — giống preload-web nhưng chạy qua executeJavaScript
  const js = `
(function() {
  // Xóa overlay cũ nếu có
  var old = document.getElementById('__dl_pick_overlay__');
  if (old) old.remove();
  var oldTip = document.getElementById('__dl_pick_tip__');
  if (oldTip) oldTip.remove();

  var overlay = document.createElement('div');
  overlay.id = '__dl_pick_overlay__';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0',
    zIndex: '2147483647', cursor: 'crosshair',
    background: 'rgba(239,68,68,0.08)',
    outline: '3px dashed rgba(239,68,68,0.7)'
  });

  var tip = document.createElement('div');
  tip.id = '__dl_pick_tip__';
  Object.assign(tip.style, {
    position: 'fixed', top: '8px', left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(15,23,42,0.92)', color: '#f87171',
    padding: '6px 16px', borderRadius: '999px',
    fontSize: '13px', fontWeight: '700',
    fontFamily: 'system-ui,sans-serif',
    pointerEvents: 'none', zIndex: '2147483647',
    border: '1px solid rgba(239,68,68,0.5)',
    whiteSpace: 'nowrap'
  });
  tip.textContent = '🎯 Click to pick position — ESC to cancel';
  document.body.appendChild(tip);

  function cleanup() {
    try { overlay.remove(); } catch(_) {}
    try { tip.remove(); } catch(_) {}
    document.removeEventListener('keydown', escHandler, true);
  }

  function escHandler(e) {
    if (e.key === 'Escape') { cleanup(); }
  }
  document.addEventListener('keydown', escHandler, true);

  overlay.addEventListener('click', function(ev) {
    ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
    var vpX = ev.clientX; var vpY = ev.clientY;
    overlay.style.pointerEvents = 'none';
    var target = document.elementFromPoint(vpX, vpY) || document.body;
    overlay.style.pointerEvents = 'all';
    var rect = target.getBoundingClientRect();
    var cx = Math.round(rect.left + rect.width / 2);
    var cy = Math.round(rect.top + rect.height / 2);
    cleanup();
    // Ghi kết quả vào window để main process đọc
    window.__DL_PICKED_POINT__ = { x: cx, y: cy };
  }, { once: true });

  document.body.appendChild(overlay);
  return { ok: true };
})()
`;

  try {
    await popupWin.webContents.executeJavaScript(js, true);

    // Poll cho đến khi user click hoặc timeout 30s
    const picked = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 30000);
      const interval = setInterval(async () => {
        try {
          if (popupWin.isDestroyed()) { clearInterval(interval); clearTimeout(timeout); resolve(null); return; }
          const result = await popupWin.webContents.executeJavaScript(
            "(function(){ var p = window.__DL_PICKED_POINT__; if(p){ window.__DL_PICKED_POINT__ = null; return p; } return null; })()",
            true
          );
          if (result && typeof result.x === "number") {
            clearInterval(interval);
            clearTimeout(timeout);
            resolve(result);
          }
        } catch (_) {}
      }, 200);
    });

    if (!picked) return { ok: false, reason: "timeout or cancelled" };
    log(`[popup:pick-point] slot ${slotId} picked:`, picked);
    return { ok: true, x: picked.x, y: picked.y };
  } catch (err) {
    return { ok: false, reason: "pick-point error: " + err.message };
  }
});

// Inject pick selector overlay vào popup window
ipcMain.handle("popup:pick-selector", async (_event, payload) => {
  const slotId = (payload && payload.slotId) || 1;
  const popupWin = popupSlots.get(slotId);
  if (!popupWin || popupWin.isDestroyed()) {
    return { ok: false, reason: `No popup for slot ${slotId}` };
  }

  const js = `
(function() {
  var old = document.getElementById('__dl_pick_overlay__');
  if (old) old.remove();
  var oldTip = document.getElementById('__dl_pick_tip__');
  if (oldTip) oldTip.remove();

  var overlay = document.createElement('div');
  overlay.id = '__dl_pick_overlay__';
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0',
    zIndex: '2147483647', cursor: 'crosshair',
    background: 'rgba(56,189,248,0.06)',
    outline: '3px dashed rgba(56,189,248,0.7)'
  });

  var tip = document.createElement('div');
  tip.id = '__dl_pick_tip__';
  Object.assign(tip.style, {
    position: 'fixed', top: '8px', left: '50%',
    transform: 'translateX(-50%)',
    background: 'rgba(15,23,42,0.92)', color: '#38bdf8',
    padding: '6px 16px', borderRadius: '999px',
    fontSize: '13px', fontWeight: '700',
    fontFamily: 'system-ui,sans-serif',
    pointerEvents: 'none', zIndex: '2147483647',
    border: '1px solid rgba(56,189,248,0.5)',
    whiteSpace: 'nowrap'
  });
  tip.textContent = '🔵 Click to pick selector — ESC to cancel';
  document.body.appendChild(tip);

  function cleanup() {
    try { overlay.remove(); } catch(_) {}
    try { tip.remove(); } catch(_) {}
    document.removeEventListener('keydown', escHandler, true);
  }
  function escHandler(e) { if (e.key === 'Escape') cleanup(); }
  document.addEventListener('keydown', escHandler, true);

  overlay.addEventListener('click', function(ev) {
    ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
    overlay.style.pointerEvents = 'none';
    var target = document.elementFromPoint(ev.clientX, ev.clientY) || document.body;
    overlay.style.pointerEvents = 'all';
    cleanup();

    var tag = target.tagName ? target.tagName.toLowerCase() : 'div';
    var sel = '';
    if ((tag === 'input' || tag === 'textarea') && target.placeholder) {
      var ph = target.placeholder;
      sel = ph.indexOf('"') >= 0 && ph.indexOf("'") < 0
        ? tag + "[placeholder='" + ph + "']"
        : tag + '[placeholder="' + ph + '"]';
    } else if (target.id) {
      sel = tag + '#' + target.id;
    } else if (target.className && typeof target.className === 'string') {
      var cls = target.className.split(/\\s+/).filter(function(c){ return c && !c.includes(':'); }).slice(0,2);
      sel = tag + (cls.length ? '.' + cls.join('.') : '');
    } else {
      sel = tag;
    }

    var elementText = (target.innerText || target.textContent || '').trim().slice(0, 80);

    window.__DL_PICKED_SELECTOR__ = { selector: sel, elementText: elementText };
  }, { once: true });

  document.body.appendChild(overlay);
  return { ok: true };
})()
`;

  try {
    await popupWin.webContents.executeJavaScript(js, true);

    const picked = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 30000);
      const interval = setInterval(async () => {
        try {
          if (popupWin.isDestroyed()) { clearInterval(interval); clearTimeout(timeout); resolve(null); return; }
          const result = await popupWin.webContents.executeJavaScript(
            "(function(){ var p = window.__DL_PICKED_SELECTOR__; if(p){ window.__DL_PICKED_SELECTOR__ = null; return p; } return null; })()",
            true
          );
          if (result && result.selector != null) {
            clearInterval(interval); clearTimeout(timeout); resolve(result);
          }
        } catch (_) {}
      }, 200);
    });

    if (!picked) return { ok: false, reason: "timeout or cancelled" };
    log(`[popup:pick-selector] slot ${slotId} picked:`, picked);
    return { ok: true, selector: picked.selector, elementText: picked.elementText };
  } catch (err) {
    return { ok: false, reason: "pick-selector error: " + err.message };
  }
});

// Cho phép check popup tồn tại không
ipcMain.handle("popup:status", async (_event, { slotId }) => {
  const id = Number(slotId) || 1;
  const popupWin = popupSlots.get(id);
  const exists = !!(popupWin && !popupWin.isDestroyed());
  const url = exists ? popupWin.webContents.getURL() : "";
  return { ok: true, exists, url };
});

// web:result từ preload-web: gửi kèm slotId để control route đúng
ipcMain.on("web:result", (_event, data) => {
if (!ensureControlWindow()) return;
// Nếu data chưa có slotId, tự suy ra từ webContentsId của sender
const enriched = data && data.slotId
? data
: { ...data, slotId: getSlotIdByWebContentsId(_event.sender && _event.sender.id) || 1 };
controlWin.webContents.send("web:result", enriched);
});

// ── Media storage helpers ─────────────────────────────────────────────

function getMediaRootDir() {
const base = app.getPath("userData");
const dir = path.join(base, "media");
try {
fs.mkdirSync(dir, { recursive: true });
} catch (_) {}
return dir;
}

function getMediaIndexPath() {
return path.join(getMediaRootDir(), "media_index.json");
}

function loadMediaIndex() {
try {
const p = getMediaIndexPath();
if (!fs.existsSync(p)) return { items: [] };
const raw = fs.readFileSync(p, "utf8");
const data = JSON.parse(raw);
if (!data || !Array.isArray(data.items)) return { items: [] };
return { items: data.items };
} catch (err) {
console.warn("[MAIN] loadMediaIndex error:", err);
return { items: [] };
}
}

function saveMediaIndex(index) {
try {
const p = getMediaIndexPath();
const safe = {
items: Array.isArray(index && index.items) ? index.items : []
};
fs.writeFileSync(p, JSON.stringify(safe, null, 2), "utf8");
} catch (err) {
console.warn("[MAIN] saveMediaIndex error:", err);
}
}

function sanitizeFileName(name) {
const base = String(name || "").trim() || "media";
return base.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
}

function makeMediaId() {
return (
"media-" +
Date.now() +
"-" +
Math.random().toString(36).slice(2, 9)
);
}

  // ── IPC: control → main: download media from sheet ────────────────────
  // payload: { slotId, items: [{ id, fileName, url, rowId }] }
  ipcMain.handle("media:download-from-sheet", async (_event, payload) => {
    const safe = payload || {};
    const slotId = safe.slotId || 1;
    const items = Array.isArray(safe.items) ? safe.items : [];

    console.log("[MAIN] media:download-from-sheet payload:", {
      slotId,
      count: items.length,
      sample: items[0] || null
    });

    if (!items.length) {
      console.warn("[MAIN] media:download-from-sheet no items");
      return { ok: false, reason: "no items" };
    }

    const mediaRoot = getMediaRootDir();
    const index = loadMediaIndex();
    const results = [];

    for (const item of items) {
      const url = String(item && item.url || "").trim();
      if (!url) {
        console.warn("[MAIN] media item has empty url:", item);
        results.push({ ok: false, reason: "empty url", id: item && item.id, rowId: item && item.rowId });
        continue;
      }

      const fileName = sanitizeFileName(item.fileName || item.id || "media");

      try {
        console.log("[MAIN] media download start:", { url, rowId: item.rowId, id: item.id });
        const res = await fetch(url);
        if (!res.ok) {
          console.warn("[MAIN] media download http error:", res.status, url);
          results.push({ ok: false, reason: "http " + res.status, status: res.status, id: item.id, rowId: item.rowId });
          continue;
        }

        // Đoán ext từ URL trước, nếu không có thì fallback theo MIME (image/png → .png, ...)
        let ext = path.extname((url.split("?")[0] || "").split("#")[0]) || "";
        const mime = (res.headers && res.headers.get("content-type")) || "";

        if (!ext && mime && mime.startsWith("image/")) {
          const lower = mime.toLowerCase();
          if (lower.includes("png")) ext = ".png";
          else if (lower.includes("jpeg") || lower.includes("jpg")) ext = ".jpg";
          else if (lower.includes("webp")) ext = ".webp";
          else if (lower.includes("gif")) ext = ".gif";
        }

        const baseName = ext && !fileName.endsWith(ext) ? fileName + ext : fileName;

        // Nếu URL này đã tải trước đó (cùng slot) → tái sử dụng entry cũ, ghi đè đúng file đó.
        const existing = index.items.find(
          it => it && it.sourceUrl === url && Number(it.slotId) === Number(slotId)
        );

        let finalName;
        let destPath;

        if (existing && existing.localPath) {
          // Ghi đè lại file cũ của đúng URL này (không tạo bản trùng)
          finalName = existing.fileName;
          destPath = existing.localPath;
        } else {
          // Tên mới: phải UNIQUE trên đĩa để nhiều ảnh khác URL nhưng cùng tên cột
          // không đè lên nhau. Giữ base name để upload match kiểu "contains".
          const extPart = path.extname(baseName);
          const stem = extPart ? baseName.slice(0, -extPart.length) : baseName;
          finalName = baseName;
          destPath = path.join(mediaRoot, finalName);
          let counter = 1;
          const usedPaths = new Set(index.items.map(it => it && it.localPath));
          while (fs.existsSync(destPath) || usedPaths.has(destPath)) {
            finalName = stem + " (" + counter + ")" + extPart;
            destPath = path.join(mediaRoot, finalName);
            counter++;
          }
        }

        const arrayBuf = await res.arrayBuffer();
        fs.writeFileSync(destPath, Buffer.from(arrayBuf));

        if (existing) {
          // Cập nhật entry sẵn có thay vì push trùng
          existing.fileName = finalName;
          existing.localPath = destPath;
          existing.rowId = item.rowId || existing.rowId || null;
          existing.status = "downloaded";
          existing.mime = mime;
          results.push({ ok: true, id: existing.id, rowId: existing.rowId });
        } else {
          const mediaItem = {
            id: makeMediaId(),
            fileName: finalName,
            localPath: destPath,
            sourceUrl: url,
            rowId: item.rowId || null,
            slotId,
            status: "downloaded",
            mime
          };
          index.items.push(mediaItem);
          results.push({ ok: true, id: mediaItem.id, rowId: mediaItem.rowId });
        }
      } catch (err) {
        console.warn("[MAIN] media download error:", err, url);
        results.push({
          ok: false,
          reason: err && err.message ? err.message : "download error",
          id: item && item.id,
          rowId: item && item.rowId
        });
      }
    }

    saveMediaIndex(index);

    // Báo cho control để nó refresh tab Image nếu muốn
    sendToControl("media:index-updated", {
      slotId,
      items: index.items
    });

    console.log("[MAIN] media:download-from-sheet done:", {
      slotId,
      total: items.length,
      okCount: results.filter(r => r.ok).length
    });

    return {
      ok: true,
      slotId,
      results
    };
  });

// IPC: control hỏi index media để render tab Image
ipcMain.handle("media:get-index", async () => {
const index = loadMediaIndex();
return {
ok: true,
items: index.items
};
});

// IPC: control yêu cầu xóa media (theo ids). ids rỗng/không truyền => xóa tất cả.
ipcMain.handle("media:delete", async (_event, payload) => {
  try {
    const safe = payload || {};
    const ids = Array.isArray(safe.ids) ? safe.ids.map(String) : null;
    const index = loadMediaIndex();
    const before = index.items.length;

    const toRemove = (ids && ids.length)
      ? index.items.filter(it => it && ids.includes(String(it.id)))
      : index.items.slice();

    // Xóa file vật lý trên đĩa
    toRemove.forEach(it => {
      try {
        if (it && it.localPath && fs.existsSync(it.localPath)) {
          fs.unlinkSync(it.localPath);
        }
      } catch (e) {
        console.warn("[MAIN] media:delete unlink error:", e, it && it.localPath);
      }
    });

    // Giữ lại các item không nằm trong danh sách xóa
    index.items = (ids && ids.length)
      ? index.items.filter(it => it && !ids.includes(String(it.id)))
      : [];

    saveMediaIndex(index);

    sendToControl("media:index-updated", {
      items: index.items
    });

    const removed = before - index.items.length;
    console.log("[MAIN] media:delete done:", { requested: ids ? ids.length : "all", removed });

    return { ok: true, removed, items: index.items };
  } catch (err) {
    console.warn("[MAIN] media:delete error:", err);
    return { ok: false, reason: err && err.message ? err.message : "delete error" };
  }
});

ipcMain.handle("dialog:pick-files", async (_event, payload) => {
try {
const safe = payload || {};
const filters = Array.isArray(safe.filters) && safe.filters.length
? safe.filters
: [
{ name: "Media", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "mp4", "mov", "avi", "mkv", "webm"] }
];
const properties = Array.isArray(safe.properties) && safe.properties.length
? safe.properties
: ["openFile", "multiSelections"];
const owner = ensureControlWindow() || BrowserWindow.getFocusedWindow() || null;

const res = await dialog.showOpenDialog(owner, {
title: safe.title ? String(safe.title) : "Select media files",
properties,
filters
});

if (res.canceled) {
return { ok: true, canceled: true, files: [] };
}

const files = (res.filePaths || []).map(fp => ({
name: path.basename(fp),
localPath: fp
}));

return { ok: true, canceled: false, files };
} catch (err) {
console.warn("[MAIN] dialog:pick-files error:", err);
return {
ok: false,
reason: err && err.message ? err.message : "pick files error"
};
}
});

ipcMain.handle("media:read-files", async (_event, payload) => {
try {
const safe = payload || {};
const files = Array.isArray(safe.files) ? safe.files : [];
if (!files.length) return { ok: true, files: [] };

const index = loadMediaIndex();
const items = Array.isArray(index.items) ? index.items : [];
const results = [];

for (const file of files) {
const wantedId = String(file && file.id || "").trim();
const wantedPath = String(file && file.localPath || "").trim();

let matched = null;
if (wantedId) {
matched = items.find(it => String(it && it.id || "").trim() === wantedId) || null;
}
if (!matched && wantedPath) {
matched = items.find(it => String(it && it.localPath || "").trim() === wantedPath) || null;
}
if (!matched) {
matched = {
id: wantedId || null,
fileName: file && file.name ? String(file.name) : "upload-file",
localPath: wantedPath,
mime: file && file.type ? String(file.type) : ""
};
}

const absPath = String(matched.localPath || "").trim();
if (!absPath || !fs.existsSync(absPath)) {
results.push({
ok: false,
id: matched.id || null,
name: matched.fileName || "upload-file",
reason: "file not found"
});
continue;
}

const buf = fs.readFileSync(absPath);
results.push({
ok: true,
id: matched.id || null,
name: matched.fileName || "upload-file",
type: matched.mime || "",
size: buf.length,
bufferBase64: Buffer.from(buf).toString("base64")
});
}

return { ok: true, files: results };
} catch (err) {
console.warn("[MAIN] media:read-files error:", err);
return { ok: false, reason: err.message || "media read error" };
}
});

ipcMain.handle("detectlab:fetch-sheet-rows", async (_event, config) => {
  try {
    const {
      baseUrl,
      sheetId,
      sheetName,
      startRow,
      maxRows
    } = config || {};

    if (!baseUrl || !sheetId || !sheetName) {
      return { ok: false, error: "Missing baseUrl / sheetId / sheetName" };
    }

    const r = startRow && startRow > 1 ? startRow : 2;
    const limit = maxRows && maxRows > 0 ? maxRows : 100;

    const url =
      baseUrl +
      "?sheetId=" + encodeURIComponent(sheetId) +
      "&tab=" + encodeURIComponent(sheetName) +
      "&startRow=" + encodeURIComponent(r) +
      "&maxRows=" + encodeURIComponent(limit);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    let res;
    let data;

    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "camp-detect-app/0.1.0",
          "Accept": "application/json,text/plain,*/*"
        }
      });

      const text = await res.text();
      data = JSON.parse(text);
    } finally {
      clearTimeout(timeout);
    }

    if (!data || data.ok === false) {
      return { ok: true, rawRows: null };
    }

    let rawRows;

    // Trường hợp API trả về nhiều dòng: { rows: [ ... ] }
    if (Array.isArray(data.rows) && data.rows.length) {
      rawRows = data.rows.map(row =>
        Array.isArray(row) ? row.map(v => (v != null ? String(v) : "")) : []
      );
    } else if (Array.isArray(data.__raw)) {
      // Trường hợp API hiện tại: 1 dòng duy nhất, dùng __raw
      rawRows = [data.__raw.map(v => (v != null ? String(v) : ""))];
    } else {
      return { ok: true, rawRows: null };
    }

    return {
      ok: true,
      rawRows
    };
  } catch (err) {
    console.warn("[MAIN] detectlab:fetch-sheet-rows error", err);
    return {
      ok: false,
      error: err && err.message ? err.message : "fetch error"
    };
  }
});

// ── Session (cookie) storage helpers ─────────────────────────────────────────

function getSessionDir() {
  const dir = path.join(app.getPath("userData"), "sessions");
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function getSessionIndexPath() {
  return path.join(getSessionDir(), "_index.json");
}

function loadSessionIndex() {
  try {
    const p = getSessionIndexPath();
    if (!fs.existsSync(p)) return { sessions: [] };
    return JSON.parse(fs.readFileSync(p, "utf8")) || { sessions: [] };
  } catch (_) { return { sessions: [] }; }
}

function saveSessionIndex(index) {
  try {
    fs.writeFileSync(getSessionIndexPath(), JSON.stringify(index, null, 2), "utf8");
  } catch (err) { console.warn("[MAIN] saveSessionIndex error:", err); }
}

// Lấy tất cả cookies + localStorage của một web window
async function captureSessionFromWindow(win, domains) {
  if (!win || win.isDestroyed()) return null;
  const ses = win.webContents.session;

  // Lấy domain chính từ URL hiện tại của window
  let mainDomain = "";
  try {
    const url = win.webContents.getURL();
    const parsed = new URL(url);
    // Lấy 2 phần cuối của hostname: kie.ai, google.com, etc.
    const parts = parsed.hostname.split(".");
    mainDomain = parts.length >= 2 ? parts.slice(-2).join(".") : parsed.hostname;
  } catch (_) {}

  // Danh sách domain bị chặn — third-party auth/tracking không nên lưu
  const BLOCKED_DOMAINS = [
    "google.com", "googleapis.com", "gstatic.com", "accounts.google.com",
    "facebook.com", "twitter.com", "apple.com",
    "cloudflare.com", "doubleclick.net", "analytics.com"
  ];

  let allCookies = await ses.cookies.get({});

  // Filter theo domains nếu user chỉ định rõ
  if (domains && domains.length) {
    allCookies = allCookies.filter(c =>
      domains.some(d => {
        const cleanD = d.replace(/^https?:\/\//, "").split("/")[0];
        return (c.domain || "").includes(cleanD);
      })
    );
  } else {
    // Mặc định: chỉ lấy cookies của domain chính, loại bỏ third-party
    allCookies = allCookies.filter(c => {
      const cookieDomain = (c.domain || "").replace(/^\./, "").toLowerCase();
      // Chặn các domain nhạy cảm
      if (BLOCKED_DOMAINS.some(bd => cookieDomain.includes(bd))) return false;
      // Chỉ giữ cookies thuộc domain chính
      if (mainDomain && !cookieDomain.includes(mainDomain)) return false;
      return true;
    });
  }

  log(`[captureSession] mainDomain=${mainDomain}, cookies: ${allCookies.length} (filtered from all)`);

  // Lấy localStorage
  let localStorageData = {};
  try {
    localStorageData = await win.webContents.executeJavaScript(`
      (function(){
        var out = {};
        try {
          for (var i = 0; i < localStorage.length; i++) {
            var k = localStorage.key(i);
            out[k] = localStorage.getItem(k);
          }
        } catch(_) {}
        return out;
      })()
    `, true);
  } catch (_) {}

  // Lấy sessionStorage
  let sessionStorageData = {};
  try {
    sessionStorageData = await win.webContents.executeJavaScript(`
      (function(){
        var out = {};
        try {
          for (var i = 0; i < sessionStorage.length; i++) {
            var k = sessionStorage.key(i);
            out[k] = sessionStorage.getItem(k);
          }
        } catch(_) {}
        return out;
      })()
    `, true);
  } catch (_) {}

  return { cookies: allCookies, localStorage: localStorageData, sessionStorage: sessionStorageData, mainDomain };
}

// Inject session vào web window
async function injectSessionToWindow(win, sessionData) {
  if (!win || win.isDestroyed() || !sessionData) return false;
  const ses = win.webContents.session;

  const cookies = Array.isArray(sessionData.cookies) ? sessionData.cookies : [];
  let injected = 0;
  let failed = 0;

  for (const cookie of cookies) {
    try {
      // Build URL đúng từ domain + path
      const domain = (cookie.domain || "").replace(/^\./, "");
      if (!domain) continue;
      const scheme = cookie.secure ? "https" : "http";
      const url = `${scheme}://${domain}${cookie.path || "/"}`;

      const cookieDetails = {
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly,
        sameSite: cookie.sameSite || "no_restriction"
      };
      // Chỉ set expirationDate nếu hợp lệ
      if (cookie.expirationDate && Number.isFinite(cookie.expirationDate) && cookie.expirationDate > 0) {
        cookieDetails.expirationDate = cookie.expirationDate;
      }

      await ses.cookies.set(cookieDetails);
      injected++;
    } catch (err) {
      failed++;
      // Không throw — bỏ qua cookie lỗi, tiếp tục inject cái khác
      console.warn(`[injectSession] skip cookie "${cookie.name}" @ ${cookie.domain}: ${err.message}`);
    }
  }

  log(`[injectSession] injected ${injected}/${cookies.length} cookies (${failed} failed)`);

  // Inject localStorage + sessionStorage
  const ls = sessionData.localStorage || {};
  const ss = sessionData.sessionStorage || {};
  if (Object.keys(ls).length || Object.keys(ss).length) {
    try {
      await win.webContents.executeJavaScript(`
        (function(ls, ss){
          try { Object.keys(ls).forEach(function(k){ localStorage.setItem(k, ls[k]); }); } catch(_) {}
          try { Object.keys(ss).forEach(function(k){ sessionStorage.setItem(k, ss[k]); }); } catch(_) {}
        })(${JSON.stringify(ls)}, ${JSON.stringify(ss)})
      `, true);
    } catch (_) {}
  }

  return true;
}

// IPC: lưu session từ web window
ipcMain.handle("session:save", async (_event, payload) => {
  try {
    const { slotId = 1, name, domains = [] } = payload || {};
    if (!name || !String(name).trim()) return { ok: false, reason: "session name required" };

    const win = ensureWebWindow(slotId);
    if (!win) return { ok: false, reason: `slot ${slotId} not ready` };

    // Flush cookies trước khi đọc
    try { await win.webContents.session.cookies.flushStore(); } catch (_) {}

    const sessionData = await captureSessionFromWindow(win, domains);
    if (!sessionData) return { ok: false, reason: "failed to capture session" };

    const safeName = String(name).trim().replace(/[^\w\-_.]/g, "_");
    const filePath = path.join(getSessionDir(), safeName + ".json");
    const entry = {
      name: safeName,
      savedAt: Date.now(),
      url: win.webContents.getURL(),
      cookieCount: sessionData.cookies.length,
      mainDomain: sessionData.mainDomain || "",
      domains
    };

    fs.writeFileSync(filePath, JSON.stringify(sessionData, null, 2), "utf8");

    const index = loadSessionIndex();
    index.sessions = index.sessions.filter(s => s.name !== safeName);
    index.sessions.unshift(entry);
    saveSessionIndex(index);

    log(`[session:save] saved "${safeName}" — ${sessionData.cookies.length} cookies, domain: ${sessionData.mainDomain}`);
    return { ok: true, name: safeName, cookieCount: sessionData.cookies.length };
  } catch (err) {
    console.warn("[MAIN] session:save error:", err);
    return { ok: false, reason: err.message };
  }
});

// IPC: load session vào web window
ipcMain.handle("session:load", async (_event, payload) => {
  try {
    const { slotId = 1, name, navigateTo } = payload || {};
    if (!name || !String(name).trim()) return { ok: false, reason: "session name required" };

    const safeName = String(name).trim().replace(/[^\w\-_.]/g, "_");
    const filePath = path.join(getSessionDir(), safeName + ".json");
    if (!fs.existsSync(filePath)) return { ok: false, reason: `session "${safeName}" not found` };

    const sessionData = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const win = ensureWebWindow(slotId);
    if (!win) return { ok: false, reason: `slot ${slotId} not ready` };

    // Xóa cookies cũ của domain trước khi inject để tránh conflict
    const ses = win.webContents.session;
    if (sessionData.mainDomain) {
      try {
        const oldCookies = await ses.cookies.get({ domain: sessionData.mainDomain });
        for (const c of oldCookies) {
          const url = `http${c.secure ? "s" : ""}://${c.domain.replace(/^\./, "")}${c.path || "/"}`;
          try { await ses.cookies.remove(url, c.name); } catch (_) {}
        }
      } catch (_) {}
    }

    // Inject cookies
    await injectSessionToWindow(win, { cookies: sessionData.cookies || [], localStorage: {}, sessionStorage: {} });

    // Flush cookies xuống disk
    try { await ses.cookies.flushStore(); } catch (_) {}

    // Navigate nếu có URL
    if (navigateTo) {
      await win.loadURL(navigateTo);
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 10000);
        win.webContents.once("did-finish-load", () => { clearTimeout(timer); resolve(); });
      });
    }

    // Inject localStorage/sessionStorage sau khi trang load
    await injectSessionToWindow(win, {
      cookies: [],
      localStorage: sessionData.localStorage || {},
      sessionStorage: sessionData.sessionStorage || {}
    });

    const cookieCount = (sessionData.cookies || []).length;
    log(`[session:load] loaded "${safeName}" — ${cookieCount} cookies`);
    return { ok: true, name: safeName, cookieCount };
  } catch (err) {
    console.warn("[MAIN] session:load error:", err);
    return { ok: false, reason: err.message };
  }
});

// IPC: xóa toàn bộ cookies của slot (reset về trạng thái fresh)
ipcMain.handle("session:clear-cookies", async (_event, payload) => {
  try {
    const slotId = (payload && payload.slotId) || 1;
    const win = ensureWebWindow(slotId);
    const ses = win ? win.webContents.session : null;

    // Nếu window đang mở, dùng session của nó
    if (ses) {
      const cookies = await ses.cookies.get({});
      for (const c of cookies) {
        try {
          const url = `http${c.secure ? "s" : ""}://${(c.domain || "").replace(/^\./, "")}${c.path || "/"}`;
          await ses.cookies.remove(url, c.name);
        } catch (_) {}
      }
      try { await ses.cookies.flushStore(); } catch (_) {}
      log(`[session:clear-cookies] cleared ${cookies.length} cookies for slot ${slotId}`);
      return { ok: true, cleared: cookies.length };
    }

    // Nếu window chưa mở, dùng session.fromPartition
    const { session: electronSession } = require("electron");
    const partitionSes = electronSession.fromPartition(`persist:slot${slotId}`);
    const cookies = await partitionSes.cookies.get({});
    for (const c of cookies) {
      try {
        const url = `http${c.secure ? "s" : ""}://${(c.domain || "").replace(/^\./, "")}${c.path || "/"}`;
        await partitionSes.cookies.remove(url, c.name);
      } catch (_) {}
    }
    try { await partitionSes.cookies.flushStore(); } catch (_) {}
    log(`[session:clear-cookies] cleared ${cookies.length} cookies for slot ${slotId} (partition)`);
    return { ok: true, cleared: cookies.length };
  } catch (err) {
    console.warn("[MAIN] session:clear-cookies error:", err);
    return { ok: false, reason: err.message };
  }
});

// IPC: list sessions
ipcMain.handle("session:list", async () => {
  try {
    const index = loadSessionIndex();
    return { ok: true, sessions: index.sessions || [] };
  } catch (err) {
    return { ok: false, sessions: [], reason: err.message };
  }
});

// IPC: delete session
ipcMain.handle("session:delete", async (_event, payload) => {
  try {
    const safeName = String((payload && payload.name) || "").trim().replace(/[^\w\-_.]/g, "_");
    if (!safeName) return { ok: false, reason: "name required" };
    const filePath = path.join(getSessionDir(), safeName + ".json");
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    const index = loadSessionIndex();
    index.sessions = index.sessions.filter(s => s.name !== safeName);
    saveSessionIndex(index);
    return { ok: true, name: safeName };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// ═════════════════════════════════════════════════════════════
// Chrome-pool: harvest cookie từ Chrome thật + xoay vòng identity
// + auto-reset khi gặp captcha
// ═════════════════════════════════════════════════════════════

// Suy domain "chính" (2 phần cuối hostname) từ URL hiện tại của slot
function slotMainDomain(win) {
  try {
    const url = win.webContents.getURL();
    const u = new URL(url);
    const parts = u.hostname.split(".");
    return parts.length >= 2 ? parts.slice(-2).join(".") : u.hostname;
  } catch (_) { return ""; }
}

// Xoá sạch cookie + storage của slot (fresh)
async function clearSlotStorage(win) {
  if (!win || win.isDestroyed()) return;
  const ses = win.webContents.session;
  try {
    await ses.clearStorageData({
      storages: ["cookies", "localstorage", "caches", "indexdb", "serviceworkers", "websql", "shadercache"],
    });
  } catch (err) {
    // fallback: xoá cookie thủ công
    try {
      const cookies = await ses.cookies.get({});
      for (const c of cookies) {
        const dom = (c.domain || "").replace(/^\./, "");
        const url = `${c.secure ? "https" : "http"}://${dom}${c.path || "/"}`;
        try { await ses.cookies.remove(url, c.name); } catch (_) {}
      }
    } catch (_) {}
  }
  try { await ses.cookies.flushStore(); } catch (_) {}
}

/**
 * Reset identity của 1 slot:
 *   1. burn identity hiện tại trong pool
 *   2. clear cookie/storage slot
 *   3. lấy identity sạch kế tiếp từ pool (auto-harvest nếu pool cạn)
 *   4. inject cookie + reload
 * reason: "captcha" | "manual" | ...
 */
async function resetSlotIdentity(slotId, reason = "manual") {
  const id = Number(slotId) || 1;
  if (slotResetting.has(id)) {
    return { ok: false, reason: "đang reset, bỏ qua trùng" };
  }
  const win = ensureWebWindow(id);
  if (!win) return { ok: false, reason: `slot ${id} chưa mở` };

  slotResetting.add(id);
  try {
    const domain = slotMainDomain(win);
    const curUrl = win.webContents.getURL();

    // 1. burn identity hiện tại
    const prev = slotIdentity.get(id);
    if (prev && prev.identityId && prev.domain) {
      try { chromePool.markBurned(prev.domain, prev.identityId); } catch (_) {}
    }

    sendToControl("slot:reset-start", { slotId: id, reason, domain });
    log(`[reset] slot ${id} reason=${reason} domain=${domain}`);

    // 2. clear
    await clearSlotStorage(win);

    // 2b. xoay IP: rút proxy kế tiếp từ pool (nếu bật) → đổi IP cho lần này
    if (proxyState.rotateOnReset && proxyState.pool.length) {
      const nextProxy = nextPoolProxy();
      if (nextProxy) {
        await applyProxyToSlot(id, nextProxy);
        const px = proxyState.slots.get(id);
        log(`[reset] slot ${id} xoay IP → ${px ? px.redacted : nextProxy}`);
      }
    }

    // 3. lấy identity sạch kế tiếp
    let next = domain ? chromePool.takeNextClean(domain, id) : null;

    // pool cạn → auto-harvest 1 bộ fresh nếu bật
    if (!next && domain && captchaConfig.autoHarvestOnEmpty && curUrl && /^https?:/i.test(curUrl)) {
      try {
        log(`[reset] pool cạn → auto-harvest từ Chrome riêng slot ${id}`);
        const slotPx = proxyState.slots.get(id);
        const h = await chromePool.harvestCookies({
          url: curUrl,
          slotId: id,
          waitMs: captchaConfig.harvestWaitMs,
          persistent: true,
          domainFilter: domain,
          proxy: slotPx ? (slotPx._raw || slotPx.server) : null,
        });
        if (h && h.cookies && h.cookies.length) {
          chromePool.addIdentity(domain, h.cookies, { source: "auto-harvest", harvestedFor: id });
          next = chromePool.takeNextClean(domain, id);
        }
      } catch (err) {
        log(`[reset] auto-harvest lỗi: ${err.message}`);
      }
    }

    // 4. inject + reload
    if (next && next.cookies && next.cookies.length) {
      await injectSessionToWindow(win, { cookies: next.cookies, localStorage: {}, sessionStorage: {} });
      try { await win.webContents.session.cookies.flushStore(); } catch (_) {}
      slotIdentity.set(id, { domain, identityId: next.id });
      log(`[reset] slot ${id} ← identity ${next.id} (${next.cookies.length} cookie)`);
    } else {
      slotIdentity.delete(id);
      log(`[reset] slot ${id} không có identity sạch → chạy fresh (no cookie)`);
    }

    // reload trang hiện tại
    if (curUrl && /^https?:/i.test(curUrl)) {
      try { await win.loadURL(curUrl); } catch (_) {}
    } else {
      try { win.webContents.reload(); } catch (_) {}
    }

    const status = domain ? chromePool.poolStatus(domain) : null;
    sendToControl("slot:reset-done", {
      slotId: id, reason, domain,
      identityId: next ? next.id : null,
      injected: next ? next.cookies.length : 0,
      pool: status,
    });
    return { ok: true, slotId: id, identityId: next ? next.id : null, pool: status };
  } catch (err) {
    log(`[reset] slot ${id} lỗi: ${err.message}`);
    return { ok: false, reason: err.message };
  } finally {
    slotResetting.delete(id);
  }
}

// Captcha phát hiện từ preload-web → tự reset nếu bật
ipcMain.on("web:captcha-detected", async (_event, data) => {
  const slotId = (data && data.slotId)
    || getSlotIdByWebContentsId(_event.sender && _event.sender.id) || 1;
  log(`[captcha] slot ${slotId} signal=${data && data.signal}`);
  // báo control để hiện cảnh báo
  sendToControl("slot:captcha", { slotId, signal: data && data.signal, url: data && data.url });
  if (captchaConfig.enabled && captchaConfig.autoReset) {
    await resetSlotIdentity(slotId, "captcha");
  }
});

// IPC: harvest cookie thủ công từ Chrome thật của slot → thêm vào pool
ipcMain.handle("chrome:harvest", async (_event, payload) => {
  try {
    const url = String((payload && payload.url) || "").trim();
    const slotId = Number(payload && payload.slotId) || 1;
    const slotPx = proxyState.slots.get(slotId);
    // url trống cũng OK: harvest sẽ tự lấy URL từ tab Chrome đang mở của slot
    const h = await chromePool.harvestCookies({
      url: url || undefined,
      slotId,
      waitMs: Number(payload && payload.waitMs) || captchaConfig.harvestWaitMs,
      persistent: payload && payload.persistent !== false,
      domainFilter: (payload && payload.domain) || "",
      headless: !!(payload && payload.headless),
      proxy: (payload && payload.proxy) || (slotPx ? (slotPx._raw || slotPx.server) : null),
    });
    if (!h || !h.cookies || !h.cookies.length) {
      return { ok: false, reason: "không lấy được cookie nào", domain: h && h.domain };
    }
    const entry = chromePool.addIdentity(h.domain, h.cookies, { source: "manual-harvest" });
    return { ok: true, domain: h.domain, identityId: entry.id, cookieCount: h.cookies.length, pool: chromePool.poolStatus(h.domain) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// IPC: mở Chrome thật riêng của slot (để đăng nhập tay rồi harvest)
ipcMain.handle("chrome:open", async (_event, payload) => {
  try {
    const slotId = Number(payload && payload.slotId) || 1;
    const url = payload && payload.url;
    const slotPx = proxyState.slots.get(slotId);
    const entry = await chromePool.openInChrome(slotId, url, {
      proxy: (payload && payload.proxy) || (slotPx ? (slotPx._raw || slotPx.server) : null),
    });
    return { ok: true, slotId, port: entry.port, profileDir: entry.profileDir };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// IPC: đóng Chrome riêng của slot
ipcMain.handle("chrome:close", async (_event, payload) => {
  try {
    const slotId = Number(payload && payload.slotId) || 1;
    chromePool.closeChrome(slotId);
    return { ok: true, slotId };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// IPC: trạng thái pool (1 domain hoặc tất cả)
ipcMain.handle("pool:status", async (_event, payload) => {
  try {
    const domain = (payload && payload.domain) || "";
    return { ok: true, status: chromePool.poolStatus(domain || undefined), chromePath: chromePool.findChromePath() };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// IPC: recycle used → clean (tái dùng identity chưa burn)
ipcMain.handle("pool:recycle", async (_event, payload) => {
  try {
    const domain = String((payload && payload.domain) || "").trim();
    if (!domain) return { ok: false, reason: "thiếu domain" };
    const n = chromePool.recycleUsed(domain);
    return { ok: true, recycled: n, pool: chromePool.poolStatus(domain) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// IPC: reset identity thủ công cho slot
ipcMain.handle("slot:reset-identity", async (_event, payload) => {
  const slotId = Number(payload && payload.slotId) || 1;
  return await resetSlotIdentity(slotId, (payload && payload.reason) || "manual");
});

// IPC: cấu hình captcha auto-reset (push xuống slot + lưu global)
ipcMain.handle("captcha:config", async (_event, payload) => {
  try {
    const cfg = payload || {};
    if (typeof cfg.enabled === "boolean") captchaConfig.enabled = cfg.enabled;
    if (typeof cfg.autoReset === "boolean") captchaConfig.autoReset = cfg.autoReset;
    if (typeof cfg.autoHarvestOnEmpty === "boolean") captchaConfig.autoHarvestOnEmpty = cfg.autoHarvestOnEmpty;
    if (Number.isFinite(cfg.cooldownMs)) captchaConfig.cooldownMs = cfg.cooldownMs;
    if (Number.isFinite(cfg.harvestWaitMs)) captchaConfig.harvestWaitMs = cfg.harvestWaitMs;

    // pattern tuỳ chỉnh (lưu lại để boot sau vẫn còn)
    if (Array.isArray(cfg.textPatterns)) captchaConfig.customTextPatterns = cfg.textPatterns.map(String);
    if (Array.isArray(cfg.srcPatterns)) captchaConfig.customSrcPatterns = cfg.srcPatterns.map(String);
    if (Array.isArray(cfg.urlPatterns)) captchaConfig.customUrlPatterns = cfg.urlPatterns.map(String);
    saveCaptchaConfig();

    const rendererCfg = buildRendererCaptchaCfg();
    const targets = (cfg.slotId != null)
      ? [Number(cfg.slotId)]
      : Array.from(webSlots.keys());
    for (const sid of targets) {
      const w = webSlots.get(sid);
      if (w && !w.isDestroyed()) {
        try { w.webContents.send("captcha:config", rendererCfg); } catch (_) {}
      }
    }
    return { ok: true, config: captchaConfig };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// IPC: đọc config captcha hiện tại
ipcMain.handle("captcha:get-config", async () => {
  return { ok: true, config: captchaConfig };
});

// ── Proxy IPC ────────────────────────────────────────────────────────────────

// Đặt proxy cho 1 slot (string rỗng/null = direct)
ipcMain.handle("proxy:set", async (_event, payload) => {
  try {
    const slotId = Number(payload && payload.slotId) || 1;
    const proxyStr = (payload && payload.proxy != null) ? String(payload.proxy).trim() : "";
    const px = await applyProxyToSlot(slotId, proxyStr || null);
    // reload slot để áp IP mới ngay
    const win = ensureWebWindow(slotId);
    if (win && payload && payload.reload) {
      const u = win.webContents.getURL();
      if (u && /^https?:/i.test(u)) { try { await win.loadURL(u); } catch (_) {} }
    }
    return { ok: true, slotId, proxy: px ? px.redacted : null };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// Lấy cấu hình proxy hiện tại (đã ẩn mật khẩu)
ipcMain.handle("proxy:get", async () => {
  const slots = {};
  for (const [id, px] of proxyState.slots) slots[id] = px.redacted;
  return {
    ok: true,
    slots,
    pool: (proxyState._poolRaw || []).map((s) => { const p = chromePool.parseProxy(s); return p ? p.redacted : s; }),
    rotateOnReset: proxyState.rotateOnReset,
  };
});

// Đặt danh sách proxy pool (xoay vòng khi reset) + bật/tắt rotate
ipcMain.handle("proxy:set-pool", async (_event, payload) => {
  try {
    const arr = Array.isArray(payload && payload.pool) ? payload.pool : [];
    proxyState._poolRaw = arr.map((s) => String(s).trim()).filter(Boolean);
    proxyState.pool = proxyState._poolRaw.map((s) => chromePool.parseProxy(s)).filter(Boolean);
    proxyState.poolIdx = 0;
    if (typeof (payload && payload.rotateOnReset) === "boolean") {
      proxyState.rotateOnReset = payload.rotateOnReset;
    }
    saveProxyConfig();
    return { ok: true, count: proxyState.pool.length, rotateOnReset: proxyState.rotateOnReset };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// Test 1 proxy: gọi qua session tạm tới dịch vụ echo IP
ipcMain.handle("proxy:test", async (_event, payload) => {
  const { session: electronSession, net } = require("electron");
  const proxyStr = String((payload && payload.proxy) || "").trim();
  const testUrl = (payload && payload.url) || "https://api.ipify.org?format=json";
  const px = proxyStr ? chromePool.parseProxy(proxyStr) : null;
  if (!px) return { ok: false, reason: "proxy không hợp lệ" };
  try {
    const testSes = electronSession.fromPartition(`proxy-test-${Date.now()}`);
    await testSes.setProxy({ mode: "fixed_servers", proxyRules: px.electronRules, proxyBypassRules: "<local>" });
    // auth cho session test
    const onLogin = (event, _wc, _d, authInfo, cb) => {
      if (authInfo && authInfo.isProxy && px.hasAuth) { event.preventDefault(); cb(px.username, px.password); }
    };
    app.on("login", onLogin);
    const result = await new Promise((resolve) => {
      const req = net.request({ url: testUrl, session: testSes });
      let body = "";
      const timer = setTimeout(() => { try { req.abort(); } catch (_) {} resolve({ ok: false, reason: "timeout" }); }, 12000);
      req.on("response", (res) => {
        res.on("data", (c) => { body += c.toString(); });
        res.on("end", () => { clearTimeout(timer); resolve({ ok: true, status: res.statusCode, body: body.slice(0, 200) }); });
      });
      req.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message }); });
      req.end();
    });
    app.removeListener("login", onLogin);
    try { await testSes.clearStorageData(); } catch (_) {}
    return { proxy: px.redacted, ...result };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// ─────────────────────────────────────────────────────────────
// Localhost control / debug endpoint
// ─────────────────────────────────────────────────────────────
// Loopback-only HTTP listener so external automation (developer
// terminal, video-engine integration tests) can drive the app
// without touching the control window UI:
//
//   GET  /status         — slot list, current URLs, control state
//   GET  /logs           — rolling buffer of main + renderer logs
//                          ?since=<unix-ms>&source=control|slot:N
//   POST /eval           — body: { target: "control"|"slot:N", code }
//                          run JS in that webContents, return result
//
// Binds to 127.0.0.1 only — no external exposure. If port 7331 is
// taken we log and skip rather than crash boot.
const CONTROL_PORT = 7331;
const MAX_LOG_LINES = 2000;
const logBuffer = [];

// Token bảo vệ control server: client ngoài phải gửi header x-control-token.
// Sinh ngẫu nhiên mỗi lần boot, ghi ra file userData để automation tin cậy đọc.
let CONTROL_TOKEN = null;
function ensureControlToken() {
  if (CONTROL_TOKEN) return CONTROL_TOKEN;
  try {
    const crypto = require("crypto");
    CONTROL_TOKEN = crypto.randomBytes(24).toString("hex");
  } catch (_) {
    CONTROL_TOKEN = "tok_" + process.pid + "_" + process.hrtime.bigint().toString(36);
  }
  try {
    const p = path.join(app.getPath("userData"), "control-token.txt");
    fs.writeFileSync(p, CONTROL_TOKEN, "utf8");
    console.log("[MAIN] control token ghi tại:", p);
  } catch (err) { console.warn("[MAIN] ghi control-token lỗi:", err && err.message); }
  return CONTROL_TOKEN;
}
function checkControlAuth(req) {
  const tok = req.headers["x-control-token"];
  return !!CONTROL_TOKEN && tok === CONTROL_TOKEN;
}

function _formatLogArg(a) {
  if (a == null) return String(a);
  if (typeof a === "string") return a;
  try { return JSON.stringify(a); } catch (_) { return String(a); }
}

function pushLog(source, level, message) {
  logBuffer.push({
    ts: new Date().toISOString(),
    source: String(source || "main"),
    level: String(level || "log"),
    message: String(message == null ? "" : message).slice(0, 4000)
  });
  while (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
}

// Mirror main-process console.* into the buffer. Keep originals
// firing so the terminal that started Electron still sees output.
(function patchMainConsole() {
  const orig = {
    log: console.log.bind(console),
    info: console.info ? console.info.bind(console) : console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug ? console.debug.bind(console) : console.log.bind(console)
  };
  for (const lvl of Object.keys(orig)) {
    console[lvl] = (...args) => {
      try { pushLog("main", lvl, args.map(_formatLogArg).join(" ")); } catch (_) {}
      orig[lvl](...args);
    };
  }
})();

function attachConsoleCapture(webContents, source) {
  if (!webContents) return;
  const LEVELS = ["debug", "log", "warn", "error"];
  webContents.on("console-message", (_event, level, message /*, line, sourceId */) => {
    pushLog(source, LEVELS[level] || "log", message);
  });
}

async function evalInControl(code) {
  if (!controlWin || controlWin.isDestroyed()) {
    return { ok: false, reason: "control window not available" };
  }
  try {
    const result = await controlWin.webContents.executeJavaScript(code, true);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : "eval error" };
  }
}

async function evalInSlot(slotId, code) {
  const win = ensureWebWindow(slotId);
  if (!win) return { ok: false, reason: `slot ${slotId} not open` };
  try {
    const result = await win.webContents.executeJavaScript(code, true);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : "eval error" };
  }
}

function _readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        // 2 MB cap — eval payloads are tiny; bigger probably means abuse
        req.destroy();
        resolve({});
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (_) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function startControlServer() {
  ensureControlToken();
  const http = require("http");
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => {
      // KHÔNG đặt Access-Control-Allow-Origin: '*' nữa.
      // Không gửi ACAO + yêu cầu header x-control-token → preflight của web ngoài
      // sẽ fail, chặn được CSRF/RCE từ trang web bất kỳ mà user mở trong browser.
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Vary": "Origin",
      });
      res.end(JSON.stringify(body));
    };

    if (req.method === "OPTIONS") {
      // Không cho phép cross-origin preflight (không reflect Origin / không allow header).
      return json(204, {});
    }

    // Mọi endpoint đều yêu cầu token (trừ OPTIONS đã xử lý ở trên).
    if (!checkControlAuth(req)) {
      return json(401, { ok: false, reason: "unauthorized: thiếu/sai x-control-token" });
    }

    try {
      const url = new URL(req.url, `http://127.0.0.1:${CONTROL_PORT}`);

      if (req.method === "GET" && url.pathname === "/status") {
        const slots = [];
        for (const [id, win] of webSlots) {
          if (!win.isDestroyed()) {
            slots.push({
              slotId: id,
              url: win.webContents.getURL(),
              title: win.webContents.getTitle()
            });
          }
        }
        return json(200, {
          ok: true,
          control:
            controlWin && !controlWin.isDestroyed()
              ? { url: controlWin.webContents.getURL() }
              : null,
          slots
        });
      }

      if (req.method === "GET" && url.pathname === "/logs") {
        const since = parseInt(url.searchParams.get("since") || "0", 10);
        const sourceFilter = url.searchParams.get("source") || "";
        const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), MAX_LOG_LINES);
        let sliced = since > 0
          ? logBuffer.filter((l) => new Date(l.ts).getTime() > since)
          : logBuffer.slice(-limit);
        if (sourceFilter) {
          sliced = sliced.filter((l) => l.source.includes(sourceFilter));
        }
        return json(200, { ok: true, logs: sliced, total: logBuffer.length });
      }

      if (req.method === "POST" && url.pathname === "/eval") {
        const body = await _readJsonBody(req);
        const target = String(body.target || "control");
        const code = String(body.code || "");
        if (!code) return json(400, { ok: false, reason: "missing code" });
        const result = target.startsWith("slot:")
          ? await evalInSlot(Number(target.slice(5)), code)
          : await evalInControl(code);
        return json(200, result);
      }

      return json(404, { ok: false, reason: `unknown endpoint ${url.pathname}` });
    } catch (err) {
      pushLog("main", "error", `control-server: ${err && err.message}`);
      return json(500, { ok: false, reason: err && err.message });
    }
  });

  server.on("error", (err) => {
    // EADDRINUSE just means a previous instance is still bound — log
    // and continue rather than killing Electron boot.
    pushLog("main", "warn", `control server bind failed: ${err.message}`);
    console.warn("[MAIN] control server bind failed:", err.message);
  });

  server.listen(CONTROL_PORT, "127.0.0.1", () => {
    console.log(`[MAIN] control server listening on 127.0.0.1:${CONTROL_PORT}`);
  });
}

app.whenReady().then(() => {
  // AppUserModelID giúp Windows nhận diện app trên taskbar
  try { app.setAppUserModelId("com.detectlab.camp"); } catch (_) {}
  // KHÔNG dùng Menu.setApplicationMenu(null) vì sẽ làm hỏng Ctrl+C/V/A trong input.
  // Thay vào đó ẩn thanh menu ở từng cửa sổ (vẫn giữ phím tắt edit).

  // Khởi tạo chrome-pool: thư mục lưu profile + cookie pool, logger chung
  try {
    chromePool.setLogger((...a) => log("[chrome-pool]", ...a));
    chromePool.init(app.getPath("userData"));
  } catch (err) {
    console.warn("[MAIN] chromePool.init error:", err && err.message);
  }

  // Captcha: nạp cấu hình + pattern custom đã lưu
  try { loadCaptchaConfig(); } catch (_) {}

  // Proxy: nạp cấu hình + đăng ký handler auth + áp cho từng slot
  try {
    registerProxyLogin();
    loadProxyConfig();
    for (const [id, px] of proxyState.slots) {
      applyProxyToSlot(id, px._raw || px.server);
    }
  } catch (err) {
    console.warn("[MAIN] proxy init error:", err && err.message);
  }

  createWindows();
  startControlServer();

  // Capture console output from every window that exists or gets
  // created later. webSlots map fills in via createWebWindowForSlot,
  // but at this point slot 1 is already up.
  if (controlWin && !controlWin.isDestroyed()) {
    attachConsoleCapture(controlWin.webContents, "control");
  }
  for (const [id, win] of webSlots) {
    if (!win.isDestroyed()) {
      attachConsoleCapture(win.webContents, `slot:${id}`);
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindows();
    } else {
      if (!ensureControlWindow()) createControlWindow();
      if (!ensureWebWindow(1)) createWebWindowForSlot(1);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Đảm bảo kill mọi Chrome riêng khi thoát app (tránh process mồ côi)
app.on("before-quit", () => {
  try { chromePool.closeAllChrome(); } catch (_) {}
});
app.on("will-quit", () => {
  try { chromePool.closeAllChrome(); } catch (_) {}
});
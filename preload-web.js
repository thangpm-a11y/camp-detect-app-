const { ipcRenderer } = require("electron");

// Load noti-inject.js vào main world ngay khi preload chạy
// contextIsolation=false + sandbox=false → preload chạy cùng world với trang
try {
  require(__dirname + "/noti-inject.js");
} catch(e) {
  console.warn("[WEB_PRELOAD] noti-inject load error:", e.message);
}

let NOTI_RULES = [];
let DETECTLAB_RUNNING = false;
let DETECTLAB_PAUSED = false;
let NOTI_OBSERVER = null;
let LAST_ACTIVE_ELEMENT = null;

// ── Noti 2-way IPC state ──────────────────────────────────────────────────
// Map: requestId → { dialog, matchedRule, timer }
const PENDING_NOTI = new Map();
// "auto-only" | "control-first" | "hybrid" (default)
let NOTI_MODE = "hybrid";
// ms chờ control trả lời trước khi fallback
const NOTI_REQUEST_TIMEOUT_MS = 8000;

// =========================================================
// helpers
// =========================================================

function sendResult(data) {
  try {
    ipcRenderer.send("web:result", data);
  } catch (err) {
    console.warn("[WEB] sendResult error:", err, data);
  }
}

function sendLog(message, extra = {}) {
  sendResult({
    type: "detectlab_log",
    message,
    ...extra
  });
}

function sendStatus(message, extra = {}) {
  sendResult({
    type: "detectlab_status",
    message,
    ...extra
  });
}

/**
 * Sửa selector bị vỡ do placeholder chứa dấu " không được escape.
 * Ví dụ: input[placeholder="e.g. "Chatbot Key""]  →  input[placeholder='e.g. "Chatbot Key"']
 */
function fixSelectorQuotes(sel) {
  if (!sel || typeof sel !== "string") return sel;
  try {
    // Kiểm tra selector có hợp lệ không – nếu hợp lệ giữ nguyên
    document.querySelector(sel);
    return sel;
  } catch (_) {
    // Cố gắng sửa: tìm [attr="..."..."]
    const fixed = sel.replace(
      /\[([\w-]+)="([^\]]+)"\]/g,
      (match, attr, val) => {
        // Val có thể chứa " thừa – dùng ngoặc đơn nếu không có '
        if (!val.includes("'")) {
          return `[${attr}='${val}']`;
        }
        return `[${attr}="${val.replace(/"/g, '\\"')}"]`;
      }
    );
    try {
      document.querySelector(fixed);
      console.log("[DetectLabWeb] fixSelectorQuotes:", sel, "→", fixed);
      return fixed;
    } catch (_2) {
      console.warn("[DetectLabWeb] fixSelectorQuotes failed:", sel);
      return sel; // trả về bản gốc, safeSelector sẽ catch
    }
  }
}

const MODAL_ANCESTOR_SELECTOR = '[role="dialog"], .n-modal, .n-dialog, .n-modal-body-wrapper';

function safeSelector(selector) {
  try {
    // 1) Try inside detected modal first
    const modal = getActiveModalRoot();
    if (modal) {
      const el = modal.querySelector(selector);
      console.log("[safeSelector] modal=", modal.className.slice(0,40), "| query:", selector, "→", el ? "FOUND" : "null");
      if (el) return el;
    } else {
      console.log("[safeSelector] no modal detected for selector:", selector);
    }

    // 2) Multiple matches in document — prefer whichever is inside a dialog/modal
    const all = document.querySelectorAll(selector);
    if (all.length > 1) {
      for (const el of all) {
        try {
          if (typeof el.closest === "function" && el.closest(MODAL_ANCESTOR_SELECTOR)) return el;
        } catch (_) {}
      }
    }

    return all[0] || null;
  } catch (err) {
    console.warn("[WEB] bad selector:", selector, err);
    return null;
  }
}

function safeSelectorAll(selector) {
  try {
    // 1) Try inside detected modal first
    const modal = getActiveModalRoot();
    if (modal) {
      const els = Array.from(modal.querySelectorAll(selector));
      if (els.length > 0) return els;
    }

    // 2) Filter document results to modal-scoped ones if any dialog is open
    const all = Array.from(document.querySelectorAll(selector));
    const inModal = all.filter(el => {
      try { return typeof el.closest === "function" && el.closest(MODAL_ANCESTOR_SELECTOR); } catch (_) { return false; }
    });
    return inModal.length > 0 ? inModal : all;
  } catch (err) {
    console.warn("[WEB] bad selectorAll:", selector, err);
    return [];
  }
}

function normalizeText(v) {
  return typeof v === "string" ? v.trim() : "";
}

function sleep(ms) {
  const delay = typeof ms === "number" && ms > 0 ? ms : 0;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// ── hook window.alert / window.confirm để auto handle theo NOTI_RULES ─────
function _matchNotiRuleForText(msg) {
  if (!Array.isArray(NOTI_RULES) || !NOTI_RULES.length) return null;
  const text = String(msg || "");
  const lower = text.toLowerCase();
  return (
    NOTI_RULES.find(
      r => r && r.pattern && lower.includes(String(r.pattern).toLowerCase())
    ) || null
  );
}

const _origAlert = window.alert ? window.alert.bind(window) : null;
const _origConfirm = window.confirm ? window.confirm.bind(window) : null;

if (_origAlert) {
  window.alert = function (msg) {
    const matched = _matchNotiRuleForText(msg);
    if (matched) {
      const choice = (matched.choice || "ok").toLowerCase();
      sendLog(
        `[AlertHook] Auto handled alert (${choice}) for pattern: "${matched.pattern}"`
      );
      return;
    }
    return _origAlert(msg);
  };
}

if (_origConfirm) {
  window.confirm = function (msg) {
    const matched = _matchNotiRuleForText(msg);
    if (matched) {
      const isCancel = (matched.choice || "ok").toLowerCase() === "cancel";
      const result = !isCancel;
      sendLog(
        `[AlertHook] Auto confirm(${result}) for pattern: "${matched.pattern}"`
      );
      return result;
    }
    return _origConfirm(msg);
  };
}

function showFakeCursor(x, y, color = "#facc15") {
  const dot = document.createElement("div");
  Object.assign(dot.style, {
    position: "fixed",
    left: x - 6 + "px",
    top: y - 6 + "px",
    width: "12px",
    height: "12px",
    borderRadius: "999px",
    border: `2px solid ${color}`,
    background: "rgba(250,204,21,0.15)",
    zIndex: "2147483647",
    pointerEvents: "none",
    transition: "opacity 0.2s ease-out"
  });
  document.body.appendChild(dot);

  setTimeout(() => {
    dot.style.opacity = "0";
    setTimeout(() => {
      try {
        dot.remove();
      } catch (_) {}
    }, 200);
  }, 500);
}

function dispatchPointerSequence(el, x, y) {
  if (!el) return;

  // Track click — safe với cả SVG elements (className là SVGAnimatedString)
  try {
    const tag = (el.tagName || "").toLowerCase();
    const cls = typeof el.className === "string" ? el.className.slice(0, 50) : (el.className && el.className.baseVal ? el.className.baseVal.slice(0, 50) : "");
    const nearInput = typeof el.closest === "function"
      ? el.closest(".n-input-number, .n-input-number-suffix, .n-input")
      : null;
    if (nearInput) {
      const inp = nearInput.querySelector("input");
      console.log("[clickTrack] clicking", tag, cls, "near input value:", inp ? inp.value : "?");
    }
  } catch (_) {}

  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    // pointerId phải nhất quán và hợp lệ trong suốt sequence
    // React dùng pointerId để track pointer capture — thiếu hoặc sai id gây releasePointerCapture crash
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    pressure: 0.5
  };

  try {
    el.dispatchEvent(new PointerEvent("pointerover", { ...opts, buttons: 0, pressure: 0 }));
    el.dispatchEvent(new PointerEvent("pointerenter", { ...opts, buttons: 0, pressure: 0 }));
    el.dispatchEvent(new PointerEvent("pointermove", { ...opts, buttons: 0, pressure: 0 }));
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0, pressure: 0 }));
  } catch (_) {}

  try {
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
  } catch (_) {}

  try {
    if (typeof el.focus === "function") {
      el.focus({ preventScroll: true });
    }
  } catch (_) {}
}

function dispatchHoverSequence(el, x, y) {
  if (!el) return;

  const opts = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 0,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    pressure: 0
  };

  try {
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new PointerEvent("pointerenter", opts));
    el.dispatchEvent(new PointerEvent("pointermove", opts));
  } catch (_) {}

  try {
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
  } catch (_) {}
}

function pickBestMatch(selector, x, y) {
  const list = safeSelectorAll(selector);
  if (!list.length) return null;

  if (list.length === 1 || typeof x !== "number" || typeof y !== "number") {
    return list[0];
  }

  let best = list[0];
  let bestDist = Infinity;

  list.forEach(cand => {
    const r = cand.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = cx - x;
    const dy = cy - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      best = cand;
    }
  });

  return best;
}

function getElementCenter(el) {
  const rect = el.getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
}

function isEditableElement(el) {
  if (!el) return false;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  if (tag === "textarea") return true;
  if (tag === "input") return true;
  if (el.isContentEditable) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Boolean-state readers for checkbox-like and custom switch widgets.
// Used by getTextBySelector to return "true"/"false" instead of innerText
// when the read selector lands inside one of these widgets.
// ─────────────────────────────────────────────────────────────────────────────

function isVisuallyVisible(el) {
  if (!el) return false;
  try {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const op = parseFloat(cs.opacity || "1");
    return !isNaN(op) && op > 0.01;
  } catch (_) { return false; }
}

function readCheckboxLikeState(el) {
  // Determine the bounding "checkbox tree" — prefer .n-checkbox ancestor,
  // fall back to .n-checkbox-box-wrapper or the element itself.
  const tree =
    (typeof el.closest === "function" && (
      el.closest(".n-checkbox") ||
      el.closest(".n-checkbox-box-wrapper") ||
      el.closest("[role='checkbox'], [role='switch'], [role='radio']")
    )) || el;

  // 1) Native input inside the tree (Naive sometimes renders one for a11y)
  const nativeInput = tree.querySelector && tree.querySelector('input[type="checkbox"], input[type="radio"]');
  if (nativeInput) return nativeInput.checked ? "true" : "false";

  // 2) aria-checked anywhere from el up to tree
  let cur = el;
  for (let i = 0; i < 6 && cur; i++) {
    if (cur.getAttribute) {
      const aria = cur.getAttribute("aria-checked");
      if (aria === "true") return "true";
      if (aria === "false") return "false";
    }
    if (cur === tree) break;
    cur = cur.parentElement;
  }

  // 3) Class signals: n-checkbox--checked, .checked, .is-checked, .is-active
  cur = el;
  for (let i = 0; i < 6 && cur; i++) {
    const cls = cur.classList;
    if (cls) {
      if (cls.contains("n-checkbox--checked")) return "true";
      if (cls.contains("is-checked") || cls.contains("is-active")) return "true";
      // Plain "checked" only counts on a checkbox-ish wrapper, otherwise too generic
      if (cls.contains("checked") && (cls.contains("n-checkbox") || cls.contains("n-checkbox-box"))) return "true";
    }
    if (cur === tree) break;
    cur = cur.parentElement;
  }

  // 4) Visual fallback: the .check-icon SVG is rendered visible only when ticked.
  //    Naive UI styles it with opacity:0 by default and opacity:1 under .n-checkbox--checked.
  const svg = tree.querySelector && tree.querySelector(".check-icon, .n-checkbox-icon svg");
  if (svg && isVisuallyVisible(svg)) return "true";

  return "false";
}

function readCustomSwitchActive(swEl) {
  const buttons = Array.from(swEl.querySelectorAll("button"));
  if (!buttons.length) return null;

  // Sliding pill: direct child div with `absolute` + a translate-x* class.
  let pill = null;
  for (const child of swEl.children) {
    if (child.tagName !== "DIV") continue;
    const cls = child.className || "";
    if (/(^|\s)absolute(\s|$)/.test(cls) && /translate-x/.test(cls)) {
      pill = child;
      break;
    }
  }

  let activeBtn = null;

  // Strategy A: bounding-rect overlap — the active button sits under the pill.
  if (pill) {
    try {
      const pillRect = pill.getBoundingClientRect();
      const pillCenter = pillRect.left + pillRect.width / 2;
      let minDist = Infinity;
      for (const btn of buttons) {
        const r = btn.getBoundingClientRect();
        const c = r.left + r.width / 2;
        const d = Math.abs(c - pillCenter);
        if (d < minDist) { minDist = d; activeBtn = btn; }
      }
    } catch (_) {}
  }

  // Strategy B: parse the translate-x class as a 0..N index over the buttons.
  if (!activeBtn && pill) {
    const cls = pill.className || "";
    if (/translate-x-0(\s|$)/.test(cls)) activeBtn = buttons[0];
    else if (/translate-x-(full|\[100%\])/.test(cls)) activeBtn = buttons[buttons.length - 1];
    else {
      const m = cls.match(/translate-x-(\d+)/);
      if (m) {
        const idx = parseInt(m[1], 10);
        if (idx >= 0 && idx < buttons.length) activeBtn = buttons[idx];
      }
    }
  }

  if (!activeBtn) return null;

  const text = (activeBtn.innerText || activeBtn.textContent || "").trim().toLowerCase();
  if (text === "on" || text === "yes" || text === "active" || text === "enabled" || text === "true") return "true";
  if (text === "off" || text === "no" || text === "inactive" || text === "disabled" || text === "false") return "false";
  return text; // unknown labels: return the literal button label
}

// Extract the value from a specific DOM element (checkbox/switch/input/text-aware).
// Used by both selector-only and payload-based read paths so they share behaviour.
function readElementValue(el) {
  if (!el) return "";

  const tag = el.tagName ? el.tagName.toLowerCase() : "";

  // Native checkbox / radio → return "true" / "false"
  if (tag === "input") {
    const inputType = (el.type || "").toLowerCase();
    if (inputType === "checkbox" || inputType === "radio") {
      return el.checked ? "true" : "false";
    }
  }

  // ARIA checkbox / switch / radio
  if (typeof el.getAttribute === "function") {
    const role = el.getAttribute("role");
    if (role === "checkbox" || role === "switch" || role === "radio") {
      const aria = el.getAttribute("aria-checked");
      if (aria === "true" || aria === "false") return aria;
      const cls = el.classList;
      if (cls && (cls.contains("checked") || cls.contains("is-checked") || cls.contains("n-checkbox--checked"))) {
        return "true";
      }
      return "false";
    }
  }

  // Custom switch (.custom-switch-dark-mode with sliding pill + Off/On buttons)
  if (typeof el.closest === "function") {
    const swEl = (el.matches && el.matches(".custom-switch-dark-mode"))
      ? el
      : el.closest(".custom-switch-dark-mode");
    if (swEl) {
      const swResult = readCustomSwitchActive(swEl);
      if (swResult !== null) return swResult;
    }
  }

  // Checkbox-like: any element inside an .n-checkbox / .n-checkbox-box-wrapper tree
  if (typeof el.closest === "function") {
    const cbEl = el.closest(".n-checkbox, .n-checkbox-box-wrapper");
    if (cbEl) return readCheckboxLikeState(el);
  }

  if (tag === "input" || tag === "textarea") {
    const cls = typeof el.className === "string" ? el.className : "";

    // Naive UI single-select: input.n-base-selection-input always has value=""
    // Real displayed value is in the parent .n-base-selection-label as visible text
    if (cls.includes("n-base-selection-input") && !cls.includes("n-base-selection-input-tag")) {
      const label = typeof el.closest === "function"
        ? el.closest(".n-base-selection-label, .n-base-selection")
        : null;
      if (label) return normalizeText(label.innerText || "");
    }

    return normalizeText(el.value || "");
  }

  return normalizeText(el.innerText || el.textContent || "");
}

// True when payload carries enough hints to narrow via findElementForStep
// (label/element text or recorded x/y coords from the click-selector picker).
function payloadHasNarrowingHints(payload) {
  if (!payload) return false;
  if (payload.labelText) return true;
  if (payload.elementText) return true;
  if (typeof payload.x === "number" && typeof payload.y === "number") return true;
  if (payload.containerTag || payload.containerClassName) return true;
  return false;
}

function getTextBySelector(selector) {
  const modal = getActiveModalRoot();

  // Empty selector: read modal text only when popup is open — never the whole page
  if (!selector) {
    if (modal) return normalizeText(modal.innerText || modal.textContent || "");
    return "";
  }

  // Khi có popup mở, ưu tiên tìm trong popup. Nhưng nếu KHÔNG thấy trong popup,
  // fallback về document (selector cụ thể như input[placeholder="Name"] vẫn an toàn,
  // chỉ tránh fallback khi selector quá rộng kiểu body/html).
  let el = modal ? modal.querySelector(selector) : safeSelector(selector);
  if (!el && modal) {
    const broad = /^(body|html|\*)$/i.test(String(selector).trim());
    if (!broad) el = safeSelector(selector);
  }
  return readElementValue(el);
}

// Payload-aware text read. When the step has labelText / elementText / x,y,
// route through findElementForStep so a wide selector (recorded by clickselector)
// narrows down to the specific picked field — same logic as click/hover.
function getTextByPayload(payload) {
  if (!payload) return "";
  if (!payloadHasNarrowingHints(payload)) {
    return getTextBySelector(payload.selector || "");
  }
  const el = findElementForStep(payload);
  if (!el) return "";
  return readElementValue(el);
}

function getHtmlBySelector(selector) {
  const modal = getActiveModalRoot();
  if (!selector) {
    if (modal) return modal.innerHTML || "";
    return "";
  }
  const el = modal ? modal.querySelector(selector) : safeSelector(selector);
  if (!el) return "";
  return el.innerHTML || "";
}

function getHtmlByPayload(payload) {
  if (!payload) return "";
  if (!payloadHasNarrowingHints(payload)) {
    return getHtmlBySelector(payload.selector || "");
  }
  const el = findElementForStep(payload);
  if (!el) return "";
  return el.innerHTML || "";
}

function ensureInView(el, behavior = "smooth", block = "center", inline = "center") {
  if (!el || typeof el.scrollIntoView !== "function") return;
  // Modal elements are already visible (fixed/absolute overlay) — scrolling the page causes misalignment
  if (isInsideActiveModal(el)) return;
  try {
    el.scrollIntoView({ behavior, block, inline });
  } catch (_) {
    try {
      el.scrollIntoView();
    } catch (_) {}
  }
}

function fireInputEvents(el) {
  if (!el) return;
  // keydown/keypress/keyup – React cần để update synthetic state
  try { el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true })); } catch (_) {}
  try { el.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true })); } catch (_) {}
  // input event – quan trọng nhất với React controlled input
  try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
  try { el.dispatchEvent(new Event("change", { bubbles: true })); } catch (_) {}
  try { el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true })); } catch (_) {}
  // focus/blur – trigger validation
  try { if (typeof el.focus === "function") el.focus({ preventScroll: true }); } catch (_) {}
  try { if (typeof el.blur === "function") el.blur(); } catch (_) {}
  try { if (typeof el.focus === "function") el.focus({ preventScroll: true }); } catch (_) {}
}

// Async version — đợi React flush 2 animation frames trước khi return
// Dùng cho input → click sequence để React có đủ thời gian commit state
async function fireInputEventsAsync(el) {
  if (!el) return;
  fireInputEvents(el);
  await new Promise(resolve =>
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        Promise.resolve().then(resolve)
      )
    )
  );
}

function setNativeValue(element, value) {
if (!element) return false;
const tag = element.tagName ? element.tagName.toLowerCase() : "";

if (tag === "input" || tag === "textarea") {
const proto = tag === "textarea"
? window.HTMLTextAreaElement.prototype
: window.HTMLInputElement.prototype;

const desc = Object.getOwnPropertyDescriptor(proto, "value");
if (desc && typeof desc.set === "function") {
desc.set.call(element, value);
} else {
element.value = value;
}
fireInputEvents(element);

// Blur + focus để trigger React validation/onChange handler
try { element.blur(); } catch (_) {}
try { element.focus({ preventScroll: true }); } catch (_) {}

return true;
}

if (element.isContentEditable) {
  element.focus();
  if (value === "" || value == null) {
    // Xóa sạch: selectAll + delete, fallback clear trực tiếp
    try { document.execCommand("selectAll", false, null); } catch (_) {}
    try { document.execCommand("delete", false, null); } catch (_) {}
    // Fallback cứng nếu execCommand không xóa được
    if ((element.textContent || "").trim() !== "") {
      element.textContent = "";
      try { element.innerHTML = ""; } catch (_) {}
    }
  } else {
    try { document.execCommand("selectAll", false, null); } catch (_) {}
    try {
      document.execCommand("insertText", false, value);
    } catch (_) {
      element.textContent = value;
    }
  }
  fireInputEvents(element);
  return true;
}

return false;
}

// Async version — đợi React flush state sau khi set value
async function setNativeValueAsync(element, value) {
  const ok = setNativeValue(element, value);
  if (ok) {
    await new Promise(resolve =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          Promise.resolve().then(resolve)
        )
      )
    );
  }
  return ok;
}

function isFileInput(el) {
if (!el || !el.tagName) return false;
return el.tagName.toLowerCase() === "input" && String(el.type || "").toLowerCase() === "file";
}

function findFileInputForStep(payload) {
  // 0) ưu tiên đúng input PubPower giống extension Chrome
  const pubPowerExact = document.querySelector(
    'input.n-upload-file-input[type="file"][data-url-uploader-ext="input_755194313804430"]'
  );
  if (isFileInput(pubPowerExact)) return pubPowerExact;

  const pubPowerAny = document.querySelector(
    'input.n-upload-file-input[type="file"]'
  );
  if (isFileInput(pubPowerAny)) return pubPowerAny;

  // 1) dùng thuật toán cũ theo findElementForStep + selector
  const direct = findElementForStep(payload);
  if (isFileInput(direct)) return direct;

  const selector =
    payload && payload.selector ? String(payload.selector) : "";
  if (selector) {
    const bySelector = safeSelector(selector);
    if (isFileInput(bySelector)) return bySelector;

    if (bySelector && typeof bySelector.querySelector === "function") {
      const nested = bySelector.querySelector('input[type="file"]');
      if (isFileInput(nested)) return nested;
    }

    if (bySelector && bySelector.parentElement) {
      const parentNested = bySelector.parentElement.querySelector(
        'input[type="file"]'
      );
      if (isFileInput(parentNested)) return parentNested;
    }

    if (bySelector && typeof bySelector.closest === "function") {
      const uploadRoot =
        bySelector.closest(".n-upload") ||
        bySelector.closest(".upload") ||
        bySelector.closest("[data-upload]") ||
        bySelector.closest('[role="button"]');

      if (uploadRoot && typeof uploadRoot.querySelector === "function") {
        const nearInput = uploadRoot.querySelector('input[type="file"]');
        if (isFileInput(nearInput)) return nearInput;
      }
    }
  }

  // 2) fallback cuối cùng: bất kỳ input[type=file] nào trên trang
  const allInputs = safeSelectorAll('input[type="file"]');
  if (allInputs.length === 1) return allInputs[0];

  return allInputs[0] || null;
}

async function buildBrowserFiles(filePayloads) {
const safeFiles = Array.isArray(filePayloads) ? filePayloads.filter(Boolean) : [];
if (!safeFiles.length) return [];

const readRes = await ipcRenderer.invoke("media:read-files", { files: safeFiles });
if (!readRes || !readRes.ok || !Array.isArray(readRes.files)) {
throw new Error((readRes && readRes.reason) || "read files failed");
}

const out = [];
for (const item of readRes.files) {
if (!item || !item.ok || !item.bufferBase64) continue;
const binary = atob(String(item.bufferBase64));
const bytes = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) {
bytes[i] = binary.charCodeAt(i);
}
const file = new File(
[bytes],
String(item.name || "upload-file"),
{ type: String(item.type || "") }
);
out.push(file);
}
return out;
}

// handleUploadFiles (v1 DataTransfer) đã được thay bằng v2 dùng CDP web:set-file-input-files ở dưới

function pressKeyOnElement(el, key) {
  if (!el) el = document.activeElement || document.body;
  if (!el) return;

  const opts = {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    composed: true
  };

  try {
    el.dispatchEvent(new KeyboardEvent("keydown", opts));
  } catch (_) {}
  try {
    el.dispatchEvent(new KeyboardEvent("keypress", opts));
  } catch (_) {}
  try {
    el.dispatchEvent(new KeyboardEvent("keyup", opts));
  } catch (_) {}

  if (key === "Enter") {
    try {
      if (typeof el.click === "function" && !isEditableElement(el)) {
        el.click();
      }
    } catch (_) {}
  }
}

function closestTextFromNode(node) {
  if (!node) return "";
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeText(node.textContent || "");
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    return normalizeText(node.innerText || node.textContent || "");
  }
  return "";
}

// =========================================================
// notification auto handling
// =========================================================

function looksLikeDialog(el) {
  if (!el || el.nodeType !== 1) return false;

  const role = (el.getAttribute("role") || "").toLowerCase();
  const ariaModal = (el.getAttribute("aria-modal") || "").toLowerCase();
  const cls = (el.className || "").toString().toLowerCase();

  if (role === "dialog" || role === "alertdialog") return true;
  if (ariaModal === "true") return true;
  if (cls.includes("modal") || cls.includes("dialog") || cls.includes("popup")) return true;

  return false;
}

function getDialogCandidates() {
  const candidates = [];

  const roleNodes = [
    ...document.querySelectorAll('[role="dialog"]'),
    ...document.querySelectorAll('[role="alertdialog"]'),
    ...document.querySelectorAll('[aria-modal="true"]')
  ];

  roleNodes.forEach(n => candidates.push(n));

  const broad = document.querySelectorAll("div,section,aside");
  broad.forEach(el => {
    if (looksLikeDialog(el)) candidates.push(el);
  });

  return Array.from(new Set(candidates));
}

function scoreButtonForChoice(button, choice) {
  const txt = normalizeText(
    (button.innerText || button.textContent || button.value || "").toLowerCase()
  );

  if (!txt) return -1;

  const okWords = [
    "ok", "okay", "yes", "continue", "confirm", "allow", "accept",
    "submit", "done", "agree", "save", "proceed"
  ];

  const cancelWords = [
    "cancel", "close", "no", "dismiss", "deny", "reject", "back"
  ];

  const words = choice === "cancel" ? cancelWords : okWords;
  let score = 0;

  words.forEach(w => {
    if (txt === w) score += 10;
    else if (txt.includes(w)) score += 5;
  });

  if (button.matches('[type="submit"]') && choice === "ok") score += 2;
  if (button.matches('[aria-label*="close" i]') && choice === "cancel") score += 4;

  return score;
}

function findBestActionButton(container, choice) {
  if (!container) return null;

  const candidates = [
    ...container.querySelectorAll('button'),
    ...container.querySelectorAll('input[type="button"]'),
    ...container.querySelectorAll('input[type="submit"]'),
    ...container.querySelectorAll('[role="button"]')
  ];

  if (!candidates.length) return null;

  let best = null;
  let bestScore = -1;

  candidates.forEach(btn => {
    const score = scoreButtonForChoice(btn, choice);
    if (score > bestScore) {
      bestScore = score;
      best = btn;
    }
  });

  return bestScore >= 0 ? best : null;
}

// ── auto click (hành vi cũ) ───────────────────────────────────────────
function _autoClickDialog(dialog, matchedRule) {
  const targetBtn = findBestActionButton(dialog, matchedRule.choice || "ok");
  if (!targetBtn) return;
  const { x, y } = getElementCenter(targetBtn);
  showFakeCursor(x, y, matchedRule.choice === "cancel" ? "#f97373" : "#22c55e");
  dispatchPointerSequence(targetBtn, x, y);
  sendLog(`[NotiAuto] Handled: "${matchedRule.pattern}" → ${matchedRule.choice || "ok"}`);
}

// ── gửi noti:request lên control + set timeout fallback ──────────────
function _sendNotiRequest(dialog, dialogText, matchedRule) {
  // Tránh spam: nếu dialog này đang pending rồi thì bỏ qua
  if (dialog._dlNotiPending) return;
  dialog._dlNotiPending = true;

  const requestId = "noti-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7);

  // Tập hợp danh sách nút trong dialog để hiển thị cho control
  const buttons = [
    ...dialog.querySelectorAll("button"),
    ...dialog.querySelectorAll('[role="button"]'),
    ...dialog.querySelectorAll('input[type="button"]'),
    ...dialog.querySelectorAll('input[type="submit"]')
  ];
  const availableActions = buttons
    .map(b => normalizeText(b.innerText || b.textContent || b.value || ""))
    .filter(Boolean)
    .slice(0, 6);

  // Gửi lên control qua kênh web:result hiện có (main.js tự enrich slotId)
  sendResult({
    type: "noti:request",
    requestId,
    dialogText: dialogText.slice(0, 300),
    matchedRule: matchedRule || null,
    availableActions,
    source: "dialog-observer",
    ts: Date.now()
  });

  // Timeout fallback
  const timer = setTimeout(() => {
    PENDING_NOTI.delete(requestId);
    dialog._dlNotiPending = false;
    sendResult({ type: "noti:timeout", requestId });
    if (matchedRule) {
      sendLog(`[NotiTimeout] Fallback auto for ${requestId}`);
      _autoClickDialog(dialog, matchedRule);
    } else {
      sendLog(`[NotiTimeout] No rule, ignored ${requestId}`);
    }
  }, NOTI_REQUEST_TIMEOUT_MS);

  PENDING_NOTI.set(requestId, { dialog, matchedRule, timer });
  sendLog(`[NotiRequest] Sent ${requestId}`);
}

// ── tryHandleNotifications: route theo mode ─────────────────────────
function tryHandleNotifications() {
  if (!Array.isArray(NOTI_RULES)) return false;

  const dialogs = getDialogCandidates();
  if (!dialogs.length) return false;

  let handled = false;

  dialogs.forEach(dialog => {
    const text = normalizeText((dialog.innerText || dialog.textContent || "").toLowerCase());
    if (!text) return;

    const matchedRule = NOTI_RULES.length
      ? NOTI_RULES.find(rule => rule && rule.pattern && text.includes(String(rule.pattern).toLowerCase()))
      : null;

    if (NOTI_MODE === "auto-only") {
      if (!matchedRule) return;
      _autoClickDialog(dialog, matchedRule);
    } else if (NOTI_MODE === "control-first") {
      // Luôn gửi lên control dù có match hay không
      _sendNotiRequest(dialog, text, matchedRule);
    } else {
      // hybrid (default): có rule → auto; không có → hỏi control
      if (matchedRule) {
        _autoClickDialog(dialog, matchedRule);
      } else {
        _sendNotiRequest(dialog, text, null);
      }
    }
    handled = true;
  });

  return handled;
}

// ── xử lý noti:resolve từ control ──────────────────────────────────
async function handleNotiResolve(payload) {
  const { requestId, decision } = payload || {};
  if (!requestId) return;

  const pending = PENDING_NOTI.get(requestId);
  if (!pending) {
    sendResult({ type: "noti:resolved", requestId, ok: false, reason: "requestId not found" });
    return;
  }

  const { dialog, matchedRule, timer } = pending;
  clearTimeout(timer);
  PENDING_NOTI.delete(requestId);
  if (dialog) dialog._dlNotiPending = false;

  if (decision === "ignore") {
    sendResult({ type: "noti:resolved", requestId, decision, ok: true, reason: "ignored" });
    return;
  }

  if (!dialog || !document.contains(dialog)) {
    sendResult({ type: "noti:resolved", requestId, decision, ok: false, reason: "dialog gone" });
    return;
  }

  const choice = decision === "cancel" ? "cancel" : "ok";
  const targetBtn = findBestActionButton(dialog, choice);
  if (!targetBtn) {
    sendResult({ type: "noti:resolved", requestId, decision, ok: false, reason: "button not found" });
    return;
  }

  const { x, y } = getElementCenter(targetBtn);
  showFakeCursor(x, y, choice === "cancel" ? "#f97373" : "#22c55e");
  dispatchPointerSequence(targetBtn, x, y);

  sendResult({ type: "noti:resolved", requestId, decision, ok: true });
  sendLog(`[NotiResolved] ${requestId} → ${decision}`);
}

function ensureNotiObserver() {
  if (NOTI_OBSERVER) return;

  NOTI_OBSERVER = new MutationObserver(() => {
    tryHandleNotifications();
  });

  try {
    NOTI_OBSERVER.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      attributes: false
    });
  } catch (err) {
    console.warn("[WEB] MutationObserver error:", err);
  }
}

// =========================================================
// findElementForStep – position-first matching algorithm
// =========================================================

/**
 * Tìm element dựa trên 3 điều kiện BẬ BUỘC kết hợp:
 *   1. tagName phải khớp
 *   2. elementText phải khớp (exact hoặc contains)
 *   3. element.matches(selector) phải đúng
 *
 * Vị trí x,y (document coords) làm điểm khởi đầu tìm kiếm:
 *   - Tự scroll đến vùng x,y trước
 *   - Lấy tất cả element trong bán kính R quanh x,y
 *   - Lọc theo 3 điều kiện bắt buộc
 *   - Nếu nhiều kết quả → pick gần x,y nhất
 *   - Nếu 0 kết quả → nới bán kính → thử lại 1 lần
 *
 * @param {object} payload
 * @param {string} [payload.selector]
 * @param {string} [payload.elementText]
 * @param {string} [payload.labelText]  (dự phòng, không bắt buộc)
 * @param {number} [payload.x]          document x
 * @param {number} [payload.y]          document y
 * @returns {Element|null}
 */
/**
 * Lấy tất cả element nằm trong bán kính R (px) quanh điểm (cx, cy) trong viewport.
 * cx, cy là viewport coords (sau khi đã scroll).
 */
function getElementsInRadius(cx, cy, radius) {
  const all = Array.from(document.querySelectorAll("*"));
  return all.filter(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    // Tâm của element
    const ex = r.left + r.width / 2;
    const ey = r.top + r.height / 2;
    return Math.sqrt((ex - cx) ** 2 + (ey - cy) ** 2) <= radius;
  });
}

function getActiveModalRoot() {
  // Strategy 1: Naive UI modal mask always wraps the modal when open
  const mask = document.querySelector('.n-modal-mask');
  if (mask) {
    const inner = mask.querySelector('[role="dialog"], .n-card.n-modal, .n-modal, .n-dialog');
    if (inner) {
      try {
        const r = inner.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          console.log("[getActiveModalRoot] found via mask:", inner.className.slice(0,50));
          return inner;
        }
      } catch (_) {}
    }
  }

  // Strategy 2: Any visible [role="dialog"] or .n-modal
  const selectors = [
    '[role="dialog"][aria-modal="true"]',
    '.n-modal[role="dialog"]',
    '.n-modal',
    '.n-dialog',
    '.n-modal-body-wrapper'
  ];
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    for (const el of els) {
      try {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          console.log("[getActiveModalRoot] found via selector", sel, ":", el.className.slice(0,50));
          return el;
        }
      } catch (_) {}
    }
  }

  console.log("[getActiveModalRoot] no modal found");
  return null;
}

function isInsideActiveModal(el) {
  if (!el) return false;
  const modal = getActiveModalRoot();
  if (!modal) return false;
  try { return modal === el || modal.contains(el); } catch (_) { return false; }
}

function findElementForStep(payload) {
  const {
    selector,
    labelText,
    elementText,
    containerTag,
    containerClassName,
    x,
    y
  } = payload || {};

  const fixedSelector = selector ? fixSelectorQuotes(selector) : null;
  const hasPosition = typeof x === "number" && typeof y === "number";

  // Khi có modal đang mở → restrict search vào modal, bỏ radius (transform làm lệch tọa độ)
  const modalRoot = getActiveModalRoot();

  // ── Bước 1: Scroll đến vùng x,y (document coords) — chỉ khi không có modal ──
  if (hasPosition && !modalRoot) {
    const scrollX = x - window.innerWidth / 2;
    const scrollY = y - window.innerHeight / 2;
    window.scrollTo({
      left: Math.max(0, scrollX),
      top: Math.max(0, scrollY),
      behavior: "instant"
    });
  }

  /**
   * Hàm lõi: tìm trong bán kính `radius`.
   * Ba điều kiện BẶT BUỘC (nếu field đó có dữ liệu):
   *   • tagName khớp (từ selector hoặc containerTag)
   *   • elementText khớp (exact hoặc contains)
   *   • element.matches(fixedSelector)
   */
  function searchInRadius(radius) {
    // viewport coords của điểm mục tiêu (sau khi đã scroll)
    const vpX = hasPosition ? x - window.scrollX : window.innerWidth / 2;
    const vpY = hasPosition ? y - window.scrollY : window.innerHeight / 2;

    // Khi modal đang mở: chỉ search trong modal, bỏ radius
    const pool = modalRoot
      ? Array.from(modalRoot.querySelectorAll("*"))
      : hasPosition
        ? getElementsInRadius(vpX, vpY, radius)
        : Array.from(document.querySelectorAll("*"));

    let results = pool;

    // Điều kiện 1: selector match (element.matches)
    if (fixedSelector) {
      results = results.filter(el => {
        try { return el.matches(fixedSelector); } catch (_) { return false; }
      });
    }

    // Điều kiện 2: elementText khớp
    if (elementText) {
      const eText = String(elementText).trim();
      const eLower = eText.toLowerCase();
      results = results.filter(el => {
        const t = (el.innerText || el.value || el.textContent || "").trim();
        return t === eText || t.toLowerCase() === eLower || t.toLowerCase().includes(eLower);
      });
    }

    // Điều kiện 2b: labelText — dùng khi elementText không có hoặc results vẫn còn nhiều
    // Tìm element có label gần nhất khớp labelText
    if (labelText && !elementText) {
      const lText = String(labelText).trim().toLowerCase();
      const withLabel = results.filter(el => {
        // Tìm label[for=id]
        if (el.id) {
          try {
            const lbl = document.querySelector(`label[for="${el.id}"]`);
            if (lbl && (lbl.innerText || lbl.textContent || "").trim().toLowerCase().includes(lText)) return true;
          } catch (_) {}
        }
        // Tìm label cha
        try {
          const parentLabel = typeof el.closest === "function" ? el.closest("label") : null;
          if (parentLabel && (parentLabel.innerText || parentLabel.textContent || "").trim().toLowerCase().includes(lText)) return true;
        } catch (_) {}
        // Tìm text gần trong parent
        try {
          let p = el.parentElement;
          let depth = 0;
          while (p && depth < 3) {
            const t = (p.innerText || p.textContent || "").trim().toLowerCase();
            if (t.includes(lText)) return true;
            p = p.parentElement;
            depth++;
          }
        } catch (_) {}
        return false;
      });
      if (withLabel.length > 0) results = withLabel;
    }

    // Điều kiện 3: tagName khớp (lấy từ containerTag nếu selector không rõ tag)
    if (containerTag && !fixedSelector) {
      const tag = String(containerTag).toLowerCase();
      results = results.filter(el => el.tagName.toLowerCase() === tag);
    }

    return { results, vpX, vpY };
  }

  // ── Bước 2: Tìm trong bán kính 120px ─────────────────────
  let { results, vpX, vpY } = searchInRadius(120);

  // ── Bước 3: Nếu 0 kết quả → nới bán kính lên 400px rồi thử lại ──
  if (results.length === 0) {
    console.log("[DetectLabWeb] radius 120 found 0, retrying with 400px");
    ({ results, vpX, vpY } = searchInRadius(400));
  }

  // ── Bước 4: Nếu vẫn 0 → fallback: tìm toàn trang không giới hạn vị trí ──
  if (results.length === 0) {
    console.log("[DetectLabWeb] radius 400 found 0, retrying full-page");
    ({ results, vpX, vpY } = searchInRadius(Infinity));
  }

  if (results.length === 0) {
    console.warn("[DetectLabWeb] findElementForStep: element not found for payload", payload);
    return null;
  }

  // ── Bước 5: Nếu nhiều kết quả → pick gần (x,y) nhất ────────────
  if (results.length === 1) {
    console.log("[DetectLabWeb] findElementForStep: found (exact 1)", results[0]);
    return results[0];
  }

  // Nhiều hơn 1: pick gần điểm mục tiêu nhất
  let best = results[0];
  let bestDist = Infinity;
  results.forEach(el => {
    const r = el.getBoundingClientRect();
    const ex = r.left + r.width / 2;
    const ey = r.top + r.height / 2;
    const d2 = (ex - vpX) ** 2 + (ey - vpY) ** 2;
    if (d2 < bestDist) { bestDist = d2; best = el; }
  });
  console.log("[DetectLabWeb] findElementForStep: found (" + results.length + " candidates, picked closest)", best);
  return best;
}

// =========================================================
// action handlers
// =========================================================

async function handleLogTitle() {
  console.log("[WEB] document.title =", document.title);
  sendLog("Title: " + document.title);
}

// ── Quick step builder overlay (Feature 2) ─────────────────────────
function dlBuildSelectorForElement(target) {
  const tag = target && target.tagName ? target.tagName.toLowerCase() : "div";
  try {
    if ((tag === "input" || tag === "textarea") && target.placeholder) {
      const ph = String(target.placeholder);
      return ph.includes('"') && !ph.includes("'")
        ? `${tag}[placeholder='${ph}']`
        : `${tag}[placeholder="${ph}"]`;
    }
    if (target.id) return `${tag}#${target.id}`;
    if (target.className && typeof target.className === "string") {
      const safe = target.className.split(/\s+/).filter(c => c && !c.includes(":")).slice(0, 2);
      const cp = safe.map(c => "." + c.replace(/[^a-zA-Z0-9_-]/g, "")).join("");
      return cp ? tag + cp : tag;
    }
  } catch (_) {}
  return tag;
}

// Các field hiển thị theo từng loại step (khớp với editor thật)
const DL_BUILDER_FIELDS = {
  click:        ["selector", "point", "clickMode", "delay"],
  cdpclick:     ["selector", "point", "clickMode", "delay"],
  hover:        ["selector", "clickMode", "delay"],
  clicknear:    ["selector", "clicknearDirection", "clicknearIndex", "delay"],
  pressarrow:   ["selector", "arrowDirection", "arrowCount", "arrowDelay", "delay"],
  scroll:       ["selector", "delay"],
  input:        ["selector", "column", "value", "delay"],
  read:         ["selector", "resultKey", "readMode", "matchText", "delay"],
  upload:       ["selector", "column", "delay"],
  download:     ["selector", "point", "column", "fileNameColumn", "delay"],
  delete:       ["selector", "delay"],
  open:         ["url", "column", "value", "delay"],
  opentab:      ["url", "column", "value", "delay"],
  keypress:     ["key", "delay"],
  wait:         ["delay"],
  end:          [],
  "save-session": ["sessionName", "delay"],
  "load-session": ["sessionName", "url", "delay"],
  condition:    ["resultKey", "op", "conditionValueColumn", "conditionValue", "conditionTrueMode", "conditionJumpTo", "delay"]
};

const DL_FIELD_LABELS = {
  selector: "Selector",
  point: "Điểm (x,y)",
  clickMode: "Click mode",
  column: "Column",
  fileNameColumn: "Name column",
  value: "Value",
  url: "URL",
  delay: "Delay (ms)",
  resultKey: "Result key (Var)",
  readMode: "Read mode",
  matchText: "Match text",
  clicknearDirection: "Hướng",
  clicknearIndex: "Index",
  arrowDirection: "Arrow",
  arrowCount: "Số lần",
  arrowDelay: "Arrow delay (ms)",
  key: "Key",
  sessionName: "Session name",
  op: "Operator",
  conditionValueColumn: "Value column",
  conditionValue: "Value (fixed)",
  conditionTrueMode: "If FALSE →",
  conditionJumpTo: "Jump to step #"
};

const DL_SELECT_OPTIONS = {
  clickMode: [["selector", "selector"], ["point", "point"]],
  readMode: [["text", "text"], ["html", "html"]],
  clicknearDirection: [["up", "up"], ["down", "down"], ["left", "left"], ["right", "right"]],
  arrowDirection: [["up", "↑ up"], ["down", "↓ down"], ["left", "← left"], ["right", "→ right"]]
};

let __dlBuilderActive = false;

function handleShowStepBuilder(payload) {
  const stepType = String((payload && payload.stepType) || "click").toLowerCase();
  const requestId = (payload && payload.requestId) || "";
  const old = document.getElementById("__dl_step_builder");
  if (old) old.remove();

  // Ack ngay để control biết slot đang mở & nhận lệnh
  try { ipcRenderer.send("web:result", { type: "stepBuilder", requestId, ack: true }); } catch (_) {}

  const fields = DL_BUILDER_FIELDS[stepType] || ["selector", "delay"];
  const values = { x: null, y: null };

  const panel = document.createElement("div");
  panel.id = "__dl_step_builder";
  Object.assign(panel.style, {
    position: "fixed", top: "12px", right: "12px", width: "300px",
    background: "rgba(2,6,23,0.97)", color: "#e5e7eb",
    border: "1px solid #3b82f6", borderRadius: "10px", padding: "10px",
    zIndex: "2147483647", fontFamily: "system-ui,sans-serif", fontSize: "12px",
    boxShadow: "0 8px 30px rgba(0,0,0,0.55)"
  });

  const h = document.createElement("div");
  h.textContent = "➕ Step mới: " + stepType.toUpperCase();
  Object.assign(h.style, { fontWeight: "700", marginBottom: "2px", fontSize: "13px", color: "#60a5fa" });
  panel.appendChild(h);

  const hint = document.createElement("div");
  hint.textContent = "S: selector · P: point · Ctrl+S: lưu · Esc: hủy";
  Object.assign(hint.style, { fontSize: "10px", color: "#94a3b8", marginBottom: "8px" });
  panel.appendChild(hint);

  const inputs = {};

  function addLabeledControl(key, ctrl) {
    const wrap = document.createElement("div");
    wrap.style.marginBottom = "6px";
    const lb = document.createElement("div");
    lb.textContent = DL_FIELD_LABELS[key] || key;
    Object.assign(lb.style, { fontSize: "10px", color: "#94a3b8", marginBottom: "2px" });
    wrap.appendChild(lb);
    wrap.appendChild(ctrl);
    panel.appendChild(wrap);
  }

  function mkInput(key, ph) {
    const inp = document.createElement("input");
    inp.type = "text";
    inp.placeholder = ph || "";
    Object.assign(inp.style, {
      width: "100%", boxSizing: "border-box", padding: "4px 6px",
      borderRadius: "5px", border: "1px solid #374151",
      background: "#0b1220", color: "#e5e7eb", fontSize: "12px"
    });
    inputs[key] = inp;
    return inp;
  }

  fields.forEach(f => {
    if (f === "selector") {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "4px" });
      const inp = mkInput("selector", "CSS selector");
      const pickBtn = document.createElement("button");
      pickBtn.textContent = "🔵 Pick";
      Object.assign(pickBtn.style, { flexShrink: "0", padding: "4px 8px", borderRadius: "5px", border: "1px solid #2563eb", background: "#1d4ed8", color: "#fff", cursor: "pointer", fontSize: "11px" });
      pickBtn.onclick = () => startInlinePick("selector");
      row.appendChild(inp);
      row.appendChild(pickBtn);
      addLabeledControl("selector", row);
    } else if (f === "point") {
      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "4px", alignItems: "center" });
      const span = document.createElement("span");
      span.id = "__dl_point_label";
      span.textContent = "(chưa chọn)";
      Object.assign(span.style, { flex: "1", fontSize: "11px", color: "#cbd5e1" });
      const pickBtn = document.createElement("button");
      pickBtn.textContent = "🎯 Pick point";
      Object.assign(pickBtn.style, { flexShrink: "0", padding: "4px 8px", borderRadius: "5px", border: "1px solid #b45309", background: "#d97706", color: "#fff", cursor: "pointer", fontSize: "11px" });
      pickBtn.onclick = () => startInlinePick("point");
      row.appendChild(span);
      row.appendChild(pickBtn);
      addLabeledControl("point", row);
    } else if (f === "op") {
      const sel = document.createElement("select");
      Object.assign(sel.style, { width: "100%", padding: "4px", borderRadius: "5px", border: "1px solid #374151", background: "#0b1220", color: "#e5e7eb", fontSize: "12px" });
      [["", "(none)"], ["equal", "equal"], ["exact", "exact"], ["different", "different"], ["contain", "contain"], [">", ">"], ["<", "<"], [">=", "≥"], ["<=", "≤"]].forEach(([v, l]) => {
        const o = document.createElement("option"); o.value = v; o.textContent = l; sel.appendChild(o);
      });
      inputs.op = sel;
      addLabeledControl("op", sel);
    } else if (f === "conditionTrueMode") {
      const sel = document.createElement("select");
      Object.assign(sel.style, { width: "100%", padding: "4px", borderRadius: "5px", border: "1px solid #374151", background: "#0b1220", color: "#e5e7eb", fontSize: "12px" });
      [["stop", "Stop (when FALSE)"], ["jump", "Jump to step (when FALSE)"]].forEach(([v, l]) => {
        const o = document.createElement("option"); o.value = v; o.textContent = l; sel.appendChild(o);
      });
      inputs.conditionTrueMode = sel;
      addLabeledControl("conditionTrueMode", sel);
    } else if (DL_SELECT_OPTIONS[f]) {
      const sel = document.createElement("select");
      Object.assign(sel.style, { width: "100%", padding: "4px", borderRadius: "5px", border: "1px solid #374151", background: "#0b1220", color: "#e5e7eb", fontSize: "12px" });
      DL_SELECT_OPTIONS[f].forEach(([v, l]) => {
        const o = document.createElement("option"); o.value = v; o.textContent = l; sel.appendChild(o);
      });
      inputs[f] = sel;
      addLabeledControl(f, sel);
    } else if (f === "delay") {
      const inp = mkInput("delay", "300");
      inp.value = "300";
      addLabeledControl("delay", inp);
    } else {
      addLabeledControl(f, mkInput(f, ""));
    }
  });

  // Buttons
  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, { display: "flex", gap: "6px", marginTop: "8px" });
  const saveBtn = document.createElement("button");
  saveBtn.textContent = "✓ Thêm step (Enter)";
  Object.assign(saveBtn.style, { flex: "1", padding: "6px", borderRadius: "6px", border: "1px solid #15803d", background: "linear-gradient(90deg,#16a34a,#22c55e)", color: "#052e16", cursor: "pointer", fontWeight: "700", fontSize: "12px" });
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "✕";
  Object.assign(cancelBtn.style, { padding: "6px 10px", borderRadius: "6px", border: "1px solid #b91c1c", background: "#dc2626", color: "#fff", cursor: "pointer", fontWeight: "700" });
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);
  panel.appendChild(btnRow);

  let highlightEl = null;
  function clearHighlight() { try { if (highlightEl) highlightEl.remove(); highlightEl = null; } catch (_) {} }

  function startInlinePick(mode) {
    panel.style.display = "none";
    const tip = document.createElement("div");
    Object.assign(tip.style, { position: "fixed", top: "8px", left: "50%", transform: "translateX(-50%)", background: "rgba(15,23,42,0.95)", color: mode === "point" ? "#f59e0b" : "#38bdf8", padding: "6px 16px", borderRadius: "999px", fontSize: "13px", fontWeight: "700", zIndex: "2147483647", pointerEvents: "none", border: "1px solid rgba(56,189,248,0.5)" });
    tip.textContent = mode === "point" ? "🎯 Click để chọn điểm — ESC hủy" : "🔵 Click để chọn element — ESC hủy";
    document.body.appendChild(tip);

    function cleanup() {
      try { tip.remove(); } catch (_) {}
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onEsc, true);
      panel.style.display = "block";
    }
    function onEsc(e) { if (e.key === "Escape") { cleanup(); } }
    function onClick(ev) {
      ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
      const target = document.elementFromPoint(ev.clientX, ev.clientY) || document.body;
      if (mode === "point") {
        values.x = Math.round(ev.clientX + window.scrollX);
        values.y = Math.round(ev.clientY + window.scrollY);
        const lbl = document.getElementById("__dl_point_label");
        if (lbl) lbl.textContent = values.x + ", " + values.y;
      } else {
        const sel = dlBuildSelectorForElement(target);
        if (inputs.selector) inputs.selector.value = sel;
        // Thu thập thông tin phong phú giống picker Sel thật
        try {
          values.x = Math.round((target.getBoundingClientRect().left + target.getBoundingClientRect().width / 2) + window.scrollX);
          values.y = Math.round((target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2) + window.scrollY);
          values.elementText = String(target.innerText || target.textContent || "").trim().slice(0, 200);
          let labelText = "";
          if (target.id) {
            const fl = document.querySelector('label[for="' + target.id + '"]');
            if (fl) labelText = (fl.innerText || fl.textContent || "").trim();
          }
          if (!labelText && typeof target.closest === "function") {
            const pl = target.closest("label");
            if (pl) labelText = (pl.innerText || pl.textContent || "").trim();
          }
          values.labelText = labelText;
          const cont = (typeof target.closest === "function" && target.closest("div,section,article,li,td,th")) || target.parentElement;
          if (cont) {
            values.containerTag = cont.tagName ? cont.tagName.toLowerCase() : "";
            if (cont.className && typeof cont.className === "string") {
              values.containerClassName = cont.className.split(/\s+/).filter(c => c && !c.includes(":")).slice(0, 2).join(" ");
            }
          }
        } catch (_) {}
        // highlight
        try {
          clearHighlight();
          const r = target.getBoundingClientRect();
          highlightEl = document.createElement("div");
          Object.assign(highlightEl.style, { position: "fixed", left: (r.left - 2) + "px", top: (r.top - 2) + "px", width: (r.width + 4) + "px", height: (r.height + 4) + "px", border: "2px solid #38bdf8", borderRadius: "4px", pointerEvents: "none", zIndex: "2147483646", background: "rgba(56,189,248,0.08)" });
          document.body.appendChild(highlightEl);
          setTimeout(clearHighlight, 1500);
        } catch (_) {}
      }
      cleanup();
      // pick xong → focus ô value đầu tiên để gõ ngay (delay/column...)
      focusFirstField();
    }
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onEsc, true);
  }

  function finish(ok) {
    __dlBuilderActive = false;
    clearHighlight();
    try { panel.remove(); } catch (_) {}
    document.removeEventListener("keydown", onKey, true);
    const out = { type: "stepBuilder", requestId, ok, stepType, fields: {}, fromSlot: !!(payload && payload.fromSlot) };
    if (ok) {
      Object.keys(inputs).forEach(k => { out.fields[k] = inputs[k].value; });
      out.fields.x = values.x;
      out.fields.y = values.y;
      out.fields.labelText = values.labelText;
      out.fields.elementText = values.elementText;
      out.fields.containerTag = values.containerTag;
      out.fields.containerClassName = values.containerClassName;
    }
    ipcRenderer.send("web:result", out);
  }

  function inField(e) {
    const t = e.target;
    const tag = t && t.tagName ? t.tagName.toLowerCase() : "";
    return tag === "input" || tag === "textarea" || tag === "select";
  }
  function focusFirstField() {
    const all = panel.querySelectorAll("input,select");
    for (let i = 0; i < all.length; i++) {
      if (all[i] !== inputs.selector) { try { all[i].focus(); } catch (_) {} return; }
    }
    if (all[0]) try { all[0].focus(); } catch (_) {}
  }
  function onKey(e) {
    // Ctrl+S lưu, Esc hủy — luôn áp dụng kể cả khi đang gõ trong field
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); finish(true); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); return; }
    // Command mode (chưa focus vào field): S=selector, P=point, Enter=lưu
    if (!inField(e)) {
      const k = String(e.key).toLowerCase();
      if (k === "s") { e.preventDefault(); startInlinePick("selector"); }
      else if (k === "p") { e.preventDefault(); startInlinePick("point"); }
      else if (e.key === "Enter") { e.preventDefault(); finish(true); }
    }
  }

  saveBtn.onclick = () => finish(true);
  cancelBtn.onclick = () => finish(false);
  document.addEventListener("keydown", onKey, true);

  document.body.appendChild(panel);
  __dlBuilderActive = true;
  // KHÔNG auto-focus → vào "command mode": bấm S/P để pick ngay, không cần chuột.
  // (sau khi pick xong sẽ tự focus vào ô value đầu tiên để gõ)
  sendStatus("Step builder: " + stepType + " — S/P để pick, Ctrl+S lưu");
}

// ── Phím tắt NGAY TRÊN cửa sổ slot để thêm step ────────────────────
// Bật/tắt bằng Ctrl+Shift+B; mặc định TẮT để không cản trở thao tác web.
const DL_SLOT_QUICK_KEYS = {
  c: "click", h: "hover", i: "input", r: "read", k: "condition",
  u: "upload", d: "download", o: "open", w: "wait", e: "end", x: "delete"
};
let __dlSlotQuickOn = false;

function dlToggleQuickKeys(on) {
  __dlSlotQuickOn = (typeof on === "boolean") ? on : !__dlSlotQuickOn;
  // Badge hiển thị trạng thái
  let badge = document.getElementById("__dl_quick_badge");
  if (__dlSlotQuickOn) {
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "__dl_quick_badge";
      Object.assign(badge.style, {
        position: "fixed", bottom: "10px", right: "10px", zIndex: "2147483647",
        background: "rgba(22,163,74,0.92)", color: "#fff", padding: "5px 10px",
        borderRadius: "8px", fontSize: "11px", fontFamily: "system-ui,sans-serif",
        fontWeight: "700", pointerEvents: "none", boxShadow: "0 4px 14px rgba(0,0,0,0.4)"
      });
      document.body.appendChild(badge);
    }
    badge.textContent = "⌨ Quick-add ON — c/i/r/k/h/u/d/o/w/e/x  (Ctrl+Shift+B tắt)";
    badge.style.display = "block";
  } else if (badge) {
    badge.style.display = "none";
  }
  sendStatus("Slot quick-keys: " + (__dlSlotQuickOn ? "ON" : "OFF"));
}

document.addEventListener("keydown", (ev) => {
  // Bật/tắt nhanh
  if (ev.ctrlKey && ev.shiftKey && String(ev.key).toLowerCase() === "b") {
    ev.preventDefault();
    dlToggleQuickKeys();
    return;
  }
  if (!__dlSlotQuickOn) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (__dlBuilderActive || document.getElementById("__dl_step_builder")) return;
  const t = ev.target;
  const tag = t && t.tagName ? t.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return;
  const key = String(ev.key || "").toLowerCase();
  if (DL_SLOT_QUICK_KEYS[key]) {
    ev.preventDefault();
    // Mở overlay nhập step NGAY trên slot; control sẽ ghi nhận khi lưu
    handleShowStepBuilder({
      stepType: DL_SLOT_QUICK_KEYS[key],
      requestId: "kbd-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      fromSlot: true
    });
  }
}, true);

async function handleGetText(payload, requestId) {
  const text = getTextByPayload(payload);
  try {
    const sel = payload && payload.selector ? String(payload.selector) : "";
    const modal = getActiveModalRoot();
    let el = null;
    if (payloadHasNarrowingHints(payload)) el = findElementForStep(payload);
    else if (sel) el = (modal && modal.querySelector(sel)) || safeSelector(sel);
    console.log("[WEB] getText:", {
      selector: sel,
      modalOpen: !!modal,
      found: !!el,
      tag: el && el.tagName,
      value: el ? (el.value != null ? el.value : (el.innerText || el.textContent || "")) : null,
      returned: text
    });
  } catch (_) {}
  sendResult({
    requestId,
    type: "getText",
    text
  });
}

async function handleGetHtml(payload, requestId) {
  const html = getHtmlByPayload(payload);
  sendResult({
    requestId,
    type: "getHtml",
    html
  });
}

async function handleClickSelector(payload) {
  const el = findElementForStep(payload);
  if (!el) {
    console.warn("[WEB] clickSelector: not found", payload);
    sendStatus("clickSelector not found: " + (payload.selector || JSON.stringify(payload)));
    return;
  }

  ensureInView(el, "smooth", "center", "center");
  await sleep(80);

  // Safe className cho cả SVG elements
  const safeClass = typeof el.className === "string"
    ? el.className.slice(0, 40)
    : (el.className && el.className.baseVal ? el.className.baseVal.slice(0, 40) : "");

  // Track giá trị input trước khi click
  const nearInputEl = typeof el.closest === "function"
    ? (el.closest(".n-input-number, .n-input-number-suffix, [class*='input-number']") || el.closest(".n-input"))
    : null;
  const inputBefore = nearInputEl ? (nearInputEl.querySelector("input") || {}).value : null;
  if (inputBefore !== null) {
    console.log("[clickTrack] PRE-CLICK el:", el.tagName, safeClass, "| input.value:", inputBefore);
  }

  const center = getElementCenter(el);
  showFakeCursor(center.x, center.y);

  // Chỉ dùng el.click() khi nằm trong n-input-number-suffix (nút +/-)
  // Điều kiện chặt — không dùng cho SVG chung chung
  const inNumberSuffix = typeof el.closest === "function" &&
    !!el.closest(".n-input-number-suffix, .n-input-number__button-group");

  // Chỉ detect input element nằm trong n-input-number — không phải SVG/line
  const isNumberInput = el.tagName === "INPUT" &&
    typeof el.closest === "function" &&
    !inNumberSuffix &&
    !!el.closest(".n-input-number");

  if (inNumberSuffix) {
    el.click();
    console.log("[clickTrack] NaiveUI number btn: el.click()");
  } else if (isNumberInput) {
    // n-input-number: KHÔNG focus(), KHÔNG click() — cả 2 đều trigger NaiveUI reset
    // Chỉ log, để pressArrow tự xử lý
    console.log("[clickTrack] NaiveUI number input: skip all events");
  } else {
    dispatchPointerSequence(el, center.x, center.y);
  }

  // Track sau click
  if (inputBefore !== null) {
    await sleep(150);
    const inputAfter = nearInputEl ? (nearInputEl.querySelector("input") || {}).value : null;
    console.log("[clickTrack] POST-CLICK input.value:", inputAfter, "| changed:", inputBefore !== inputAfter);
    if (inputAfter === "0" || inputAfter === "0.000" || inputAfter === "0.00") {
      console.warn("[clickTrack] WARNING: value reset to 0 after click — NaiveUI synthetic event issue");
    }
  }

  LAST_ACTIVE_ELEMENT = el;
  sendLog("Clicked selector: " + (payload.selector || payload.elementText || payload.labelText || "?"));
}

async function handleClickPoint(x, y) {
  // x, y là document coords

  // Skip page scroll when a modal is open — modal is fixed overlay, scrolling causes misalignment
  if (!getActiveModalRoot()) {
    const targetScrollX = Math.max(0, x - window.innerWidth / 2);
    const targetScrollY = Math.max(0, y - window.innerHeight / 2);
    window.scrollTo({ left: targetScrollX, top: targetScrollY, behavior: "instant" });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  // Tính viewport coords sau scroll
  const vpX = x - window.scrollX;
  const vpY = y - window.scrollY;

  console.log("[clickPoint] doc:", x, y, "→ vp:", Math.round(vpX), Math.round(vpY));

  // Bước 4: Lấy element tại điểm đó
  const el = document.elementFromPoint(vpX, vpY);
  if (!el || el === document.documentElement || el === document.body) {
    console.warn("[WEB] clickPoint: no meaningful element at", vpX, vpY);
    sendStatus("clickPoint not found at " + x + ", " + y);
    return;
  }

  // Bước 5: Dùng đúng tọa độ x,y gốc (document coords converted to viewport)
  // KHÔNG dùng center của element — vì user đã pick đúng điểm cần click
  showFakeCursor(vpX, vpY);

  // SVG elements và nút input-number: dùng el.click() thay vì dispatchPointerSequence
  // dispatchPointerSequence với NaiveUI input-number sẽ reset internal state về 0
  const isSvgEl = el.tagName && ["svg","path","line","polyline","polygon","circle","rect","g","use"].includes(el.tagName.toLowerCase());
  const inNumberSuffixPt = typeof el.closest === "function" &&
    !!el.closest(".n-input-number-suffix, .n-input-number__button-group");

  if (isSvgEl || inNumberSuffixPt) {
    // Log parent chain để debug
    let p = el.parentElement;
    let parentInfo = [];
    for (let i = 0; i < 4 && p; i++) {
      const pClass = typeof p.className === "string" ? p.className.slice(0, 50) : (p.className && p.className.baseVal ? p.className.baseVal.slice(0, 50) : "");
      parentInfo.push(p.tagName + "." + pClass);
      p = p.parentElement;
    }
    console.log("[clickTrack] el.click() for SVG, parents:", parentInfo.join(" → "));
    // SVG elements có thể không có click() — leo lên parent clickable
    if (typeof el.click === "function") {
      el.click();
    } else {
      // Tìm parent gần nhất có click()
      let clickTarget = el.parentElement;
      while (clickTarget && typeof clickTarget.click !== "function") {
        clickTarget = clickTarget.parentElement;
      }
      if (clickTarget && typeof clickTarget.click === "function") {
        clickTarget.click();
        console.log("[clickTrack] clicked parent:", clickTarget.tagName, clickTarget.className && typeof clickTarget.className === "string" ? clickTarget.className.slice(0, 40) : "");
      } else {
        // Fallback: dispatchPointerSequence
        dispatchPointerSequence(el, vpX, vpY);
      }
    }
  } else {
    dispatchPointerSequence(el, vpX, vpY);
  }

  LAST_ACTIVE_ELEMENT = el;
  sendLog("Clicked point: " + x + ", " + y + " → vp(" + Math.round(vpX) + ", " + Math.round(vpY) + ") el=" + (el.tagName || "?") + (el.className ? "." + String(el.className).split(" ")[0] : ""));
}

async function handleHoverSelector(payload) {
  const el = findElementForStep(payload);
  if (!el) {
    sendStatus("hoverSelector not found: " + (payload.selector || JSON.stringify(payload)));
    return;
  }

  ensureInView(el, "smooth", "center", "center");
  await sleep(60);

  const center = getElementCenter(el);
  showFakeCursor(center.x, center.y, "#38bdf8");
  dispatchHoverSequence(el, center.x, center.y);

  LAST_ACTIVE_ELEMENT = el;
  sendLog("Hovered selector: " + (payload.selector || payload.elementText || payload.labelText || "?"));
}

async function handleScrollIntoView(payload) {
  const el = findElementForStep(payload);
  if (!el) {
    sendStatus("scrollIntoView not found: " + (payload.selector || JSON.stringify(payload)));
    return;
  }

  ensureInView(el, "smooth", "center", "center");
  LAST_ACTIVE_ELEMENT = el;
  sendLog("Scrolled into view: " + (payload.selector || payload.elementText || payload.labelText || "?"));
}

function findNaiveSelectContainer(el) {
  if (!el || el.nodeType !== 1) return null;
  const tag = el.tagName ? el.tagName.toLowerCase() : "";
  const elCls = typeof el.className === "string" ? el.className : (el.className && el.className.baseVal ? el.className.baseVal : "");

  // If it's the specific Naive UI inner tag-input, find the outer .n-base-selection container
  if (tag === "input" && elCls.includes("n-base-selection-input-tag__input")) {
    let cur = el.parentElement;
    for (let i = 0; i < 5; i++) {
      if (!cur) return null;
      const c = typeof cur.className === "string" ? cur.className : "";
      if (c.includes("n-select") || c.includes("n-base-selection")) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // Regular input/textarea/contentEditable → skip, let setNativeValue handle it
  if (tag === "input" || tag === "textarea" || el.isContentEditable) return null;

  // Walk up to find .n-select or .n-base-selection container
  let cur = el;
  for (let i = 0; i < 6; i++) {
    if (!cur || cur.nodeType !== 1) break;
    const cls = typeof cur.className === "string" ? cur.className : (cur.className && cur.className.baseVal ? cur.className.baseVal : "");
    if (cls.includes("n-select") || cls.includes("n-base-selection")) return cur;
    cur = cur.parentElement;
  }
  return null;
}

async function trySetNaiveSelect(el, value) {
  const container = findNaiveSelectContainer(el);
  if (!container) return false;

  ensureInView(container, "smooth", "center", "center");
  await sleep(60);

  // Click container to focus/open
  const center = getElementCenter(container);
  dispatchPointerSequence(container, center.x, center.y);
  await sleep(200);

  // Find inner input
  const innerInput =
    container.querySelector("input.n-base-selection-input-tag__input") ||
    container.querySelector(".n-base-selection-input-tag__input") ||
    container.querySelector("input");

  if (!innerInput) return false;

  // Type each character one by one like a human
  const str = String(value);
  for (const char of str) {
    const keyCode = char.charCodeAt(0);
    try { innerInput.dispatchEvent(new KeyboardEvent("keydown", { key: char, keyCode, which: keyCode, bubbles: true, cancelable: true })); } catch (_) {}
    try { innerInput.dispatchEvent(new KeyboardEvent("keypress", { key: char, keyCode, which: keyCode, bubbles: true, cancelable: true })); } catch (_) {}

    const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    const current = innerInput.value;
    const next = current + char;
    if (desc && typeof desc.set === "function") {
      desc.set.call(innerInput, next);
    } else {
      innerInput.value = next;
    }

    try { innerInput.dispatchEvent(new Event("input", { bubbles: true })); } catch (_) {}
    try { innerInput.dispatchEvent(new KeyboardEvent("keyup", { key: char, keyCode, which: keyCode, bubbles: true })); } catch (_) {}
    await sleep(30);
  }

  return true;
}

// Monaco editor (kie.ai, GitHub, VSCode-web, etc.) maintains its own
// text model and ignores writes to the hidden .monaco-editor
// textarea.inputarea. When setValue's target lands inside a .monaco-editor
// we fall back to the editor's API, which is reachable as window.monaco.
function trySetMonacoValue(el, text) {
  try {
    const wrapper = el && typeof el.closest === "function" ? el.closest(".monaco-editor") : null;
    if (!wrapper) return false;
    const mon = window.monaco;
    if (!mon || !mon.editor || typeof mon.editor.getEditors !== "function") return false;
    const eds = mon.editor.getEditors();
    // Match the editor whose DOM node contains the targeted element.
    // kie.ai mounts one editor per model section — finding the right
    // one matters when multiple are present (only one is visible at a
    // time, but DOM still contains all six).
    let target = null;
    for (const ed of eds) {
      try {
        const node = ed.getDomNode();
        if (node && (node === wrapper || node.contains(el) || wrapper.contains(node))) {
          target = ed;
          break;
        }
      } catch (_) {}
    }
    // Fallback: first visible editor on the page
    if (!target) {
      target = eds.find((ed) => {
        try { return ed.getDomNode() && ed.getDomNode().offsetParent !== null; }
        catch (_) { return false; }
      });
    }
    if (!target) return false;
    target.setValue(String(text == null ? "" : text));
    return true;
  } catch (err) {
    console.warn("[setValue] Monaco branch error:", err && err.message);
    return false;
  }
}

async function handleSetValue(payload, value) {
const el = findElementForStep(payload);
if (!el) {
sendStatus("setValue not found: " + (payload.selector || JSON.stringify(payload)));
return;
}

ensureInView(el, "smooth", "center", "center");
await sleep(80);

// Special case: Monaco editor — uses an internal model, can't be
// reached via a raw .value write on the hidden inputarea textarea.
const monacoOk = trySetMonacoValue(el, value == null ? "" : String(value));
if (monacoOk) {
  LAST_ACTIVE_ELEMENT = el;
  sendLog("Set value on Monaco editor: " + (payload.selector || payload.labelText || payload.elementText || "?"));
  return;
}

// Special case: Naive UI n-select / n-base-selection-tags component
const naiveOk = await trySetNaiveSelect(el, value == null ? "" : String(value));
if (naiveOk) {
  LAST_ACTIVE_ELEMENT = el;
  sendLog("Set value on Naive select: " + (payload.selector || payload.labelText || payload.elementText || "?"));
  return;
}

try {
if (typeof el.focus === "function") {
el.focus({ preventScroll: true });
}
} catch (_) {}

const ok = await setNativeValueAsync(el, value == null ? "" : String(value));
if (!ok) {
sendStatus("setValue unsupported element: " + (payload.selector || JSON.stringify(payload)));
return;
}

LAST_ACTIVE_ELEMENT = el;
sendLog("Set value on: " + (payload.selector || payload.labelText || payload.elementText || "?"));
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

const selectors = [
'input[type="file"]',
'input[type=file]'
];

for (const sel of selectors) {
try {
if (typeof el.matches === "function" && el.matches(sel)) return el;
} catch (_) {}
}

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

function describeUploadTarget(el, input) {
const targetTag = el && el.tagName ? el.tagName.toLowerCase() : "?";
const inputTag = input && input.tagName ? input.tagName.toLowerCase() : "?";
const inputType = input ? String(input.type || "").toLowerCase() : "";
return `${targetTag} -> ${inputTag}${inputType ? `[type=${inputType}]` : ""}`;
}

async function handleUploadFiles(payload, files) {
const targetEl = findElementForStep(payload);

let inputEl = resolveUploadInputFromElement(targetEl);
if (!inputEl && payload && payload.selector) {
try {
const directEl = safeSelector(String(payload.selector));
inputEl = resolveUploadInputFromElement(directEl);
} catch (_) {}
}

if (!inputEl) {
const allFileInputs = safeSelectorAll('input[type="file"]');
if (allFileInputs.length === 1) {
inputEl = allFileInputs[0];
}
}

if (!targetEl && !inputEl) {
sendResult({
type: "uploadFiles",
ok: false,
reason: "target not found"
});
sendStatus("uploadFiles target not found: " + (payload.selector || JSON.stringify(payload)));
return;
}

if (!inputEl) {
sendResult({
type: "uploadFiles",
ok: false,
reason: "input type=file not found"
});
sendStatus("uploadFiles input type=file not found: " + (payload.selector || JSON.stringify(payload)));
return;
}

ensureInView(inputEl, "smooth", "center", "center");
await sleep(80);

const safeFiles = Array.isArray(files)
? files.filter(f => f && typeof f.localPath === "string" && f.localPath.trim())
: [];

if (!safeFiles.length) {
sendResult({
type: "uploadFiles",
ok: false,
reason: "no valid localPath"
});
sendStatus("uploadFiles no valid localPath");
return;
}

try {
if (typeof inputEl.focus === "function") {
inputEl.focus({ preventScroll: true });
}
} catch (_) {}

try {
const res = await ipcRenderer.invoke("web:set-file-input-files", {
selector: payload && payload.selector ? payload.selector : "",
labelText: payload && payload.labelText ? payload.labelText : "",
elementText: payload && payload.elementText ? payload.elementText : "",
containerTag: payload && payload.containerTag ? payload.containerTag : "",
containerClassName: payload && payload.containerClassName ? payload.containerClassName : "",
x: payload && typeof payload.x === "number" ? payload.x : null,
y: payload && typeof payload.y === "number" ? payload.y : null,
files: safeFiles.map(f => ({
id: f.id || "",
name: f.name || "",
type: f.type || "",
localPath: String(f.localPath || "").trim()
}))
});

const ok = !!(res && res.ok);
if (!ok) {
const reason = (res && res.reason) ? String(res.reason) : "upload failed";
sendResult({
type: "uploadFiles",
ok: false,
reason
});
sendStatus("uploadFiles " + reason);
return;
}

try {
inputEl.dispatchEvent(new Event("input", { bubbles: true }));
} catch (_) {}
try {
inputEl.dispatchEvent(new Event("change", { bubbles: true }));
} catch (_) {}

LAST_ACTIVE_ELEMENT = inputEl;
sendResult({
type: "uploadFiles",
ok: true,
count: safeFiles.length,
target: describeUploadTarget(targetEl, inputEl)
});
sendLog("uploadFiles ok: " + safeFiles.length + " file(s)");
} catch (err) {
const reason = err && err.message ? err.message : "ipc upload error";
sendResult({
type: "uploadFiles",
ok: false,
reason
});
sendStatus("uploadFiles " + reason);
}
}

async function handlePressKey(key) {
const target = document.activeElement || LAST_ACTIVE_ELEMENT || document.body;
pressKeyOnElement(target, key || "Enter");
sendLog("Pressed key: " + (key || "Enter"));
}

async function handleDetectLabStart() {
  DETECTLAB_RUNNING = true;
  DETECTLAB_PAUSED = false;
  sendStatus("DetectLab running");
}

async function handleDetectLabPause() {
  DETECTLAB_PAUSED = true;
  DETECTLAB_RUNNING = false;
  sendStatus("DetectLab paused");
}

async function handleDetectLabResume() {
  DETECTLAB_PAUSED = false;
  DETECTLAB_RUNNING = true;
  sendStatus("DetectLab resumed");
}

async function handleDetectLabPing() {
  sendStatus("DetectLab bridge OK");
}

async function handleOpenUrlInPage(url) {
  const clean = (url || "").trim();
  if (!clean) return;
  try {
    window.location.href = clean;
  } catch (err) {
    console.warn("[WEB] handleOpenUrlInPage error:", err);
  }
}

async function handleSetNotiRules(rules) {
  NOTI_RULES = Array.isArray(rules) ? rules.filter(Boolean) : [];
  ensureNotiObserver();
  tryHandleNotifications();
  sendLog("Notification rules updated: " + NOTI_RULES.length);
}

// =========================================================
// IPC command receiver
// =========================================================

ipcRenderer.on("web:exec", async (event, payload) => {
const {
type,
selector,
labelText,
elementText,
containerTag,
containerClassName,
x,
y,
requestId,
value,
key,
rules,
stepId
} = payload || {};

// Gói toàn bộ metadata định vị vào một object để truyền vào findElementForStep
const stepPayload = {
selector,
labelText,
elementText,
containerTag,
containerClassName,
x,
y
};

if (!type) return;

console.log("[WEB_PRELOAD] web:exec type =", type);

try {
if (type === "logTitle") {
await handleLogTitle();
return;
}

    if (type === "getText") {
      // Pass the full step payload so findElementForStep can narrow on
      // labelText / elementText / x,y when the recorded selector is too wide.
      await handleGetText(stepPayload, requestId);
      return;
    }

    if (type === "getHtml") {
      await handleGetHtml(stepPayload, requestId);
      return;
    }

    if (type === "gsiclick") {
      // window.google không thấy được từ isolated preload world
      // → forward lên main.js để dùng executeJavaScript trong page context thật
      // main.js đã có handler riêng cho type=gsiclick, không forward xuống web:exec thông thường
      sendLog("GSI: forwarding to main process (page context)");
      return;
    }

    if (type === "cdpClick") {
      // Trusted CDP click — bypass isTrusted check (Google OAuth, v.v.)
      // Được xử lý ở main.js, không phải ở đây
      // preload chỉ forward lên main qua invoke
      try {
        const res = await ipcRenderer.invoke("web:cdp-click", payload);
        if (res && res.ok) {
          sendLog("CDP click ok at (" + res.x + ", " + res.y + ")");
        } else {
          sendStatus("CDP click failed: " + (res && res.reason ? res.reason : "unknown"));
        }
      } catch (err) {
        sendStatus("CDP click error: " + (err && err.message ? err.message : "unknown"));
      }
      return;
    }

    if (type === "clickSelector") {
      if (selector || labelText || elementText) {
        await handleClickSelector(stepPayload);
      } else if (typeof x === "number" && typeof y === "number") {
        // Không có selector/text → fallback sang clickPoint
        console.warn("[WEB] clickSelector: no selector/text, fallback to clickPoint", stepPayload);
        await handleClickPoint(x, y);
      } else {
        sendStatus("clickSelector: missing selector, labelText, elementText, or x/y");
      }
      return;
    }

    if (type === "pressArrow") {
      const el = findElementForStep(stepPayload);
      if (!el) {
        sendStatus("pressArrow: element not found");
        return;
      }

      ensureInView(el, "smooth", "center", "center");
      await sleep(80);

      // n-input-number: KHÔNG click, KHÔNG focus — cả 2 reset internal state
      // Chỉ dispatch key events lên container
      const isInNumber = typeof el.closest === "function" && !!el.closest(".n-input-number");
      if (!isInNumber) {
        try { el.click(); } catch(_) {}
        try { el.focus({ preventScroll: true }); } catch(_) {}
        await sleep(80);
      }

      const direction = payload.arrowDirection || "ArrowUp";
      const count = Math.max(1, Math.min(100, parseInt(payload.arrowCount || 1, 10)));
      const delayBetween = parseInt(payload.arrowDelay || 50, 10);

      const keyMap = {
        up: "ArrowUp", down: "ArrowDown",
        left: "ArrowLeft", right: "ArrowRight",
        ArrowUp: "ArrowUp", ArrowDown: "ArrowDown",
        ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight"
      };
      const key = keyMap[direction] || "ArrowUp";
      const keyCode = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }[key];
      const arrow = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" }[key] || key;

      // Visual: highlight element và hiện tooltip
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      showFakeCursor(cx, cy);

      // Hiện overlay nhỏ trên element để biết đang chạy
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed",
        left: (rect.left - 2) + "px",
        top: (rect.top - 2) + "px",
        width: (rect.width + 4) + "px",
        height: (rect.height + 4) + "px",
        border: "2px solid #38bdf8",
        borderRadius: "4px",
        pointerEvents: "none",
        zIndex: "2147483646",
        background: "rgba(56,189,248,0.08)"
      });

      // Label hiện key và count
      const label = document.createElement("div");
      Object.assign(label.style, {
        position: "fixed",
        left: (rect.right + 6) + "px",
        top: rect.top + "px",
        background: "rgba(15,23,42,0.9)",
        color: "#38bdf8",
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "13px",
        fontWeight: "700",
        fontFamily: "system-ui,sans-serif",
        pointerEvents: "none",
        zIndex: "2147483647"
      });
      label.textContent = arrow + " x" + count;

      document.body.appendChild(overlay);
      document.body.appendChild(label);

      console.log("[pressArrow] key:", key, "count:", count, "el:", el.tagName, el.placeholder || "");

      // NaiveUI input-number lắng nghe arrow keys trên container, không phải input bên trong
      // Tìm container phù hợp để dispatch
      let dispatchTarget = el;
      if (typeof el.closest === "function") {
        const numberContainer = el.closest(".n-input-number, .n-input-number-suffix");
        if (numberContainer) {
          dispatchTarget = numberContainer;
          console.log("[pressArrow] dispatching to container:", numberContainer.className.slice(0, 50));
        }
      }

      for (let i = 0; i < count; i++) {
        label.textContent = arrow + " " + (i + 1) + "/" + count;
        // Dispatch lên cả input lẫn container để đảm bảo nhận được
        [el, dispatchTarget].forEach(target => {
          if (target === el && target === dispatchTarget) return; // không dispatch 2 lần nếu cùng element
          target.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
          target.dispatchEvent(new KeyboardEvent("keypress", { key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
          target.dispatchEvent(new KeyboardEvent("keyup", { key, keyCode, which: keyCode, bubbles: true }));
        });
        el.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key, keyCode, which: keyCode, bubbles: true }));
        if (i < count - 1 && delayBetween > 0) await sleep(delayBetween);
      }

      // Cleanup overlay
      try { overlay.remove(); label.remove(); } catch(_) {}

      await fireInputEventsAsync(el);

      sendLog("pressArrow: " + key + " x" + count + " → value: " + (el.value || "?"));
      LAST_ACTIVE_ELEMENT = el;
      return;
    }

    if (type === "clicknear") {
  const refEl = findElementForStep(stepPayload);
  if (!refEl) { sendStatus("clicknear: ref element not found"); return; }

  ensureInView(refEl, "smooth", "center", "center");
  await sleep(150);

  const refRect = refEl.getBoundingClientRect();
  const direction = payload.direction || "right";
  const btnIndex = typeof payload.index === "number" ? payload.index : 0;
  const maxDist = typeof payload.maxDist === "number" ? payload.maxDist : 300;

  console.log("[clicknear] ref:", refEl.tagName, refEl.placeholder || "", "rect:", Math.round(refRect.left), Math.round(refRect.top), Math.round(refRect.right), Math.round(refRect.bottom));

  // Tìm tất cả clickable elements gần refEl
  const allClickable = Array.from(document.querySelectorAll(
    "button, [role='button'], .n-button, a[href], [tabindex]"
  )).filter(b => {
    if (b === refEl) return false;
    const r = b.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    // Cùng hàng ngang (vertical overlap)
    const refCenterY = refRect.top + refRect.height / 2;
    const bCenterY = r.top + r.height / 2;
    const vertOk = Math.abs(bCenterY - refCenterY) < refRect.height;
    if (!vertOk) return false;
    // Filter theo direction
    if (direction === "right") return r.left >= refRect.left && r.left <= refRect.right + maxDist;
    if (direction === "left") return r.right <= refRect.right && r.right >= refRect.left - maxDist;
    return true;
  }).sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    if (direction === "right") return ra.left - rb.left;
    return rb.right - ra.right;
  });

  console.log("[clicknear] found", allClickable.length, "clickable elements, direction:", direction);
  allClickable.slice(0, 6).forEach((b, i) => {
    const r = b.getBoundingClientRect();
    const cls = typeof b.className === "string" ? b.className.slice(0, 50) : "";
    console.log("[clicknear] [" + i + "]", b.tagName, cls, "left:", Math.round(r.left), "top:", Math.round(r.top), "w:", Math.round(r.width));
  });

  const target = allClickable[btnIndex];
  if (!target) {
    sendStatus("clicknear: no element at index " + btnIndex + " (found " + allClickable.length + ")");
    return;
  }

  const r = target.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  showFakeCursor(cx, cy);

  if (typeof target.click === "function") {
    target.click();
  } else {
    dispatchPointerSequence(target, cx, cy);
  }

  sendLog("clicknear: [" + btnIndex + "] " + direction + " of " + (stepPayload.selector || stepPayload.labelText || "?"));
  LAST_ACTIVE_ELEMENT = target;
  return;
}

    if (type === "clickPoint" && typeof x === "number" && typeof y === "number") {
      await handleClickPoint(x, y);
      return;
    }

    if (type === "hoverSelector" && (selector || labelText || elementText)) {
      await handleHoverSelector(stepPayload);
      return;
    }

if (type === "scrollIntoView" && (selector || labelText || elementText)) {
await handleScrollIntoView(stepPayload);
return;
}
if (type === "typeCharByChar") {
  console.log("[typeCharByChar] START payload:", JSON.stringify({
    selector: stepPayload.selector,
    labelText: stepPayload.labelText,
    elementText: stepPayload.elementText,
    value: String(value || "").slice(0, 50)
  }));

  const el = findElementForStep(stepPayload);
  if (!el) {
    console.warn("[typeCharByChar] element NOT FOUND for selector:", stepPayload.selector, "labelText:", stepPayload.labelText);
    sendStatus("typeCharByChar: element not found");
    return;
  }

  console.log("[typeCharByChar] element found:", el.tagName, el.className, "value:", el.value, "type:", el.type);

  ensureInView(el, "smooth", "center", "center");
  await sleep(80);

  try { el.focus({ preventScroll: true }); } catch (_) {}
  await sleep(50);

  const chars = String(value || "");
  console.log("[typeCharByChar] typing value:", chars.slice(0, 60), "length:", chars.length);

  const tag = el.tagName ? el.tagName.toLowerCase() : "input";
  const proto = tag === "textarea"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value") &&
    Object.getOwnPropertyDescriptor(proto, "value").set;

  console.log("[typeCharByChar] nativeSetter available:", !!nativeSetter);

  const isInNumberInput = el.tagName === "INPUT" &&
    typeof el.closest === "function" &&
    !!el.closest(".n-input-number");

  if (nativeSetter) {
    if (isInNumberInput) {
      const container = el.closest(".n-input-number");

      // Bước 1: Click nút + để NaiveUI activate internal state
      // Khi internal state = 0, NaiveUI không nhận value từ typing
      // Click + một lần → internal state = 0 + step → NaiveUI đang active
      const plusBtn = container ? container.querySelector("button:last-child, [class*='plus'], [class*='add']") : null;
      if (plusBtn) {
        plusBtn.click();
        await sleep(50);
        console.log("[typeCharByChar] activated n-input-number via + btn");
      }

      // Bước 2: Focus và clear
      try { el.focus({ preventScroll: true }); } catch(_) {}
      await sleep(50);

      // Clear bằng Ctrl+A + Delete
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "a", keyCode: 65, ctrlKey: true, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: "a", keyCode: 65, ctrlKey: true, bubbles: true }));
      await sleep(20);
      nativeSetter.call(el, "");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(30);

      // Bước 3: Type từng ký tự
      for (const char of chars) {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true, cancelable: true }));
        el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true, cancelable: true }));
        nativeSetter.call(el, el.value + char);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
        await sleep(20);
      }

      await sleep(50);
      console.log("[typeCharByChar] n-input-number typed, el.value:", el.value);
    } else {
      nativeSetter.call(el, chars);
      await fireInputEventsAsync(el);
      try { el.blur(); } catch(_) {}
      await sleep(80);
      console.log("[typeCharByChar] blurred, el.value:", el.value);
    }
    sendLog("typeCharByChar (React): set '" + chars.slice(0, 40) + "' ✓");
  } else {
    try {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_) {}

    for (const char of chars) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true, cancelable: true }));
      el.value += char;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      await sleep(15);
    }
    await fireInputEventsAsync(el);
    console.log("[typeCharByChar] fallback done, el.value:", el.value);
    sendLog("typeCharByChar (fallback): typed " + chars.length + " chars");
  }

  try { el.blur(); } catch (_) {}
  await sleep(20);
  try { el.focus({ preventScroll: true }); } catch (_) {}

  LAST_ACTIVE_ELEMENT = el;
  return;
}

if (type === "setValue" && (selector || labelText || elementText)) {
await handleSetValue(stepPayload, value);
return;
}

if (type === "uploadFiles" && (selector || labelText || elementText)) {
await handleUploadFiles(stepPayload, payload.files);
return;
}

if (type === "pressKey") {
await handlePressKey(key);
return;
}

    if (type === "setNotiRules") {
      await handleSetNotiRules(rules);
      return;
    }

    if (type === "noti:resolve") {
      await handleNotiResolve(payload);
      return;
    }

    if (type === "setNotiMode") {
      const validModes = ["auto-only", "control-first", "hybrid"];
      NOTI_MODE = validModes.includes(payload.mode) ? payload.mode : "hybrid";
      sendLog(`[NotiMode] Set to: ${NOTI_MODE}`);
      return;
    }

    if (type === "detectlab_start") {
      await handleDetectLabStart();
      return;
    }

    if (type === "detectlab_pause") {
      await handleDetectLabPause();
      return;
    }

    if (type === "detectlab_resume") {
      await handleDetectLabResume();
      return;
    }

    if (type === "detectlab_ping") {
      await handleDetectLabPing();
      return;
    }

    if (type === "openUrl") {
      await handleOpenUrlInPage(value || selector || "");
      return;
    }

    if (type === "showStepBuilder") {
      handleShowStepBuilder(payload);
      return;
    }

    if (type === "startPickPoint") {
      // Inject overlay full-screen transparent để chặn FedCM/OAuth button
      // FedCM xử lý ở browser level nên stopImmediatePropagation không đủ —
      // overlay z-index cao nhất đảm bảo mọi click đi vào overlay trước
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        cursor: "crosshair",
        background: "rgba(239,68,68,0.08)",
        outline: "3px dashed rgba(239,68,68,0.7)"
      });

      // Tooltip nhắc user
      const tip = document.createElement("div");
      Object.assign(tip.style, {
        position: "fixed",
        top: "8px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(15,23,42,0.92)",
        color: "#f87171",
        padding: "6px 16px",
        borderRadius: "999px",
        fontSize: "13px",
        fontWeight: "700",
        fontFamily: "system-ui,sans-serif",
        pointerEvents: "none",
        zIndex: "2147483647",
        border: "1px solid rgba(239,68,68,0.5)",
        whiteSpace: "nowrap"
      });
      tip.textContent = "🎯 Click to pick position — ESC to cancel";
      document.body.appendChild(tip);

      function cleanup() {
        try { overlay.remove(); } catch (_) {}
        try { tip.remove(); } catch (_) {}
        document.removeEventListener("keydown", escHandler, true);
      }

      function escHandler(e) {
        if (e.key === "Escape") {
          cleanup();
          sendStatus("Pick cancelled");
        }
      }
      document.addEventListener("keydown", escHandler, true);

      overlay.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();

        try {
          const vpX = ev.clientX;
          const vpY = ev.clientY;

          overlay.style.pointerEvents = "none";

          // Lưu đúng điểm user click (không lấy center của element)
          // document coords = viewport coords + scroll
          const docX = vpX + window.scrollX;
          const docY = vpY + window.scrollY;

          showFakeCursor(vpX, vpY, "#f97373");

          ipcRenderer.send("web:result", {
            type: "pickedPoint",
            stepId,
            x: docX,
            y: docY
          });
        } finally {
          cleanup();
        }
      }, { once: true });

      document.body.appendChild(overlay);
      sendStatus("Click on page to pick point — ESC to cancel");
      return;
    }

    if (type === "startPickSelector") {
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        cursor: "crosshair",
        background: "rgba(56,189,248,0.06)",
        outline: "3px dashed rgba(56,189,248,0.7)"
      });

      const tip = document.createElement("div");
      Object.assign(tip.style, {
        position: "fixed",
        top: "8px",
        left: "50%",
        transform: "translateX(-50%)",
        background: "rgba(15,23,42,0.92)",
        color: "#38bdf8",
        padding: "6px 16px",
        borderRadius: "999px",
        fontSize: "13px",
        fontWeight: "700",
        fontFamily: "system-ui,sans-serif",
        pointerEvents: "none",
        zIndex: "2147483647",
        border: "1px solid rgba(56,189,248,0.5)",
        whiteSpace: "nowrap"
      });
      tip.textContent = "🔵 Click to pick selector — ESC to cancel";
      document.body.appendChild(tip);

      function cleanup() {
        try { overlay.remove(); } catch (_) {}
        try { tip.remove(); } catch (_) {}
        document.removeEventListener("keydown", escHandler, true);
      }

      function escHandler(e) {
        if (e.key === "Escape") {
          cleanup();
          sendStatus("Pick cancelled");
        }
      }
      document.addEventListener("keydown", escHandler, true);

      overlay.addEventListener("click", ev => {
        ev.preventDefault();
        ev.stopPropagation();
        ev.stopImmediatePropagation();

        // Tắt overlay vĩnh viễn — KHÔNG restore lại "all"
        overlay.style.pointerEvents = "none";
        const target = document.elementFromPoint(ev.clientX, ev.clientY) || document.body;

        try {
          const rect = target.getBoundingClientRect();
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;

          showFakeCursor(cx, cy, "#38bdf8");

          const tag = target.tagName ? target.tagName.toLowerCase() : "div";

          // ── Thu thập labelText ──
          let labelText = "";
          try {
            if (target.id) {
              const forLabel = document.querySelector(`label[for="${target.id}"]`);
              if (forLabel) labelText = (forLabel.innerText || forLabel.textContent || "").trim();
            }
            if (!labelText) {
              const parentLabel = typeof target.closest === "function" ? target.closest("label") : null;
              if (parentLabel) labelText = (parentLabel.innerText || parentLabel.textContent || "").trim();
            }
            if (!labelText) {
              let p = target.parentElement;
              while (p && p !== document.body && !labelText) {
                const candidates = p.querySelectorAll("label,span,strong,p,div");
                for (const node of candidates) {
                  if (node.contains(target)) continue;
                  const txt = (node.innerText || node.textContent || "").trim();
                  if (txt && txt.length <= 80) { labelText = txt; break; }
                }
                p = p.parentElement;
              }
            }
          } catch (_) {}

          // ── elementText ──
          let elementText = "";
          try { elementText = (target.innerText || target.textContent || "").trim(); } catch (_) {}

          // ── containerTag / containerClassName ──
          let containerTag = "";
          let containerClassName = "";
          try {
            const container = (typeof target.closest === "function" &&
              target.closest("div,section,article,li,td,th")) || target.parentElement;
            if (container) {
              containerTag = container.tagName ? container.tagName.toLowerCase() : "";
              if (container.className && typeof container.className === "string") {
                const safeClasses = container.className.split(/\s+/)
                  .filter(c => c && !c.includes(":")).slice(0, 2);
                containerClassName = safeClasses.join(" ");
              }
            }
          } catch (_) {}

          // ── Build selector ──
          let selectorPicked = "";
          if ((tag === "input" || tag === "textarea") && target.placeholder) {
            const ph = String(target.placeholder);
            selectorPicked = ph.includes('"') && !ph.includes("'")
              ? `${tag}[placeholder='${ph}']`
              : `${tag}[placeholder="${ph}"]`;
          } else if (target.id) {
            selectorPicked = `${tag}#${target.id}`;
          } else if (target.className && typeof target.className === "string") {
            const safeClasses = target.className.split(/\s+/)
              .filter(c => c && !c.includes(":")).slice(0, 2);
            const classPart = safeClasses.map(c => "." + c.replace(/[^a-zA-Z0-9_-]/g, "")).join("");
            selectorPicked = classPart ? tag + classPart : tag;
          } else {
            selectorPicked = tag;
          }

          ipcRenderer.send("web:result", {
            type: "pickedSelector",
            stepId,
            selector: selectorPicked,
            x: cx + window.scrollX,
            y: cy + window.scrollY,
            elInfo: {
              tag,
              id: target.id || "",
              className: target.className || "",
              placeholder: target.placeholder || "",
              labelText,
              elementText,
              containerTag,
              containerClassName
            }
          });
        } finally {
          // Đảm bảo overlay luôn bị xóa dù có lỗi hay không
          cleanup();
        }
      }, { once: true });

      document.body.appendChild(overlay);
      sendStatus("Click on page to pick selector — ESC to cancel");
      return;
    }

    if (type === "possel") {
      // Resolve selector tại vị trí (x,y) tài liệu — robust hơn click point cố định
      const posX = typeof x === "number" ? x : 0;
      const posY = typeof y === "number" ? y : 0;
      const reqId = requestId || "";
      try {
        // Cuộn để vị trí nằm trong viewport
        window.scrollTo(posX - window.innerWidth / 2, posY - window.innerHeight / 2);
        await sleep(120);
        const vpX = posX - window.scrollX;
        const vpY = posY - window.scrollY;
        const target = document.elementFromPoint(vpX, vpY);
        if (!target) {
          ipcRenderer.send("web:result", { type: "possel", requestId: reqId, ok: false, reason: "no element at doc(" + posX + "," + posY + ")" });
          return;
        }
        const tag = (target.tagName || "div").toLowerCase();
        let selectorPicked = "";
        if ((tag === "input" || tag === "textarea") && target.placeholder) {
          const ph = String(target.placeholder);
          selectorPicked = ph.includes('"') && !ph.includes("'") ? tag + "[placeholder='" + ph + "']" : tag + '[placeholder="' + ph + '"]';
        } else if (target.id) {
          selectorPicked = tag + "#" + target.id;
        } else if (target.className && typeof target.className === "string") {
          const safeClasses = target.className.split(/\s+/).filter(c => c && !c.includes(":")).slice(0, 2);
          const classPart = safeClasses.map(c => "." + c.replace(/[^a-zA-Z0-9_-]/g, "")).join("");
          selectorPicked = classPart ? tag + classPart : tag;
        } else {
          selectorPicked = tag;
        }
        let labelText = "";
        try {
          if (target.id) { const fl = document.querySelector('label[for="' + target.id + '"]'); if (fl) labelText = (fl.innerText || "").trim(); }
          if (!labelText && typeof target.closest === "function") { const pl = target.closest("label"); if (pl) labelText = (pl.innerText || "").trim(); }
        } catch (_) {}
        let elText = "";
        try { elText = (target.innerText || target.textContent || "").trim().slice(0, 200); } catch (_) {}
        let containerTagR = "", containerClassNameR = "";
        try {
          const container = (typeof target.closest === "function" && target.closest("div,section,article,li,td,th")) || target.parentElement;
          if (container) {
            containerTagR = (container.tagName || "").toLowerCase();
            if (container.className && typeof container.className === "string") {
              containerClassNameR = container.className.split(/\s+/).filter(c => c && !c.includes(":")).slice(0, 2).join(" ");
            }
          }
        } catch (_) {}
        ipcRenderer.send("web:result", {
          type: "possel", requestId: reqId, ok: true,
          selector: selectorPicked, elementText: elText, labelText, containerTag: containerTagR, containerClassName: containerClassNameR
        });
      } catch (e) {
        ipcRenderer.send("web:result", { type: "possel", requestId: reqId, ok: false, reason: e && e.message ? e.message : "possel error" });
      }
      return;
    }

    sendStatus("Unhandled web:exec type = " + type);
  } catch (err) {
    console.warn("[WEB] command error:", type, err);
    sendStatus("Error in " + type + ": " + (err && err.message ? err.message : "unknown"));
  }
});

// =========================================================
// startup hooks
// =========================================================

window.addEventListener("focusin", e => {
  try {
    if (e && e.target) LAST_ACTIVE_ELEMENT = e.target;
  } catch (_) {}
});

window.addEventListener("DOMContentLoaded", () => {
console.log("[WEB_PRELOAD_CHECK]", typeof handleUploadFiles);
ensureNotiObserver();
sendStatus("Web preload ready");
});

// contextIsolation=false → assign trực tiếp vào window thay vì dùng contextBridge
window.webInjected = {
  ping: () => "ok",
  getState: () => ({
    running: DETECTLAB_RUNNING,
    paused: DETECTLAB_PAUSED,
    notiRules: Array.isArray(NOTI_RULES) ? NOTI_RULES.length : 0
  })
};

window.__DL_NOTI__ = {
  getRules() {
    return Array.isArray(NOTI_RULES) ? NOTI_RULES : [];
  },
  setRules(rules) {
    NOTI_RULES = Array.isArray(rules) ? rules.filter(Boolean) : [];
    ensureNotiObserver();
    tryHandleNotifications();
    sendLog("[NotiDebug] Rules set from renderer: " + NOTI_RULES.length);
    return NOTI_RULES;
  },
  testNow() {
    ensureNotiObserver();
    return tryHandleNotifications();
  },
  setMode(mode) {
    const valid = ["auto-only", "control-first", "hybrid"];
    NOTI_MODE = valid.includes(mode) ? mode : NOTI_MODE;
    sendLog("[NotiDebug] Mode set from renderer: " + NOTI_MODE);
    return NOTI_MODE;
  }
};

// =========================================================
// Captcha auto-detect watcher
// ---------------------------------------------------------
// Dò dấu hiệu captcha (reCAPTCHA / hCaptcha / Cloudflare Turnstile + pattern
// tuỳ chỉnh). Khi phát hiện → báo main qua ipc "web:captcha-detected"
// (main tự suy slotId từ webContentsId của sender, giống web:result).
// Có debounce + cooldown để không bắn lặp; tự re-arm khi captcha biến mất.
// =========================================================
const CAPTCHA = {
  enabled: true,
  cooldownMs: 12000,
  // text patterns (lowercase, includes-match) — bổ sung từ control qua config
  textPatterns: [
    "i'm not a robot",
    "verify you are human",
    "verifying you are human",
    "unusual traffic",
    "are you a robot",
    "xác minh bạn là người",
    "xác nhận bạn không phải robot",
    "checking your browser",
    "needs to review the security",
  ],
  // iframe/src + URL substrings
  srcPatterns: [
    "google.com/recaptcha",
    "recaptcha/api2",
    "recaptcha/enterprise",
    "hcaptcha.com",
    "challenges.cloudflare.com",
    "turnstile",
    "/cdn-cgi/challenge-platform",
  ],
  // url patterns (location.href includes)
  urlPatterns: [],
  _lastFire: 0,
  _armed: true, // true = sẵn sàng bắn; false = đã bắn, chờ captcha biến mất để re-arm
};

function _captchaVisible(el) {
  if (!el) return false;
  try {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = window.getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
    return true;
  } catch (_) { return true; }
}

// Trả về chuỗi tín hiệu nếu phát hiện captcha, ngược lại null
function detectCaptcha() {
  if (!CAPTCHA.enabled) return null;
  try {
    const href = String(location.href || "").toLowerCase();
    for (const p of CAPTCHA.urlPatterns) {
      if (p && href.includes(String(p).toLowerCase())) return "url:" + p;
    }

    // iframe theo src
    const iframes = document.querySelectorAll("iframe[src]");
    for (const f of iframes) {
      const src = String(f.getAttribute("src") || "").toLowerCase();
      for (const p of CAPTCHA.srcPatterns) {
        if (src.includes(p) && _captchaVisible(f)) return "iframe:" + p;
      }
    }

    // script src (turnstile/recaptcha api loader) — dấu hiệu phụ
    // chỉ tính khi kèm widget container hiển thị
    const widgets = document.querySelectorAll(
      ".g-recaptcha, .h-captcha, #cf-challenge-running, .cf-turnstile, [data-sitekey], #challenge-stage, #challenge-form"
    );
    for (const w of widgets) {
      if (_captchaVisible(w)) return "widget:" + (w.className || w.id || "node");
    }

    // text match — DỄ false-positive nên siết: chỉ tính khi trang giống
    // "trang challenge" (nội dung ngắn) HOẶC title khớp. Trang nội dung dài
    // (bài viết, dashboard…) bỏ qua text signal để tránh báo nhầm.
    const rawText = (document.body && document.body.innerText) ? document.body.innerText : "";
    const title = String(document.title || "").toLowerCase();
    const isShort = rawText.length > 0 && rawText.length < 1500; // challenge page thường rất ngắn
    const titleHit = CAPTCHA.textPatterns.some((t) => t && title.includes(t));
    if (titleHit) return "title:" + (CAPTCHA.textPatterns.find((t) => t && title.includes(t)));
    if (isShort) {
      const bodyText = rawText.slice(0, 4000).toLowerCase();
      for (const t of CAPTCHA.textPatterns) {
        if (t && bodyText.includes(t)) return "text:" + t;
      }
    }
  } catch (_) {}
  return null;
}

function captchaTick() {
  if (!CAPTCHA.enabled) return;
  const signal = detectCaptcha();
  const now = Date.now();

  if (signal) {
    if (CAPTCHA._armed && (now - CAPTCHA._lastFire) > CAPTCHA.cooldownMs) {
      CAPTCHA._armed = false;
      CAPTCHA._lastFire = now;
      try {
        ipcRenderer.send("web:captcha-detected", {
          signal,
          url: location.href,
          ts: now,
        });
      } catch (_) {}
      sendLog("[Captcha] phát hiện: " + signal + " → báo main reset identity");
    }
  } else {
    // không còn captcha → re-arm cho lần sau
    CAPTCHA._armed = true;
  }
}

let _captchaTimer = null;
let _captchaObserver = null;
function startCaptchaWatcher() {
  if (_captchaTimer) return;
  _captchaTimer = setInterval(captchaTick, 1500);
  try {
    _captchaObserver = new MutationObserver(() => {
      // throttle qua _lastFire/cooldown trong captchaTick
      captchaTick();
    });
    if (document.documentElement) {
      _captchaObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  } catch (_) {}
  captchaTick();
}

// Nhận config từ main/control
function _mergeUnique(base, extra) {
  const set = new Set(base.map((x) => String(x).toLowerCase()));
  for (const e of extra) {
    const v = String(e);
    if (!set.has(v.toLowerCase())) { base.push(v); set.add(v.toLowerCase()); }
  }
  return base;
}
ipcRenderer.on("captcha:config", (_e, cfg) => {
  if (!cfg || typeof cfg !== "object") return;
  if (typeof cfg.enabled === "boolean") CAPTCHA.enabled = cfg.enabled;
  if (Number.isFinite(cfg.cooldownMs)) CAPTCHA.cooldownMs = cfg.cooldownMs;
  // MERGE custom patterns vào default (không xoá default)
  if (Array.isArray(cfg.textPatterns)) _mergeUnique(CAPTCHA.textPatterns, cfg.textPatterns);
  if (Array.isArray(cfg.srcPatterns)) _mergeUnique(CAPTCHA.srcPatterns, cfg.srcPatterns);
  if (Array.isArray(cfg.urlPatterns)) _mergeUnique(CAPTCHA.urlPatterns, cfg.urlPatterns);
  // replace toàn bộ nếu yêu cầu rõ (reset patterns)
  if (cfg.replacePatterns) {
    if (Array.isArray(cfg.textPatterns)) CAPTCHA.textPatterns = cfg.textPatterns.map(String);
    if (Array.isArray(cfg.srcPatterns)) CAPTCHA.srcPatterns = cfg.srcPatterns.map(String);
    if (Array.isArray(cfg.urlPatterns)) CAPTCHA.urlPatterns = cfg.urlPatterns.map(String);
  }
  CAPTCHA._armed = true;
  sendLog("[Captcha] config cập nhật: enabled=" + CAPTCHA.enabled);
});

window.__DL_CAPTCHA__ = {
  detectNow: () => detectCaptcha(),
  getConfig: () => ({ ...CAPTCHA }),
  setEnabled: (v) => { CAPTCHA.enabled = !!v; CAPTCHA._armed = true; return CAPTCHA.enabled; },
  addPattern: (kind, p) => {
    const map = { text: "textPatterns", src: "srcPatterns", url: "urlPatterns" };
    const key = map[kind];
    if (key && p) CAPTCHA[key].push(String(p));
    return CAPTCHA[key] ? CAPTCHA[key].length : 0;
  },
};

// Khởi động watcher khi DOM sẵn sàng
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", startCaptchaWatcher, { once: true });
} else {
  startCaptchaWatcher();
}
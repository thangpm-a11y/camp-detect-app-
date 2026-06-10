// Camping Detect Lab – Electron Control version
// Full rewrite for Electron control window
// Architecture kept for Electron bridge via window.controlAPI.execOnWeb(...)

(function () {
  "use strict";

  // =========================================================
  // DOM adapter to Web window
  // =========================================================

function hasControlAPI() {
  return !!(window && window.controlAPI);
}

function safeOnWebResult(handler) {
  try {
    if (hasControlAPI() && typeof window.controlAPI.onWebResult === "function") {
      return window.controlAPI.onWebResult(handler);
    }
  } catch (err) {
    console.warn("[DetectLab] onWebResult bind error:", err);
  }
  return null;
}

safeOnWebResult(data => {
  try {
    if (!data || !data.type) return;

    if (data.type === "pickedPoint" && data.stepId) {
      const index = steps.findIndex(s => s.id === data.stepId);
      if (index >= 0) {
        steps[index].x = data.x;
        steps[index].y = data.y;
        steps[index].clickMode = "point";
        // Cập nhật live vào editor nếu đang mở đúng step này
        if (activeEditorCtx && activeEditorCtx.stepId === data.stepId) {
          if (activeEditorCtx.xInput) activeEditorCtx.xInput.value = String(data.x);
          if (activeEditorCtx.yInput) activeEditorCtx.yInput.value = String(data.y);
          if (activeEditorCtx.clickModeSelect) activeEditorCtx.clickModeSelect.value = "point";
        }
        setLog("Picked point for step " + (steps[index].fieldId || index + 1));
        renderSteps();
      }
      return;
    }

    if (data.type === "pickedSelector" && data.stepId) {
      const index = steps.findIndex(s => s.id === data.stepId);
      if (index >= 0) {
        const rawSel = data.selector || "";

        function buildNiceSelectorFromRaw(raw, extra) {
          const elInfo = extra && extra.tag ? extra : null;

          if (elInfo) {
            const tag = String(elInfo.tag || "div").toLowerCase();

            // 1) Input/textarea có placeholder
            if ((tag === "input" || tag === "textarea") && elInfo.placeholder) {
              const ph = String(elInfo.placeholder);
              // Nếu placeholder chứa dấu " → dùng ngoặc đơn bọc ngoài
              // Nếu placeholder chứa cả " lẫn ' → escape dấu " thành \" (CSS attr selector chấp nhận)
              if (ph.includes('"') && !ph.includes("'")) {
                return `${tag}[placeholder='${ph}']`;
              } else if (ph.includes('"') && ph.includes("'")) {
                const escaped = ph.replace(/"/g, '\\"');
                return `${tag}[placeholder="${escaped}"]`;
              }
              return `${tag}[placeholder="${ph}"]`;
            }

            // 2) Có id thì dùng id
            if (elInfo.id) {
              return `${tag}#${CSS.escape(elInfo.id)}`;
            }

            // 3) Fallback: 1–2 class an toàn
            const rawClasses = String(elInfo.className || "")
              .split(/\s+/)
              .filter(Boolean);

            const safeClasses = rawClasses
              .filter(c => !c.includes(":"))
              .slice(0, 2);

            const classPart = safeClasses
              .map(c => "." + CSS.escape(c))
              .join("");

            if (classPart) {
              return tag + classPart;
            }
          }

          if (!raw) return "";

          // Nếu raw đã là selector có placeholder hoặc id, giữ nguyên
          if (raw.indexOf("placeholder") >= 0 || raw.indexOf("#") >= 0) {
            return raw;
          }

          const parts = raw.split(".");
          if (parts.length <= 1) return raw;

          const tag = parts[0] || "div";

          const safeClasses = parts
            .slice(1)
            .filter(c => c && !c.includes(":"))
            .slice(0, 2);

          return safeClasses.length
            ? tag + "." + safeClasses.join(".")
            : tag;
        }

        const niceSelector = buildNiceSelectorFromRaw(rawSel, data.elInfo || null);
        const step = steps[index];

        step.selector = niceSelector || rawSel || "";
        step.x = data.x;
        step.y = data.y;
        step.clickMode = "selector";

        const info = data.elInfo || {};
        step.labelText = String(info.labelText || "").trim();
        step.elementText = String(info.elementText || "").trim();
        step.containerTag = String(info.containerTag || "").trim();
        step.containerClassName = String(info.containerClassName || "").trim();

        // Cập nhật live vào editor nếu đang mở đúng step này
        if (activeEditorCtx && activeEditorCtx.stepId === data.stepId) {
          if (activeEditorCtx.selectorInput) activeEditorCtx.selectorInput.value = step.selector;
          if (activeEditorCtx.xInput) activeEditorCtx.xInput.value = String(data.x);
          if (activeEditorCtx.yInput) activeEditorCtx.yInput.value = String(data.y);
          if (activeEditorCtx.clickModeSelect) activeEditorCtx.clickModeSelect.value = "selector";
        }
        setLog("Picked selector for step " + (step.fieldId || index + 1));
        renderSteps();
      }
      return;
    }

    // ── noti:request: web phát hiện dialog, chờ control quyết định ──
    if (data.type === "noti:request") {
      const sid = Number(data.slotId) || 1;
      const st = slotStates[sid];
      if (st) {
        // Tránh duplicate requestId
        if (!st.pendingNotiRequests.find(r => r.requestId === data.requestId)) {
          st.pendingNotiRequests.push({
            requestId: data.requestId,
            dialogText: data.dialogText || "",
            matchedRule: data.matchedRule || null,
            availableActions: data.availableActions || [],
            ts: data.ts || Date.now(),
            slotId: sid
          });

          renderPendingNotiPanel();
          highlightNotiTab();
        }
      }
      return;
    }

    // ── noti:resolved / noti:timeout / noti:ignored: dọn pending ──
    if (data.type === "noti:resolved" || data.type === "noti:timeout" || data.type === "noti:ignored") {
      const sid = Number(data.slotId) || 1;
      const st = slotStates[sid];
      if (st) {
        st.pendingNotiRequests = st.pendingNotiRequests.filter(r => r.requestId !== data.requestId);
        renderPendingNotiPanel();
        highlightNotiTab();
      }
      return;
    }

  } catch (err) {
    console.warn("[DetectLab] web result handler error:", err, data);
  }
});

function domExec(payload, execSlotId) {
  try {
    if (!hasControlAPI() || typeof window.controlAPI.execOnWeb !== "function") {
      console.warn("[DetectLab] controlAPI.execOnWeb not available", payload);
      return null;
    }

    // Gắn slotId vào payload để main.js route đúng web window
    // execSlotId: slot đang chạy (không đổi khi switch tab), activeSlotId: fallback
    const targetSlot = execSlotId || activeSlotId;
    const enriched = payload && typeof payload === "object"
      ? { ...payload, slotId: targetSlot }
      : payload;
    const res = window.controlAPI.execOnWeb(enriched);
    return res;
  } catch (err) {
    console.warn("[DetectLab] execOnWeb error:", err, payload);
    return null;
  }
}

function domGetText(selector, _slotId) {
  return new Promise(resolve => {
    const requestId = "getText-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const handler = data => {
      try {
        if (!data) return;
        if (data.type === "getText" && data.requestId === requestId) {
          resolve(typeof data.text === "string" ? data.text : "");
        }
      } catch (err) {
        console.warn("[DetectLab] domGetText handler error:", err);
        resolve("");
      }
    };
    safeOnWebResult(handler);
    domExec({ type: "getText", selector, requestId }, _slotId);
  });
}

// Read text using the full step payload — same selector resolution as click/hover.
// Forwards labelText/elementText/containerTag/x/y so a wide recorded selector
// narrows to the specific picked field instead of returning whole-page text.
function domGetTextForStep(step, _slotId, rowObj, _dvars) {
  return new Promise(resolve => {
    const requestId = "getText-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    let done = false;
    let off = null;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { if (typeof off === "function") off(); } catch (_) {}
      resolve(val);
    };
    const handler = data => {
      try {
        if (!data) return;
        if (data.type === "getText" && data.requestId === requestId) {
          finish(typeof data.text === "string" ? data.text : "");
        }
      } catch (err) {
        console.warn("[DetectLab] domGetTextForStep handler error:", err);
        finish("");
      }
    };
    off = safeOnWebResult(handler);
    const payload = buildSelectorPayloadFromStep(step, rowObj, _dvars);
    domExec({
      type: "getText",
      ...payload,
      x: step && typeof step.x === "number" ? step.x : undefined,
      y: step && typeof step.y === "number" ? step.y : undefined,
      requestId
    }, _slotId);
    // Không treo vô hạn nếu web không phản hồi (slot chưa mở / sai trang)
    setTimeout(() => { if (!done) { console.warn("[DetectLab] getText timeout", requestId); finish("__NO_RESPONSE__"); } }, 8000);
  });
}

// Hiện overlay step-builder trên slot web, chờ user nhập + Save → trả {ok, stepType, fields}
function domShowStepBuilder(stepType, _slotId) {
  return new Promise(resolve => {
    const requestId = "stepBuilder-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    let done = false;
    let off = null;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { if (typeof off === "function") off(); } catch (_) {}
      resolve(val);
    };
    let gotAck = false;
    const handler = data => {
      if (!data || data.type !== "stepBuilder" || data.requestId !== requestId) return;
      if (data.ack) { gotAck = true; return; }
      finish(data);
    };
    off = safeOnWebResult(handler);
    domExec({ type: "showStepBuilder", stepType, requestId }, _slotId);
    // Nếu 3s không có ack → slot chưa mở / sai trang
    setTimeout(() => { if (!done && !gotAck) finish({ ok: false, noResponse: true }); }, 3000);
  });
}

function domReadHtmlForStep(step, _slotId, rowObj, _dvars) {
  return new Promise(resolve => {
    const requestId = "getHtml-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const handler = data => {
      try {
        if (!data) return;
        if (data.type === "getHtml" && data.requestId === requestId) {
          resolve(typeof data.html === "string" ? data.html : "");
        }
      } catch (err) {
        console.warn("[DetectLab] domReadHtmlForStep handler error:", err);
        resolve("");
      }
    };
    safeOnWebResult(handler);
    const payload = buildSelectorPayloadFromStep(step, rowObj, _dvars);
    domExec({
      type: "getHtml",
      ...payload,
      x: step && typeof step.x === "number" ? step.x : undefined,
      y: step && typeof step.y === "number" ? step.y : undefined,
      requestId
    }, _slotId);
  });
}

  function buildSelectorPayloadFromStep(step, rowObj, _dvars) {
    if (!step) return {};

    // elementText có thể lấy từ sheet column hoặc var
    let elementText = step.elementText || "";
    if (step.elementTextColumn && rowObj) {
      const fromSheet = getCellValueByColumn(rowObj, step.elementTextColumn);
      if (fromSheet) elementText = String(fromSheet);
    } else if (step.elementTextVar && _dvars) {
      const fromVar = _dvars[String(step.elementTextVar).trim()];
      if (fromVar != null) elementText = String(fromVar);
    } else if (elementText && _dvars) {
      // support {{varName}} template trong elementText
      elementText = elementText.replace(/\{\{([^}]+)\}\}/g, (m, k) => {
        const v = _dvars[String(k).trim()];
        return v != null ? String(v) : m;
      });
    }

    return {
      selector: step.selector || "",
      // lớp ngữ nghĩa
      labelText: step.labelText || "",
      elementText,
      // lớp vùng
      containerTag: step.containerTag || "",
      containerClassName: step.containerClassName || ""
    };
  }

  function domClickSelectorForStep(step, _slotId, rowObj, _dvars) {
    const payload = buildSelectorPayloadFromStep(step, rowObj, _dvars);
    return domExec({
      type: "clickSelector",
      ...payload,
      x: step && typeof step.x === "number" ? step.x : undefined,
      y: step && typeof step.y === "number" ? step.y : undefined
    }, _slotId);
  }

  function domClickPoint(x, y, _slotId) {
    return domExec({ type: "clickPoint", x, y }, _slotId);
  }

  function domHoverSelectorForStep(step, _slotId, rowObj, _dvars) {
    const payload = buildSelectorPayloadFromStep(step, rowObj, _dvars);
    return domExec({
      type: "hoverSelector",
      ...payload
    }, _slotId);
  }

function domSetValueForStep(step, value, _slotId, rowObj, _dvars) {
const payload = buildSelectorPayloadFromStep(step, rowObj, _dvars);
return domExec({
type: "setValue",
...payload,
value
}, _slotId);
}

async function domUploadFilesForStep(step, files, _slotId, rowObj, _dvars) {
  const payload = buildSelectorPayloadFromStep(step, rowObj, _dvars);
  const safeFiles = Array.isArray(files) ? files.filter(Boolean) : [];
  return domExec({
    type: "uploadFiles",
    ...payload,
    // vẫn gửi selector/labelText/elementText nếu có,
    // nhưng kể cả rỗng thì web vẫn xử lý được
    files: safeFiles
  }, _slotId);
}

// NOTE: buildUploadFilesForStep được định nghĩa 1 lần duy nhất ở phía dưới
// (gần startDownloadMediaFromSheet). Bản trùng ở đây đã được gỡ bỏ.

function domScrollIntoViewForStep(step, _slotId, rowObj, _dvars) {
const payload = buildSelectorPayloadFromStep(step, rowObj, _dvars);
return domExec({
type: "scrollIntoView",
...payload
}, _slotId);
}

  function domPressKey(key, _slotId) {
    return domExec({ type: "pressKey", key }, _slotId);
  }

  function domReadHtml(selector, _slotId) {
    return new Promise(resolve => {
      const requestId = "getHtml-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const handler = data => {
        try {
          if (!data) return;
          if (data.type === "getHtml" && data.requestId === requestId) {
            resolve(typeof data.html === "string" ? data.html : "");
          }
        } catch (err) {
          console.warn("[DetectLab] domReadHtml handler error:", err);
          resolve("");
        }
      };
      safeOnWebResult(handler);
      domExec({ type: "getHtml", selector, requestId }, _slotId);
    });
  }

  // =========================================================
  // Multi-slot state management
  // =========================================================

const MAX_SLOTS = 3;
let activeSlotId = 1;

// Lưu giá trị READ gần nhất theo "slotId:stepId" để hiển thị trên card (không persist).
const lastReadByStep = {};
// Lưu kết quả CONDITION gần nhất (true/false) theo "slotId:stepId".
const lastConditionByStep = {};
function readKey(slotId, step) {
  return String(slotId) + ":" + String((step && step.id) || (step && step.fieldId) || "");
}

/**
 * Tạo state mặc định cho 1 slot.
 * Mỗi slot có toàn bộ runtime state độc lập.
 */
function createSlotState(slotId) {
  return {
    slotId,
    sidebarEl: null,
    steps: [],
    patterns: {},
    notiRules: [],
    imageLibrary: [],
    mediaItems: [], // [{ id, fileName, localPath, rowId, slotId, status, mime, selected }]
    detectLabVars: {},
    rowData: {},
    rawRowArray: [],
    startRow: 2, // dòng bắt đầu của sheet — riêng theo slot (parallel-safe)
    endRowLimit: 0, // dòng kết thúc cứng (0 = auto) — riêng theo slot, KHÁC với cờ endRow
    running: false, // slot đang chạy vòng lặp hay không (parallel-safe)
    currentRowRunning: null,
    currentStepRunning: null,
    currentStepIndexForResume: 0,
    runningRangeEnd: null,
    isRunningRange: false,
    draggingIndex: null,
    paused: false,
    stopped: false,
    // ── Noti 2-way ──
    pendingNotiRequests: [], // [{ requestId, dialogText, matchedRule, availableActions, ts, slotId }]
    notiMode: "hybrid" // "auto-only" | "control-first" | "hybrid"
  };
}

// Khởi tạo sẵn 3 slot
const slotStates = {
  1: createSlotState(1),
  2: createSlotState(2),
  3: createSlotState(3)
};

/** Trả về state của slot đang active */
function S() {
  return slotStates[activeSlotId] || slotStates[1];
}

/** Switch sang slot khác — lưu UI slot cũ, restore UI slot mới */
function switchToSlot(slotId) {
  const id = Number(slotId);
  if (!slotStates[id]) return;
  if (id === activeSlotId) return;
  flushProxies();
  activeSlotId = id;
  syncProxies();
  // Re-render toàn bộ UI theo slot mới
  renderActiveSlotUI();
  // Thông báo cho preview panel (index-2.html) để sync active highlight
  if (typeof window.__previewSetActiveSlot === "function") {
    window.__previewSetActiveSlot(id);
  }
}

// Expose cho preview panel gọi ngược lại (click card → switch tab)
window.__detectlabSwitchSlot = function (slotId) {
  switchToSlot(Number(slotId));
  // renderSlotTabs được gắn vào sidebarEl sau khi sidebar init
  if (sidebarEl && typeof sidebarEl.renderSlotTabs === "function") {
    sidebarEl.renderSlotTabs();
  }
};

  // =========================================================
  // Globals (proxy sang slot state active)
  // Các getter/setter này giữ cho toàn bộ code cũ không cần sửa
  // =========================================================

  // sidebarEl — đối tượng DOM sidebar, mỗi slot có thể có sidebar riêng
  // (hiện tại chỉ 1 sidebar — sẽ mở rộng sau)
  let sidebarEl = null;

  Object.defineProperties(window, {
    DETECTLABPAUSED: {
      get() { return S().paused; },
      set(v) { S().paused = !!v; },
      configurable: true
    },
    DETECTLABSTOPPED: {
      get() { return S().stopped; },
      set(v) { S().stopped = !!v; },
      configurable: true
    }
  });

window.__DL_DEBUG__ = {
get slotId() { return activeSlotId; },
get state() { return S(); },
get rowData() { return S().rowData; },
get raw() { return S().rawRowArray; },
get allSlots() { return slotStates; }
};

// Lắng nghe media:index-updated từ main để refresh tab Image
if (window.controlAPI && typeof window.controlAPI.on === "function") {
window.controlAPI.on("media:index-updated", data => {
try {
if (!data || !Array.isArray(data.items)) return;
mediaItems = data.items.slice();
S().mediaItems = mediaItems;
if (typeof window.renderMediaPanel === "function") window.renderMediaPanel();
} catch (err) {
console.warn("[DetectLab] media:index-updated handler error:", err);
}
});

// Sync noti rules mỗi khi trang web load xong
// Đảm bảo rules luôn được inject vào noti-inject.js kể cả khi app mới start
window.controlAPI.on("slot:page-loaded", data => {
  try {
    const slotId = (data && data.slotId) || activeSlotId;
    const st = slotStates[slotId] || S();
    const rules = (st.notiRules || notiRules || [])
      .filter(r => r && r.enabled !== false && r.pattern && String(r.pattern).trim())
      .map(r => ({
        pattern: String(r.pattern || "").toLowerCase(),
        choice: String(r.choice || "ok").toLowerCase() === "cancel" ? "cancel" : "ok"
      }));
    if (rules.length && hasControlAPI() && typeof window.controlAPI.syncNotiRules === "function") {
      window.controlAPI.syncNotiRules(slotId, rules).catch(() => {});
      console.log("[DetectLab] slot:page-loaded → synced", rules.length, "noti rules for slot", slotId);
    }
  } catch (err) {
    console.warn("[DetectLab] slot:page-loaded noti sync error:", err);
  }
});
}

  // Expose slot states để preview panel đọc step/row hiện tại theo slot
  window.__DL_SLOT_STATES__ = slotStates;

  // ── Groups (dùng chung mọi slot) ───────────────────────────────
  // groups = { [name]: { name, steps: [...stepObjects], ts } }
  let groups = {};
  // Step được tick chọn (theo step.id) để gộp thành group
  let selectedStepIds = new Set();
  // Group được tick chọn (theo tên) để combine
  let selectedGroupNames = new Set();
  // Trạng thái gấp/mở của group trong danh sách Steps (theo tên group)
  const groupCollapsed = {};
  // Group rỗng vừa tạo (chưa có step) — hiện placeholder để kéo step vào
  let pendingEmptyGroups = [];
  // Đang kéo cả 1 group (mảng step object) để đổi vị trí
  let draggingGroupSteps = null;
  // Editor step đang mở — để picker (Pos/Sel) cập nhật live vào các ô của editor
  let activeEditorCtx = null;

  // Proxy shortcuts — các hàm cũ dùng trực tiếp các biến này
  // Hướng dẫn: KHÔNG dùng các biến này trong hàm mới,
  //              thay vào đó dùng S().steps, S().rowData, v.v.
let steps,
patterns,
notiRules,
imageLibrary,
mediaItems,
detectLabVars,
rowData,
rawRowArray,
currentRowRunning,
currentStepRunning,
currentStepIndexForResume,
runningRangeEnd,
isRunningRange,
draggingIndex;

  /**
   * Đồng bộ proxy shortcuts từ slot state hiện tại.
   * Gọi sau mỗi lần switch slot và ở đầu mọi entry point async.
   */
function syncProxies() {
const st = S();
steps = st.steps;
patterns = st.patterns;
notiRules = st.notiRules;
imageLibrary = st.imageLibrary;
mediaItems = st.mediaItems;
detectLabVars = st.detectLabVars;
rowData = st.rowData;
rawRowArray = st.rawRowArray;
currentRowRunning = st.currentRowRunning;
currentStepRunning = st.currentStepRunning;
currentStepIndexForResume= st.currentStepIndexForResume;
runningRangeEnd = st.runningRangeEnd;
isRunningRange = st.isRunningRange;
draggingIndex = st.draggingIndex;
}

  /**
   * Ghi proxy shortcuts ngược vào slot state.
   * Gọi trước khi switch slot hoặc khi cần persist.
   */
function flushProxies() {
const st = S();
st.steps = steps;
st.patterns = patterns;
st.notiRules = notiRules;
st.imageLibrary = imageLibrary;
st.mediaItems = mediaItems;
st.detectLabVars = detectLabVars;
st.rowData = rowData;
st.rawRowArray = rawRowArray;
st.currentRowRunning = currentRowRunning;
st.currentStepRunning = currentStepRunning;
st.currentStepIndexForResume = currentStepIndexForResume;
st.runningRangeEnd = runningRangeEnd;
st.isRunningRange = isRunningRange;
st.draggingIndex = draggingIndex;
}

  // Sync ngay khi khởi động
  syncProxies();

  // =========================================================
  // Storage keys
  // =========================================================

  /**
   * STORAGE_KEYS — trả về keys có prefix theo slotId.
   * Slot 1 giữ key gốc (để backward compat với dữ liệu cũ).
   * Slot 2, 3 dùng key có suffix `_s2`, `_s3`.
   */
  function STORAGE_KEYS(slotId) {
    const id = slotId || activeSlotId || 1;
    const sfx = id === 1 ? "" : `_s${id}`;
    return {
      // PATTERNS, NOTI, GROUPS dùng CHUNG cho mọi slot (không có suffix)
      // → tab Pattern / Noti / Groups được đồng bộ hóa giữa các slot.
      PATTERNS:        "campDetectPatterns",
      NOTI:            "campDetectNotiRules",
      GROUPS:          "campDetectGroups",
      // IMAGES (tab Media) tách RIÊNG theo từng slot.
      IMAGES:          "campDetectImages"            + sfx,
      // Các state còn lại vẫn riêng theo từng slot
      ROW_STATE:       "detectlabRowState"           + sfx,
      CURRENT_PATTERN: "detectlabCurrentPatternName" + sfx,
      SHEET_DATA:      "detectlabSheetData"          + sfx,
      RAW_ROW_ARRAY:   "detectlabRawRowArray"        + sfx,
      SHEET_CONFIG:    "detectlabSheetConfig"        + sfx
    };
  }

  // =========================================================
  // Storage helpers
  // =========================================================

  function loadJsonFromStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      console.warn("[DetectLab] loadJsonFromStorage error:", key, err);
      return fallback;
    }
  }

  function saveJsonToStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn("[DetectLab] saveJsonToStorage error:", key, err);
    }
  }

  // =========================================================
  // Utils
  // =========================================================

  function deepClone(v) {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return v;
    }
  }

  function wait(ms) {
    const delay = typeof ms === "number" && ms >= 0 ? ms : 0;
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  function uid(prefix) {
    return (
      (prefix || "id") +
      "-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2, 9)
    );
  }

  function normalizeText(v) {
    return typeof v === "string" ? v.trim() : "";
  }

  function toNumber(v, fallback) {
    const n = parseInt(String(v ?? "").trim(), 10);
    return Number.isNaN(n) ? fallback : n;
  }

  function cssEllipsis(el) {
    if (!el) return;
    el.style.overflow = "hidden";
    el.style.textOverflow = "ellipsis";
    el.style.whiteSpace = "nowrap";
  }

  function setStatus(text, tone) {
    if (!sidebarEl || !sidebarEl.statusBox) return;
    const box = sidebarEl.statusBox;
    box.textContent = text || "Idle";

    if (tone === "error") {
      box.style.background = "linear-gradient(90deg,#f97373,#ef4444)";
      box.style.color = "#ffffff";
      return;
    }
    if (tone === "warn") {
      box.style.background = "linear-gradient(90deg,#facc15,#eab308)";
      box.style.color = "#111827";
      return;
    }
    if (tone === "run") {
      box.style.background = "linear-gradient(90deg,#38bdf8,#2563eb)";
      box.style.color = "#020617";
      return;
    }
    if (tone === "ok") {
      box.style.background = "linear-gradient(90deg,#22c55e,#16a34a)";
      box.style.color = "#052e16";
      return;
    }

    box.style.background = "linear-gradient(90deg,#334155,#1f2937)";
    box.style.color = "#e5e7eb";
  }

  function setLog(text) {
    if (!sidebarEl || !sidebarEl.logBox) return;
    sidebarEl.logBox.textContent = text || "Idle";
  }

  function getCurrentPatternName() {
    // Đọc từ localStorage — source of truth, không dùng DOM text (dễ bị cắt bởi ellipsis)
    const stored = loadJsonFromStorage(STORAGE_KEYS().CURRENT_PATTERN, "");
    return typeof stored === "string" ? stored.trim() : "";
  }

  function setCurrentPatternName(name) {
    const clean = normalizeText(name);
    if (sidebarEl && sidebarEl.currentPatternLabel) {
      sidebarEl.currentPatternLabel.textContent = "Pattern: " + (clean || "none");
    }
    saveJsonToStorage(STORAGE_KEYS().CURRENT_PATTERN, clean || "");
  }

  function getWindowConfigFromUI() {
    if (!sidebarEl) {
      return { windowWidth: null, windowHeight: null, zoom: null };
    }
    const w = toNumber(sidebarEl.winWInput && sidebarEl.winWInput.value, null);
    const h = toNumber(sidebarEl.winHInput && sidebarEl.winHInput.value, null);
    const z = sidebarEl.zoomSelect && sidebarEl.zoomSelect.value
      ? String(sidebarEl.zoomSelect.value).trim()
      : "";

    return {
      windowWidth: !w || w <= 0 ? null : w,
      windowHeight: !h || h <= 0 ? null : h,
      zoom: z || null
    };
  }

  function applyWindowConfig(cfg) {
    if (!cfg) return;
    try {
      domExec({
        type: "applyWindowConfig",
        width: cfg.windowWidth || null,
        height: cfg.windowHeight || null,
        zoom: cfg.zoom || null
      });
    } catch (err) {
      console.warn("[DetectLab] applyWindowConfig error:", err);
    }
  }

function saveRowState() {
  if (!sidebarEl) return;
  const st = {
    startRow: toNumber(sidebarEl.startInput && sidebarEl.startInput.value, 2),
    endRow: toNumber(sidebarEl.endInput && sidebarEl.endInput.value, 0),
    currentRow: toNumber(sidebarEl.currentRowInput && sidebarEl.currentRowInput.value, 2),
    windowWidth: toNumber(sidebarEl.winWInput && sidebarEl.winWInput.value, null),
    windowHeight: toNumber(sidebarEl.winHInput && sidebarEl.winHInput.value, null),
    zoom: sidebarEl.zoomSelect && sidebarEl.zoomSelect.value
      ? String(sidebarEl.zoomSelect.value)
      : null
  };
  saveJsonToStorage(STORAGE_KEYS().ROW_STATE, st);
  // Đồng bộ startRow + endRowLimit vào slot state (parallel-safe)
  if (typeof st.startRow === "number" && st.startRow >= 2) S().startRow = st.startRow;
  S().endRowLimit = (typeof st.endRow === "number" && st.endRow >= 2) ? st.endRow : 0;

  const sheetCfg = {
    baseUrl: sidebarEl.sheetBaseInput ? String(sidebarEl.sheetBaseInput.value || "").trim() : "",
    returnUrl: sidebarEl.sheetReturnInput ? String(sidebarEl.sheetReturnInput.value || "").trim() : "",
    sheetId: sidebarEl.sheetIdInput ? String(sidebarEl.sheetIdInput.value || "").trim() : "",
    sheetName: sidebarEl.sheetTabInput ? String(sidebarEl.sheetTabInput.value || "").trim() : ""
  };
  saveJsonToStorage(STORAGE_KEYS().SHEET_CONFIG, sheetCfg);
}

function restoreStateFromStorage() {
  const st = loadJsonFromStorage(STORAGE_KEYS().ROW_STATE, null);
  if (st && sidebarEl) {
    if (typeof st.startRow === "number" && st.startRow >= 2 && sidebarEl.startInput) {
      sidebarEl.startInput.value = String(st.startRow);
      S().startRow = st.startRow; // giữ startRow theo slot (parallel-safe)
    }
    if (typeof st.endRow === "number" && st.endRow >= 0 && sidebarEl.endInput) {
      sidebarEl.endInput.value = String(st.endRow);
      S().endRowLimit = st.endRow >= 2 ? st.endRow : 0;
    }
    if (typeof st.currentRow === "number" && st.currentRow >= 2 && sidebarEl.currentRowInput) {
      sidebarEl.currentRowInput.value = String(st.currentRow);
      currentRowRunning = st.currentRow;
    }
    // BUG FIX: nếu slot đang/đã chạy thì ưu tiên row LIVE (_st.currentRowRunning)
    // thay vì giá trị cũ lưu trong storage (tránh hiện row stale khi switch slot lại).
    const liveRow = S().currentRowRunning;
    if (typeof liveRow === "number" && liveRow >= 2 && sidebarEl.currentRowInput) {
      sidebarEl.currentRowInput.value = String(liveRow);
      currentRowRunning = liveRow;
    }
    if (typeof st.windowWidth === "number" && st.windowWidth > 0 && sidebarEl.winWInput) {
      sidebarEl.winWInput.value = String(st.windowWidth);
    }
    if (typeof st.windowHeight === "number" && st.windowHeight > 0 && sidebarEl.winHInput) {
      sidebarEl.winHInput.value = String(st.windowHeight);
    }
    if (st.zoom && sidebarEl.zoomSelect) {
      sidebarEl.zoomSelect.value = String(st.zoom);
    }
  }

  const sheetCfg = loadJsonFromStorage(STORAGE_KEYS().SHEET_CONFIG, null);
  if (sheetCfg && typeof sheetCfg === "object" && sidebarEl) {
    if (sidebarEl.sheetBaseInput && sheetCfg.baseUrl) {
      sidebarEl.sheetBaseInput.value = String(sheetCfg.baseUrl);
    }
    if (sidebarEl.sheetReturnInput && sheetCfg.returnUrl) {
      sidebarEl.sheetReturnInput.value = String(sheetCfg.returnUrl);
    }
    if (sidebarEl.sheetIdInput && sheetCfg.sheetId) {
      sidebarEl.sheetIdInput.value = String(sheetCfg.sheetId);
    }
    if (sidebarEl.sheetTabInput && sheetCfg.sheetName) {
      sidebarEl.sheetTabInput.value = String(sheetCfg.sheetName);
    }
    console.log("[DetectLab] loaded sheet config", sheetCfg);
  }

  const curPattern = loadJsonFromStorage(STORAGE_KEYS().CURRENT_PATTERN, "");
  if (curPattern) {
    setCurrentPatternName(curPattern);
  } else {
    setCurrentPatternName("");
  }

  rowData = loadJsonFromStorage(STORAGE_KEYS().SHEET_DATA, {}) || {};
  rawRowArray = loadJsonFromStorage(STORAGE_KEYS().RAW_ROW_ARRAY, []) || [];

  if (sidebarEl) {
    if (sidebarEl.startInput) sidebarEl.startInput.addEventListener("change", saveRowState);
    if (sidebarEl.endInput) sidebarEl.endInput.addEventListener("change", saveRowState);
    if (sidebarEl.currentRowInput) sidebarEl.currentRowInput.addEventListener("change", saveRowState);
    if (sidebarEl.winWInput) sidebarEl.winWInput.addEventListener("change", saveRowState);
    if (sidebarEl.winHInput) sidebarEl.winHInput.addEventListener("change", saveRowState);
    if (sidebarEl.zoomSelect) sidebarEl.zoomSelect.addEventListener("change", saveRowState);
    if (sidebarEl.sheetBaseInput) sidebarEl.sheetBaseInput.addEventListener("change", saveRowState);
    if (sidebarEl.sheetReturnInput) sidebarEl.sheetReturnInput.addEventListener("change", saveRowState);
    if (sidebarEl.sheetIdInput) sidebarEl.sheetIdInput.addEventListener("change", saveRowState);
    if (sidebarEl.sheetTabInput) sidebarEl.sheetTabInput.addEventListener("change", saveRowState);
  }
}

window.DetectLabGetSheetConfig = function DetectLabGetSheetConfig() {
  if (!sidebarEl) return null;
  const baseUrl = sidebarEl.sheetBaseInput ? String(sidebarEl.sheetBaseInput.value || "").trim() : "";
  const returnUrl = sidebarEl.sheetReturnInput ? String(sidebarEl.sheetReturnInput.value || "").trim() : "";
  const sheetId = sidebarEl.sheetIdInput ? String(sidebarEl.sheetIdInput.value || "").trim() : "";
  const sheetName = sidebarEl.sheetTabInput ? String(sidebarEl.sheetTabInput.value || "").trim() : "";
  return { baseUrl, returnUrl, sheetId, sheetName };
};

// =========================================================
// Default step factory
// =========================================================

function createDefaultStep(index) {
return {
id: uid("step"),
fieldId: "Step " + index,
type: "click",
action: "click",
selector: "",
// column: cột URL (Drive link, image URL,...)
column: "",
// fileNameColumn: cột tên file khi download media
fileNameColumn: "",
value: "",
url: "",
conditionExpr: "",
// Operator-based comparison:
//   cell(conditionValueColumn, current row)  [conditionOp]  conditionValue
// `conditionValue` is a FIXED literal typed by the user (independent from
// `value` used by input/open/popup steps). Supports plain text, numbers,
// "true"/"false", or {{varName}} substitution.
// `conditionValueColumn` is a sheet column letter; the cell from that column
// for the current row is the dynamic side of the comparison.
conditionOp: "",     // "" | equal | exact | different | contain | > | < | >= | <=
conditionValueColumn: "",
conditionValue: "",
// What to do when the condition evaluates TRUE:
//   "jump" → jump to step có id = conditionJumpTo (id ổn định, không theo số thứ tự)
//   "stop" → stop the row's pattern
conditionTrueMode: "stop",
conditionJumpTo: "",
sessionName: "",
x: undefined,
y: undefined,
clickMode: "selector",
delayMs: 300,
waitBeforeMs: 0,
waitAfterMs: 0,
enabled: true,
note: "",
matchText: "",
key: "",
readMode: "text",
resultKey: ""
};
}

function normalizeStep(step, index) {
const base = createDefaultStep(index + 1);
const merged = Object.assign({}, base, step || {});
if (!merged.id) merged.id = uid("step");
if (!merged.fieldId) merged.fieldId = "Step " + (index + 1);
if (!merged.type) merged.type = "click";
if (!merged.action) merged.action = merged.type;
if (!merged.clickMode) merged.clickMode = "selector";
if (typeof merged.enabled !== "boolean") merged.enabled = true;
if (typeof merged.delayMs !== "number") merged.delayMs = toNumber(merged.delayMs, 300);
if (typeof merged.waitBeforeMs !== "number") merged.waitBeforeMs = toNumber(merged.waitBeforeMs, 0);
if (typeof merged.waitAfterMs !== "number") merged.waitAfterMs = toNumber(merged.waitAfterMs, 0);
if (!merged.readMode) merged.readMode = "text";
if (merged.url == null) merged.url = "";
if (merged.conditionExpr == null) merged.conditionExpr = "";
if (merged.conditionOp == null) merged.conditionOp = "";
if (merged.conditionValueColumn == null) merged.conditionValueColumn = "";
if (merged.conditionValue == null) merged.conditionValue = "";
if (!merged.conditionTrueMode) merged.conditionTrueMode = "stop";
if (merged.conditionJumpTo == null) merged.conditionJumpTo = "";
if (merged.sessionName == null) merged.sessionName = "";

// backward compat: pattern cũ chưa có fileNameColumn
if (typeof merged.fileNameColumn !== "string") {
merged.fileNameColumn = "";
}

if ((merged.type === "open" || merged.type === "opentab") && !String(merged.url || "").trim()) {
merged.url = String(merged.value || "").trim();
}

// Read step KHÔNG dùng column nữa — dọn column khỏi step cũ để không hiện pill
// và không ghi nhầm vào sheet data.
if (merged.type === "read") {
merged.column = "";
}

return merged;
}

  function normalizeAllSteps() {
    steps = (steps || []).map((step, index) => normalizeStep(step, index)); 
 }
  window.detectLabDebug = {
  get steps() { return steps; },
  get notiRules() { return notiRules; },
  get activeSlotId() { return activeSlotId; },
  sendNotiRules() { sendAllNotiRulesToPage(); return "sent " + (notiRules||[]).length + " rules"; }
};

  /**
   * Re-render toàn bộ UI control theo slot đang active.
   * Gọi sau mỗi lần switch slot.
   */
function renderActiveSlotUI() {
if (!sidebarEl) return;
syncProxies();

// Restore config inputs từ storage của slot mới
patterns = loadJsonFromStorage(STORAGE_KEYS().PATTERNS, {}) || {};
notiRules = loadJsonFromStorage(STORAGE_KEYS().NOTI, []) || [];
imageLibrary = loadJsonFromStorage(STORAGE_KEYS().IMAGES, []) || [];
S().patterns = patterns;
S().notiRules = notiRules;
S().imageLibrary = imageLibrary;

// Media index được load từ main (theo app scope), sau đó filter theo slot nếu cần
if (Array.isArray(S().mediaItems) && !Array.isArray(mediaItems)) {
  mediaItems = S().mediaItems;
}

restoreStateFromStorage();
normalizeAllSteps();
renderSteps();
  renderPatternsPanel();
  renderImagesPanel();
  if (typeof window.refreshMediaIndexFromMain === "function") window.refreshMediaIndexFromMain();
  renderNotiRulesPanel();
if (typeof window.renderMediaPanel === "function") window.renderMediaPanel();

setStatus("Slot " + activeSlotId + " ready", null);
setLog("Switched to Slot " + activeSlotId);

// Sync noti rules lên main ngay sau khi switch slot
// Dùng setTimeout nhỏ để đảm bảo sendAllNotiRulesToPage đã được define
setTimeout(() => {
  try { if (typeof sendAllNotiRulesToPage === "function") sendAllNotiRulesToPage(); } catch(_) {}
}, 100);

if (sidebarEl.renderSlotTabs) sidebarEl.renderSlotTabs();
  }
  // =========================================================
  // Row data helpers
  // =========================================================

  // Called from Electron bridge / preload to inject Google Sheet data
  // rawRows: [ [header1, header2, ...], [row2col1, row2col2, ...], ... ]
  window.DetectLabInjectSheetData = function DetectLabInjectSheetData(rawRows) {
    try {
      if (!Array.isArray(rawRows) || !rawRows.length) {
        console.warn("[DetectLab] DetectLabInjectSheetData empty rawRows");
        return;
      }
      rawRowArray = rawRows;
      saveJsonToStorage(STORAGE_KEYS().RAW_ROW_ARRAY, rawRowArray);
      buildRowDataFromRawArray();
      setStatus("Sheet data injected (" + rawRowArray.length + " rows)", "ok");
      setLog("Sheet data ready");
    } catch (err) {
      console.warn("[DetectLab] DetectLabInjectSheetData error:", err);
      setStatus("Inject sheet data failed", "error");
      setLog("Inject sheet data failed");
    }
  };

  function getRowNumberFromUI() {
    if (!sidebarEl || !sidebarEl.currentRowInput) return 2;
    const n = toNumber(sidebarEl.currentRowInput.value, 2);
    return n >= 2 ? n : 2;
  }

  function setRowNumberToUI(row) {
    if (!sidebarEl || !sidebarEl.currentRowInput) return;
    sidebarEl.currentRowInput.value = String(row >= 2 ? row : 2);
    saveRowState();
  }

  function getCellValueByColumn(rowObj, column) {
    if (!rowObj || !column) return "";
    const key = String(column).trim().toUpperCase();
    if (!key) return "";
    return rowObj[key] != null ? String(rowObj[key]) : "";
  }

  function setCellValueByColumn(rowNumber, column, value) {
    if (!rowNumber || !column) return;
    if (!rowData || typeof rowData !== "object") rowData = {};
    if (!rowData[rowNumber]) rowData[rowNumber] = {};
    rowData[rowNumber][String(column).trim().toUpperCase()] = value == null ? "" : String(value);
    saveJsonToStorage(STORAGE_KEYS().SHEET_DATA, rowData);
  }

  function buildRowDataFromRawArray() {
  try {
    if (!Array.isArray(rawRowArray) || !rawRowArray.length) return;

    const baseRow =
      typeof window.DetectLabSheetStartRow === "number" &&
      window.DetectLabSheetStartRow >= 2
        ? window.DetectLabSheetStartRow
        : 2;

    const nextData = {};
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

    for (let i = 0; i < rawRowArray.length; i++) {
      const arr = Array.isArray(rawRowArray[i]) ? rawRowArray[i] : [];
      const rowNum = baseRow + i; // ví dụ: 46

      const rowObj = {};
      for (let j = 0; j < arr.length; j++) {
        const col = letters[j] || `COL${j + 1}`;
        const val = arr[j];
        rowObj[col] = val == null ? "" : String(val);
      }

      nextData[rowNum] = rowObj;
    }

    rowData = nextData;
    // Sync ngay vào slot state hiện tại — tránh _st.rowData bị stale
    S().rowData = rowData;
    saveJsonToStorage(STORAGE_KEYS().SHEET_DATA, rowData);
  } catch (err) {
    console.warn("[DetectLab] buildRowDataFromRawArray error:", err);
  }
}

  function loadValuesForStartRow() {
  try {
    const maybeRaw = loadJsonFromStorage(STORAGE_KEYS().RAW_ROW_ARRAY, []);
    const maybeMap = loadJsonFromStorage(STORAGE_KEYS().SHEET_DATA, {});
    if (Array.isArray(maybeRaw) && maybeRaw.length) {
      rawRowArray = maybeRaw;
    }
    if (maybeMap && typeof maybeMap === "object" && Object.keys(maybeMap).length) {
      rowData = maybeMap;
    }
    if ((!rowData || !Object.keys(rowData).length) && Array.isArray(rawRowArray) && rawRowArray.length) {
      buildRowDataFromRawArray();
    }

    if (!rowData || !Object.keys(rowData).length) {
      setStatus("No sheet data in storage", "warn");
      setLog("No sheet data – check Google Sheet bridge");
      return;
    }

    const row = toNumber(sidebarEl && sidebarEl.startInput && sidebarEl.startInput.value, 2);
    const safeRow = row >= 2 ? row : 2;
    currentRowRunning = safeRow;
    setRowNumberToUI(safeRow);

    // console.log("[DL DEBUG] loadValuesForStartRow currentRowRunning:", currentRowRunning);
    setStatus("Loaded row " + currentRowRunning, "ok");
    setLog("Values ready (row " + currentRowRunning + ")");
  } catch (err) {
    console.warn("[DetectLab] loadValuesForStartRow error:", err);
    setStatus("Load values failed", "error");
    setLog("Load values failed");
  }
}

  /**
   * refreshValuesForRow(rowNum, renderUI)
   *  - renderUI = true  : gọi renderSteps() để cập nhập pill hiển thị (chỉ dùng khi gọi từ nút Refresh
   *                       hoặc bắt kỳ context nào đang KHAÍCH
   *  - renderUI = false : (mặc định) chỉ cập nhập data + UI input, không render
   *                       (dùng trong END step khi đang chạy pattern — tránh đệ quy)
   */
  function refreshValuesForRow(rowNum, renderUI, slotSt) {
    // slotSt: nếu truyền vào, update thẳng slot state đó (không phụ thuộc activeSlotId)
    const _st = slotSt || S();
    const safeRow = rowNum >= 2 ? rowNum : (_st.currentRowRunning || getRowNumberFromUI() || 2);
    try {
      // Đảm bảo rowData luôn được build từ rawRowArray nếu cần
      if (!_st.rowData || !_st.rowData[safeRow]) {
        if (Array.isArray(_st.rawRowArray) && _st.rawRowArray.length) {
          // Swap rawRowArray proxy sang array của slot này rồi build
          rawRowArray = _st.rawRowArray;
          buildRowDataFromRawArray();
          _st.rowData = rowData; // sync lại vào đúng slot
        }
      }
      _st.currentRowRunning = safeRow;
      if (_st === S()) {
        currentRowRunning = safeRow;
        setRowNumberToUI(safeRow);
      }
      // Chỉ re-render khi được gọi từ nút Refresh (renderUI=true) và đang xem slot này
      if (renderUI && _st === S()) renderSteps();
      setStatus("Row " + safeRow + " ready", "ok");
      setLog("Refreshed values → row " + safeRow);
    } catch (err) {
      console.warn("[DetectLab] refreshValuesForRow error:", err);
    }
  }


  // =========================================================
  // Init entry
  // =========================================================

window.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("detectlab-root");
  if (!root) return;
  initDetectLabUI(root);
});

window.addEventListener("message", event => {
  const data = event.data || {};
  if (data.type === "DetectLabRawRows" && Array.isArray(data.rawRows)) {
    try {
      const first = data.rawRows[0];

      if (Array.isArray(first)) {
  const baseRow =
    typeof data.startRow === "number" && data.startRow >= 2
      ? data.startRow
      : 2;

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const nextData = {};

  data.rawRows.forEach((arr, idx) => {
    const rowNum = baseRow + idx; // 46, 47...
    const row = Array.isArray(arr) ? arr : [];
    const rowObj = {};
    row.forEach((val, j) => {
      const col = letters[j] || `COL${j + 1}`;
      rowObj[col] = val == null ? "" : String(val);
    });
    nextData[rowNum] = rowObj;
  });

  rowData = nextData;
  rawRowArray = data.rawRows;
  // Lưu startRow theo slot hiện tại (parallel-safe, không dựa vào global)
  S().startRow = baseRow;
  // Flush ngay vào slot state — tránh _st.rowData stale khi btnTest chạy
  flushProxies();
  saveJsonToStorage(STORAGE_KEYS().SHEET_DATA, rowData);
  saveJsonToStorage(STORAGE_KEYS().RAW_ROW_ARRAY, rawRowArray);
  console.log("[DetectLabBridge] SHEET_DATA saved from message (2D, baseRow=" + baseRow + ")", rowData);
} else if (first && typeof first === "object") {
        // dạng object: build map rowNumber -> COLUMN => value
        const nextData = {};
        data.rawRows.forEach(row => {
          const idx = row.rowIndex || row.row || row._row;
          if (idx == null) return;
          const rowNum = Number(idx);
          if (!Number.isFinite(rowNum) || rowNum < 2) return;

          const target = {};
          Object.keys(row).forEach(key => {
            if (key === "rowIndex" || key === "row" || key === "_row") return;
            const col = String(key || "").trim().toUpperCase();
            if (!col) return;
            const v = row[key];
            target[col] = v == null ? "" : String(v);
          });
          nextData[rowNum] = target;
        });

        rowData = nextData;
        // Flush ngay vào slot state
        flushProxies();
        saveJsonToStorage(STORAGE_KEYS().SHEET_DATA, rowData);
        console.log("[DetectLabBridge] SHEET_DATA saved from message", Object.keys(rowData).length);
      } else {
        console.warn(
          "[DetectLabBridge] DetectLabRawRows unsupported format",
          data.rawRows
        );
      }

      setStatus(
        "Sheet data injected (" +
          (Array.isArray(data.rawRows) ? data.rawRows.length : 0) +
          " rows)",
        "ok"
      );
      setLog("Sheet data ready");
    } catch (err) {
      console.warn("[DetectLabBridge] DetectLabRawRows handler error:", err);
      setStatus("Inject sheet data failed", "error");
      setLog("Inject sheet data failed");
    }
  }
});

  // =========================================================
  // UI primitives
  // =========================================================

  function makeSmallLabel(text) {
    const span = document.createElement("span");
    span.textContent = text;
    span.style.fontSize = "11px";
    span.style.color = "#9ca3af";
    return span;
  }

  function makeSmallInput(type, value, width) {
    const input = document.createElement("input");
    input.type = type || "text";
    if (value != null) input.value = String(value);
    Object.assign(input.style, {
      width: width || "80px",
      padding: "3px 6px",
      borderRadius: "4px",
      border: "1px solid #475569",
      background: "#020617",
      color: "#e5e7eb",
      fontSize: "11px",
      outline: "none"
    });
    return input;
  }

  function makeSmallNumberInput(min, defaultVal, width) {
    const input = makeSmallInput("number", defaultVal, width || "64px");
    if (min != null) input.min = String(min);
    return input;
  }

  function makeSmallTextarea(value, rows) {
    const el = document.createElement("textarea");
    el.value = value || "";
    el.rows = rows || 2;
    Object.assign(el.style, {
      width: "100%",
      padding: "5px 6px",
      borderRadius: "4px",
      border: "1px solid #475569",
      background: "#020617",
      color: "#e5e7eb",
      fontSize: "11px",
      resize: "vertical",
      outline: "none"
    });
    return el;
  }

  function makeSelect(options, value, width) {
    const sel = document.createElement("select");
    Object.assign(sel.style, {
      width: width || "110px",
      padding: "3px 6px",
      borderRadius: "4px",
      border: "1px solid #475569",
      background: "#020617",
      color: "#e5e7eb",
      fontSize: "11px",
      outline: "none"
    });

    (options || []).forEach(optVal => {
      const opt = document.createElement("option");
      if (typeof optVal === "object") {
        opt.value = String(optVal.value);
        opt.textContent = String(optVal.label);
      } else {
        opt.value = String(optVal);
        opt.textContent = String(optVal);
      }
      sel.appendChild(opt);
    });

    if (value != null) sel.value = String(value);
    return sel;
  }

  function makeBtn(text, bg, color) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    Object.assign(btn.style, {
      padding: "5px 10px",
      border: "none",
      borderRadius: "6px",
      background: bg || "rgba(255,255,255,0.08)",
      color: color || "#e5e7eb",
      fontWeight: "500",
      cursor: "pointer",
      fontSize: "11px"
    });
    return btn;
  }

  /**
   * Thay thế window.prompt() — không hoạt động trong Electron renderer.
   * @param {string} label   — câu hỏi hiển thị
   * @param {string} defaultVal — giá trị mặc định trong input
   * @returns {Promise<string|null>}  null nếu user cancel
   */
  function showPromptModal(label, defaultVal) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed", inset: "0",
        background: "rgba(2,6,23,0.75)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: "999999"
      });

      const box = document.createElement("div");
      Object.assign(box.style, {
        background: "#0f172a", border: "1px solid #2563eb",
        borderRadius: "10px", padding: "16px",
        display: "flex", flexDirection: "column", gap: "10px",
        width: "min(360px, calc(100vw - 32px))",
        boxShadow: "0 10px 30px rgba(0,0,0,0.4)"
      });

      const lbl = document.createElement("div");
      lbl.textContent = label;
      Object.assign(lbl.style, { color: "#e5e7eb", fontSize: "13px", fontWeight: "600" });

      const inp = document.createElement("input");
      inp.type = "text";
      inp.value = defaultVal || "";
      Object.assign(inp.style, {
        background: "#1e293b", border: "1px solid #334155",
        borderRadius: "6px", padding: "6px 8px",
        color: "#f1f5f9", fontSize: "13px", outline: "none", width: "100%",
        boxSizing: "border-box"
      });

      const row = document.createElement("div");
      Object.assign(row.style, { display: "flex", gap: "8px", justifyContent: "flex-end" });

      const cancelBtn = makeBtn("Cancel", "linear-gradient(90deg,#334155,#1f2937)", "#fff");
      const okBtn     = makeBtn("OK",     "linear-gradient(90deg,#0ea5e9,#3b82f6)", "#082f49");

      function doOk() {
        overlay.remove();
        const v = inp.value.trim();
        resolve(v === "" ? null : v);
      }
      function doCancel() {
        overlay.remove();
        resolve(null);
      }

      okBtn.onclick = doOk;
      cancelBtn.onclick = doCancel;
      overlay.addEventListener("click", e => { if (e.target === overlay) doCancel(); });
      inp.addEventListener("keydown", e => {
        if (e.key === "Enter")  doOk();
        if (e.key === "Escape") doCancel();
      });

      row.appendChild(cancelBtn);
      row.appendChild(okBtn);
      box.appendChild(lbl);
      box.appendChild(inp);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      setTimeout(() => inp.focus(), 30);
    });
  }

  function makeSectionCard() {
    const box = document.createElement("div");
    Object.assign(box.style, {
      padding: "8px 10px",
      borderRadius: "8px",
      background: "rgba(255,255,255,0.025)",
      border: "none"
    });
    return box;
  }

  function makeInlineField(labelText, controlEl) {
    const wrap = document.createElement("div");
    Object.assign(wrap.style, {
      display: "flex",
      alignItems: "center",
      gap: "6px"
    });

    const label = makeSmallLabel(labelText);
    label.style.minWidth = "62px";

    wrap._labelEl = label;
    wrap._setLabel = text => {
      label.textContent = text;
    };

    wrap.appendChild(label);
    wrap.appendChild(controlEl);
    return wrap;
  }

  // =========================================================
  // UI creation
  // =========================================================

  function initDetectLabUI(root) {
    if (sidebarEl) return;

    sidebarEl = document.createElement("div");
    sidebarEl.id = "detectlabsidebar";
    Object.assign(sidebarEl.style, {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      minHeight: "0",
      height: "100%",
      fontSize: "12px",
      color: "#e5e7eb",
      fontFamily: "system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
    });

    // Header
    const header = document.createElement("div");
    Object.assign(header.style, {
      padding: "8px 10px",
      borderRadius: "8px",
      background: "linear-gradient(90deg, rgba(15,23,42,0.98), rgba(30,64,175,0.92))",
      border: "1px solid #1d4ed8",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between"
    });

    const headLeft = document.createElement("div");
    Object.assign(headLeft.style, {
      display: "flex",
      flexDirection: "column"
    });

    const title = document.createElement("div");
    title.textContent = "Camping Detect Lab";
    title.style.fontWeight = "700";
    title.style.fontSize = "15px";

    const subtitle = document.createElement("div");
    subtitle.textContent = "Electron Control";
    subtitle.style.fontSize = "11px";
    subtitle.style.color = "#bfdbfe";

    headLeft.appendChild(title);
    headLeft.appendChild(subtitle);

    const headRight = document.createElement("div");
    Object.assign(headRight.style, {
      display: "flex",
      gap: "6px",
      alignItems: "center"
    });

    const ping = document.createElement("div");
    ping.textContent = hasControlAPI() ? "Bridge OK" : "Bridge ?";
    Object.assign(ping.style, {
      padding: "3px 8px",
      borderRadius: "999px",
      fontSize: "10px",
      fontWeight: "700",
      background: hasControlAPI()
        ? "linear-gradient(90deg,#22c55e,#16a34a)"
        : "linear-gradient(90deg,#facc15,#eab308)",
      color: hasControlAPI() ? "#052e16" : "#111827"
    });

    headRight.appendChild(ping);
    header.appendChild(headLeft);
    header.appendChild(headRight);

    // Config row
    const configRow = makeSectionCard();
    Object.assign(configRow.style, {
      display: "flex",
      flexDirection: "column",
      gap: "8px"
    });

    const sheetLine1 = document.createElement("div");
    Object.assign(sheetLine1.style, {
      display: "flex",
      gap: "6px",
      flexWrap: "wrap",
      alignItems: "center"
    });

    const sheetLine2 = document.createElement("div");
    Object.assign(sheetLine2.style, {
      display: "flex",
      gap: "6px",
      flexWrap: "wrap",
      alignItems: "center"
    });

    const rowRangeLine = document.createElement("div");
    Object.assign(rowRangeLine.style, {
      display: "flex",
      gap: "6px",
      flexWrap: "wrap",
      alignItems: "center"
    });

    const startInput = makeSmallNumberInput(2, 2, "70px");
    const endInput = makeSmallNumberInput(0, 0, "70px");
    endInput.placeholder = "0 = auto";

    const winWInput = makeSmallNumberInput(400, 1200, "80px");
    const winHInput = makeSmallNumberInput(300, 800, "80px");

    const zoomSelect = makeSelect(["50", "67", "75", "80", "90", "100", "110", "125", "150"], "100", "84px");

    const sheetBaseInput = makeSmallInput("text", "", "220px");
    sheetBaseInput.placeholder = "Apps Script URL (load data)";
    const sheetReturnInput = makeSmallInput("text", "", "220px");
    sheetReturnInput.placeholder = "Apps Script URL (return data)";
    const sheetIdInput = makeSmallInput("text", "", "160px");
    sheetIdInput.placeholder = "Sheet ID";
    const sheetTabInput = makeSmallInput("text", "", "120px");
    sheetTabInput.placeholder = "Tab name";

    sheetLine1.appendChild(makeSmallLabel("Apps URL"));
    sheetLine1.appendChild(sheetBaseInput);
    sheetLine1.appendChild(makeSmallLabel("Return URL"));
    sheetLine1.appendChild(sheetReturnInput);

    sheetLine2.appendChild(makeSmallLabel("Sheet ID"));
    sheetLine2.appendChild(sheetIdInput);
    sheetLine2.appendChild(makeSmallLabel("Tab"));
    sheetLine2.appendChild(sheetTabInput);

    rowRangeLine.appendChild(makeSmallLabel("Start row"));
    rowRangeLine.appendChild(startInput);
    rowRangeLine.appendChild(makeSmallLabel("End row"));
    rowRangeLine.appendChild(endInput);
    rowRangeLine.appendChild(makeSmallLabel("Win W"));
    rowRangeLine.appendChild(winWInput);
    rowRangeLine.appendChild(makeSmallLabel("Win H"));
    rowRangeLine.appendChild(winHInput);
    rowRangeLine.appendChild(makeSmallLabel("Zoom"));
    rowRangeLine.appendChild(zoomSelect);

    const loadRow = document.createElement("div");
    Object.assign(loadRow.style, {
      display: "flex",
      gap: "6px",
      alignItems: "center"
    });

    const statusLabel = makeSmallLabel("Status");

    const statusBox = document.createElement("div");
    Object.assign(statusBox.style, {
      flex: "1",
      padding: "4px 8px",
      borderRadius: "6px",
      border: "1px solid #475569",
      background: "linear-gradient(90deg,#334155,#1f2937)",
      color: "#e5e7eb",
      fontSize: "12px",
      minHeight: "22px",
      display: "flex",
      alignItems: "center"
    });
    statusBox.textContent = "Idle";

    loadRow.appendChild(statusLabel);
    loadRow.appendChild(statusBox);

    configRow.appendChild(sheetLine1);
    configRow.appendChild(sheetLine2);
    configRow.appendChild(rowRangeLine);
    configRow.appendChild(loadRow);

    // Tabs
    const tabs = document.createElement("div");
    Object.assign(tabs.style, {
      display: "flex",
      gap: "4px"
    });

    function makeTab(text, name) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      btn.dataset.tab = name;
      Object.assign(btn.style, {
        flex: "1",
        padding: "5px 6px",
        borderRadius: "999px",
        border: "1px solid #1f2937",
        background: "#020617",
        color: "#9ca3af",
        fontSize: "12px",
        cursor: "pointer"
      });
      return btn;
    }

    const tabSteps = makeTab("Steps", "steps");
    const tabGroups = makeTab("Groups", "groups");
    const tabPatterns = makeTab("Patterns", "patterns");
    const tabImages = makeTab("Images", "images");
    const tabNoti = makeTab("Noti", "noti");
    const tabSession = makeTab("Session", "session");

    tabs.appendChild(tabSteps);
    tabs.appendChild(tabGroups);
    tabs.appendChild(tabPatterns);
    tabs.appendChild(tabImages);
    tabs.appendChild(tabNoti);
    tabs.appendChild(tabSession);

    // Panels wrapper
    const panelsWrapper = document.createElement("div");
    Object.assign(panelsWrapper.style, {
      flex: "1",
      minHeight: "0",
      display: "flex",
      flexDirection: "column",
      gap: "6px"
    });

    const panelSteps = document.createElement("div");
    panelSteps.id = "dlpanelsteps";
    Object.assign(panelSteps.style, {
      display: "flex",
      flexDirection: "column",
      flex: "1",
      minHeight: "0",
      overflowY: "auto"
    });

    const panelGroups = document.createElement("div");
    panelGroups.id = "dlpanelgroups";
    Object.assign(panelGroups.style, {
      display: "none",
      flexDirection: "column",
      flex: "1",
      minHeight: "0",
      overflowY: "auto"
    });

    const panelPatterns = document.createElement("div");
    panelPatterns.id = "dlpanelpatterns";
    Object.assign(panelPatterns.style, {
      display: "none",
      flexDirection: "column",
      flex: "1",
      minHeight: "0"
    });

    const panelImages = document.createElement("div");
    panelImages.id = "dlpanelimages";
    Object.assign(panelImages.style, {
      display: "none",
      flexDirection: "column",
      flex: "1",
      minHeight: "0"
    });

    const panelNoti = document.createElement("div");
    panelNoti.id = "dlpanelnoti";
    Object.assign(panelNoti.style, {
      display: "none",
      flexDirection: "column",
      flex: "1",
      minHeight: "0"
    });

    const panelSession = document.createElement("div");
    panelSession.id = "dlpanelsession";
    Object.assign(panelSession.style, {
      display: "none",
      flexDirection: "column",
      flex: "1",
      minHeight: "0",
      gap: "8px",
      overflowY: "auto",
      padding: "4px 0"
    });

    panelsWrapper.appendChild(panelSteps);
    panelsWrapper.appendChild(panelGroups);
    panelsWrapper.appendChild(panelPatterns);
    panelsWrapper.appendChild(panelImages);
    panelsWrapper.appendChild(panelNoti);
    panelsWrapper.appendChild(panelSession);

    function switchTab(name) {
      const map = {
        steps: panelSteps,
        groups: panelGroups,
        patterns: panelPatterns,
        images: panelImages,
        noti: panelNoti,
        session: panelSession
      };

      Object.keys(map).forEach(key => {
        map[key].style.display = key === name ? "flex" : "none";
      });

      [tabSteps, tabGroups, tabPatterns, tabImages, tabNoti, tabSession].forEach(btn => {
        const active = btn.dataset.tab === name;
        btn.style.background = active ? "#1d4ed8" : "#020617";
        btn.style.color = active ? "#e5e7eb" : "#9ca3af";
      });

      if (name === "session") renderSessionPanel(panelSession);
      if (name === "groups") renderGroupsPanel();
    }

    tabSteps.onclick = () => switchTab("steps");
    tabGroups.onclick = () => switchTab("groups");
    tabPatterns.onclick = () => switchTab("patterns");
    tabImages.onclick = () => switchTab("images");
    tabNoti.onclick = () => switchTab("noti");
    tabSession.onclick = () => switchTab("session");
    switchTab("steps");

    buildGroupsPanel(panelGroups);

    root.innerHTML = "";
    root.style.minHeight = "0";
    root.style.height = "100%";
    root.appendChild(sidebarEl);

    // ── Slot tabs ───────────────────────────────────────────
    const slotTabBar = document.createElement("div");
    Object.assign(slotTabBar.style, {
      display: "flex",
      gap: "4px",
      marginBottom: "2px",
      alignItems: "center"
    });
    sidebarEl.slotTabBar = slotTabBar;

    function renderSlotTabs() {
      slotTabBar.innerHTML = "";
      const label = document.createElement("span");
      label.textContent = "Slot:";
      Object.assign(label.style, { fontSize: "11px", color: "#9ca3af", marginRight: "4px" });
      slotTabBar.appendChild(label);

      for (let i = 1; i <= MAX_SLOTS; i++) {
        const btn = document.createElement("button");
        btn.textContent = `#${i}`;
        const isActive = i === activeSlotId;
        Object.assign(btn.style, {
          padding: "3px 10px",
          borderRadius: "6px",
          border: isActive ? "1.5px solid #3b82f6" : "1px solid #374151",
          background: isActive
            ? "linear-gradient(90deg,#1d4ed8,#2563eb)"
            : "rgba(31,41,55,0.8)",
          color: isActive ? "#fff" : "#9ca3af",
          fontSize: "11px",
          fontWeight: isActive ? "700" : "400",
          cursor: "pointer"
        });
        btn.title = `Switch to Slot ${i}`;
        btn.onclick = () => {
          if (i !== activeSlotId) {
            flushProxies(); // lưu state slot cũ
            activeSlotId = i;
            syncProxies(); // load state slot mới
            // KHÔNG tự động mở web window khi chuyển slot.
            // Người dùng tự bấm nút "Open" khi muốn mở slot.
            renderSlotTabs();
            renderActiveSlotUI();
          }
        };
        slotTabBar.appendChild(btn);
      }

      // Nút + mở slot mới (optional shortcut)
      const addBtn = document.createElement("button");
      addBtn.textContent = "+";
      Object.assign(addBtn.style, {
        padding: "3px 8px",
        borderRadius: "6px",
        border: "1px dashed #374151",
        background: "transparent",
        color: "#6b7280",
        fontSize: "11px",
        cursor: "pointer",
        marginLeft: "auto"
      });
      addBtn.title = "Open all slots";
      addBtn.onclick = () => {
        if (!hasControlAPI() || !window.controlAPI.openSlot) return;
        for (let i = 1; i <= MAX_SLOTS; i++) window.controlAPI.openSlot(i);
      };
      slotTabBar.appendChild(addBtn);
    }

    renderSlotTabs();
    sidebarEl.renderSlotTabs = renderSlotTabs;
    // ──────────────────────────────────────────────────

    sidebarEl.appendChild(slotTabBar);
    sidebarEl.appendChild(header);
    sidebarEl.appendChild(configRow);
    sidebarEl.appendChild(tabs);
    sidebarEl.appendChild(panelsWrapper);

    // bind
    sidebarEl.startInput = startInput;
    sidebarEl.endInput = endInput;
    sidebarEl.winWInput = winWInput;
    sidebarEl.winHInput = winHInput;
    sidebarEl.zoomSelect = zoomSelect;
    sidebarEl.statusBox = statusBox;
    sidebarEl.sheetBaseInput = sheetBaseInput;
    sidebarEl.sheetReturnInput = sheetReturnInput;
    sidebarEl.sheetIdInput = sheetIdInput;
    sidebarEl.sheetTabInput = sheetTabInput;

    buildStepsPanel(panelSteps);
    buildPatternsPanel(panelPatterns);
    buildImagesPanel(panelImages);
    buildNotiPanel(panelNoti);

    patterns = loadJsonFromStorage(STORAGE_KEYS().PATTERNS, {}) || {};
    notiRules = loadJsonFromStorage(STORAGE_KEYS().NOTI, []) || [];
    imageLibrary = loadJsonFromStorage(STORAGE_KEYS().IMAGES, []) || [];

    restoreStateFromStorage();
    normalizeAllSteps();
    renderSteps();
    renderPatternsPanel();
    renderImagesPanel();
    renderNotiRulesPanel();

    setStatus("Idle", null);
    setLog("Ready");
  }

  // =========================================================
  // Steps panel
  // =========================================================

  function buildStepsPanel(panelSteps) {
    panelSteps.innerHTML = "";

    const controls = makeSectionCard();
    Object.assign(controls.style, {
      display: "flex",
      gap: "6px",
      alignItems: "center",
      flexWrap: "wrap"
    });

    const runBtn = makeBtn("Start", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
    const pauseBtn = makeBtn("Pause", "linear-gradient(90deg,#facc15,#eab308)", "#111827");
    const continueBtn = makeBtn("Continue", "linear-gradient(90deg,#38bdf8,#2563eb)", "#020617");
    const loadValuesBtn = makeBtn("Load values", "linear-gradient(90deg,#0ea5e9,#3b82f6)", "#0f172a");
    const addStepBtn = makeBtn("Add step", "linear-gradient(90deg,#a855f7,#6366f1)", "#e5e7eb");
    const duplicateAllBtn = makeBtn("Refresh values", "linear-gradient(90deg,#e5e7eb,#94a3b8)", "#020617");
    const clearBtn = makeBtn("Clear", "linear-gradient(90deg,#f97373,#ef4444)", "#ffffff");
    const groupSelBtn = makeBtn("Gộp Group", "linear-gradient(90deg,#a855f7,#6366f1)", "#e5e7eb");
    groupSelBtn.onclick = () => { try { saveSelectedStepsAsGroup(); } catch (e) { console.warn(e); } };
    const addGroupBtn = makeBtn("+ Group", "linear-gradient(90deg,#8b5cf6,#7c3aed)", "#ede9fe");
    addGroupBtn.onclick = async () => {
      const nm = await showPromptModal("Tên group mới:", "");
      if (!nm || !nm.trim()) return;
      const name = nm.trim();
      if (!pendingEmptyGroups.includes(name)) pendingEmptyGroups.push(name);
      renderSteps();
      setLog("Đã tạo group rỗng '" + name + "' — kéo step vào");
    };

    const currentRowLabel = makeSmallLabel("Current row");
    const currentRowInput = makeSmallNumberInput(2, 2, "76px");

    const logBox = document.createElement("div");
    Object.assign(logBox.style, {
      marginLeft: "auto",
      padding: "4px 8px",
      borderRadius: "6px",
      border: "1px solid #1f2937",
      background: "#020617",
      color: "#9ca3af",
      fontSize: "11px",
      maxWidth: "240px"
    });
    cssEllipsis(logBox);
    logBox.textContent = "Idle";

    controls.appendChild(runBtn);
    controls.appendChild(pauseBtn);
    controls.appendChild(continueBtn);
    controls.appendChild(loadValuesBtn);
    controls.appendChild(addStepBtn);
    controls.appendChild(duplicateAllBtn);
    controls.appendChild(clearBtn);
    controls.appendChild(groupSelBtn);
    controls.appendChild(addGroupBtn);
    controls.appendChild(currentRowLabel);
    controls.appendChild(currentRowInput);
    controls.appendChild(logBox);

    const scrollSteps = makeSectionCard();
    scrollSteps.id = "detectlabsteps";
    Object.assign(scrollSteps.style, {
      flex: "1",
      minHeight: "180px",
      overflowY: "auto",
      whiteSpace: "pre-wrap"
    });

    const saveRow = makeSectionCard();
    Object.assign(saveRow.style, {
      display: "flex",
      gap: "6px",
      alignItems: "center"
    });

    const currentPatternLabel = document.createElement("div");
    currentPatternLabel.id = "dlcurrentpatternlabel";
    Object.assign(currentPatternLabel.style, {
      flex: "1",
      fontSize: "11px",
      color: "#111827",
      background: "linear-gradient(90deg,#facc15,#eab308)",
      borderRadius: "6px",
      padding: "4px 8px"
    });
    cssEllipsis(currentPatternLabel);
    currentPatternLabel.textContent = "Pattern: none";

    const savePatternBtn = makeBtn("Save pattern", "linear-gradient(90deg,#38bdf8,#2563eb)", "#020617");
    const saveAsNewBtn = makeBtn("Save as new", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");

    saveRow.appendChild(currentPatternLabel);
    saveRow.appendChild(savePatternBtn);
    saveRow.appendChild(saveAsNewBtn);

    controls.style.position = "sticky";
    controls.style.top = "0";
    controls.style.zIndex = "20";
    controls.style.background = "rgba(15,23,42,0.98)";

    panelSteps.appendChild(controls);
    panelSteps.appendChild(scrollSteps);
    panelSteps.appendChild(saveRow);

    sidebarEl.currentRowInput = currentRowInput;
    sidebarEl.logBox = logBox;
    sidebarEl.currentPatternLabel = currentPatternLabel;
    sidebarEl.scrollSteps = scrollSteps;

    runBtn.onclick = async () => {
      try {
        if (S().running) {
          setLog("Slot " + activeSlotId + " is already running");
          return;
        }
        const start = toNumber(sidebarEl.startInput && sidebarEl.startInput.value, 2);
        const current = toNumber(currentRowInput.value, start >= 2 ? start : 2);

        // ưu tiên Current row (user có thể chỉnh tay), fallback về start
        currentRowRunning = current >= 2 ? current : (start >= 2 ? start : 2);

        applyWindowConfig(getWindowConfigFromUI());
        saveRowState();
        await runLoop(false);
      } catch (err) {
        console.warn("[DetectLab] run error:", err);
        setStatus("Run failed", "error");
        setLog("Run failed");
      }
    };

    pauseBtn.onclick = () => {
      // Target slot đang active (mỗi slot có pause độc lập)
      const _st = S();
      _st.stopped = true;
      _st.paused = true;
      setStatus("Paused", "warn");
      setLog("Paused");
    };

    continueBtn.onclick = async () => {
      try {
        const _st = S();
        if (!_st.steps || !_st.steps.length) {
          setStatus("No steps", "warn");
          return;
        }
        if (!_st.stopped && !_st.paused) {
          setLog("Already running");
          return;
        }
        setStatus("Continuing...", "run");
        setLog("Continue");
        await runLoop(true);
      } catch (err) {
        console.warn("[DetectLab] continue error:", err);
        setStatus("Continue failed", "error");
        setLog("Continue failed");
      }
    };

    loadValuesBtn.onclick = async () => {
      try {
        const cfg = window.DetectLabGetSheetConfig ? window.DetectLabGetSheetConfig() : null;
        if (!cfg || !cfg.baseUrl || !cfg.sheetId || !cfg.sheetName) {
          setStatus("Missing Apps Script / sheet config", "warn");
          setLog("Fill Apps URL, Sheet ID, Tab first");
          return;
        }

        const rawStart = sidebarEl && sidebarEl.startInput ? sidebarEl.startInput.value : "2";
        const rawEnd   = sidebarEl && sidebarEl.endInput ? sidebarEl.endInput.value : "0";

        let startRow = parseInt((rawStart || "2").trim(), 10);
        let endRow   = parseInt((rawEnd || "0").trim(), 10);

        if (!Number.isFinite(startRow) || startRow < 2) startRow = 2;
        if (!Number.isFinite(endRow) || endRow < startRow) endRow = 0; // 0 = auto

        if (window.sheetBridge && typeof window.sheetBridge.fetchAndInject === "function") {
          setStatus("Fetching sheet...", "run");
          await window.sheetBridge.fetchAndInject({
            baseUrl: cfg.baseUrl,
            sheetId: cfg.sheetId,
            sheetName: cfg.sheetName,
            startRow,
            endRow
          });
        }

        // luôn reload lại rowData từ storage sau khi bridge ghi dữ liệu
        loadValuesForStartRow();
      } catch (err) {
        console.warn("[DetectLab] Load values with sheetBridge error:", err);
        setStatus("Load values failed", "error");
        setLog("Load values failed");
      }
    };

    addStepBtn.onclick = () => {
      steps.push(createDefaultStep(steps.length + 1));
      normalizeAllSteps();
      renderSteps();
      setLog("Added step");
    };

    duplicateAllBtn.onclick = () => {
      // Refresh values từ dữ liệu đã fetch — không gọi sheetBridge lại
      // renderUI=true: cập nhập pill hiển thị ngay
      const row = currentRowRunning || getRowNumberFromUI() || 2;
      refreshValuesForRow(row, true);
    };

    clearBtn.onclick = () => {
      if (!steps.length) return;
      if (!confirm("Clear all steps?")) return;
      steps = [];
      renderSteps();
      setLog("Steps cleared");
    };

    savePatternBtn.onclick = async () => {
      const current = getCurrentPatternName();
      // Nếu đang mở pattern có tên → overwrite thẳng, không hỏi
      // Nếu chưa có tên → mới hỏi tên (lúc đó hành vi giống Save as new)
      const name = current || await showPromptModal("Pattern name:", "");
      if (!name || !name.trim()) return;

      const winCfg = getWindowConfigFromUI();
      patterns[name.trim()] = {
        steps: deepClone(steps),
        savedAt: Date.now(),
        windowWidth: winCfg.windowWidth,
        windowHeight: winCfg.windowHeight,
        zoom: winCfg.zoom
      };
      saveJsonToStorage(STORAGE_KEYS().PATTERNS, patterns);
      renderPatternsPanel();
      setCurrentPatternName(name.trim());
      setLog("Saved: " + name.trim());
    };

    saveAsNewBtn.onclick = async () => {
      const name = await showPromptModal("New pattern name:", "");
      if (!name || !name.trim()) return;

      const trimmed = name.trim();
      // Cảnh báo nếu tên đã tồn tại
      if (patterns[trimmed] && !confirm("\"" + trimmed + "\" already exists. Overwrite?")) return;

      const winCfg = getWindowConfigFromUI();
      patterns[trimmed] = {
        steps: deepClone(steps),
        savedAt: Date.now(),
        windowWidth: winCfg.windowWidth,
        windowHeight: winCfg.windowHeight,
        zoom: winCfg.zoom
      };
      saveJsonToStorage(STORAGE_KEYS().PATTERNS, patterns);
      renderPatternsPanel();
      setCurrentPatternName(trimmed);
      setLog("Saved as new: " + trimmed);
    };
  }

  // =========================================================
  // Step editor / renderer
  // =========================================================

  function renderSteps() {
    if (!sidebarEl || !sidebarEl.scrollSteps) return;
    normalizeAllSteps();

    const container = sidebarEl.scrollSteps;
    container.innerHTML = "";

    if (!steps.length) {
      const empty = document.createElement("div");
      empty.textContent = "No steps. Click 'Add step' to create one.";
      empty.style.fontSize = "12px";
      empty.style.color = "#9ca3af";
      container.appendChild(empty);
      return;
    }

    // Đếm số step theo từng group để hiện trên header
    const groupCounts = {};
    steps.forEach(s => { const g = String((s && s.groupName) || "").trim(); if (g) groupCounts[g] = (groupCounts[g] || 0) + 1; });

    // Theo dõi group container đang mở khi render tuần tự
    let curGroupName = null;
    let curGroupBody = null;

    function startGroup(name) {
      curGroupName = name;
      const collapsed = !!groupCollapsed[name];
      const wrap = document.createElement("div");
      Object.assign(wrap.style, {
        borderRadius: "8px", margin: "6px 0",
        background: "rgba(255,255,255,0.03)",
        borderLeft: "2px solid rgba(139,92,246,0.55)"
      });
      const head = document.createElement("div");
      Object.assign(head.style, {
        display: "flex", alignItems: "center", gap: "8px",
        padding: "6px 8px", cursor: "grab", userSelect: "none"
      });
      // Kéo cả group để đổi vị trí trong danh sách step
      head.draggable = true;
      head.addEventListener("dragstart", (e) => {
        draggingGroupSteps = steps.filter(s => s && String(s.groupName || "").trim() === name);
        draggingIndex = null;
        try { e.dataTransfer.effectAllowed = "move"; } catch (_) {}
      });
      head.addEventListener("dragend", () => { draggingGroupSteps = null; });
      const caret = document.createElement("span");
      caret.textContent = collapsed ? "▸" : "▾";
      caret.style.color = "#c4b5fd";
      const tag = document.createElement("span");
      tag.textContent = "▦ GROUP";
      Object.assign(tag.style, { fontSize: "10px", fontWeight: "700", color: "#c4b5fd" });
      const nm = document.createElement("span");
      nm.textContent = name + " (" + (groupCounts[name] || 0) + ")";
      Object.assign(nm.style, { fontSize: "12px", fontWeight: "700", color: "#e9d5ff", flex: "1" });

      const saveGBtn = document.createElement("button");
      saveGBtn.textContent = "💾";
      saveGBtn.title = "Lưu group này vào tab Groups";
      Object.assign(saveGBtn.style, { fontSize: "11px", border: "1px solid #6d28d9", background: "rgba(109,40,217,0.5)", color: "#ede9fe", borderRadius: "5px", cursor: "pointer", padding: "1px 6px" });
      saveGBtn.onclick = (e) => { e.stopPropagation(); saveInlineGroupToLibrary(name); };

      const ungBtn = document.createElement("button");
      ungBtn.textContent = "Ungroup";
      Object.assign(ungBtn.style, { fontSize: "11px", border: "1px solid #475569", background: "rgba(51,65,85,0.7)", color: "#cbd5e1", borderRadius: "5px", cursor: "pointer", padding: "1px 6px" });
      ungBtn.onclick = (e) => {
        e.stopPropagation();
        steps.forEach(s => { if (s && String(s.groupName || "").trim() === name) delete s.groupName; });
        flushProxies();
        renderSteps();
      };

      // Xóa group: xóa luôn các step thuộc group (khác Ungroup)
      const delGBtn = document.createElement("button");
      delGBtn.textContent = "🗑 Xóa";
      delGBtn.title = "Xóa group này và toàn bộ step bên trong";
      Object.assign(delGBtn.style, { fontSize: "11px", border: "1px solid #7f1d1d", background: "rgba(127,29,29,0.6)", color: "#fecaca", borderRadius: "5px", cursor: "pointer", padding: "1px 6px" });
      delGBtn.onclick = (e) => {
        e.stopPropagation();
        const cnt = groupCounts[name] || 0;
        if (!window.confirm("Xóa group \"" + name + "\" và " + cnt + " step bên trong? Không thể hoàn tác.")) return;
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i] && String(steps[i].groupName || "").trim() === name) steps.splice(i, 1);
        }
        delete groupCollapsed[name];
        clearPendingEmpty(name);
        flushProxies();
        renderSteps();
        setLog("Đã xóa group: " + name + " (" + cnt + " step)");
      };

      const body = document.createElement("div");
      Object.assign(body.style, { padding: "0 6px 6px 6px", display: collapsed ? "none" : "block", minHeight: "10px" });

      // Thả step vào vùng group → step nhận group này (đưa xuống cuối group)
      const acceptDrop = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (draggingIndex == null) return;
        const moved = steps[draggingIndex];
        if (!moved) { draggingIndex = null; return; }
        steps.splice(draggingIndex, 1);
        moved.groupName = name;
        clearPendingEmpty(name);
        // tìm vị trí cuối cùng của group này rồi chèn sau
        let lastIdx = -1;
        steps.forEach((s, i) => { if (s && String(s.groupName || "").trim() === name) lastIdx = i; });
        steps.splice(lastIdx + 1, 0, moved);
        draggingIndex = null;
        flushProxies();
        renderSteps();
      };
      body.addEventListener("dragover", e => { e.preventDefault(); });
      body.addEventListener("drop", acceptDrop);
      head.addEventListener("dragover", e => { e.preventDefault(); });
      head.addEventListener("drop", acceptDrop);

      head.onclick = () => { groupCollapsed[name] = !groupCollapsed[name]; renderSteps(); };

      head.appendChild(caret);
      head.appendChild(tag);
      head.appendChild(nm);
      head.appendChild(saveGBtn);
      head.appendChild(ungBtn);
      head.appendChild(delGBtn);
      wrap.appendChild(head);
      wrap.appendChild(body);
      container.appendChild(wrap);
      curGroupBody = body;
    }

    // Thả vào KHE giữa các item top-level: chèn vào vị trí targetArrIndex,
    // step lẻ → BỎ group (nằm giữa, không thuộc group nào); group → di chuyển cả khối.
    function dropAtGap(targetArrIndex) {
      const anchorObj = steps[targetArrIndex] || null; // step đứng ngay sau khe (trước khi xóa)
      if (draggingGroupSteps && draggingGroupSteps.length) {
        const set = new Set(draggingGroupSteps);
        const block = steps.filter(s => set.has(s)); // giữ đúng thứ tự
        steps = steps.filter(s => !set.has(s));
        let ins = anchorObj ? steps.indexOf(anchorObj) : steps.length;
        if (ins < 0) ins = steps.length;
        steps.splice(ins, 0, ...block);
        draggingGroupSteps = null;
      } else if (draggingIndex != null) {
        const moved = steps[draggingIndex];
        if (!moved) { draggingIndex = null; return; }
        steps.splice(draggingIndex, 1);
        delete moved.groupName; // khe = nằm ngoài group
        let ins = anchorObj ? steps.indexOf(anchorObj) : steps.length;
        if (ins < 0) ins = steps.length;
        steps.splice(ins, 0, moved);
        draggingIndex = null;
      } else { return; }
      flushProxies();
      renderSteps();
    }

    function makeGapZone(targetArrIndex) {
      const gap = document.createElement("div");
      Object.assign(gap.style, { height: "8px", margin: "0", borderRadius: "4px", transition: "all .1s" });
      gap.addEventListener("dragover", (e) => {
        e.preventDefault();
        gap.style.height = "20px";
        gap.style.background = "rgba(59,130,246,0.35)";
      });
      gap.addEventListener("dragleave", () => {
        gap.style.height = "8px"; gap.style.background = "transparent";
      });
      gap.addEventListener("drop", (e) => {
        e.preventDefault(); e.stopPropagation();
        dropAtGap(targetArrIndex);
      });
      return gap;
    }

    steps.forEach((step, index) => {
      const row = document.createElement("div");
      row.draggable = true;
      row.dataset.index = String(index);
      Object.assign(row.style, {
        padding: "8px 10px",
        marginBottom: "4px",
        borderRadius: "8px",
        background: currentStepRunning && currentStepRunning.id === step.id
          ? "rgba(59,130,246,0.18)"
          : "rgba(255,255,255,0.03)",
        border: "none",
        boxShadow: currentStepRunning && currentStepRunning.id === step.id
          ? "inset 0 0 0 1px rgba(59,130,246,0.5)" : "none",
        display: "flex",
        flexDirection: "column",
        gap: "6px"
      });

      row.addEventListener("dragstart", () => {
        draggingIndex = index;
      });

      row.addEventListener("dragover", e => {
        e.preventDefault();
      });

      row.addEventListener("drop", e => {
        e.preventDefault();
        e.stopPropagation();
        // Đang kéo CẢ group → thả lên 1 step nghĩa là di chuyển group tới ngay trước step đó
        if (draggingGroupSteps && draggingGroupSteps.length) { dropAtGap(index); return; }
        const targetIndex = index;
        if (draggingIndex == null || draggingIndex === targetIndex) return;
        const moved = steps[draggingIndex];
        const targetStep = steps[targetIndex];
        if (!moved || !targetStep) { draggingIndex = null; return; }
        // Thả lên step nào → nhận group của step đó (kéo vào group / ra ngoài)
        const targetGroup = String(targetStep.groupName || "").trim();
        steps.splice(draggingIndex, 1);
        const ti = steps.indexOf(targetStep);
        if (targetGroup) moved.groupName = targetGroup; else delete moved.groupName;
        steps.splice(ti + 1, 0, moved);
        draggingIndex = null;
        flushProxies();
        renderSteps();
      });

      const topLine = document.createElement("div");
      Object.assign(topLine.style, {
        display: "flex",
        alignItems: "center",
        gap: "6px"
      });

      const orderBadge = document.createElement("div");
      orderBadge.textContent = "#" + (index + 1);
      Object.assign(orderBadge.style, {
        padding: "2px 7px",
        borderRadius: "999px",
        background: "linear-gradient(90deg,#0ea5e9,#3b82f6)",
        color: "#082f49",
        fontSize: "10px",
        fontWeight: "700"
      });

      const title = document.createElement("div");
      title.textContent = step.fieldId || "Step " + (index + 1);
      Object.assign(title.style, {
        fontWeight: "700",
        fontSize: "12px",
        cursor: "text"
      });
      title.title = "Double click to rename";
      title.ondblclick = async () => {
        const next = await showPromptModal("Step name:", step.fieldId || ("Step " + (index + 1)));
        if (next == null) return;
        steps[index].fieldId = String(next).trim() || ("Step " + (index + 1));
        renderSteps();
      };

      const typeBadge = document.createElement("div");
      typeBadge.textContent = (step.type || "click").toUpperCase();
      Object.assign(typeBadge.style, {
        padding: "2px 7px",
        borderRadius: "999px",
        background: step.enabled === false
          ? "linear-gradient(90deg,#64748b,#475569)"
          : "linear-gradient(90deg,#22c55e,#16a34a)",
        color: step.enabled === false ? "#e2e8f0" : "#052e16",
        fontSize: "10px",
        fontWeight: "700"
      });

      const summary = document.createElement("div");
      summary.style.fontSize = "11px";
      summary.style.color = "#9ca3af";
      summary.textContent = buildStepSummary(step);

      const note = document.createElement("div");
      note.style.fontSize = "10px";
      note.style.color = "#cbd5e1";
      note.textContent = step.note ? "Note: " + step.note : "";

      const meta = document.createElement("div");
      Object.assign(meta.style, {
        display: "flex",
        flexWrap: "wrap",
        gap: "8px",
        fontSize: "10px",
        color: "#94a3b8"
      });

      const controlsLine = document.createElement("div");
      Object.assign(controlsLine.style, {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px",
        alignItems: "center"
      });

      const btnTest = makeBtn("Test", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
      const btnPos = makeBtn("Pos", "linear-gradient(90deg,#f97373,#ef4444)", "#fff");
      const btnSel = makeBtn("Sel", "linear-gradient(90deg,#38bdf8,#2563eb)", "#020617");
      const btnModeSelector = makeBtn(
        "Selector",
        step.clickMode === "selector"
          ? "linear-gradient(90deg,#22c55e,#16a34a)"
          : "linear-gradient(90deg,#e5e7eb,#94a3b8)",
        step.clickMode === "selector" ? "#052e16" : "#020617"
      );
      const btnModePoint = makeBtn(
        "Point",
        step.clickMode === "point"
          ? "linear-gradient(90deg,#facc15,#eab308)"
          : "linear-gradient(90deg,#e5e7eb,#94a3b8)",
        step.clickMode === "point" ? "#111827" : "#020617"
      );
      const btnEdit = makeBtn("Edit", "linear-gradient(90deg,#0ea5e9,#3b82f6)", "#082f49");
      const btnDup = makeBtn("Dup", "linear-gradient(90deg,#e5e7eb,#94a3b8)", "#020617");
      const btnDel = makeBtn("Del", "linear-gradient(90deg,#f97373,#ef4444)", "#fff");

      // Checkbox chọn step để gộp thành group
      const selChk = document.createElement("input");
      selChk.type = "checkbox";
      selChk.title = "Chọn step để gộp Group";
      selChk.checked = selectedStepIds.has(step.id);
      selChk.style.cursor = "pointer";
      selChk.onclick = (ev) => { ev.stopPropagation(); };
      selChk.onchange = () => {
        if (selChk.checked) selectedStepIds.add(step.id);
        else selectedStepIds.delete(step.id);
      };

      topLine.appendChild(selChk);
      topLine.appendChild(orderBadge);
      topLine.appendChild(title);
      topLine.appendChild(typeBadge);

      if (step.selector && ["click", "hover", "input", "read", "upload", "delete", "download", "scroll"].includes(step.type)) {
        const shortSel =
          step.selector.length > 80 ? step.selector.slice(0, 77) + "..." : step.selector;
        meta.appendChild(makeMetaPill("selector", shortSel));
      }

      if (step.type === "open" || step.type === "opentab") {
        if (step.column) {
          const pill = makeMetaPill("url column", step.column);
          pill.title = "Double click to edit URL column";
          pill.ondblclick = async () => {
            const next = await showPromptModal("URL column:", step.column || "");
            if (next == null) return;
            steps[index].column = String(next).trim().toUpperCase();
            renderSteps();
          };
          meta.appendChild(pill);
        } else {
          const metaUrl = (step.url || step.value || "").trim();
          if (metaUrl) {
            const shortUrl =
              metaUrl.length > 80 ? metaUrl.slice(0, 77) + "..." : metaUrl;
            meta.appendChild(makeMetaPill("url", shortUrl));
          }
        }
      } else if (step.column) {
        const pill = makeMetaPill("column", step.column);
        pill.title = "Double click to edit column";
        pill.ondblclick = async () => {
          const next = await showPromptModal("Column:", step.column || "");
          if (next == null) return;
          steps[index].column = String(next).trim().toUpperCase();
          renderSteps();
        };
        meta.appendChild(pill);
      }

      if ((step.type === "click" || step.type === "hover") && step.clickMode) {
        meta.appendChild(makeMetaPill("mode", step.clickMode));
      }

      // Var = CHỈ Result key (không lấy Step name/Field ID làm var)
      if ((step.type === "read" || step.type === "return" || step.type === "input") &&
          step.resultKey) {
        const keyName = String(step.resultKey).trim();
        if (keyName) {
          meta.appendChild(makeMetaPill("var", keyName));
        }
      }
      // Condition: hiện biến đang kiểm tra (check var)
      if (step.type === "condition") {
        const cvar = String(step.resultKey || "").trim();
        meta.appendChild(makeMetaPill("check", cvar ? cvar : "last read"));
      }

      // Hiện giá trị READ gần nhất ngay trên card (read step)
      if (step.type === "read") {
        const rv = lastReadByStep[readKey(activeSlotId, step)];
        if (rv !== undefined && rv !== null) {
          const rvStr = String(rv).trim();
          const short = rvStr.length > 80 ? rvStr.slice(0, 77) + "..." : (rvStr || "(empty)");
          const rvPill = makeMetaPill("read", short);
          rvPill.title = rvStr || "(empty)";
          meta.appendChild(rvPill);
        }
      }

      // Hiện kết quả CONDITION gần nhất (TRUE/false) trên card
      if (step.type === "condition") {
        const cv = lastConditionByStep[readKey(activeSlotId, step)];
        if (cv !== undefined) {
          const cPill = makeMetaPill("result", cv ? "✓ TRUE" : "✗ false");
          cPill.style.background = cv ? "rgba(22,163,74,0.85)" : "rgba(220,38,38,0.85)";
          cPill.style.color = "#fff";
          meta.appendChild(cPill);
        }
      }

      if (step.type === "click" && step.clickMode === "point" &&
          typeof step.x === "number" && typeof step.y === "number") {
        meta.appendChild(makeMetaPill("point", step.x + ", " + step.y));
      }

      const delayPill = makeMetaPill("delay", String(step.delayMs || 0) + "ms");
      delayPill.title = "Double click to edit delay";
      delayPill.ondblclick = async () => {
        const next = await showPromptModal("Delay (ms):", String(step.delayMs || 0));
        if (next == null) return;
        steps[index].delayMs = toNumber(next, step.delayMs || 0);
        renderSteps();
      };
      meta.appendChild(delayPill);

      try {
        const rowNum = currentRowRunning || getRowNumberFromUI() || 2;
        if (!rowData || !rowData[rowNum]) {
          meta.appendChild(makeMetaPill("sheet", "no data for row " + rowNum));
        } else if (step.column) {
          const previewRaw = getCellValueByColumn(rowData[rowNum], step.column);
          /* console.log("[DL DEBUG] preview", {
            row: rowNum,
            fieldId: step.fieldId,
            type: step.type,
            column: step.column,
            value: previewRaw,
            rowObj: rowData[rowNum]
          }); */
          if (previewRaw) {
            const trimmed = String(previewRaw).trim();
            const short =
              trimmed.length > 80
                ? trimmed.slice(0, 77) + "..."
                : trimmed;
            meta.appendChild(makeMetaPill("value", short));
          }
        }
      } catch (_) {
      }

      controlsLine.appendChild(btnTest);

      if (["click", "hover", "input", "read", "upload", "delete", "download", "clicknear", "read-input", "cdpclick", "pressarrow"].includes(step.type)) {
        controlsLine.appendChild(btnPos);
        controlsLine.appendChild(btnSel);
      }

      // Popup clickpoint/clickselector: thêm nút Pick từ popup window
      if (step.type === "popup" && (step.popupAction === "clickpoint" || step.popupAction === "clickselector")) {
        if (step.popupAction === "clickpoint") {
          const btnPopupPos = makeBtn("Pick Pos (popup)", "linear-gradient(90deg,#f97373,#ef4444)", "#fff");
          btnPopupPos.onclick = async () => {
            try {
              if (!hasControlAPI() || typeof window.controlAPI.popupPickPoint !== "function") {
                setStatus("popupPickPoint API not available", "error"); return;
              }
              setStatus("Click on popup window to pick position...", "run");
              const res = await window.controlAPI.popupPickPoint({ slotId: activeSlotId });
              if (res && res.ok) {
                steps[index].x = res.x;
                steps[index].y = res.y;
                renderSteps();
                setStatus("Picked: " + res.x + ", " + res.y, "ok");
              } else {
                setStatus("Pick failed: " + (res && res.reason ? res.reason : "unknown"), "error");
              }
            } catch (err) { setStatus("Pick point error", "error"); }
          };
          controlsLine.appendChild(btnPopupPos);
        }

        if (step.popupAction === "clickselector") {
          const btnPopupSel = makeBtn("Pick Sel (popup)", "linear-gradient(90deg,#38bdf8,#2563eb)", "#020617");
          btnPopupSel.onclick = async () => {
            try {
              if (!hasControlAPI() || typeof window.controlAPI.popupPickSelector !== "function") {
                setStatus("popupPickSelector API not available", "error"); return;
              }
              setStatus("Click on popup window to pick selector...", "run");
              const res = await window.controlAPI.popupPickSelector({ slotId: activeSlotId });
              if (res && res.ok) {
                steps[index].selector = res.selector || "";
                if (res.elementText) steps[index].elementText = res.elementText;
                renderSteps();
                setStatus("Selector picked: " + (res.selector || ""), "ok");
              } else {
                setStatus("Pick failed: " + (res && res.reason ? res.reason : "unknown"), "error");
              }
            } catch (err) { setStatus("Pick selector error", "error"); }
          };
          controlsLine.appendChild(btnPopupSel);
        }
      }

      if (step.type === "click" || step.type === "hover") {
        controlsLine.appendChild(btnModeSelector);
        controlsLine.appendChild(btnModePoint);
      }

      controlsLine.appendChild(btnEdit);
      controlsLine.appendChild(btnDup);
      controlsLine.appendChild(btnDel);

      row.appendChild(topLine);
      row.appendChild(summary);
      if (note.textContent) row.appendChild(note);
      row.appendChild(meta);
      row.appendChild(controlsLine);

      btnTest.onclick = async () => {
        try {
          // Luôn đọc steps[index] tại thời điểm click — không dùng closure `step`
          // vì pick selector/point đã update steps[index] sau khi render
          const liveStep = steps[index];
          if (!liveStep) {
            setStatus("Step not found", "error");
            return;
          }
          const _st = S();
          _st.paused = false;
          _st.stopped = false;
          _st.endRow = false;
          _st.currentStepIndexForResume = index;
          currentStepIndexForResume = index;
          currentStepRunning = liveStep;

          // Đảm bảo currentRowRunning được set trước khi test
          const uiRow = getRowNumberFromUI() || 2;
          _st.currentRowRunning = uiRow;

          if (String(liveStep.type || "").toLowerCase() === "condition") {
            // Condition: chạy luồng THẬT từ step này, lặp đến khi TRUE thì DỪNG (chỉ test)
            flushProxies();
            setStatus("Test: chạy đến khi condition TRUE...", "run");
            await runStepsFromIndex(index, _st, { stopOnCondTrue: true });
            const passed = !!_st.lastConditionPassed;
            setStatus("Condition = " + (passed ? "TRUE ✓ → dừng" : "FALSE ✗"), passed ? "ok" : "warn");
            setLog("CONDITION test => " + (passed ? "TRUE (dừng tại đây)" : "FALSE"));
          } else {
            setStatus("Run single step", "run");
            await runSingleStep(liveStep, _st);
            setStatus("Step done", "ok");
            setLog("Done " + (liveStep.fieldId || ("Step " + (index + 1))));
          }
          currentStepRunning = null;
          renderSteps();
        } catch (err) {
          console.warn("[DetectLab] run single step error:", err);
          setStatus("Step failed", "error");
          setLog("Step failed");
          currentStepRunning = null;
          renderSteps();
        }
      };

      btnPos.onclick = () => {
        try {
          domExec({
            type: "startPickPoint",
            stepId: steps[index] ? steps[index].id : step.id
          });
          setStatus("Click on target page to pick position", "run");
        } catch (err) {
          console.warn("[DetectLab] startPickPoint error:", err);
        }
      };

      btnSel.onclick = () => {
        try {
          domExec({
            type: "startPickSelector",
            stepId: steps[index] ? steps[index].id : step.id
          });
          setStatus("Click on target page to pick selector", "run");
        } catch (err) {
          console.warn("[DetectLab] startPickSelector error:", err);
        }
      };

      btnModeSelector.onclick = () => {
        steps[index].clickMode = "selector";
        renderSteps();
      };

      btnModePoint.onclick = () => {
        steps[index].clickMode = "point";
        renderSteps();
      };

      btnEdit.onclick = () => openStepEditor(index);
      btnDup.onclick = () => duplicateStep(index);
      btnDel.onclick = () => {
        if (!confirm("Delete this step?")) return;
        steps.splice(index, 1);
        renderSteps();
      };

      // Đưa row vào group container nếu step thuộc group
      const gname = String(step.groupName || "").trim();
      if (gname) {
        if (gname !== curGroupName) {
          container.appendChild(makeGapZone(index)); // khe trước 1 group mới
          startGroup(gname);
        }
        curGroupBody.appendChild(row);
      } else {
        curGroupName = null;
        curGroupBody = null;
        container.appendChild(makeGapZone(index)); // khe trước step lẻ
        container.appendChild(row);
      }
    });

    // Khe cuối cùng (thả xuống cuối danh sách)
    curGroupName = null; curGroupBody = null;
    container.appendChild(makeGapZone(steps.length));

    // Render các group RỖNG (vừa Add Group, chưa có step) làm vùng kéo-thả
    pendingEmptyGroups.forEach(name => {
      const has = steps.some(s => s && String(s.groupName || "").trim() === name);
      if (!has) startGroup(name);
    });
  }

  // Cleanup: bỏ tên khỏi danh sách group rỗng khi đã có step
  function clearPendingEmpty(name) {
    pendingEmptyGroups = pendingEmptyGroups.filter(n => n !== name);
  }

  function makeMetaPill(label, value) {
    const el = document.createElement("div");
    el.textContent = label + ": " + value;
    Object.assign(el.style, {
      padding: "1px 7px",
      borderRadius: "6px",
      border: "none",
      background: "rgba(255,255,255,0.05)",
      color: "#94a3b8",
      fontSize: "10px",
      userSelect: "none"
    });
    return el;
  }

  function buildStepSummary(step) {
    const type = step.type || "click";

    if (type === "click") {
      if (step.clickMode === "point") {
        return "Click point at (" + String(step.x ?? "") + ", " + String(step.y ?? "") + ")";
      }
      return "Click element";
    }

    if (type === "hover") {
      return "Hover element";
    }

    if (type === "input") {
      return "Input into " + (step.selector || "(none)") + " from " +
        (step.column ? "column " + step.column : "fixed value");
    }

    if (type === "open" || type === "opentab") {
      const target = step.column
        ? "column " + step.column
        : (step.url || step.value || "(none)");
      return (type === "open" ? "Open URL: " : "Open tab URL: ") + target;
    }

    if (type === "upload") {
      return "Upload file via " + (step.selector || "(none)") + " from column " + (step.column || "(none)");
    }

    if (type === "delete") {
      return "Delete / clear via " + (step.selector || "(none)");
    }

    if (type === "end") {
      return "End pattern";
    }

    if (type === "condition") {
      return "Condition: " + (step.conditionExpr || step.value || "(none)");
    }

    if (type === "read") {
      const key = (step.resultKey || "").trim();
      return "Read " + (step.readMode || "text") + " from " + (step.selector || "(none)") +
        (key ? " -> var '" + key + "'" : " (value only)");
    }

    if (type === "download") {
      return "Download from " + (step.selector || "(none)") + " => " + (step.value || "(default)");
    }

    if (type === "return") {
      return "Return sheet value from column " + (step.column || "(none)");
    }

    if (type === "popup") {
      const pa = step.popupAction || "click";
      if (pa === "click")     return "Popup click: " + (step.elementText || step.selector || "(none)");
      if (pa === "input")     return "Popup input " + (step.selector || "input") + " = " + (step.value || "col " + (step.column || "?"));
      if (pa === "read")      return "Popup read " + (step.selector || "body") + " -> var '" + (step.resultKey || "?") + "'";
      if (pa === "wait")      return "Popup: wait for popup to open";
      if (pa === "wait-load") return "Popup: wait for page load";
      if (pa === "keypress")  return "Popup keypress: " + (step.popupKey || "Enter") + (step.selector ? " on " + step.selector : " (focused)");
      if (pa === "get-url")   return "Popup get-url -> var '" + (step.resultKey || "?") + "'";
      if (pa === "close")     return "Popup close";
      return "Popup: " + pa;
    }

    if (type === "wait") {
      return "Wait " + String(step.delayMs || 0) + " ms";
    }

    if (type === "scroll") {
      return "Scroll into view: " + (step.selector || "(none)");
    }

    if (type === "keypress") {
      return "Press key: " + (step.key || "(none)");
    }

    return "Type: " + type;
  }

  function duplicateStep(index) {
    const step = steps[index];
    if (!step) return;
    const cloned = deepClone(step);
    cloned.id = uid("step");
    cloned.fieldId = (step.fieldId || "Step") + " copy";
    steps.splice(index + 1, 0, cloned);
    renderSteps();
  }

  function openStepEditor(index) {
    const step = steps[index];
    if (!step) return;

    const overlay = document.createElement("div");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      background: "rgba(2,6,23,0.7)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "99999"
    });

    const modal = document.createElement("div");
    Object.assign(modal.style, {
      width: "min(760px, calc(100vw - 24px))",
      maxHeight: "calc(100vh - 24px)",
      overflowY: "auto",
      padding: "12px",
      borderRadius: "10px",
      background: "#0f172a",
      border: "1px solid #2563eb",
      color: "#e5e7eb",
      boxShadow: "0 10px 30px rgba(0,0,0,0.35)",
      display: "flex",
      flexDirection: "column",
      gap: "10px"
    });

    const head = document.createElement("div");
    Object.assign(head.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "8px"
    });

    const headTitle = document.createElement("div");
    headTitle.textContent = "Edit step #" + (index + 1);
    headTitle.style.fontWeight = "700";
    headTitle.style.fontSize = "15px";

    const closeBtn = makeBtn("Close", "linear-gradient(90deg,#334155,#1f2937)", "#fff");

    head.appendChild(headTitle);
    head.appendChild(closeBtn);

    const grid = document.createElement("div");
    Object.assign(grid.style, {
      display: "grid",
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      gap: "10px"
    });

    const fieldIdInput = makeSmallInput("text", step.fieldId || "", "100%");
    fieldIdInput.style.width = "100%";

    const typeSelect = makeSelect(
      [
        "click",
        "cdpclick",
        "gsiclick",
        "clicknear",
        "pressarrow",
        "hover",
        "input",
        "read-input",
        "open",
        "opentab",
        "upload",
        "delete",
        "end",
        "condition",
        "read",
        "download",
        "return",
        "save-session",
        "load-session",
        "popup"
      ],
      step.type || "click",
      "100%"
    );
    typeSelect.style.width = "100%";

    const selectorInput = makeSmallInput("text", step.selector || "", "100%");
    selectorInput.style.width = "100%";

    const columnInput = makeSmallInput("text", step.column || "", "100%");
    columnInput.style.width = "100%";

    const fileNameColumnInput = makeSmallInput("text", step.fileNameColumn || "", "100%");
    fileNameColumnInput.style.width = "100%";

    const urlInput = makeSmallInput("text", step.url || "", "100%");
    urlInput.style.width = "100%";

    const valueInput = makeSmallInput("text", step.value || "", "100%");
    valueInput.style.width = "100%";

    const conditionExprInput = makeSmallInput("text", step.conditionExpr || "", "100%");
    conditionExprInput.style.width = "100%";
    conditionExprInput.placeholder = "e.g. vars.status === 'ok' (used when no operator)";

    const conditionOpSelect = makeSelect(
      [
        { value: "",          label: "(no operator — truthy check / use expression)" },
        { value: "equal",     label: "equal (case-insensitive)" },
        { value: "exact",     label: "exact (===)" },
        { value: "different", label: "different (≠)" },
        { value: "contain",   label: "contain" },
        { value: ">",         label: ">" },
        { value: "<",         label: "<" },
        { value: ">=",        label: "≥" },
        { value: "<=",        label: "≤" }
      ],
      step.conditionOp || "",
      "100%"
    );
    conditionOpSelect.style.width = "100%";

    const conditionValueColumnInput = makeSmallInput("text", step.conditionValueColumn || "", "100%");
    conditionValueColumnInput.style.width = "100%";
    conditionValueColumnInput.placeholder = "Sheet column (e.g. B) — read cell for current row";

    // Dedicated fixed-literal value for the condition (separate from the
    // shared `value` field used by input/open/popup steps).
    const conditionValueInput = makeSmallInput("text", step.conditionValue || "", "100%");
    conditionValueInput.style.width = "100%";
    conditionValueInput.placeholder = "Fixed value (e.g. true, Active, 100, {{var}})";

    const sessionNameInput = makeSmallInput("text", step.sessionName || "", "100%");
    sessionNameInput.style.width = "100%";
    sessionNameInput.placeholder = "e.g. kie_ai_account1";

    const sourceFieldIdInput = makeSmallInput("text", step.sourceFieldId || "", "100%");
    sourceFieldIdInput.style.width = "100%";
    sourceFieldIdInput.placeholder = "Field ID / resultKey của read step";

    const conditionTrueModeSelect = makeSelect(
      [
        { value: "stop", label: "Stop pattern (when FALSE)" },
        { value: "jump", label: "Jump to step (when FALSE) →" }
      ],
      step.conditionTrueMode || "stop",
      "100%"
    );
    conditionTrueModeSelect.style.width = "100%";

    // Jump target: dropdown neo theo ID step (ổn định khi thêm/xóa/đổi thứ tự).
    // KHÔNG lưu số thứ tự cố định nữa — số thứ tự dịch chuyển sẽ làm jump sai.
    const conditionJumpToInput = document.createElement("select");
    Object.assign(conditionJumpToInput.style, {
      width: "100%", padding: "3px 6px", borderRadius: "4px",
      border: "1px solid #475569", background: "#020617", color: "#e5e7eb",
      fontSize: "11px", outline: "none"
    });
    (function buildJumpOptions() {
      const none = document.createElement("option");
      none.value = ""; none.textContent = "— chọn step đích —";
      conditionJumpToInput.appendChild(none);

      // Migrate giá trị cũ (số thứ tự / fieldId) → id ổn định
      const cur = String(step.conditionJumpTo || "").trim();
      let curId = "";
      if (cur) {
        const numStr = cur.replace(/^#/, "").trim();
        if (/^\d+$/.test(numStr)) {
          const t = steps[parseInt(numStr, 10) - 1];
          if (t) curId = t.id;
        } else {
          const byId = steps.find(s => s && String(s.id) === cur);
          const byField = steps.find(s => s && String(s.fieldId || "").trim().toLowerCase() === cur.toLowerCase());
          curId = byId ? byId.id : (byField ? byField.id : "");
        }
      }

      steps.forEach((s, i) => {
        if (!s) return;
        const opt = document.createElement("option");
        opt.value = String(s.id);
        const isSelf = s.id === step.id;
        opt.textContent = "#" + (i + 1) + " · " + (s.fieldId || ("Step " + (i + 1))) + (isSelf ? " (chính nó)" : "");
        conditionJumpToInput.appendChild(opt);
      });
      conditionJumpToInput.value = curId;
    })();

    const clickModeSelect = makeSelect(["selector", "point"], step.clickMode || "selector", "100%");
    clickModeSelect.style.width = "100%";

    const clicknearDirectionSelect = makeSelect(["right", "left"], step.clicknearDirection || "right", "100%");
    clicknearDirectionSelect.style.width = "100%";

    const clicknearIndexInput = makeSmallInput("number", step.clicknearIndex != null ? String(step.clicknearIndex) : "0", "100%");
    clicknearIndexInput.style.width = "100%";
    clicknearIndexInput.placeholder = "0 = first btn, 1 = second...";

    const xInput = makeSmallNumberInput(-99999, step.x ?? "", "100%");
    xInput.style.width = "100%";

    const yInput = makeSmallNumberInput(-99999, step.y ?? "", "100%");
    yInput.style.width = "100%";

    const offsetXInput = makeSmallNumberInput(-9999, step.offsetX ?? 0, "100%");
    offsetXInput.style.width = "100%";
    offsetXInput.placeholder = "0 = center, + = right, - = left";

    const offsetYInput = makeSmallNumberInput(-9999, step.offsetY ?? 0, "100%");
    offsetYInput.style.width = "100%";

    const offsetEdgeSelect = makeSelect(["center", "right", "left"], step.offsetEdge || "center", "100%");
    offsetEdgeSelect.style.width = "100%";

    const arrowDirectionSelect = makeSelect(["up", "down", "left", "right"], step.arrowDirection || "up", "100%");
    arrowDirectionSelect.style.width = "100%";

    const arrowCountInput = makeSmallInput("number", step.arrowCount != null ? String(step.arrowCount) : "1", "100%");
    arrowCountInput.style.width = "100%";
    arrowCountInput.placeholder = "Số lần nhấn (vd: 1)";

    const arrowDelayInput = makeSmallInput("number", step.arrowDelay != null ? String(step.arrowDelay) : "50", "100%");
    arrowDelayInput.style.width = "100%";
    arrowDelayInput.placeholder = "Delay giữa các lần (ms)";

    const delayInput = makeSmallNumberInput(0, step.delayMs ?? 300, "100%");
    delayInput.style.width = "100%";

    const waitBeforeInput = makeSmallNumberInput(0, step.waitBeforeMs ?? 0, "100%");
    waitBeforeInput.style.width = "100%";

    const waitAfterInput = makeSmallNumberInput(0, step.waitAfterMs ?? 0, "100%");
    waitAfterInput.style.width = "100%";

    const matchTextInput = makeSmallInput("text", step.matchText || "", "100%");
    matchTextInput.style.width = "100%";

    const keyInput = makeSmallInput("text", step.key || "", "100%");
    keyInput.style.width = "100%";

    const labelTextInput = makeSmallInput("text", step.labelText || "", "100%");
    labelTextInput.style.width = "100%";
    labelTextInput.placeholder = "e.g. Email";

    const elementTextInput = makeSmallInput("text", step.elementText || "", "100%");
    elementTextInput.style.width = "100%";
    elementTextInput.placeholder = "e.g. Submit (hoặc dùng {{varName}})";

    const elementTextColumnInput = makeSmallInput("text", step.elementTextColumn || "", "100%");
    elementTextColumnInput.style.width = "100%";
    elementTextColumnInput.placeholder = "e.g. C (override text từ sheet)";

    const elementTextVarInput = makeSmallInput("text", step.elementTextVar || "", "100%");
    elementTextVarInput.style.width = "100%";
    elementTextVarInput.placeholder = "e.g. selectedAccount";

    const containerTagInput = makeSmallInput("text", step.containerTag || "", "100%");
    containerTagInput.style.width = "100%";
    containerTagInput.placeholder = "e.g. div";

    const containerClassInput = makeSmallInput("text", step.containerClassName || "", "100%");
    containerClassInput.style.width = "100%";
    containerClassInput.placeholder = "e.g. form-group";

    const readModeSelect = makeSelect(["text", "html"], step.readMode || "text", "100%");
    readModeSelect.style.width = "100%";

    const resultKeyInput = makeSmallInput("text", step.resultKey || "", "100%");
    resultKeyInput.style.width = "100%";
    resultKeyInput.placeholder = "Tên biến lưu giá trị (vd: campaignName) — để trống nếu chỉ cần đọc";

    // --- Popup-specific fields ---
    const popupActionSelect = makeSelect(
      ["wait", "wait-load", "click", "clickpoint", "clickselector", "input", "keypress", "read", "get-url", "close"],
      step.popupAction || "click",
      "100%"
    );
    popupActionSelect.style.width = "100%";

    const popupKeyInput = makeSmallInput("text", step.popupKey || "", "100%");
    popupKeyInput.style.width = "100%";
    popupKeyInput.placeholder = "Enter, Tab, Escape, Space...";

    const enabledWrap = document.createElement("div");
    Object.assign(enabledWrap.style, {
      display: "flex",
      alignItems: "center",
      gap: "8px",
      paddingTop: "8px"
    });
    const enabledCheck = document.createElement("input");
    enabledCheck.type = "checkbox";
    enabledCheck.checked = step.enabled !== false;
    const enabledLabel = makeSmallLabel("Enabled");
    enabledWrap.appendChild(enabledCheck);
    enabledWrap.appendChild(enabledLabel);

    const noteInput = makeSmallTextarea(step.note || "", 3);

    const fieldFieldId = makeInlineField("Step name", fieldIdInput);
    const fieldType = makeInlineField("Type", typeSelect);
    const fieldSelector = makeInlineField("Selector", selectorInput);
    const fieldColumn = makeInlineField("Column", columnInput);
    const fieldFileNameColumn = makeInlineField("Name column", fileNameColumnInput);
    const fieldUrl = makeInlineField("URL", urlInput);
    const fieldValue = makeInlineField("Value", valueInput);
    const fieldConditionValueColumn = makeInlineField("Value column", conditionValueColumnInput);
    const fieldConditionOp = makeInlineField("Operator", conditionOpSelect);
    const fieldConditionValue = makeInlineField("Value (fixed)", conditionValueInput);
    const fieldCondition = makeInlineField("Expression", conditionExprInput);
    const fieldConditionTrueMode = makeInlineField("If FALSE →", conditionTrueModeSelect);
    const fieldConditionJumpTo = makeInlineField("Jump to step", conditionJumpToInput);
    const fieldSessionName = makeInlineField("Session name", sessionNameInput);
    const fieldSourceFieldId = makeInlineField("Source field ID", sourceFieldIdInput);
    const fieldReadMode = makeInlineField("Read mode", readModeSelect);
    const fieldResultKey = makeInlineField("Result key (Var)", resultKeyInput);
    const fieldClickMode = makeInlineField("Click mode", clickModeSelect);
    const fieldClicknearDirection = makeInlineField("Direction", clicknearDirectionSelect);
    const fieldClicknearIndex = makeInlineField("Btn index", clicknearIndexInput);
    const fieldMatchText = makeInlineField("Match text", matchTextInput);
    const fieldX = makeInlineField("X", xInput);
    const fieldY = makeInlineField("Y", yInput);
    const fieldOffsetX = makeInlineField("Offset X", offsetXInput);
    const fieldOffsetY = makeInlineField("Offset Y", offsetYInput);
    const fieldOffsetEdge = makeInlineField("Offset edge", offsetEdgeSelect);
    const fieldArrowDirection = makeInlineField("Arrow dir", arrowDirectionSelect);
    const fieldArrowCount = makeInlineField("Arrow count", arrowCountInput);
    const fieldArrowDelay = makeInlineField("Arrow delay", arrowDelayInput);
    const fieldDelay = makeInlineField("Delay", delayInput);
    const fieldWaitBefore = makeInlineField("Wait before", waitBeforeInput);
    const fieldWaitAfter = makeInlineField("Wait after", waitAfterInput);
    const fieldKey = makeInlineField("Key", keyInput);
    const fieldLabelText = makeInlineField("Label text", labelTextInput);
    const fieldElementText = makeInlineField("Element text", elementTextInput);
    const fieldElementTextColumn = makeInlineField("Text from column", elementTextColumnInput);
    const fieldElementTextVar = makeInlineField("Text from var", elementTextVarInput);
    const fieldContainerTag = makeInlineField("Container tag", containerTagInput);
    const fieldContainerClass = makeInlineField("Container class", containerClassInput);
    const fieldPopupAction = makeInlineField("Popup action", popupActionSelect);
    const fieldPopupKey = makeInlineField("Key", popupKeyInput);

    [
      fieldFieldId,
      fieldType,
      fieldPopupAction,
      fieldPopupKey,
      fieldSelector,
      fieldLabelText,
      fieldElementText,
      fieldElementTextColumn,
      fieldElementTextVar,
      fieldContainerTag,
      fieldContainerClass,
      fieldColumn,
      fieldFileNameColumn,
      fieldUrl,
      fieldValue,
      fieldConditionValueColumn,
      fieldConditionOp,
      fieldConditionValue,
      fieldCondition,
      fieldConditionTrueMode,
      fieldConditionJumpTo,
      fieldSessionName,
      fieldSourceFieldId,
      fieldReadMode,
      fieldResultKey,
      fieldClickMode,
      fieldClicknearDirection,
      fieldClicknearIndex,
      fieldMatchText,
      fieldX,
      fieldY,
      fieldOffsetX,
      fieldOffsetY,
      fieldOffsetEdge,
      fieldArrowDirection,
      fieldArrowCount,
      fieldArrowDelay,
      fieldDelay,
      fieldWaitBefore,
      fieldWaitAfter,
      fieldKey
    ].forEach(el => grid.appendChild(el));

    function setFieldVisible(el, visible) {
      el.style.display = visible ? "flex" : "none";
    }

    function refreshEditorByType() {
      const type = String(typeSelect.value || "click").trim().toLowerCase();
      const isPopup = type === "popup";

      // Popup action visibility — always show when type=popup
      setFieldVisible(fieldPopupAction, isPopup);

      // For popup type, derive visible fields from popupAction
      if (isPopup) {
        const pa = String(popupActionSelect.value || "click").toLowerCase();
        const popupHasSelector = ["click", "clickselector", "input", "read", "keypress"].includes(pa);
        setFieldVisible(fieldPopupKey, pa === "keypress");
        setFieldVisible(fieldSelector, popupHasSelector);
        setFieldVisible(fieldElementText, ["click", "clickselector"].includes(pa));
        setFieldVisible(fieldElementTextColumn, false);
        setFieldVisible(fieldElementTextVar, false);
        setFieldVisible(fieldLabelText, false);
        setFieldVisible(fieldContainerTag, false);
        setFieldVisible(fieldContainerClass, false);
        setFieldVisible(fieldColumn, pa === "input");
        setFieldVisible(fieldUrl, false);
        setFieldVisible(fieldValue, pa === "input");
        setFieldVisible(fieldConditionValueColumn, false);
        setFieldVisible(fieldConditionOp, false);
        setFieldVisible(fieldConditionValue, false);
        setFieldVisible(fieldCondition, false);
        setFieldVisible(fieldConditionTrueMode, false);
        setFieldVisible(fieldConditionJumpTo, false);
        setFieldVisible(fieldReadMode, pa === "read");
        setFieldVisible(fieldResultKey, ["read", "get-url"].includes(pa));
        setFieldVisible(fieldClickMode, false);
        setFieldVisible(fieldMatchText, false);
        setFieldVisible(fieldX, pa === "clickpoint");
        setFieldVisible(fieldY, pa === "clickpoint");
        setFieldVisible(fieldKey, false);
        // wait / wait-load / close không cần delay
        setFieldVisible(fieldDelay, !["wait", "wait-load", "close"].includes(pa));
        setFieldVisible(fieldWaitBefore, true);
        setFieldVisible(fieldWaitAfter, true);
        if (pa === "input") {
          fieldColumn._setLabel("Column (data)");
          fieldValue._setLabel("Value (static)");
          columnInput.placeholder = "e.g. A";
          valueInput.placeholder = "Or static text";
        } else if (pa === "read") {
          fieldResultKey._setLabel("Result var");
          resultKeyInput.placeholder = "e.g. popupText";
        } else if (pa === "get-url") {
          fieldResultKey._setLabel("Result var (URL)");
          resultKeyInput.placeholder = "e.g. popupUrl";
        } else if (pa === "keypress") {
          fieldSelector._setLabel("Selector (optional)");
          selectorInput.placeholder = "Leave empty = focused element";
        }
        return;
      }

      // Non-popup types — original logic
      const hasSelectorType = ["click", "cdpclick", "hover", "input", "read-input", "upload", "delete", "read", "download", "scroll", "clicknear", "pressarrow"].includes(type);
      setFieldVisible(fieldSelector, hasSelectorType);
      setFieldVisible(fieldLabelText, hasSelectorType);
      setFieldVisible(fieldElementText, hasSelectorType);
      const hasElementTextSource = ["click", "cdpclick", "hover", "scroll", "delete", "download"].includes(type);
      setFieldVisible(fieldElementTextColumn, hasElementTextSource);
      setFieldVisible(fieldElementTextVar, hasElementTextSource);
      setFieldVisible(fieldContainerTag, hasSelectorType);
      setFieldVisible(fieldContainerClass, hasSelectorType);
      setFieldVisible(fieldColumn, ["input", "open", "opentab", "upload", "return"].includes(type));
      setFieldVisible(fieldUrl, ["open", "opentab", "load-session"].includes(type));
      setFieldVisible(fieldValue, ["input", "open", "opentab", "download"].includes(type));

      if (type === "read") {
        fieldColumn._setLabel("Target column");
      } else if (type === "return") {
        fieldColumn._setLabel("Return column");
      } else if (type === "open" || type === "opentab") {
        fieldColumn._setLabel("URL column");
      } else if (type === "download") {
        fieldColumn._setLabel("Link column");
      } else {
        fieldColumn._setLabel("Column");
      }
      setFieldVisible(fieldConditionOp, type === "condition");
      // Value column + Value (fixed) only matter when an operator is selected
      setFieldVisible(fieldConditionValueColumn, type === "condition" && conditionOpSelect.value !== "");
      setFieldVisible(fieldConditionValue, type === "condition" && conditionOpSelect.value !== "");
      // Free-form expression only when no operator is chosen
      setFieldVisible(fieldCondition, type === "condition" && conditionOpSelect.value === "");
      setFieldVisible(fieldConditionTrueMode, type === "condition");
      setFieldVisible(fieldConditionJumpTo, type === "condition" && conditionTrueModeSelect.value === "jump");
      setFieldVisible(fieldSessionName, type === "save-session" || type === "load-session");
      setFieldVisible(fieldSourceFieldId, type === "read-input");
      setFieldVisible(fieldReadMode, type === "read");
      setFieldVisible(fieldResultKey, ["read", "return", "input", "condition"].includes(type));
      if (type === "condition") {
        fieldResultKey._setLabel("Check Var (result key)");
        resultKeyInput.placeholder = "Tên biến cần kiểm tra (khớp Result key của step Read). Trống = dùng read gần nhất";
      } else {
        fieldResultKey._setLabel("Result key (Var)");
        resultKeyInput.placeholder = "Tên biến lưu giá trị (vd: campaignName) — để trống nếu chỉ cần đọc";
      }
      setFieldVisible(fieldClickMode, type === "click" || type === "cdpclick" || type === "hover");
      setFieldVisible(fieldClicknearDirection, type === "clicknear");
      setFieldVisible(fieldClicknearIndex, type === "clicknear");
      setFieldVisible(fieldArrowDirection, type === "pressarrow");
      setFieldVisible(fieldArrowCount, type === "pressarrow");
      setFieldVisible(fieldArrowDelay, type === "pressarrow");
      setFieldVisible(fieldMatchText, type === "read");
      setFieldVisible(fieldX, ["click", "cdpclick", "download"].includes(type));
      setFieldVisible(fieldY, ["click", "cdpclick", "download"].includes(type));
      setFieldVisible(fieldOffsetX, type === "cdpclick");
      setFieldVisible(fieldOffsetY, type === "cdpclick");
      setFieldVisible(fieldOffsetEdge, type === "cdpclick");
      setFieldVisible(fieldKey, type === "keypress");
      setFieldVisible(fieldDelay, true);
      setFieldVisible(fieldWaitBefore, true);
      setFieldVisible(fieldWaitAfter, true);
      setFieldVisible(fieldFileNameColumn, type === "download");

      fieldColumn._setLabel(
        type === "download"
          ? "Link col"
          : (type === "open" || type === "opentab")
            ? "URL col"
            : "Column"
      );

      if (type === "open" || type === "opentab") {
        urlInput.placeholder = "https://example.com";
        valueInput.placeholder = "Optional old-format fallback";
        columnInput.placeholder = "Optional sheet column";
        fileNameColumnInput.placeholder = "";
      } else if (type === "download") {
        urlInput.placeholder = "";
        valueInput.placeholder = "";
        columnInput.placeholder = "e.g. F (link column)";
        fileNameColumnInput.placeholder = "e.g. G (name column)";
      } else {
        urlInput.placeholder = "";
        valueInput.placeholder = "";
        columnInput.placeholder = "";
        fileNameColumnInput.placeholder = "";
      }
    }

    typeSelect.onchange = refreshEditorByType;
    popupActionSelect.onchange = refreshEditorByType;
    conditionTrueModeSelect.onchange = refreshEditorByType;
    conditionOpSelect.onchange = refreshEditorByType;
    refreshEditorByType();

    const noteWrap = document.createElement("div");
    noteWrap.style.display = "flex";
    noteWrap.style.flexDirection = "column";
    noteWrap.style.gap = "6px";

    const noteLabel = makeSmallLabel("Note");
    noteWrap.appendChild(noteLabel);
    noteWrap.appendChild(noteInput);

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: "8px"
    });

    const leftActions = document.createElement("div");
    Object.assign(leftActions.style, {
      display: "flex",
      gap: "8px"
    });

    const pickSelectorBtn = makeBtn("Use current selector", "linear-gradient(90deg,#facc15,#eab308)", "#111827");
    const testBtn = makeBtn("Test step", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
    const pickPopupPosBtn = makeBtn("Pick Pos from popup", "linear-gradient(90deg,#f97373,#ef4444)", "#fff");
    const pickPopupSelBtn = makeBtn("Pick Sel from popup", "linear-gradient(90deg,#38bdf8,#2563eb)", "#020617");

    // Hiện/ẩn nút Pick theo popupAction
    function updatePickPopupBtn() {
      const t = String(typeSelect.value || "").toLowerCase();
      const pa = String(popupActionSelect.value || "").toLowerCase();
      const isPopupClickpoint = t === "popup" && pa === "clickpoint";
      const isPopupClickselector = t === "popup" && pa === "clickselector";
      pickPopupPosBtn.style.display = isPopupClickpoint ? "" : "none";
      pickPopupSelBtn.style.display = isPopupClickselector ? "" : "none";
    }
    typeSelect.addEventListener("change", updatePickPopupBtn);
    popupActionSelect.addEventListener("change", updatePickPopupBtn);
    updatePickPopupBtn();

    pickPopupPosBtn.onclick = async () => {
      try {
        if (!hasControlAPI() || typeof window.controlAPI.popupPickPoint !== "function") {
          setStatus("popupPickPoint API not available", "error"); return;
        }
        setStatus("Click on popup window to pick position...", "run");
        const res = await window.controlAPI.popupPickPoint({ slotId: activeSlotId });
        if (res && res.ok) {
          xInput.value = String(res.x);
          yInput.value = String(res.y);
          setStatus("Picked: " + res.x + ", " + res.y, "ok");
        } else {
          setStatus("Pick failed: " + (res && res.reason ? res.reason : "unknown"), "error");
        }
      } catch (err) { setStatus("Pick point error", "error"); }
    };

    pickPopupSelBtn.onclick = async () => {
      try {
        if (!hasControlAPI() || typeof window.controlAPI.popupPickPoint !== "function") {
          setStatus("popupPickPoint API not available", "error"); return;
        }
        setStatus("Click on popup window to pick selector...", "run");
        const res = await window.controlAPI.popupPickSelector({ slotId: activeSlotId });
        if (res && res.ok) {
          selectorInput.value = res.selector || "";
          if (res.elementText) elementTextInput.value = res.elementText;
          setStatus("Selector picked: " + (res.selector || ""), "ok");
        } else {
          setStatus("Pick failed: " + (res && res.reason ? res.reason : "unknown"), "error");
        }
      } catch (err) { setStatus("Pick selector error", "error"); }
    };

    leftActions.appendChild(pickSelectorBtn);
    leftActions.appendChild(pickPopupPosBtn);
    leftActions.appendChild(pickPopupSelBtn);
    leftActions.appendChild(testBtn);

    const rightActions = document.createElement("div");
    Object.assign(rightActions.style, {
      display: "flex",
      gap: "8px"
    });

    const cancelBtn = makeBtn("Cancel", "linear-gradient(90deg,#334155,#1f2937)", "#fff");
    const saveBtn = makeBtn("Save", "linear-gradient(90deg,#0ea5e9,#3b82f6)", "#082f49");

    rightActions.appendChild(cancelBtn);
    rightActions.appendChild(saveBtn);

    actions.appendChild(leftActions);
    actions.appendChild(rightActions);

    function close() {
      overlay.remove();
      activeEditorCtx = null;
      document.removeEventListener("keydown", editorKeydown, true);
    }

    // Picker THẬT giống nút Pos/Sel (hiện overlay chọn trên slot)
    function triggerPickSelector() {
      try {
        domExec({ type: "startPickSelector", stepId: steps[index] ? steps[index].id : step.id });
        setStatus("Click element trên slot để lấy selector", "run");
      } catch (e) { console.warn(e); }
    }
    function triggerPickPoint() {
      try {
        domExec({ type: "startPickPoint", stepId: steps[index] ? steps[index].id : step.id });
        setStatus("Click trên slot để lấy toạ độ", "run");
      } catch (e) { console.warn(e); }
    }

    // Phím tắt trong editor: S=selector, P=point (khi chưa focus ô); Ctrl+S=lưu; Esc=đóng
    function editorKeydown(e) {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === "s") {
        e.preventDefault(); e.stopPropagation(); saveBtn.click(); return;
      }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      const t = e.target;
      const tag = t && t.tagName ? t.tagName.toLowerCase() : "";
      const inField = tag === "input" || tag === "textarea" || tag === "select";
      if (!inField) {
        const k = String(e.key).toLowerCase();
        if (k === "s") { e.preventDefault(); triggerPickSelector(); }
        else if (k === "p") { e.preventDefault(); triggerPickPoint(); }
      }
    }

    // Đăng ký context để picker cập nhật live vào editor
    activeEditorCtx = {
      stepId: steps[index] ? steps[index].id : step.id,
      selectorInput, xInput, yInput, clickModeSelect
    };
    document.addEventListener("keydown", editorKeydown, true);

    closeBtn.onclick = close;
    cancelBtn.onclick = close;
    overlay.addEventListener("click", e => {
      if (e.target === overlay) close();
    });

    pickSelectorBtn.onclick = async () => {
      const val = await showPromptModal("Paste selector from control / picker:", selectorInput.value || "");
      if (val != null) selectorInput.value = val.trim();
    };

    testBtn.onclick = async () => {
      const nextType = String(typeSelect.value || "").trim().toLowerCase();
      const nextUrl = urlInput.value.trim();
      const nextValue =
        nextType === "open" || nextType === "opentab"
          ? (nextUrl || valueInput.value)
          : valueInput.value;

      const tempStep = normalizeStep(
        {
          ...step,
          fieldId: fieldIdInput.value.trim(),
          type: typeSelect.value,
          action: typeSelect.value,
          selector: selectorInput.value.trim(),
          labelText: labelTextInput.value.trim(),
          elementText: elementTextInput.value.trim(),
          elementTextColumn: elementTextColumnInput.value.trim().toUpperCase() || undefined,
          elementTextVar: elementTextVarInput.value.trim() || undefined,
          containerTag: containerTagInput.value.trim(),
          containerClassName: containerClassInput.value.trim(),
          column: columnInput.value.trim().toUpperCase(),
          fileNameColumn: fileNameColumnInput.value.trim().toUpperCase(),
          url: nextUrl,
          value: nextValue,
          conditionExpr: conditionExprInput.value.trim(),
          conditionOp: conditionOpSelect.value,
          conditionValueColumn: conditionValueColumnInput.value.trim().toUpperCase(),
          conditionValue: conditionValueInput.value,
          conditionTrueMode: conditionTrueModeSelect.value,
          conditionJumpTo: conditionJumpToInput.value.trim(),
          sessionName: sessionNameInput.value.trim(),
          sourceFieldId: sourceFieldIdInput.value.trim(),
          clickMode: clickModeSelect.value,
          clicknearDirection: clicknearDirectionSelect.value,
          clicknearIndex: parseInt(clicknearIndexInput.value||"0",10)||0,
          offsetX: parseFloat(offsetXInput.value)||0,
          offsetY: parseFloat(offsetYInput.value)||0,
          offsetEdge: offsetEdgeSelect.value||"center",
          arrowDirection: arrowDirectionSelect.value||"up",
          arrowCount: parseInt(arrowCountInput.value||"1",10)||1,
          arrowDelay: parseInt(arrowDelayInput.value||"50",10)||50,
          x: xInput.value === "" ? undefined : toNumber(xInput.value, undefined),
          y: yInput.value === "" ? undefined : toNumber(yInput.value, undefined),
          delayMs: toNumber(delayInput.value, 300),
          waitBeforeMs: toNumber(waitBeforeInput.value, 0),
          waitAfterMs: toNumber(waitAfterInput.value, 0),
          enabled: enabledCheck.checked,
          note: noteInput.value,
          matchText: matchTextInput.value.trim(),
          key: keyInput.value.trim(),
          readMode: readModeSelect.value,
          resultKey: resultKeyInput.value.trim(),
          popupAction: popupActionSelect.value,
          popupKey: popupKeyInput.value.trim() || undefined
        },
        index
      );

      try {
        setStatus("Testing step...", "run");
        const _testType = String(tempStep.type || "").toLowerCase();
        // Reset cờ stop để test luôn chạy (kể cả sau khi 1 condition trước đã stop)
        S().stopped = false;

        // ── Condition test = CHẠY THẬT từ step này (jump/stop hoạt động) ──
        if (_testType === "condition") {
          // Áp dụng config đang sửa vào step thật để runStepsFromIndex dùng đúng
          steps[index] = tempStep;
          if (typeof S().currentRowRunning !== "number" || S().currentRowRunning < 2) {
            const base = (typeof S().startRow === "number" && S().startRow >= 2)
              ? S().startRow : (getRowNumberFromUI() || 2);
            S().currentRowRunning = base;
          }
          S().stopped = false;
          S().endRow = false;
          flushProxies();
          try { renderSteps(); } catch (_) {}
          setStatus("Test: chạy đến khi condition TRUE...", "run");
          setLog("CONDITION test → chạy từ step '" + (tempStep.fieldId || index) + "' đến khi TRUE");
          // Chạy luồng thật từ step này; CHỈ test → dừng khi TRUE (stopOnCondTrue)
          await runStepsFromIndex(index, S(), { stopOnCondTrue: true });
          const passed = !!S().lastConditionPassed;
          const desc = S().lastConditionDesc || "";
          setStatus("Condition = " + (passed ? "TRUE ✓ → dừng" : "FALSE ✗"), passed ? "ok" : "warn");
          setLog("CONDITION test => " + (passed ? "TRUE (dừng tại đây)" : "FALSE") + " | " + desc);
          lastConditionByStep[readKey(activeSlotId, steps[index])] = passed;
          try { renderSteps(); } catch (_) {}
          return;
        }

        // Các step khác: chạy đơn lẻ
        await runSingleStep(tempStep, S(), { stepIndex: index });

        // Với step read: hiện thẳng giá trị đọc được cho người dùng thấy
        if (_testType === "read") {
          const val = S().lastReadResult;
          let msg;
          if (val === "__NO_RESPONSE__") {
            msg = "⚠ Trang web không phản hồi.\nSlot có đang mở đúng trang không? (mở slot + load trang trước khi test)";
            setStatus("Read: no response from page", "error");
          } else if (val === "" || val == null) {
            msg = "(empty)\nKhông đọc được giá trị — selector có thể không trúng element, hoặc element rỗng.\nSelector: " + (tempStep.selector || "(none)");
            setStatus("Read = (empty)", "warn");
          } else {
            msg = String(val);
            setStatus("Read = " + msg.slice(0, 80), "ok");
          }
          setLog("READ test => " + msg.replace(/\n/g, " | "));
          // Cập nhật pill value trên card của step này
          if (val !== "__NO_RESPONSE__") {
            lastReadByStep[readKey(activeSlotId, steps[index])] = val;
            try { renderSteps(); } catch (_) {}
          }
          try { alert("Read value:\n\n" + msg); } catch (_) {}
        } else {
          setStatus("Test OK", "ok");
        }
      } catch (err) {
        // Condition FALSE với chế độ jump → throw __conditionJump (không phải lỗi)
        if (err && err.__conditionJump === true) {
          const desc = S().lastConditionDesc || "";
          lastConditionByStep[readKey(activeSlotId, steps[index])] = false;
          try { renderSteps(); } catch (_) {}
          setStatus("Condition = FALSE ✗ → jump (đã xác định target)", "warn");
          setLog("CONDITION test => FALSE → jump index " + err.jumpIndex + " | " + desc);
          try { alert("Condition result:\n\n✗ FALSE → sẽ jump tới step (index " + err.jumpIndex + ")\n\n" + desc + "\n\n(Lưu ý: Test chỉ kiểm tra. Jump thực sự chỉ chạy khi Run cả pattern.)"); } catch (_) {}
          return;
        }
        console.warn("[DetectLab] test step error:", err);
        setStatus("Test failed", "error");
      }
    };

    saveBtn.onclick = () => {
      const nextType = String(typeSelect.value || "").trim().toLowerCase();
      const nextUrl = urlInput.value.trim();
      const nextValue =
        nextType === "open" || nextType === "opentab"
          ? (nextUrl || valueInput.value)
          : valueInput.value;

      steps[index] = normalizeStep(
        {
          ...step,
          fieldId: fieldIdInput.value.trim(),
          type: typeSelect.value,
          action: typeSelect.value,
          selector: selectorInput.value.trim(),
          labelText: labelTextInput.value.trim(),
          elementText: elementTextInput.value.trim(),
          elementTextColumn: elementTextColumnInput.value.trim().toUpperCase() || undefined,
          elementTextVar: elementTextVarInput.value.trim() || undefined,
          containerTag: containerTagInput.value.trim(),
          containerClassName: containerClassInput.value.trim(),
          column: columnInput.value.trim().toUpperCase(),
          fileNameColumn: fileNameColumnInput.value.trim().toUpperCase(),
          url: nextUrl,
          value: nextValue,
          conditionExpr: conditionExprInput.value.trim(),
          conditionOp: conditionOpSelect.value,
          conditionValueColumn: conditionValueColumnInput.value.trim().toUpperCase(),
          conditionValue: conditionValueInput.value,
          conditionTrueMode: conditionTrueModeSelect.value,
          conditionJumpTo: conditionJumpToInput.value.trim(),
          sessionName: sessionNameInput.value.trim(),
          sourceFieldId: sourceFieldIdInput.value.trim(),
          clickMode: clickModeSelect.value,
          clicknearDirection: clicknearDirectionSelect.value,
          clicknearIndex: parseInt(clicknearIndexInput.value||"0",10)||0,
          offsetX: parseFloat(offsetXInput.value)||0,
          offsetY: parseFloat(offsetYInput.value)||0,
          offsetEdge: offsetEdgeSelect.value||"center",
          arrowDirection: arrowDirectionSelect.value||"up",
          arrowCount: parseInt(arrowCountInput.value||"1",10)||1,
          arrowDelay: parseInt(arrowDelayInput.value||"50",10)||50,
          x: xInput.value === "" ? undefined : toNumber(xInput.value, undefined),
          y: yInput.value === "" ? undefined : toNumber(yInput.value, undefined),
          delayMs: toNumber(delayInput.value, 300),
          waitBeforeMs: toNumber(waitBeforeInput.value, 0),
          waitAfterMs: toNumber(waitAfterInput.value, 0),
          enabled: enabledCheck.checked,
          note: noteInput.value,
          matchText: matchTextInput.value.trim(),
          key: keyInput.value.trim(),
          readMode: readModeSelect.value,
          resultKey: resultKeyInput.value.trim(),
          popupAction: popupActionSelect.value,
          popupKey: popupKeyInput.value.trim() || undefined
        },
        index
      );

      renderSteps();
      close();
    };

    modal.appendChild(head);
    modal.appendChild(grid);
    modal.appendChild(enabledWrap);
    modal.appendChild(noteWrap);
    modal.appendChild(actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  // =========================================================
  // Run logic
  // =========================================================

  /**
   * Vòng lặp chính — xử lý toàn bộ flow từ row hiện tại đến endRow.
   *
   * Logic:
   *   - Bắt đầu từ currentRowRunning (user có thể chỉnh tay trước khi Start)
   *   - Mỗi vòng: chạy hết steps của row hiện tại
   *   - Nếu END step được gặp: flag DETECTLABENDROW = true, thoát step loop
   *   - Vòng này kiểm tra flag: +1 row, refreshValues từ rawRowArray, lặp lại
   *   - Không có END step: chạy đúng 1 row rồi dừng
   *   - endRow = 0 (không set): END step sẽ loop mãi cho đến khi hết data hoặc Stopped
   *
   * @param {boolean} resumeMode - true = resume từ currentStepIndexForResume
   */
  async function runLoop(resumeMode, forcedSlotId) {
    // Capture slot ID ngay lúc start — không thay đổi dù user switch tab sau này.
    // forcedSlotId: chạy 1 slot CỤ THỂ (kể cả không phải slot đang xem) →
    // phục vụ nút Start/Pause per-slot ở preview bar + Start all.
    const mySlotId = Number(forcedSlotId) || activeSlotId;
    const _st = slotStates[mySlotId];
    if (!_st) return;

    // Chỉ flush proxy khi slot này đang active (tránh ghi đè state slot khác)
    if (mySlotId === activeSlotId) flushProxies();

    // Helper: chỉ cập nhật UI sidebar khi đang xem đúng slot này
    const isActive = () => mySlotId === activeSlotId;
    const uiStatus = (msg, t) => { if (isActive()) setStatus(msg, t); };
    const uiLog = (msg) => { if (isActive()) setLog(msg); };

    // hardEnd: lấy từ slot state (parallel-safe), fallback UI nếu đang active
    let hardEnd = (typeof _st.endRowLimit === "number" && _st.endRowLimit >= 2)
      ? _st.endRowLimit
      : 0;
    if (!hardEnd && isActive()) {
      const endRaw = toNumber(sidebarEl && sidebarEl.endInput && sidebarEl.endInput.value, 0);
      hardEnd = endRaw >= 2 ? endRaw : 0;
    }

    // Reset cờ stop/pause/endRow theo slot
    _st.stopped = false;
    _st.paused = false;
    _st.endRow = false;
    _st.running = true; // đánh dấu slot đang chạy

    let firstIteration = true;

    try {
    // Vòng lặp row: chạy đến khi stopped hoặc không có END step
    while (true) {
      if (_st.stopped) break;

      const curRow = _st.currentRowRunning;

      // Giới hạn cứng
      if (hardEnd > 0 && curRow > hardEnd) {
        uiStatus("Finished at row " + (curRow - 1), "ok");
        uiLog("All rows done");
        break;
      }

      // Sync UI nếu đang xem slot này
      if (isActive()) setRowNumberToUI(curRow);
      uiStatus(
        hardEnd > 0
          ? "Running row " + curRow + " / " + hardEnd
          : "Running row " + curRow,
        "run"
      );

      // Reset endRow flag trước mỗi row
      _st.endRow = false;

      if (resumeMode && firstIteration) {
        await runStepsFromIndex(_st.currentStepIndexForResume || 0, _st);
      } else {
        _st.currentStepIndexForResume = 0;
        if (_st === S()) currentStepIndexForResume = 0;
        await runStepsFromIndex(0, _st);
      }
      firstIteration = false;

      if (_st.stopped && !_st.endRow) {
        // Pause hoặc Stop thật sự
        break;
      }

      if (_st.endRow) {
        // END step gặp — nhảy sang row tiếp
        if (hardEnd > 0 && curRow >= hardEnd) {
          uiStatus("Finished at row " + curRow, "ok");
          uiLog("All rows done");
          break;
        }
        const nextRow = curRow + 1;
        _st.currentRowRunning = nextRow;
        if (_st === S()) currentRowRunning = nextRow;
        // Cập nhật ô current row LIVE nếu đang xem slot này
        if (isActive()) setRowNumberToUI(nextRow);
        // Reset cờ để iteration mới chạy được
        _st.stopped = false;
        _st.endRow = false;
        // Refresh data cho đúng slot (không phụ thuộc activeSlotId)
        refreshValuesForRow(nextRow, false, _st);
        // Tiếp tục while
      } else {
        if (!_st.stopped) {
          uiStatus("Done row " + curRow, "ok");
          uiLog("Row " + curRow + " complete");
        }
        break;
      }
    }

    if (_st.stopped && !_st.endRow) {
      uiStatus("Stopped at row " + _st.currentRowRunning, "warn");
      uiLog("Stopped");
    }
    } finally {
      _st.running = false; // luôn clear cờ running khi thoát vòng lặp
    }
  }

  // Backward compat wrappers
  async function runPatternMultiRows()  { await runLoop(false); }
  async function resumePatternMultiRows() { await runLoop(true); }

  // ── Điều khiển per-slot cho preview bar ───────────────────────────
  // Pause 1 slot cụ thể (kể cả không phải slot đang xem)
  function pauseSlot(slotId) {
    const id = Number(slotId);
    const st = slotStates[id];
    if (!st) return;
    st.stopped = true;
    st.paused = true;
    if (id === activeSlotId) { setStatus("Paused", "warn"); setLog("Paused"); }
  }

  // Start/Resume 1 slot cụ thể.
  // - Nếu đang paused → resume từ vị trí dừng (row + step live).
  // - Nếu chưa chạy → start từ currentRowRunning (hoặc startRow).
  async function startSlot(slotId) {
    const id = Number(slotId);
    const st = slotStates[id];
    if (!st) return;
    if (st.running) return; // đã chạy rồi, bỏ qua
    if (!st.steps || !st.steps.length) {
      if (id === activeSlotId) { setStatus("No steps", "warn"); setLog("No steps for slot " + id); }
      return;
    }
    const wasPaused = !!st.paused;
    if (!wasPaused) {
      // start mới: đảm bảo có currentRowRunning hợp lệ
      if (typeof st.currentRowRunning !== "number" || st.currentRowRunning < 2) {
        st.currentRowRunning = (typeof st.startRow === "number" && st.startRow >= 2) ? st.startRow : 2;
      }
    }
    await runLoop(wasPaused, id); // resumeMode=wasPaused
  }

  function pauseAllSlots() {
    for (let i = 1; i <= MAX_SLOTS; i++) pauseSlot(i);
  }

  async function startAllSlots() {
    const tasks = [];
    for (let i = 1; i <= MAX_SLOTS; i++) {
      const st = slotStates[i];
      // chỉ start slot có steps và chưa chạy
      if (st && !st.running && st.steps && st.steps.length) {
        tasks.push(startSlot(i)); // chạy song song
      }
    }
    await Promise.all(tasks);
  }

  // Expose cho preview bar (index.html) gọi
  window.__detectlabPauseSlot = pauseSlot;
  window.__detectlabStartSlot = startSlot;
  window.__detectlabPauseAll  = pauseAllSlots;
  window.__detectlabStartAll  = startAllSlots;

  /**
   * Chạy steps từ index chỉ định.
   * slotSt: slot state cố định — không bị ảnh hưởng bởi switch tab.
   * Khi gặp END step: slotSt.endRow=true, slotSt.stopped=true (thoát for).
   */
  // Watchdog: chạy 1 step với giới hạn thời gian. Nếu quá hạn → reject __stepTimeout.
  // (promise runSingleStep gốc có thể resolve muộn sau đó — ta bỏ qua.)
  const STEP_TIMEOUT_MS = 30000; // 30s
  const MAX_ROW_RETRIES = 3;     // số lần restart tối đa cho 1 row khi bị treo
  function runStepWithTimeout(step, _st, ms, opts) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject({ __stepTimeout: true });
      }, ms);
      Promise.resolve()
        .then(() => runSingleStep(step, _st, opts))
        .then(v => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(v);
        })
        .catch(e => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  async function runStepsFromIndex(fromIndex, slotSt, runOpts) {
    const _st = slotSt || S();
    // stopOnCondTrue: CHỈ dùng khi TEST condition (dừng khi condition TRUE).
    // Run pattern thật KHÔNG truyền → condition TRUE sẽ chạy tiếp.
    const stopOnCondTrue = !!(runOpts && runOpts.stopOnCondTrue);
    const _steps = _st.steps;
    if (!_steps || !_steps.length) {
      setStatus("No steps", "warn");
      setLog("No steps");
      return;
    }

    let rowRetries = 0; // đếm số lần restart row này do treo
    let i = fromIndex;
    while (i < _steps.length) {
      _st.currentStepIndexForResume = i;
      // sync proxy nếu đang xem slot này
      if (_st === S()) currentStepIndexForResume = i;
      const step = _steps[i];

      if (_st.stopped) break;
      if (!step || step.enabled === false) { i++; continue; }

      _st.currentStepRunning = step;
      if (_st === S()) { currentStepRunning = step; renderSteps(); }

      try {
        // Condition có thể CHỜ (lặp đọc lại đến khi pass) → KHÔNG áp watchdog 30s,
        // để nó tự chờ. Các step khác vẫn có watchdog chống treo.
        if (step.type === "condition") {
          await runSingleStep(step, _st, { stepIndex: i, stopOnCondTrue });
        } else {
          await runStepWithTimeout(step, _st, STEP_TIMEOUT_MS, { stepIndex: i });
        }
      } catch (err) {
        // Step bị treo > 30s → restart row này TỪ ĐẦU (step 0)
        if (err && err.__stepTimeout === true) {
          const r = _st.currentRowRunning;
          _st.currentStepRunning = null;
          _st.currentStepName = null;
          if (_st === S()) { currentStepRunning = null; renderSteps(); }

          rowRetries++;
          if (rowRetries > MAX_ROW_RETRIES) {
            if (_st === S()) {
              setStatus("Row " + r + " stuck (>" + MAX_ROW_RETRIES + " retries) — stopped", "error");
              setLog("Row " + r + " bị treo quá " + MAX_ROW_RETRIES + " lần → dừng");
            }
            _st.stopped = true;
            break;
          }

          if (_st === S()) {
            setStatus("Step stuck >30s → restart row " + r + " (lần " + rowRetries + ")", "warn");
            setLog("Step treo >30s → chạy lại row " + r + " từ đầu (lần " + rowRetries + ")");
          }
          // Restart row từ step đầu tiên
          i = 0;
          continue;
        }
        // condition jump: không phải lỗi thật — nhảy đến index chỉ định
        if (err && err.__conditionJump === true && typeof err.jumpIndex === "number") {
          _st.currentStepRunning = null;
          if (_st === S()) { currentStepRunning = null; renderSteps(); }
          i = err.jumpIndex;
          continue; // tiếp tục while từ jumpIndex, không i++
        }
        // lỗi thật → re-throw
        throw err;
      }

      _st.currentStepRunning = null;
      _st.currentStepName = null;
      if (_st === S()) { currentStepRunning = null; renderSteps(); }

      // Nếu END step hoặc condition stop vừa xử lý xong — thoát while loop ngay
      if (_st.endRow) break;

      i++;
    }
  }

  // Wrappers giữ tương thích với code gọi cũ
  async function runStepsForCurrentRow()    { await runStepsFromIndex(0, S()); }
  async function resumeStepsForCurrentRow() { await runStepsFromIndex(currentStepIndexForResume, S()); }

  function colLetterToIndex(letter) {
    const s = String(letter || "").toUpperCase().replace(/[^A-Z]/g, "");
    if (!s) return 0;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      n = n * 26 + (s.charCodeAt(i) - 64);
    }
    return n;
  }

  async function runSingleStep(step, slotSt, opts) {
    if (!step) return;
    if (step.enabled === false) return;
    // slotSt: state của slot đang chạy (cố định, không đổi khi switch tab)
    // opts.stepIndex: vị trí step trong _st.steps (condition dùng để tìm step Read phía trước)
    const _st = slotSt || S();
    const _sid = _st.slotId;
    if (_st.stopped) return;

    const row = _st.currentRowRunning || getRowNumberFromUI() || 2;
    const rowObj = _st.rowData && _st.rowData[row] ? _st.rowData[row] : {};
    const type = String(step.type || "click").trim().toLowerCase();
    const waitBeforeMs = toNumber(step.waitBeforeMs, 0);
    const waitAfterMs = toNumber(step.waitAfterMs, 0);
    const delayMs = toNumber(step.delayMs, 300);

    const stepName = step.fieldId || type;
    setStatus("Row " + row + " • step " + stepName + " (" + type + ")", "run");
    setLog("Row " + row + " • " + stepName);
    // Lưu step hiện tại vào slot state để preview panel hiển thị
    _st.currentStepRunning = step;
    _st.currentStepName = stepName;

    // delay chính: luôn đợi trước rồi mới chạy step
    if (delayMs > 0 && type !== "wait") {
      await wait(delayMs);
    }

    if (waitBeforeMs > 0) {
      await wait(waitBeforeMs);
    }

    if (_st.stopped) return;

    const _dvars = _st.detectLabVars || {};

    if (type === "click") {
      if (step.clickMode === "point") {
        const x = toNumber(step.x, null);
        const y = toNumber(step.y, null);
        if (typeof x === "number" && typeof y === "number") {
          domClickPoint(x, y, _sid);
        } else {
          throw new Error("Point click requires x and y");
        }
      } else {
        if (!step.selector && !step.elementText && !step.labelText) {
          throw new Error("Click selector is empty");
        }
        await domClickSelectorForStep(step, _sid, rowObj, _dvars);
      }
    } else if (type === "cdpclick") {
      if (!hasControlAPI()) throw new Error("cdpclick requires Electron controlAPI");
      const cdpPayload = {
        slotId: _sid,
        selector: step.selector || "",
        elementText: step.elementText || "",
        x: typeof step.x === "number" ? step.x : undefined,
        y: typeof step.y === "number" ? step.y : undefined,
        offsetX: typeof step.offsetX === "number" ? step.offsetX : 0,
        offsetY: typeof step.offsetY === "number" ? step.offsetY : 0,
        offsetEdge: step.offsetEdge || "center"
      };
      const res = await window.controlAPI.cdpClick(cdpPayload);
      if (!res || !res.ok) {
        throw new Error("cdpClick failed: " + (res && res.reason ? res.reason : "unknown"));
      }
      setLog("CDP click ok: " + (step.selector || step.elementText || "point") + " offset:" + (step.offsetX||0) + "," + (step.offsetY||0));
    } else if (type === "gsiclick") {
      // Trigger Google Sign-in — iframe cross-origin nên dùng GSI JS API
      domExec({ type: "gsiclick" }, _sid);
      setLog("GSI: triggered Google Sign-in");
    } else if (type === "open" || type === "opentab") {
      let url = "";
      if (step.column) {
        url = getCellValueByColumn(rowObj, step.column) || "";
        if (!url) {
          setLog("Row " + row + " • URL column " + step.column + " is empty");
        }
      }
      if (!url) {
        url = step.url || "";
      }
      if (!url) {
        url = step.value || "";
      }
      url = String(url || "").trim();

      if (!url) throw new Error("Open step requires URL");
      if (!/^https?:\/\//i.test(url)) {
        url = "https://" + url;
      }
      if (hasControlAPI() && window.controlAPI.loadUrl) {
        // Dùng _sid (slot cố định khi start) để mở URL đúng web window
        await window.controlAPI.loadUrl({ url, slotId: _sid });
      } else {
        domExec({ type: "openUrl", value: url }, _sid);
      }
      setLog("Open URL: " + url);
    } else if (type === "pressarrow") {
      if (!step.selector && !step.elementText && !step.labelText) {
        throw new Error("pressarrow: cần selector/elementText");
      }
      domExec({
        type: "pressArrow",
        selector: step.selector || "",
        labelText: step.labelText || "",
        elementText: step.elementText || "",
        containerTag: step.containerTag || "",
        containerClass: step.containerClass || "",
        arrowDirection: step.arrowDirection || "up",
        arrowCount: step.arrowCount || 1,
        arrowDelay: step.arrowDelay || 50,
        slotId: _sid
      }, _sid);
      setLog("pressarrow: " + (step.arrowDirection||"up") + " x" + (step.arrowCount||1));

    } else if (type === "clicknear") {
      if (!step.selector && !step.elementText && !step.labelText) {
        throw new Error("clicknear: cần selector/elementText làm ref element");
      }
      domExec({
        type: "clicknear",
        selector: step.selector || "",
        labelText: step.labelText || "",
        elementText: step.elementText || "",
        containerTag: step.containerTag || "",
        containerClass: step.containerClass || "",
        direction: step.clicknearDirection || "right",
        index: step.clicknearIndex || 0,
        maxDist: 200,
        slotId: _sid
      }, _sid);
      setLog("clicknear: btn[" + (step.clicknearIndex||0) + "] " + (step.clicknearDirection||"right") + " of " + (step.selector || step.labelText || "?"));

    } else if (type === "hover") {
      if (!step.selector && !step.elementText && !step.labelText) {
        throw new Error("Hover selector is empty");
      }
      await domHoverSelectorForStep(step, _sid, rowObj, _dvars);
    } else if (type === "scroll") {
      if (!step.selector && !step.elementText && !step.labelText) {
        throw new Error("Scroll selector is empty");
      }
      await domScrollIntoViewForStep(step, _sid, rowObj, _dvars);
    } else if (type === "keypress") {
      if (!step.key) throw new Error("Key is empty");
      domPressKey(step.key, _sid);
    } else if (type === "input") {
      if (!step.selector && !step.elementText && !step.labelText) {
        throw new Error("Input selector is empty");
      }
      let value = "";
      if (step.column) {
        value = getCellValueByColumn(rowObj, step.column);
        if (!value) {
          setLog("Row " + row + " • column " + step.column + " is empty");
        }
      } else if (step.resultKey) {
        const keyName = String(step.resultKey).trim();
        value = _dvars[keyName] != null ? String(_dvars[keyName]) : "";
        if (!value) {
          setLog("Row " + row + " • var " + keyName + " is empty");
        }
      } else {
        value = step.value || "";
      }

      const processed = String(value).replace(/\{\{([^}]+)\}\}/g, (m, k) => {
        const key = String(k || "").trim();
        return _dvars[key] != null ? String(_dvars[key]) : "";
      });

      await domSetValueForStep(step, processed, _sid, rowObj, _dvars);
        } else if (type === "upload") {
          // Không bắt buộc selector — CDP tự tìm input[type=file] trên trang
          const uploadFiles = await buildUploadFilesForStep(step, rowObj, _sid);
          if (!uploadFiles.length) {
            throw new Error("No files available for upload step");
          }

          const uploadRes = await domUploadFilesForStep(step, uploadFiles, _sid, rowObj, _dvars);
          if (!uploadRes || uploadRes.ok !== true) {
            throw new Error(
              "Upload failed" +
              (uploadRes && uploadRes.reason ? ": " + String(uploadRes.reason) : "")
            );
          }

          setLog("Uploaded " + uploadFiles.length + " files");
} else if (type === "read") {
      if (!step.selector && !step.elementText && !step.labelText) {
        throw new Error("Read selector is empty");
      }
      // KHÔNG bắt buộc column / var nữa — chỉ cần đọc value trong vùng đó.
      // Kết quả luôn được lưu vào _st.lastReadResult để condition kế tiếp dùng.

      let result = "";
      // Use the rich step payload (selector + labelText + elementText + x/y)
      // so findElementForStep on the web side narrows a wide recorded selector
      // to the specific picked field, instead of reading the whole page.
      if ((step.readMode || "text") === "html") {
        result = await domReadHtmlForStep(step, _sid, rowObj, _dvars);
      } else {
        result = await domGetTextForStep(step, _sid, rowObj, _dvars);
      }

      if (step.matchText) {
        const ok = String(result || "").toLowerCase().includes(String(step.matchText).toLowerCase());
        setLog(ok ? "Matched text" : "Text not matched");
      }

      // Checkbox / radio reads return literal "true" / "false" — coerce to real boolean
      let storedValue = result;
      if (result === "true") storedValue = true;
      else if (result === "false") storedValue = false;

      // Var GẮN VÀO read = CHỈ Result key (không dùng Step name/Field ID làm var nữa)
      const keyName = (step.resultKey || "").trim();
      if (keyName) {
        _dvars[keyName] = storedValue;
        _st.detectLabVars = _dvars;
        console.log("[DetectLab] s" + _sid + " READ stored var", keyName, "=", storedValue);
      }

      // KHÔNG ghi vào column nữa — read chỉ lấy value, không đụng tới sheet data.
      // (Tránh ảnh hưởng các step khác dùng cùng cột.)

      // Track the most recent read so the next condition step can compare
      // against it without the user having to specify a source by name.
      _st.lastReadResult = storedValue;
      _st.lastReadKey = keyName || "";

      // Lưu để hiển thị value đọc được ngay trên card step (control)
      lastReadByStep[readKey(_sid, step)] = storedValue;
      if (_st === S()) { try { renderSteps(); } catch (_) {} }

      const shortRead = String(result || "").trim().slice(0, 120);
      const dest = keyName ? ("var " + keyName) : "(value only)";
      setLog("Row " + row + " • READ => " + dest + " = " + shortRead);
      console.log("[DetectLab] s" + _sid + " row", row, "READ value =", result);
    } else if (type === "wait") {
      await wait(delayMs);
    } else if (type === "end") {
      // Báo hiệu cho runLoop biết row này đã xong — dùng slot-local flag
      _st.endRow = true;
      _st.stopped = true; // thoát for loop trong runStepsFromIndex
      setLog("End step — row " + (_st.currentRowRunning || row) + " done");
    } else if (type === "condition") {
      const evalConditionOp = (op, left, right) => {
        const leftEmpty  = left  == null || left  === "";
        const rightEmpty = right == null || right === "";
        const ls = leftEmpty  ? "" : String(left).trim();
        const rs = rightEmpty ? "" : String(right).trim();

        // Guards against the "empty=empty silently TRUE" loop bug.
        // - equal/exact: only block when BOTH sides are empty (so a real
        //   value vs explicit empty still compares naturally).
        // - contain: block when the search term is empty
        //   (str.indexOf("") returns 0, which would always match).
        // - numeric: require both sides parse as numbers.
        if (op === "equal" || op === "exact") {
          if (leftEmpty && rightEmpty) {
            console.warn("[DetectLab] condition: both operands empty — returning false to avoid loop");
            return false;
          }
        }
        if (op === "contain") {
          if (rightEmpty) {
            console.warn("[DetectLab] condition: contain right-operand empty — returning false");
            return false;
          }
        }
        if (op === ">" || op === "<" || op === ">=" || op === "<=") {
          const ln = parseFloat(ls), rn = parseFloat(rs);
          if (isNaN(ln) || isNaN(rn)) {
            console.warn("[DetectLab] condition: numeric op with non-number operand — returning false", { left, right });
            return false;
          }
          if (op === ">")  return ln >  rn;
          if (op === "<")  return ln <  rn;
          if (op === ">=") return ln >= rn;
          if (op === "<=") return ln <= rn;
        }

        switch (op) {
          case "equal":     return ls.toLowerCase() === rs.toLowerCase();
          case "exact":     return ls === rs;
          case "different": return ls !== rs;
          case "contain":   return ls.toLowerCase().indexOf(rs.toLowerCase()) !== -1;
          default:          return false;
        }
      };

      // Fixed literal value typed by the user. Supports {{varName}} substitution
      // and "true"/"false" boolean coercion so checkbox/switch reads compare cleanly.
      const resolveFixedValue = (raw) => {
        if (raw == null) return "";
        const s = String(raw).trim();
        if (s === "") return "";
        const substituted = s.replace(/\{\{([^}]+)\}\}/g, (m, k) => {
          const v = _dvars[String(k).trim()];
          return v == null ? "" : String(v);
        });
        if (substituted === "true")  return true;
        if (substituted === "false") return false;
        return substituted;
      };

      const op = String(step.conditionOp || "").trim();
      const valueColumn = String(step.conditionValueColumn || "").trim().toUpperCase();
      const expr = (step.conditionExpr || "").trim();

      // Tìm step READ ngay trước condition này (để ĐỌC LẠI khi retry).
      const myIdx = (opts && typeof opts.stepIndex === "number")
        ? opts.stepIndex
        : (Array.isArray(_st.steps) ? _st.steps.findIndex(s => s && s.id === step.id) : -1);
      let precedingRead = null;
      if (Array.isArray(_st.steps) && myIdx > 0) {
        for (let k = myIdx - 1; k >= 0; k--) {
          const s = _st.steps[k];
          if (s && s.type === "read" && s.enabled !== false) { precedingRead = s; break; }
        }
      }

      // Vế trái: ưu tiên biến theo Check Var (result key) của condition,
      // nếu trống thì dùng kết quả read gần nhất.
      const checkVar = String(step.resultKey || "").trim();
      const getLeftValue = () => {
        if (checkVar) {
          return (_dvars && Object.prototype.hasOwnProperty.call(_dvars, checkVar))
            ? _dvars[checkVar]
            : undefined;
        }
        return _st.lastReadResult;
      };
      const leftLabel = checkVar ? ("var[" + checkVar + "]") : ("read(" + (_st.lastReadKey || "?") + ")");

      // Tính 1 lần điều kiện
      const evaluateOnce = () => {
        let passed = false;
        let evalDescription = "";
        if (op) {
          const readVal = getLeftValue();
          const hasFixed = step.conditionValue != null && String(step.conditionValue).trim() !== "";
          const hasColumn = !!valueColumn;
          let rightVal, rightSource;
          if (hasColumn) {
            rightVal = getCellValueByColumn(rowObj, valueColumn);
            rightSource = "cell[" + valueColumn + "]";
          } else if (hasFixed) {
            rightVal = resolveFixedValue(step.conditionValue);
            rightSource = "fixed";
          } else {
            rightVal = ""; rightSource = "(none)";
          }
          passed = evalConditionOp(op, readVal, rightVal);
          evalDescription =
            leftLabel + "=" + JSON.stringify(readVal) +
            " " + op + " " + rightSource + "=" + JSON.stringify(rightVal);
        } else if (expr) {
          const ctx = { row, rowData: rowObj, vars: _dvars };
          try {
            const fn = new Function("ctx", "with(ctx){ return (" + expr + "); }");
            passed = !!fn(ctx);
          } catch (err) {
            passed = false;
            console.warn("[DetectLab] condition eval error:", err, expr);
          }
          evalDescription = expr;
        } else {
          evalDescription = "(empty)";
        }
        return { passed, evalDescription };
      };

      // Đánh giá 1 lần. Hành động kích hoạt khi điều kiện FALSE:
      //   - jump: nhảy tới step chỉ định (tạo vòng lặp do user điều khiển)
      //   - stop: dừng pattern ở row này
      // Khi TRUE → chạy tiếp bình thường (sang step kế).
      const { passed, evalDescription } = evaluateOnce();
      _st.lastConditionPassed = passed;
      _st.lastConditionDesc = evalDescription;
      lastConditionByStep[readKey(_sid, step)] = passed;
      if (_st === S()) { try { renderSteps(); } catch (_) {} }
      setLog("Condition " + (passed ? "✓ TRUE" : "✗ FALSE") + ": " + evalDescription);

      // CHỈ chế độ TEST (opts.stopOnCondTrue): TRUE thì DỪNG, không chạy step sau.
      // Run pattern thật KHÔNG có cờ này → TRUE sẽ CHẠY TIẾP step kế.
      if (passed && opts && opts.stopOnCondTrue) {
        setLog("Test: Condition TRUE → dừng (không chạy các step sau)");
        _st.stopped = true;
        _st.endRow = false;
        return;
      }

      if (!passed) {
        const mode = (step.conditionTrueMode || "stop").toLowerCase();
        const jumpTo = String(step.conditionJumpTo || "").trim();
        if (mode === "jump") {
          if (!jumpTo) {
            setLog("⚠ Condition FALSE nhưng chưa chọn step để jump (ô 'Jump to' trống) → bỏ qua");
            return;
          }
          const _steps = _st.steps;
          let jumpIndex = -1;
          // Ưu tiên: khớp theo ID step (ổn định, không lệ thuộc số thứ tự).
          jumpIndex = _steps.findIndex(s => s && String(s.id || "").trim() === jumpTo);
          if (jumpIndex < 0) {
            // Khớp theo Step name (không phân biệt hoa thường)
            const jt = jumpTo.toLowerCase();
            jumpIndex = _steps.findIndex(s => s && String(s.fieldId || "").trim().toLowerCase() === jt);
          }
          if (jumpIndex < 0) {
            // Tương thích ngược: pattern cũ lưu SỐ THỨ TỰ (vd "#2" hoặc "2")
            const numStr = jumpTo.replace(/^#/, "").trim();
            if (/^\d+$/.test(numStr)) jumpIndex = parseInt(numStr, 10) - 1; // 1-based → 0-based
          }
          if (jumpIndex < 0 || jumpIndex >= _steps.length) {
            throw new Error("Condition jump: step '" + jumpTo + "' không hợp lệ (chỉ có " + _steps.length + " step)");
          }
          setLog("Condition FALSE → jump to step '" + jumpTo + "' (index " + jumpIndex + ")");
          throw { __conditionJump: true, jumpIndex };
        } else {
          setLog("Condition FALSE → stop pattern (row " + row + ")");
          _st.endRow = true;
          _st.stopped = true;
        }
      }
    } else if (type === "delete") {
      if (!step.selector && !step.elementText && !step.labelText) {
        throw new Error("Delete selector is empty");
      }
      await domSetValueForStep(step, "", _sid, rowObj, _dvars);
      setLog("Delete / clear via " + (step.selector || step.labelText || step.elementText || "(no selector)"));
} else if (type === "download") {
  const targetRowNumber =
    (typeof row === "number" && row >= 2)
      ? row
      : (
          (typeof _st.currentRowRunning === "number" && _st.currentRowRunning >= 2)
            ? _st.currentRowRunning
            : (getRowNumberFromUI() || 2)
        );

  const mediaRes = await downloadMediaForStepAndRow(step, targetRowNumber, _sid, _st);
  if (mediaRes && mediaRes.ok) {
    setLog("Downloaded media row " + targetRowNumber + " to Image tab");
  }

  if (step.clickMode === "point") {
    const px = toNumber(step.x, null);
    const py = toNumber(step.y, null);
    if (typeof px === "number" && typeof py === "number") {
      domClickPoint(px, py, _sid);
      setLog("Trigger download via point " + px + ", " + py);
    } else {
      setLog("Download step clickMode=point but x/y missing");
    }
  } else if (step.selector || step.elementText || step.labelText) {
    await domClickSelectorForStep(step, _sid, rowObj, _dvars);
    setLog(
      "Trigger download via " +
        (step.selector || step.labelText || step.elementText || "no selector")
    );
  } else {
    setLog("Download step missing selector/point");
  }
} else if (type === "return") {
      if (!step.column && !step.resultKey && !step.value) {
        setLog("Return step requires column / var / value");
      } else {
        const cfg = window.DetectLabGetSheetConfig ? window.DetectLabGetSheetConfig() : null;
        const colLetter = String(step.column || "").trim().toUpperCase();

        let val;
        const varName = (step.resultKey || step.fieldId || "").trim();
        if (varName && Object.prototype.hasOwnProperty.call(_dvars, varName)) {
          val = _dvars[varName];
          console.log("[DetectLab] RETURN using var", varName, "=", val);
        } else if (colLetter) {
          val = getCellValueByColumn(rowObj, colLetter);
          console.log("[DetectLab] RETURN fallback sheet col", colLetter, "=", val);
        } else {
          val = step.value || "";
          console.log("[DetectLab] RETURN fallback fixed value =", val);
        }

        if (!cfg || !cfg.returnUrl || !cfg.sheetId || !cfg.sheetName) {
          console.warn("[DetectLab] RETURN missing config", cfg);
          throw new Error("Return step missing return URL / sheet config");
        }

        const colIndex = colLetter ? colLetterToIndex(colLetter) : 0;
        if (colLetter && (!colIndex || colIndex < 1)) {
          console.warn("[DetectLab] RETURN invalid column letter", colLetter);
          throw new Error("Return step invalid column: " + colLetter);
        }

        const safeValue = val == null ? "" : String(val);

        const params = {
          sheetId: cfg.sheetId,
          tab: cfg.sheetName,
          row,
          col: colIndex,
          value: safeValue
        };

        const qs = new URLSearchParams({
          sheetId: params.sheetId,
          tab: params.tab,
          row: String(params.row),
          col: String(params.col || 0),
          value: safeValue
        }).toString();

        const debugUrl = cfg.returnUrl + (cfg.returnUrl.includes("?") ? "&" : "?") + qs;
        console.log("[DetectLab] RETURN debug URL", debugUrl, "| raw value =", safeValue);

        try {
          if (hasControlAPI() && window.controlAPI.execOnWeb) {
            const maybePromise = domExec({
              type: "returnToSheet",
              url: debugUrl,
              payload: params
            }, _sid);

            const respData = await Promise.resolve(maybePromise);
            console.log("[DetectLab] RETURN bridge response", respData);

            if (respData && respData.ok === false) {
              throw new Error(respData.error || "Apps Script error from bridge");
            }
          } else {
            console.warn("[DetectLab] controlAPI.execOnWeb missing, RETURN cannot call Apps Script directly due to CSP. Main process must call:", debugUrl);
            throw new Error("RETURN blocked by CSP (no bridge)");
          }

          if (colLetter) {
            setLog("Returned column " + colLetter + " (col " + colIndex + ") for row " + row);
          } else if (varName) {
            setLog("Returned var " + varName + " for row " + row);
          } else {
            setLog("Returned fixed value for row " + row);
          }
        } catch (err) {
          console.warn("[DetectLab] RETURN failed", err);
          setStatus("Return failed", "error");
          setLog("Return error: " + String(err));
          throw err;
        }
      }
    } else if (type === "read-input") {
      if (!step.selector && !step.elementText && !step.labelText) {
        throw new Error("read-input: cần selector/elementText");
      }

      const srcKey = (step.sourceFieldId || step.resultKey || "").trim();
      let readValue = srcKey ? _dvars[srcKey] : null;

      // Fallback: column
      if ((readValue == null || readValue === "") && step.column) {
        readValue = getCellValueByColumn(rowObj, step.column);
      }

      console.log("[read-input] srcKey='" + srcKey + "'",
        "dvars keys:", Object.keys(_dvars),
        "value:", readValue);

      if (readValue == null || readValue === "") {
        throw new Error("read-input: var '" + srcKey + "' rỗng. Vars: " + Object.keys(_dvars).join(", "));
      }

      const processed = String(readValue).trim();
      console.log("[read-input] typing:", processed.slice(0, 60));

      domExec({
        type: "typeCharByChar",
        selector: step.selector || "",
        labelText: step.labelText || "",
        elementText: step.elementText || "",
        containerTag: step.containerTag || "",
        containerClass: step.containerClass || "",
        value: processed,
        slotId: _sid
      }, _sid);

      setLog("read-input: '" + processed.slice(0, 40) + "' → " + (step.selector || step.labelText || "?"));

    } else if (type === "save-session") {
      if (!hasControlAPI()) throw new Error("save-session requires Electron controlAPI");
      const sName = (step.sessionName || step.fieldId || "session").trim()
        .replace(/[^\w\-_.]/g, "_");
      if (!sName) throw new Error("save-session: session name is empty");
      const res = await window.controlAPI.saveSession({ slotId: _sid, name: sName });
      if (!res || !res.ok) throw new Error("save-session failed: " + (res && res.reason ? res.reason : "unknown"));
      setLog("Session saved: " + sName + " (" + (res.cookieCount || 0) + " cookies)");

    } else if (type === "load-session") {
      if (!hasControlAPI()) throw new Error("load-session requires Electron controlAPI");
      const sName = (step.sessionName || step.fieldId || "session").trim()
        .replace(/[^\w\-_.]/g, "_");
      if (!sName) throw new Error("load-session: session name is empty");
      // navigateTo: dùng step.url hoặc step.value nếu có
      const navigateTo = String(step.url || step.value || "").trim() || null;
      const res = await window.controlAPI.loadSession({ slotId: _sid, name: sName, navigateTo });
      if (!res || !res.ok) throw new Error("load-session failed: " + (res && res.reason ? res.reason : "unknown"));
      setLog("Session loaded: " + sName + " (" + (res.cookieCount || 0) + " cookies)" + (navigateTo ? " → " + navigateTo : ""));

    } else if (type === "popup") {
      // Thao tác trên popup window (Google OAuth, etc.)
      // action: click | input | read | wait | close | get-url
      const popupAction = (step.popupAction || "click").toLowerCase();
      if (!hasControlAPI()) throw new Error("popup step requires Electron controlAPI");

      const payload = {
        slotId: _sid,
        action: popupAction,
        selector: step.selector || "",
        elementText: step.elementText || "",
        value: step.column ? getCellValueByColumn(rowObj, step.column) : (step.value || ""),
        key: step.popupKey || "Enter",
        x: typeof step.x === "number" ? step.x : undefined,
        y: typeof step.y === "number" ? step.y : undefined,
        timeoutMs: toNumber(step.waitBeforeMs, 8000) || 8000
      };

      // Nếu action = wait: chờ popup xuất hiện trước
      if (popupAction === "wait") {
        // Polling chờ popup mở (did-create-window báo qua slot:popup-opened)
        setLog("Waiting for popup...");
        const appeared = await new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(false), payload.timeoutMs);
          const unsub = (typeof window.controlAPI.on === "function")
            ? window.controlAPI.on("slot:popup-opened", (data) => {
                if (Number(data && data.slotId) === _sid) {
                  clearTimeout(timeout); unsub && unsub(); resolve(true);
                }
              })
            : null;
          // Fallback: check ngay lúc này
          window.controlAPI.invoke("popup:status", { slotId: _sid }).then(res => {
            if (res && res.exists) { clearTimeout(timeout); unsub && unsub(); resolve(true); }
          }).catch(() => {});
        });
        if (!appeared) throw new Error("Popup did not appear within timeout");
        setLog("Popup appeared");

      } else {
        const res = await window.controlAPI.invoke("popup:exec", payload);
        if (!res || !res.ok) {
          throw new Error("popup:exec failed: " + (res && res.reason ? res.reason : "unknown"));
        }
        const inner = res.result;
        // Lưu result vào var nếu có resultKey
        if (popupAction === "read" && inner != null) {
          const keyName = (step.resultKey || step.fieldId || "").trim();
          if (keyName) { _dvars[keyName] = inner; _st.detectLabVars = _dvars; }
          setLog("Popup read: " + String(inner).slice(0, 80));
        } else if (popupAction === "get-url" && inner && inner.url) {
          const keyName = (step.resultKey || step.fieldId || "").trim();
          if (keyName) { _dvars[keyName] = inner.url; _st.detectLabVars = _dvars; }
          setLog("Popup url: " + String(inner.url).slice(0, 80));
        } else if (popupAction === "wait-load") {
          const url = inner && inner.url ? inner.url : "";
          setLog("Popup loaded" + (url ? ": " + url.slice(0, 60) : ""));
        } else {
          setLog("Popup " + popupAction + " ok");
        }
      }

    } else {
      console.warn("[DetectLab] unsupported step type:", type, step);
    }

    if (waitAfterMs > 0) {
      await wait(waitAfterMs);
    }
  }

  // =========================================================
  // Patterns panel
  // =========================================================

  function buildPatternsPanel(panelPatterns) {
    panelPatterns.innerHTML = "";

    const header = makeSectionCard();
    header.textContent = "Saved patterns";
    header.style.fontWeight = "700";

    const actions = makeSectionCard();
    Object.assign(actions.style, {
      display: "flex",
      gap: "6px",
      alignItems: "center"
    });

    const downloadBtn = makeBtn("Download", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
    const uploadBtn = makeBtn("Upload", "linear-gradient(90deg,#0ea5e9,#3b82f6)", "#082f49");

    const list = makeSectionCard();
    list.id = "dlpatternslist";
    Object.assign(list.style, {
      flex: "1",
      overflowY: "auto",
      minHeight: "120px"
    });

    actions.appendChild(downloadBtn);
    actions.appendChild(uploadBtn);

    panelPatterns.appendChild(header);
    panelPatterns.appendChild(actions);
    panelPatterns.appendChild(list);

    sidebarEl.patternsList = list;

    downloadBtn.onclick = () => downloadAllPatterns();
    uploadBtn.onclick = () => uploadPatternsFromFile();
  }

  function renderPatternsPanel() {
    if (!sidebarEl || !sidebarEl.patternsList) return;
    const list = sidebarEl.patternsList;
    list.innerHTML = "";

    const names = Object.keys(patterns || {});
    if (!names.length) {
      const empty = document.createElement("div");
      empty.textContent = "No patterns saved.";
      empty.style.fontSize = "12px";
      empty.style.color = "#9ca3af";
      list.appendChild(empty);
      return;
    }

    names.sort((a, b) => a.localeCompare(b));

    names.forEach(name => {
      const rawPattern = patterns[name];
      const stepsArr = Array.isArray(rawPattern)
        ? rawPattern
        : Array.isArray(rawPattern && rawPattern.steps)
        ? rawPattern.steps
        : [];

      const savedAtRaw = rawPattern && !Array.isArray(rawPattern) ? rawPattern.savedAt : null;
      const savedAt = savedAtRaw ? new Date(savedAtRaw) : null;

      const box = document.createElement("div");
      Object.assign(box.style, {
        padding: "8px",
        marginBottom: "6px",
        borderRadius: "8px",
        background: "rgba(2,6,23,0.55)",
        border: "1px solid rgba(37,99,235,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px"
      });

      const left = document.createElement("div");
      Object.assign(left.style, {
        display: "flex",
        flexDirection: "column",
        gap: "3px",
        minWidth: "0",
        flex: "1"
      });

      const nameLine = document.createElement("div");
      nameLine.textContent = name + " — " + stepsArr.length + " steps";
      nameLine.style.fontSize = "13px";
      nameLine.style.fontWeight = "700";

      const timeLine = document.createElement("div");
      timeLine.textContent = savedAt ? "Saved: " + savedAt.toLocaleString() : "Saved: unknown";
      timeLine.style.fontSize = "11px";
      timeLine.style.color = "#9ca3af";

      // Hiện thông số window config của pattern
      const winCfgRaw = rawPattern && !Array.isArray(rawPattern) ? rawPattern : {};
      const hasWinCfg = winCfgRaw.windowWidth || winCfgRaw.windowHeight || winCfgRaw.zoom;
      const winLine = document.createElement("div");
      winLine.style.fontSize = "10px";
      winLine.style.color = "#38bdf8";
      winLine.textContent = hasWinCfg
        ? "W:" + (winCfgRaw.windowWidth || "-") + " H:" + (winCfgRaw.windowHeight || "-") + " Zoom:" + (winCfgRaw.zoom || "-") + "%"
        : "No window config";

      left.appendChild(nameLine);
      left.appendChild(timeLine);
      left.appendChild(winLine);

      const btns = document.createElement("div");
      Object.assign(btns.style, {
        display: "flex",
        gap: "4px",
        flexWrap: "wrap"
      });

      const loadBtn = makeBtn("Load", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
      const renameBtn = makeBtn("Rename", "linear-gradient(90deg,#e5e7eb,#94a3b8)", "#020617");
      const delBtn = makeBtn("Del", "linear-gradient(90deg,#f97373,#ef4444)", "#fff");

      loadBtn.onclick = () => {
        const def = patterns[name];
        let winCfg = { windowWidth: null, windowHeight: null, zoom: null };

        if (Array.isArray(def)) {
          steps = deepClone(def);
        } else {
          steps = deepClone(def.steps || []);
          winCfg = {
            windowWidth: typeof def.windowWidth === "number" ? def.windowWidth : null,
            windowHeight: typeof def.windowHeight === "number" ? def.windowHeight : null,
            zoom: def.zoom || null
          };
        }

        normalizeAllSteps();
        renderSteps();
        setCurrentPatternName(name);

        // Restore UI inputs
        if (sidebarEl) {
          if (sidebarEl.winWInput && winCfg.windowWidth) sidebarEl.winWInput.value = String(winCfg.windowWidth);
          if (sidebarEl.winHInput && winCfg.windowHeight) sidebarEl.winHInput.value = String(winCfg.windowHeight);
          if (sidebarEl.zoomSelect && winCfg.zoom) sidebarEl.zoomSelect.value = String(winCfg.zoom);
        }

        // Áp dụng window config ngay lập tức vào web window
        if (winCfg.windowWidth || winCfg.windowHeight || winCfg.zoom) {
          applyWindowConfig(winCfg);
          setLog("Loaded pattern " + name + " — applied W:" + (winCfg.windowWidth || "-") + " H:" + (winCfg.windowHeight || "-") + " Zoom:" + (winCfg.zoom || "-"));
        } else {
          setLog("Loaded pattern " + name);
        }

        saveRowState();
      };

      renameBtn.onclick = async () => {
        const next = await showPromptModal("Rename pattern:", name);
        if (!next || next === name) return;
        if (patterns[next]) {
          alert("Pattern already exists.");
          return;
        }
        patterns[next] = patterns[name];
        delete patterns[name];
        saveJsonToStorage(STORAGE_KEYS().PATTERNS, patterns);
        if (getCurrentPatternName() === name) {
          setCurrentPatternName(next);
        }
        renderPatternsPanel();
      };

      delBtn.onclick = () => {
        if (!confirm("Delete pattern " + name + "?")) return;
        delete patterns[name];
        saveJsonToStorage(STORAGE_KEYS().PATTERNS, patterns);
        if (getCurrentPatternName() === name) {
          setCurrentPatternName("");
        }
        renderPatternsPanel();
      };

      btns.appendChild(loadBtn);
      btns.appendChild(renameBtn);
      btns.appendChild(delBtn);

      box.appendChild(left);
      box.appendChild(btns);
      list.appendChild(box);
    });
  }

  function downloadAllPatterns() {
    try {
      const exportObj = { version: 1, patterns: patterns || {} };
      const json = JSON.stringify(exportObj, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "detectlab_patterns.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[DetectLab] downloadAllPatterns error:", err);
      alert("Download patterns failed.");
    }
  }

  function uploadPatternsFromFile() {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.style.display = "none";

      input.onchange = e => {
        const file = e.target.files && e.target.files[0];
        if (!file) {
          input.remove();
          return;
        }

        const reader = new FileReader();
        reader.onload = ev => {
          try {
            const text = ev.target.result || "";
            const data = JSON.parse(text);

            if (!data || typeof data !== "object" || !data.patterns) {
              alert("Invalid pattern file format.");
              input.remove();
              return;
            }

            const incomingPatterns = data.patterns;
            if (!incomingPatterns || typeof incomingPatterns !== "object") {
              alert("Invalid pattern file content.");
              input.remove();
              return;
            }

            Object.keys(incomingPatterns).forEach(name => {
              patterns[name] = incomingPatterns[name];
            });

            saveJsonToStorage(STORAGE_KEYS().PATTERNS, patterns);
            renderPatternsPanel();
            alert("Imported " + Object.keys(incomingPatterns).length + " patterns.");
          } catch (err) {
            console.warn("[DetectLab] uploadPatternsFromFile parse error:", err);
            alert("Cannot read pattern file.");
          } finally {
            input.remove();
          }
        };
        reader.readAsText(file);
      };

      document.body.appendChild(input);
      input.click();
    } catch (err) {
      console.warn("[DetectLab] uploadPatternsFromFile error:", err);
      alert("Upload patterns failed.");
    }
  }

  // =========================================================
  // =========================================================
  // Groups panel — lưu nhóm step tái sử dụng (dùng chung mọi slot)
  // =========================================================
  function loadGroups() {
    groups = loadJsonFromStorage(STORAGE_KEYS().GROUPS, {}) || {};
    return groups;
  }
  function saveGroups() {
    saveJsonToStorage(STORAGE_KEYS().GROUPS, groups);
  }

  let groupsListEl = null;

  function buildGroupsPanel(panel) {
    panel.innerHTML = "";
    loadGroups();

    const header = makeSectionCard();
    header.textContent = "Groups — nhóm step tái sử dụng";
    header.style.fontWeight = "700";

    const actions = makeSectionCard();
    Object.assign(actions.style, { display: "flex", gap: "6px", flexWrap: "wrap" });

    const saveSelBtn = makeBtn("Lưu step đã chọn → group", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
    const combineBtn = makeBtn("Combine groups đã chọn", "linear-gradient(90deg,#a855f7,#6366f1)", "#e5e7eb");
    const refreshBtn = makeBtn("Refresh", "linear-gradient(90deg,#38bdf8,#2563eb)", "#020617");

    actions.appendChild(saveSelBtn);
    actions.appendChild(combineBtn);
    actions.appendChild(refreshBtn);

    const list = makeSectionCard();
    list.id = "dlgroupslist";
    Object.assign(list.style, { flex: "1", minHeight: "140px", overflowY: "auto" });
    groupsListEl = list;

    panel.appendChild(header);
    panel.appendChild(actions);
    panel.appendChild(list);

    saveSelBtn.onclick = () => saveSelectedStepsAsGroup();
    combineBtn.onclick = () => combineSelectedGroups();
    refreshBtn.onclick = () => { loadGroups(); renderGroupsPanel(); };

    renderGroupsPanel();
  }

  async function saveSelectedStepsAsGroup() {
    const chosen = (steps || []).filter(s => s && selectedStepIds.has(s.id));
    if (!chosen.length) {
      alert("Chưa chọn step nào. Tick chọn các step ở tab Steps trước.");
      return;
    }
    const name = await showPromptModal("Tên group:", "");
    if (!name || !name.trim()) return;
    const key = name.trim();
    loadGroups();
    groups[key] = {
      name: key,
      steps: deepClone(chosen).map(s => { delete s.__testStopOnTrue; delete s.groupName; return s; }),
      ts: new Date().toLocaleString()
    };
    saveGroups();
    // Gắn groupName vào CHÍNH các step trong danh sách → chúng gom thành block group
    (steps || []).forEach(s => { if (s && selectedStepIds.has(s.id)) s.groupName = key; });
    selectedStepIds.clear();
    flushProxies();
    renderSteps();
    renderGroupsPanel();
    setLog("Đã gộp " + chosen.length + " step thành group '" + key + "'");
  }

  // Lưu 1 group đang có trong danh sách Steps (theo groupName) vào thư viện Groups
  function saveInlineGroupToLibrary(name) {
    const chosen = (steps || []).filter(s => s && String(s.groupName || "").trim() === name);
    if (!chosen.length) return;
    loadGroups();
    groups[name] = {
      name: name,
      steps: deepClone(chosen).map(s => { delete s.__testStopOnTrue; delete s.groupName; return s; }),
      ts: new Date().toLocaleString()
    };
    saveGroups();
    renderGroupsPanel();
    setLog("Đã lưu group '" + name + "' vào thư viện (" + chosen.length + " step)");
  }

  async function combineSelectedGroups() {
    const names = Array.from(selectedGroupNames).filter(n => groups[n]);
    if (names.length < 2) {
      alert("Tick chọn ít nhất 2 group để combine.");
      return;
    }
    const name = await showPromptModal("Tên group gộp:", names.join(" + "));
    if (!name || !name.trim()) return;
    const key = name.trim();
    const merged = [];
    names.forEach(n => {
      const g = groups[n];
      if (g && Array.isArray(g.steps)) merged.push(...deepClone(g.steps));
    });
    groups[key] = { name: key, steps: merged, ts: new Date().toLocaleString() };
    saveGroups();
    selectedGroupNames.clear();
    renderGroupsPanel();
    setLog("Đã combine " + names.length + " group → '" + key + "' (" + merged.length + " step)");
  }

  function insertGroupIntoSteps(name) {
    const g = groups[name];
    if (!g || !Array.isArray(g.steps) || !g.steps.length) {
      alert("Group rỗng.");
      return;
    }
    // Clone + cấp id mới để không trùng; gắn groupName để gom thành block trong Steps
    const cloned = deepClone(g.steps).map(s => {
      s.id = uid("step");
      delete s.__testStopOnTrue;
      s.groupName = name;
      return s;
    });
    if (!Array.isArray(steps)) steps = [];
    steps.push(...cloned);
    normalizeAllSteps();
    flushProxies();
    renderSteps();
    setLog("Đã đẩy group '" + name + "' (" + cloned.length + " step) vào pattern");
  }

  function renderGroupsPanel() {
    if (!groupsListEl) return;
    loadGroups();
    const list = groupsListEl;
    list.innerHTML = "";
    const names = Object.keys(groups || {});
    if (!names.length) {
      const empty = document.createElement("div");
      empty.textContent = "Chưa có group nào. Tick chọn step ở tab Steps rồi bấm 'Lưu step đã chọn → group'.";
      empty.style.fontSize = "12px";
      empty.style.color = "#9ca3af";
      list.appendChild(empty);
      return;
    }
    names.forEach(name => {
      const g = groups[name] || {};
      const cnt = Array.isArray(g.steps) ? g.steps.length : 0;
      const row = document.createElement("div");
      Object.assign(row.style, {
        padding: "8px", marginBottom: "6px", borderRadius: "8px",
        background: "rgba(2,6,23,0.7)", border: "1px solid rgba(99,102,241,0.5)"
      });

      const top = document.createElement("div");
      Object.assign(top.style, { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" });

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = selectedGroupNames.has(name);
      chk.onchange = () => { if (chk.checked) selectedGroupNames.add(name); else selectedGroupNames.delete(name); };

      const title = document.createElement("span");
      title.textContent = name + "  (" + cnt + " step)";
      Object.assign(title.style, { fontSize: "13px", fontWeight: "700", color: "#e5e7eb", flex: "1" });

      const ts = document.createElement("span");
      ts.textContent = g.ts || "";
      Object.assign(ts.style, { fontSize: "10px", color: "#94a3b8" });

      top.appendChild(chk);
      top.appendChild(title);
      top.appendChild(ts);

      const btns = document.createElement("div");
      Object.assign(btns.style, { display: "flex", gap: "6px", flexWrap: "wrap" });

      const insBtn = makeBtn("Đẩy vào pattern", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
      const renBtn = makeBtn("Rename", "linear-gradient(90deg,#e5e7eb,#94a3b8)", "#020617");
      const delBtn = makeBtn("Xóa", "linear-gradient(90deg,#f87171,#dc2626)", "#fff");
      [insBtn, renBtn, delBtn].forEach(b => { b.style.fontSize = "11px"; b.style.padding = "3px 8px"; });

      insBtn.onclick = () => insertGroupIntoSteps(name);
      renBtn.onclick = async () => {
        const nn = await showPromptModal("Đổi tên group:", name);
        if (!nn || !nn.trim() || nn.trim() === name) return;
        groups[nn.trim()] = groups[name];
        groups[nn.trim()].name = nn.trim();
        delete groups[name];
        saveGroups();
        renderGroupsPanel();
      };
      delBtn.onclick = () => {
        if (!confirm("Xóa group '" + name + "'?")) return;
        delete groups[name];
        selectedGroupNames.delete(name);
        saveGroups();
        renderGroupsPanel();
      };

      btns.appendChild(insBtn);
      btns.appendChild(renBtn);
      btns.appendChild(delBtn);

      row.appendChild(top);
      row.appendChild(btns);
      list.appendChild(row);
    });
  }

  // =========================================================
  // Quick step builder (Feature 2) — phím tắt: thêm step + mở editor THẬT
  // =========================================================
  async function quickAddStep(stepType) {
    const sid = activeSlotId;
    setStatus("Step " + stepType + " — nhập trên cửa sổ slot " + sid + " (S/P pick, Ctrl+S lưu)", "run");
    const res = await domShowStepBuilder(stepType, sid);
    if (!res || !res.ok) {
      if (res && res.noResponse) {
        setStatus("Slot " + sid + " chưa mở / sai trang", "error");
        alert("Slot " + sid + " chưa mở hoặc chưa load trang. Mở slot rồi thử lại.");
      } else {
        setStatus("Hủy thêm step", null);
      }
      return;
    }
    const step = buildStepFromBuilderFields(stepType, res.fields || {}, (Array.isArray(steps) ? steps.length : 0) + 1);
    if (!Array.isArray(steps)) steps = [];
    steps.push(step);
    normalizeAllSteps();
    flushProxies();
    renderSteps();
    setStatus("Đã thêm step " + stepType + " (nhập trên slot)", "ok");
    setLog("Đã thêm '" + stepType + "' qua slot overlay");
  }

  // Build step object từ field của overlay builder
  function buildStepFromBuilderFields(stepType, f, idx) {
    f = f || {};
    const base = createDefaultStep(idx || 1);
    const step = Object.assign({}, base, { type: stepType, action: stepType });
    if (f.selector != null) step.selector = String(f.selector || "").trim();
    if (f.column != null) step.column = String(f.column || "").trim().toUpperCase();
    if (f.fileNameColumn != null) step.fileNameColumn = String(f.fileNameColumn || "").trim().toUpperCase();
    if (f.value != null) step.value = String(f.value || "");
    if (f.url != null) step.url = String(f.url || "").trim();
    if (f.resultKey != null) step.resultKey = String(f.resultKey || "").trim();
    if (f.op != null) step.conditionOp = String(f.op || "").trim();
    if (f.conditionValueColumn != null) step.conditionValueColumn = String(f.conditionValueColumn || "").trim().toUpperCase();
    if (f.conditionValue != null) step.conditionValue = String(f.conditionValue || "");
    if (f.conditionTrueMode != null) step.conditionTrueMode = String(f.conditionTrueMode || "stop");
    if (f.conditionJumpTo != null) step.conditionJumpTo = String(f.conditionJumpTo || "").trim();
    if (f.readMode != null && f.readMode) step.readMode = String(f.readMode);
    if (f.matchText != null) step.matchText = String(f.matchText || "").trim();
    if (f.key != null) step.key = String(f.key || "").trim();
    if (f.sessionName != null) step.sessionName = String(f.sessionName || "").trim();
    if (f.clicknearDirection != null && f.clicknearDirection) step.clicknearDirection = String(f.clicknearDirection);
    if (f.clicknearIndex != null && f.clicknearIndex !== "") step.clicknearIndex = parseInt(f.clicknearIndex, 10) || 0;
    if (f.arrowDirection != null && f.arrowDirection) step.arrowDirection = String(f.arrowDirection);
    if (f.arrowCount != null && f.arrowCount !== "") step.arrowCount = parseInt(f.arrowCount, 10) || 1;
    if (f.arrowDelay != null && f.arrowDelay !== "") step.arrowDelay = parseInt(f.arrowDelay, 10) || 50;
    // Thông tin element phong phú (từ pick selector)
    if (f.labelText != null) step.labelText = String(f.labelText || "").trim();
    if (f.elementText != null) step.elementText = String(f.elementText || "").trim();
    if (f.containerTag != null) step.containerTag = String(f.containerTag || "").trim();
    if (f.containerClassName != null) step.containerClassName = String(f.containerClassName || "").trim();
    const d = parseInt(f.delay, 10);
    if (!isNaN(d)) step.delayMs = d;
    // clickMode: ưu tiên giá trị chọn trong overlay; nếu có x/y mà chọn point
    if (f.clickMode != null && f.clickMode) step.clickMode = String(f.clickMode);
    if (f.x != null && f.x !== "" && f.y != null && f.y !== "") {
      step.x = Number(f.x); step.y = Number(f.y);
    }
    return step;
  }

  // Overlay nhập step bấm TRÊN cửa sổ slot → control GHI NHẬN vào đúng slot đó
  safeOnWebResult(data => {
    if (!data || data.type !== "stepBuilder" || !data.fromSlot || data.ack || !data.ok) return;
    const sid = Number(data.slotId) || activeSlotId;
    const st = slotStates[sid];
    if (!st) return;
    if (!Array.isArray(st.steps)) st.steps = [];
    const step = buildStepFromBuilderFields(data.stepType, data.fields || {}, st.steps.length + 1);
    st.steps.push(step);
    if (sid === activeSlotId) {
      syncProxies();
      normalizeAllSteps();
      flushProxies();
      renderSteps();
    }
    setStatus("Đã ghi nhận step '" + data.stepType + "' từ slot " + sid, "ok");
    setLog("Slot " + sid + " (overlay) thêm: " + data.stepType);
  });

  // Phím tắt chọn loại step (khi KHÔNG đang gõ trong ô input)
  const QUICK_STEP_KEYS = {
    c: "click", h: "hover", i: "input", r: "read", k: "condition",
    u: "upload", d: "download", o: "open", w: "wait", e: "end", x: "delete"
  };
  let quickKeysEnabled = true;
  window.__dlSetQuickKeys = (on) => { quickKeysEnabled = !!on; };

  document.addEventListener("keydown", (ev) => {
    if (!quickKeysEnabled) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const t = ev.target;
    const tag = t && t.tagName ? t.tagName.toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || tag === "select" || (t && t.isContentEditable)) return;
    // chỉ khi đang ở tab Steps
    const panelStepsEl = document.getElementById("dlpanelsteps");
    if (panelStepsEl && panelStepsEl.style.display === "none") return;
    const key = String(ev.key || "").toLowerCase();
    if (QUICK_STEP_KEYS[key]) {
      ev.preventDefault();
      quickAddStep(QUICK_STEP_KEYS[key]);
    }
  });

  // Images panel
  // =========================================================

function buildImagesPanel(panelImages) {
  panelImages.innerHTML = "";

  const libHeader = makeSectionCard();
  libHeader.textContent = "Images library";
  libHeader.style.fontWeight = "700";

  const libActions = makeSectionCard();
  Object.assign(libActions.style, {
    display: "flex",
    gap: "6px",
    alignItems: "center",
    flexWrap: "wrap"
  });

  const addImagesBtn = makeBtn("Add images", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
  const selectAllImagesBtn = makeBtn("Select all", "linear-gradient(90deg,#e5e7eb,#94a3b8)", "#020617");
  const delImagesBtn = makeBtn("Delete selected", "linear-gradient(90deg,#f97373,#ef4444)", "#fff");
  const refreshImagesBtn = makeBtn("Refresh", "linear-gradient(90deg,#facc15,#eab308)", "#111827");

  const imagesSearch = makeSmallInput("text", "", "160px");
  imagesSearch.placeholder = "Filter by name...";
  imagesSearch.style.flex = "1";
  imagesSearch.style.minWidth = "180px";

  libActions.appendChild(addImagesBtn);
  libActions.appendChild(selectAllImagesBtn);
  libActions.appendChild(delImagesBtn);
  libActions.appendChild(refreshImagesBtn);
  libActions.appendChild(imagesSearch);

  const imagesList = makeSectionCard();
  imagesList.id = "dlimageslist";
  Object.assign(imagesList.style, {
    minHeight: "120px",
    maxHeight: "180px",
    overflowY: "auto"
  });

  const mediaHeader = makeSectionCard();
  mediaHeader.textContent = "Media downloaded from sheet";
  mediaHeader.style.fontWeight = "700";

  const mediaActions = makeSectionCard();
  Object.assign(mediaActions.style, {
    display: "flex",
    gap: "6px",
    alignItems: "center",
    flexWrap: "wrap"
  });

  const mediaRefreshBtn = makeBtn("Refresh media", "linear-gradient(90deg,#38bdf8,#2563eb)", "#020617");
  const mediaDownloadFromSheetBtn = makeBtn("Download from sheet", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
  const mediaAddManualBtn = makeBtn("Add media", "linear-gradient(90deg,#a855f7,#6366f1)", "#e5e7eb");
  const mediaSelectAllBtn = makeBtn("Select all media", "linear-gradient(90deg,#e5e7eb,#94a3b8)", "#020617");
  const mediaDeleteBtn = makeBtn("Delete selected", "linear-gradient(90deg,#f87171,#dc2626)", "#fff");
  const mediaDeleteAllBtn = makeBtn("Delete all", "linear-gradient(90deg,#9f1239,#7f1d1d)", "#fecaca");

  mediaActions.appendChild(mediaRefreshBtn);
  mediaActions.appendChild(mediaDownloadFromSheetBtn);
  mediaActions.appendChild(mediaAddManualBtn);
  mediaActions.appendChild(mediaSelectAllBtn);
  mediaActions.appendChild(mediaDeleteBtn);
  mediaActions.appendChild(mediaDeleteAllBtn);

  const mediaList = makeSectionCard();
  mediaList.id = "dlmedialist";
  Object.assign(mediaList.style, {
    flex: "1",
    minHeight: "140px",
    overflowY: "auto"
  });

  panelImages.appendChild(libHeader);
  panelImages.appendChild(libActions);
  panelImages.appendChild(imagesList);
  panelImages.appendChild(mediaHeader);
  panelImages.appendChild(mediaActions);
  panelImages.appendChild(mediaList);

  sidebarEl.imagesList = imagesList;
  sidebarEl.imagesSearch = imagesSearch;
  sidebarEl.mediaList = mediaList;
  sidebarEl.mediaRefreshBtn = mediaRefreshBtn;
  sidebarEl.mediaDownloadFromSheetBtn = mediaDownloadFromSheetBtn;
  sidebarEl.mediaSelectAllBtn = mediaSelectAllBtn;

  refreshImagesBtn.onclick = () => renderImagesPanel();
  imagesSearch.oninput = () => renderImagesPanel();
  addImagesBtn.onclick = () => addImagesToLibrary();
  selectAllImagesBtn.onclick = () => {
    const checks = imagesList.querySelectorAll('input[type="checkbox"][data-id]');
    checks.forEach(ch => {
      ch.checked = true;
    });
  };
  delImagesBtn.onclick = () => deleteSelectedImagesFromLibrary();

  mediaRefreshBtn.onclick = () => refreshMediaIndexFromMain();
  mediaDownloadFromSheetBtn.onclick = () => startDownloadMediaFromSheet();
  mediaAddManualBtn.onclick = () => addManualMediaItems();
  mediaSelectAllBtn.onclick = () => {
    const checks = mediaList.querySelectorAll('input[type="checkbox"][data-id]');
    checks.forEach(ch => {
      ch.checked = true;
    });
  };

  mediaDeleteBtn.onclick = async () => {
    if (!window.controlAPI || typeof window.controlAPI.deleteMedia !== "function") {
      console.warn("[DetectLab] controlAPI.deleteMedia not available");
      return;
    }
    const checks = mediaList.querySelectorAll('input[type="checkbox"][data-id]:checked');
    const ids = Array.from(checks).map(ch => ch.dataset.id).filter(Boolean);
    if (!ids.length) {
      alert("No media selected.");
      return;
    }
    if (!confirm("Delete " + ids.length + " selected media file(s)?")) return;
    try {
      const res = await window.controlAPI.deleteMedia({ ids });
      if (res && res.ok) {
        setLog("Deleted " + (res.removed || ids.length) + " media file(s)");
      } else {
        console.warn("[DetectLab] deleteMedia (selected) failed", res);
      }
    } catch (err) {
      console.warn("[DetectLab] deleteMedia (selected) error:", err);
    }
  };

  mediaDeleteAllBtn.onclick = async () => {
    if (!window.controlAPI || typeof window.controlAPI.deleteMedia !== "function") {
      console.warn("[DetectLab] controlAPI.deleteMedia not available");
      return;
    }
    const curSlot = Number(activeSlotId) || 1;
    if (!confirm("Delete ALL media of slot " + curSlot + "? This cannot be undone.")) return;
    // Chỉ xóa media thuộc slot đang xem
    const ids = (Array.isArray(mediaItems) ? mediaItems : [])
      .filter(it => (Number(it && it.slotId) || 1) === curSlot)
      .map(it => it.id)
      .filter(Boolean);
    if (!ids.length) {
      alert("No media for slot " + curSlot + ".");
      return;
    }
    try {
      const res = await window.controlAPI.deleteMedia({ ids });
      if (res && res.ok) {
        setLog("Deleted all media of slot " + curSlot + " (" + (res.removed || 0) + " file(s))");
      } else {
        console.warn("[DetectLab] deleteMedia (all) failed", res);
      }
    } catch (err) {
      console.warn("[DetectLab] deleteMedia (all) error:", err);
    }
  };

  renderImagesPanel();
  renderMediaPanel();
}

  function renderImagesPanel() {
  if (!sidebarEl || !sidebarEl.imagesList) return;

  const list = sidebarEl.imagesList;
  list.innerHTML = "";

  const filter = sidebarEl.imagesSearch
  ? String(sidebarEl.imagesSearch.value || "").toLowerCase().trim()
  : "";

  const items = Array.isArray(imageLibrary) ? imageLibrary : [];
  const filtered = filter
  ? items.filter(it => String(it.name || "").toLowerCase().includes(filter))
  : items;

  if (!filtered.length) {
  const empty = document.createElement("div");
  empty.textContent = "No images in library (local UI icons).";
  empty.style.fontSize = "12px";
  empty.style.color = "#9ca3af";
  list.appendChild(empty);
  return;
  }

  filtered.forEach(img => {
  const row = document.createElement("div");
  Object.assign(row.style, {
  padding: "6px 8px",
  marginBottom: "4px",
  borderRadius: "6px",
  background: "rgba(2,6,23,0.6)",
  border: "1px solid rgba(37,99,235,0.45)",
  display: "flex",
  alignItems: "center",
  gap: "8px"
  });

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.id = img.id;

  const nameSpan = document.createElement("span");
  nameSpan.textContent = img.name || "no name";
  Object.assign(nameSpan.style, {
  fontSize: "12px",
  color: "#e5e7eb",
  flex: "1"
  });

  const idSpan = document.createElement("span");
  idSpan.textContent = img.id || "";
  Object.assign(idSpan.style, {
  fontSize: "10px",
  color: "#94a3b8"
  });
  cssEllipsis(idSpan);

  row.appendChild(checkbox);
  row.appendChild(nameSpan);
  row.appendChild(idSpan);

  list.appendChild(row);
  });
  }

// ── Media panel (image storage downloaded from sheet) ────────────────

  function renderMediaPanel() {
  if (!sidebarEl || !sidebarEl.mediaList) return;

  const list = sidebarEl.mediaList;
  list.innerHTML = "";

  // CHỈ hiển thị media của slot đang xem — tab Media tách riêng theo slot.
  const curSlot = Number(activeSlotId) || 1;
  const items = (Array.isArray(mediaItems) ? mediaItems : [])
    .filter(it => (Number(it && it.slotId) || 1) === curSlot);
  if (!items.length) {
  const empty = document.createElement("div");
  empty.textContent = "No media for slot " + curSlot + " yet.";
  empty.style.fontSize = "12px";
  empty.style.color = "#9ca3af";
  list.appendChild(empty);
  return;
  }

  // Hiện tại: show tất cả theo fileName
  items.forEach(item => {
  const row = document.createElement("div");
  Object.assign(row.style, {
  padding: "6px 8px",
  marginBottom: "4px",
  borderRadius: "6px",
  background: "rgba(15,23,42,0.9)",
  border: "1px solid rgba(56,189,248,0.55)",
  display: "flex",
  alignItems: "center",
  gap: "8px"
  });

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.id = item.id;
  checkbox.checked = !!item.selected;
  checkbox.onchange = () => {
  item.selected = checkbox.checked;
  };

  const nameSpan = document.createElement("span");
  nameSpan.textContent = item.fileName || "no-name";
  Object.assign(nameSpan.style, {
  fontSize: "12px",
  color: "#e5e7eb",
  flex: "1"
  });

  const metaSpan = document.createElement("span");
  metaSpan.textContent =
  "row " +
  (String(item.rowId || "?")) +
  (item.slotId ? ` · slot ${item.slotId}` : "") +
  (item.status ? ` · ${item.status}` : "");
  Object.assign(metaSpan.style, {
  fontSize: "10px",
  color: "#94a3b8"
  });
  cssEllipsis(metaSpan);

  const delBtn = document.createElement("button");
  delBtn.textContent = "✕";
  Object.assign(delBtn.style, {
  fontSize: "11px",
  lineHeight: "1",
  padding: "3px 6px",
  borderRadius: "5px",
  border: "1px solid rgba(248,113,113,0.6)",
  background: "rgba(127,29,29,0.5)",
  color: "#fecaca",
  cursor: "pointer",
  flexShrink: "0"
  });
  delBtn.title = "Delete this media";
  delBtn.onclick = async () => {
  if (!window.controlAPI || typeof window.controlAPI.deleteMedia !== "function") {
  console.warn("[DetectLab] controlAPI.deleteMedia not available");
  return;
  }
  delBtn.disabled = true;
  try {
  const res = await window.controlAPI.deleteMedia({ ids: [item.id] });
  if (res && res.ok) {
  setLog("Deleted media " + (item.fileName || item.id));
  } else {
  console.warn("[DetectLab] deleteMedia failed", res);
  }
  } catch (err) {
  console.warn("[DetectLab] deleteMedia error:", err);
  } finally {
  delBtn.disabled = false;
  }
  };

  row.appendChild(checkbox);
  row.appendChild(nameSpan);
  row.appendChild(metaSpan);
  row.appendChild(delBtn);

  list.appendChild(row);
  });
  }

  async function refreshMediaIndexFromMain() {
  try {
  if (!window.controlAPI || typeof window.controlAPI.getMediaIndex !== "function") {
  console.warn("[DetectLab] controlAPI.getMediaIndex not available");
  return;
  }
  const res = await window.controlAPI.getMediaIndex();
  if (!res || !res.ok || !Array.isArray(res.items)) {
  console.warn("[DetectLab] getMediaIndex failed", res);
  return;
  }
  mediaItems = res.items.slice();
  S().mediaItems = mediaItems;
  renderMediaPanel();
  } catch (err) {
  console.warn("[DetectLab] refreshMediaIndexFromMain error:", err);
  }
  }

  // Expose ra window để các hàm top-level và listener ngoài scope có thể gọi
  window.renderMediaPanel = renderMediaPanel;
  window.refreshMediaIndexFromMain = refreshMediaIndexFromMain;

async function downloadMediaForStepAndRow(step, rowNumber, runSlotId, runSt) {
try {
if (!window.controlAPI || typeof window.controlAPI.downloadMediaFromSheet !== "function") {
console.warn("[DetectLab] controlAPI.downloadMediaFromSheet not available");
return null;
}

// Slot đang chạy (cố định) — KHÔNG dùng activeSlotId để parallel không lẫn nhau.
const slotForDownload = Number(runSlotId) || Number(activeSlotId) || 1;
const stForRun = runSt || slotStates[slotForDownload] || S();

// Dùng rawRowArray của ĐÚNG slot đang chạy
const rows = Array.isArray(stForRun.rawRowArray) ? stForRun.rawRowArray : [];
if (!rows.length) {
console.warn("[DetectLab] downloadMediaForStepAndRow: no rawRowArray");
return null;
}

const baseRow =
typeof stForRun.startRow === "number" && stForRun.startRow >= 2
? stForRun.startRow
: (typeof window.DetectLabSheetStartRow === "number" && window.DetectLabSheetStartRow >= 2
? window.DetectLabSheetStartRow
: 2);
const idxInArray = rowNumber - baseRow;
if (idxInArray < 0 || idxInArray >= rows.length) {
console.warn("[DetectLab] downloadMediaForStepAndRow: row out of range", {
rowNumber,
baseRow,
len: rows.length
});
return null;
}

const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
let urlColIdx = 0;
let urlColLetter = null;

try {
const colStr = step && typeof step.column === "string"
? step.column.trim().toUpperCase()
: "";
if (colStr) {
urlColLetter = colStr;
const idx = letters.indexOf(colStr);
if (idx >= 0) urlColIdx = idx;
}
} catch (e) {
console.warn("[DetectLab] downloadMediaForStepAndRow resolve column failed, fallback to index 0", e);
}

console.log("[DetectLab] downloadMediaForStepAndRow using column:", {
letter: urlColLetter,
index: urlColIdx,
rowNumber
});

const row = Array.isArray(rows[idxInArray]) ? rows[idxInArray] : [];
const url = String(row[urlColIdx] || "").trim();
if (!url) {
console.warn("[DetectLab] downloadMediaForStepAndRow empty url at row", {
rowNumber,
urlColIdx
});
return null;
}

// Lấy tên file từ fileNameColumn nếu được cấu hình
let resolvedFileName = "row-" + rowNumber;
try {
  const nameColStr = step && typeof step.fileNameColumn === "string"
    ? step.fileNameColumn.trim().toUpperCase()
    : "";
  if (nameColStr) {
    const nameColIdx = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".indexOf(nameColStr);
    const nameVal = String(row[nameColIdx >= 0 ? nameColIdx : 0] || "").trim();
    if (nameVal) resolvedFileName = nameVal;
  }
} catch (e) {
  console.warn("[DetectLab] downloadMediaForStepAndRow resolve fileNameColumn error:", e);
}

const item = {
id: "row-" + rowNumber,
fileName: resolvedFileName,
url,
rowId: rowNumber
};

console.log("[DetectLab] downloadMediaForStepAndRow item:", item);

const res = await window.controlAPI.downloadMediaFromSheet({
slotId: slotForDownload,
items: [item]
});

console.log("[DetectLab] downloadMediaFromSheet (per-step) result:", res);

if (!res || !res.ok) {
console.warn("[DetectLab] downloadMediaForStepAndRow failed", res);
return null;
}

if (typeof window.refreshMediaIndexFromMain === "function") {
await window.refreshMediaIndexFromMain();
}

return res;
} catch (err) {
console.warn("[DetectLab] downloadMediaForStepAndRow error:", err);
return null;
}
}

async function buildUploadFilesForStep(step, rowObj, runSlotId) {
try {
// Dùng slot đang CHẠY (truyền vào) để parallel không lẫn media giữa các slot.
const currentSlotId = Number(runSlotId) || Number(activeSlotId) || 1;
const row = rowObj || {};
const candidates = (Array.isArray(mediaItems) ? mediaItems : [])
.filter(item => {
if (!item) return false;
const itemSlotId = Number(item.slotId) || 1;
return itemSlotId === currentSlotId;
});
if (!candidates.length) return [];

const namesFromStep = [];
const pushName = v => {
const s = String(v || "").trim();
if (s) namesFromStep.push(s);
};

if (step) {
pushName(step.value);
pushName(step.matchText);
if (step.fileNameColumn) {
pushName(getCellValueByColumn(row, step.fileNameColumn));
}
if (step.column) {
pushName(getCellValueByColumn(row, step.column));
}
}

const uniqueNames = Array.from(new Set(namesFromStep.map(v => v.trim()).filter(Boolean)));
let filtered = candidates;

if (uniqueNames.length) {
filtered = candidates.filter(item => {
const fileName = String(item && item.fileName || "").toLowerCase();
const sourceUrl = String(item && item.sourceUrl || "").toLowerCase();
const mediaId = String(item && item.id || "").toLowerCase();
return uniqueNames.some(name => {
const n = String(name).toLowerCase();
return fileName.includes(n) || sourceUrl.includes(n) || mediaId.includes(n);
});
});
} else {
const selectedOnly = candidates.filter(item => item && item.selected);
filtered = selectedOnly.length ? selectedOnly : candidates;
}

const result = filtered
.filter(item => item && item.localPath)
.map(item => ({
id: item.id,
name: item.fileName || "upload-file",
type: item.mime || "",
localPath: item.localPath,
slotId: Number(item.slotId) || currentSlotId
}));

console.log("[DetectLab] buildUploadFilesForStep DEBUG:", {
  slot: currentSlotId,
  totalMedia: (mediaItems || []).length,
  candidatesInSlot: candidates.length,
  uniqueNames,
  matchedCount: result.length,
  matchedNames: result.map(f => f.name),
  allCandidateNames: candidates.map(c => c.fileName)
});

return result;
} catch (err) {
console.warn("[DetectLab] buildUploadFilesForStep error:", err);
return [];
}
}

async function startDownloadMediaFromSheet() {
try {
if (!window.controlAPI || typeof window.controlAPI.downloadMediaFromSheet !== "function") {
console.warn("[DetectLab] controlAPI.downloadMediaFromSheet not available");
alert("Download media not supported in this build.");
return;
    }

    // Lấy rawRowArray hiện có (đã fetch từ sheet) và map ra url + fileName
    const rows = Array.isArray(rawRowArray) ? rawRowArray : [];
    console.log("[DetectLab] startDownloadMediaFromSheet raw rows length:", rows.length);
    if (!rows.length) {
      alert("No sheet rows loaded. Please fetch sheet data first.");
      return;
    }

    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const startRowBase = window.DetectLabSheetStartRow || 2;

    // Lấy TẤT CẢ step download trong pattern — mỗi step có cột URL + cột tên riêng.
    // Phải download theo từng cột mà từng step download đã chọn.
    const downloadSteps = Array.isArray(steps)
      ? steps.filter(s => s && s.type === "download")
      : [];

    // Nếu pattern chưa có step download nào → fallback: URL cột A, tên = row-N
    const stepsToUse = downloadSteps.length
      ? downloadSteps
      : [{ column: "A", fileNameColumn: "" }];

    console.log("[DetectLab] startDownloadMediaFromSheet download steps:", {
      count: downloadSteps.length,
      usingFallback: !downloadSteps.length
    });

    // Build items gộp từ mọi step download, dedupe theo url+fileName
    const allItems = [];
    const seen = new Set();

    stepsToUse.forEach((dlStep, stepIdx) => {
      // Resolve cột URL
      let urlColIdx = 0;
      let urlColLetter = null;
      const colStr = dlStep && typeof dlStep.column === "string"
        ? dlStep.column.trim().toUpperCase()
        : "";
      if (colStr) {
        urlColLetter = colStr;
        const idx = letters.indexOf(colStr);
        if (idx >= 0) urlColIdx = idx;
      }

      // Resolve cột tên (optional)
      let nameColIdx = null;
      let nameColLetter = null;
      const nameStr = dlStep && typeof dlStep.fileNameColumn === "string"
        ? dlStep.fileNameColumn.trim().toUpperCase()
        : "";
      if (nameStr) {
        nameColLetter = nameStr;
        const nIdx = letters.indexOf(nameStr);
        if (nIdx >= 0) nameColIdx = nIdx;
      }

      console.log("[DetectLab] download step #" + stepIdx + " using columns:", {
        url: { letter: urlColLetter, index: urlColIdx },
        name: { letter: nameColLetter, index: nameColIdx }
      });

      rows.forEach((row, idx) => {
        const safeRow = Array.isArray(row) ? row : [];
        const url = String(safeRow[urlColIdx] || "").trim();
        if (!url) return;

        let fileNameRaw = "";
        if (nameColIdx != null && nameColIdx >= 0 && nameColIdx < safeRow.length) {
          fileNameRaw = String(safeRow[nameColIdx] || "").trim();
        }
        const fileName = fileNameRaw || ("row-" + (idx + 1));

        const dedupeKey = url + "||" + fileName;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);

        allItems.push({
          id: "s" + stepIdx + "-row-" + (idx + 1),
          fileName,
          url,
          rowId: idx + 1 + startRowBase
        });
      });
    });

    console.log("[DetectLab] startDownloadMediaFromSheet items built:", {
      count: allItems.length,
      sample: allItems[0] || null
    });

    if (!allItems.length) {
      alert("Cannot find any image URL in sheet rows.");
      return;
    }

    setStatus("Downloading media (" + allItems.length + " items)...", "run");
    const res = await window.controlAPI.downloadMediaFromSheet({
      slotId: activeSlotId,
      items: allItems
    });

    console.log("[DetectLab] downloadMediaFromSheet result:", res);

    if (!res || !res.ok) {
      console.warn("[DetectLab] downloadMediaFromSheet failed", res);
      setStatus("Download media failed", "error");
      alert("Download media failed: " + (res && res.reason ? res.reason : "unknown"));
      return;
    }

    setStatus("Downloaded media for slot " + activeSlotId, "ok");
    if (typeof window.refreshMediaIndexFromMain === "function") await window.refreshMediaIndexFromMain();
  } catch (err) {
    console.warn("[DetectLab] startDownloadMediaFromSheet error:", err);
    setStatus("Download media failed", "error");
    alert("Download media failed: " + (err && err.message ? err.message : "unknown"));
  }
}
window.startDownloadMediaFromSheet = startDownloadMediaFromSheet;
window.downloadMediaForStepAndRow = downloadMediaForStepAndRow;

async function addManualMediaItems() {
  try {
    if (!window.controlAPI || typeof window.controlAPI.pickFiles !== "function") {
      setStatus("Pick files not supported in this build", "error");
      setLog("Missing controlAPI.pickFiles");
      return;
    }

    const res = await window.controlAPI.pickFiles({
      title: "Select media files",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Media", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "mp4", "mov", "avi", "mkv", "webm"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });

    if (!res || !res.ok) {
      setStatus("Add manual media failed", "error");
      setLog(res && res.reason ? String(res.reason) : "Pick files failed");
      return;
    }

    if (res.canceled) {
      setStatus("Add manual media canceled", "warn");
      setLog("Manual media add canceled");
      return;
    }

    const files = Array.isArray(res.files) ? res.files : [];
    let added = 0;

    files.forEach(f => {
      const localPath = String(f && f.localPath || "").trim();
      if (!localPath) return;

      mediaItems.push({
        id: uid("manual-media"),
        fileName: String(f && f.name || "upload-file"),
        localPath,
        rowId: null,
        slotId: Number(activeSlotId) || 1,
        status: "manual",
        mime: "",
        selected: true
      });
      added += 1;
    });

    S().mediaItems = mediaItems;
    renderMediaPanel();

    if (added > 0) {
      setStatus("Added " + added + " manual media", "ok");
      setLog("Manual media ready for upload test");
    } else {
      setStatus("No valid file selected", "warn");
      setLog("Manual media add skipped");
    }
  } catch (err) {
    console.warn("[DetectLab] addManualMediaItems error:", err);
    setStatus("Add manual media failed", "error");
    setLog("Add manual media failed");
  }
}

  function addImagesToLibrary() {
    try {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.style.display = "none";

      input.onchange = e => {
        const files = Array.from(e.target.files || []);
        if (!files.length) {
          input.remove();
          return;
        }

        files.forEach(f => {
          imageLibrary.push({
            id: uid("img"),
            name: f.name,
            file: null
          });
        });

        saveJsonToStorage(
          STORAGE_KEYS().IMAGES,
          imageLibrary.map(it => ({
            id: it.id,
            name: it.name
          }))
        );

        renderImagesPanel();
        input.remove();
      };

      document.body.appendChild(input);
      input.click();
    } catch (err) {
      console.warn("[DetectLab] addImagesToLibrary error:", err);
      alert("Add images failed.");
    }
  }

  function deleteSelectedImagesFromLibrary() {
    if (!sidebarEl || !sidebarEl.imagesList) return;

    const checks = sidebarEl.imagesList.querySelectorAll('input[type="checkbox"][data-id]');
    const idsToDelete = [];
    checks.forEach(ch => {
      if (ch.checked) idsToDelete.push(ch.dataset.id);
    });

    if (!idsToDelete.length) return;

    imageLibrary = (imageLibrary || []).filter(img => !idsToDelete.includes(img.id));

    saveJsonToStorage(
      STORAGE_KEYS().IMAGES,
      imageLibrary.map(it => ({
        id: it.id,
        name: it.name
      }))
    );

    renderImagesPanel();
  }

  // =========================================================
  // Noti panel
  // =========================================================

  function buildNotiPanel(panelNoti) {
    panelNoti.innerHTML = "";

    const header = makeSectionCard();
    header.textContent = "Notification rules";
    header.style.fontWeight = "700";

    const actions = makeSectionCard();
    Object.assign(actions.style, {
      display: "flex",
      gap: "6px",
      alignItems: "center"
    });

    const addNotiRuleBtn = makeBtn("Add rule", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
    const spacer = document.createElement("div");
    spacer.style.marginLeft = "auto";
    spacer.style.display = "flex";
    spacer.style.gap = "6px";

    const downloadNotiBtn = makeBtn("Download", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16");
    const uploadNotiBtn = makeBtn("Upload", "linear-gradient(90deg,#0ea5e9,#3b82f6)", "#082f49");

    spacer.appendChild(downloadNotiBtn);
    spacer.appendChild(uploadNotiBtn);

    actions.appendChild(addNotiRuleBtn);
    actions.appendChild(spacer);

    const notiList = makeSectionCard();
    notiList.id = "dlnotirules";
    Object.assign(notiList.style, {
      flex: "1",
      overflowY: "auto",
      minHeight: "120px"
    });

    panelNoti.appendChild(header);
    panelNoti.appendChild(actions);
    panelNoti.appendChild(notiList);

    sidebarEl.notiList = notiList;

    // ── Mode selector ──────────────────────────────────────────
    const modeRow = makeSectionCard();
    Object.assign(modeRow.style, { display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" });
    const modeLabel = document.createElement("span");
    modeLabel.style.cssText = "font-size:11px;color:#9ca3af;white-space:nowrap";
    modeLabel.textContent = "Handle mode:";
    const modeSelect = makeSelect(
      ["hybrid", "auto-only", "control-first"],
      slotStates[activeSlotId] ? (slotStates[activeSlotId].notiMode || "hybrid") : "hybrid",
      "130px"
    );
    modeSelect.title = "hybrid: auto nếu có rule, hỏi control nếu không | auto-only: luôn tự bấm | control-first: luôn hỏi control";
    modeSelect.onchange = () => setNotiMode(activeSlotId, modeSelect.value);
    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeSelect);
    panelNoti.appendChild(modeRow);

    // ── Pending section ────────────────────────────────────────
    const pendingHeader = makeSectionCard();
    pendingHeader.textContent = "Pending notifications";
    pendingHeader.style.fontWeight = "700";
    pendingHeader.style.marginTop = "10px";
    panelNoti.appendChild(pendingHeader);

    const pendingContainer = makeSectionCard();
    pendingContainer.id = "dl-pending-noti-container";
    Object.assign(pendingContainer.style, {
      flex: "1",
      overflowY: "auto",
      minHeight: "60px"
    });
    panelNoti.appendChild(pendingContainer);

    addNotiRuleBtn.onclick = async () => {
      const pattern = await showPromptModal("Message contains (for this notification):", "");
      if (!pattern) return;
      const choice = await showPromptModal('Auto choose: "ok" or "cancel"?', "ok");
      if (!choice) return;

      notiRules.push({
        id: uid("rule"),
        pattern: pattern.trim(),
        choice: String(choice).trim().toLowerCase() === "cancel" ? "cancel" : "ok",
        enabled: true
      });

      saveJsonToStorage(STORAGE_KEYS().NOTI, notiRules);
      renderNotiRulesPanel();
      sendAllNotiRulesToPage();
    };

    downloadNotiBtn.onclick = () => downloadNotiRules();
    uploadNotiBtn.onclick = () => uploadNotiRulesFromFile();
  }

  async function renderSessionPanel(container) {
    if (!container) return;
    container.innerHTML = "";

    const title = document.createElement("div");
    title.textContent = "Session & Cookies";
    Object.assign(title.style, { fontWeight: "700", fontSize: "13px", color: "#e2e8f0" });
    container.appendChild(title);

    // ── Bảng phím tắt set-up pattern nhanh ──
    const kbCard = makeSectionCard();
    Object.assign(kbCard.style, { display: "flex", flexDirection: "column", gap: "6px" });
    const kbTitle = document.createElement("div");
    kbTitle.textContent = "⌨ Phím tắt set-up pattern (nhập ngay trên slot)";
    Object.assign(kbTitle.style, { fontWeight: "600", fontSize: "12px", color: "#60a5fa" });
    kbCard.appendChild(kbTitle);

    const kbFlow = document.createElement("div");
    kbFlow.style.fontSize = "11px";
    kbFlow.style.color = "#cbd5e1";
    kbFlow.innerHTML =
      "<b>Bật trên cửa sổ slot:</b> <code>Ctrl+Shift+B</code> (badge xanh hiện góc dưới).<br>" +
      "<b>Flow:</b> bấm phím loại step → overlay hiện trên slot → <code>S</code> chọn selector / <code>P</code> chọn điểm → gõ value → <code>Ctrl+S</code> lưu → bấm phím tiếp.";
    kbCard.appendChild(kbFlow);

    const kbRules = [
      ["C", "click"], ["I", "input"], ["R", "read"], ["K", "condition"],
      ["H", "hover"], ["U", "upload"], ["D", "download"], ["O", "open"],
      ["W", "wait"], ["E", "end"], ["X", "delete"]
    ];
    const kbGrid = document.createElement("div");
    Object.assign(kbGrid.style, { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "4px", marginTop: "2px" });
    kbRules.forEach(([k, name]) => {
      const cell = document.createElement("div");
      Object.assign(cell.style, { fontSize: "11px", color: "#e5e7eb", display: "flex", gap: "6px", alignItems: "center" });
      const kbd = document.createElement("span");
      kbd.textContent = k;
      Object.assign(kbd.style, { display: "inline-block", minWidth: "18px", textAlign: "center", padding: "1px 5px", borderRadius: "4px", background: "rgba(255,255,255,0.1)", fontWeight: "700", fontFamily: "monospace" });
      const lbl = document.createElement("span"); lbl.textContent = name; lbl.style.color = "#9ca3af";
      cell.appendChild(kbd); cell.appendChild(lbl);
      kbGrid.appendChild(cell);
    });
    kbCard.appendChild(kbGrid);

    const kbInOverlay = document.createElement("div");
    kbInOverlay.style.fontSize = "11px";
    kbInOverlay.style.color = "#94a3b8";
    kbInOverlay.style.marginTop = "4px";
    kbInOverlay.innerHTML = "Trong overlay: <code>S</code> selector · <code>P</code> point · <code>Ctrl+S</code> lưu · <code>Esc</code> hủy";
    kbCard.appendChild(kbInOverlay);

    container.appendChild(kbCard);

    // ── Clear cookies của slot hiện tại ──
    const clearCard = makeSectionCard();
    Object.assign(clearCard.style, { display: "flex", flexDirection: "column", gap: "8px" });

    const clearTitle = document.createElement("div");
    clearTitle.textContent = "🍪 Clear cookies (slot " + activeSlotId + ")";
    Object.assign(clearTitle.style, { fontWeight: "600", fontSize: "12px", color: "#fbbf24" });

    const clearDesc = document.createElement("div");
    clearDesc.style.fontSize = "11px";
    clearDesc.style.color = "#9ca3af";
    clearDesc.textContent = "Xóa toàn bộ cookies của slot hiện tại. Dùng khi bị lỗi cookie malformed từ Google.";

    const clearBtn = makeBtn("🗑 Clear all cookies (Slot " + activeSlotId + ")",
      "linear-gradient(90deg,#f97373,#ef4444)", "#fff");

    clearBtn.onclick = async () => {
      if (!hasControlAPI() || typeof window.controlAPI.clearSessionCookies !== "function") {
        setStatus("clearSessionCookies API not available", "error"); return;
      }
      clearBtn.disabled = true;
      clearBtn.textContent = "Clearing...";
      try {
        const res = await window.controlAPI.clearSessionCookies({ slotId: activeSlotId });
        if (res && res.ok) {
          setStatus("Cleared " + (res.cleared || 0) + " cookies for slot " + activeSlotId, "ok");
          clearBtn.textContent = "✓ Cleared " + (res.cleared || 0) + " cookies";
        } else {
          setStatus("Clear failed: " + (res && res.reason || "unknown"), "error");
          clearBtn.textContent = "❌ Failed";
        }
      } catch (err) {
        setStatus("Clear error: " + err.message, "error");
        clearBtn.textContent = "❌ Error";
      }
      setTimeout(() => {
        clearBtn.disabled = false;
        clearBtn.textContent = "🗑 Clear all cookies (Slot " + activeSlotId + ")";
      }, 3000);
    };

    clearCard.appendChild(clearTitle);
    clearCard.appendChild(clearDesc);
    clearCard.appendChild(clearBtn);
    container.appendChild(clearCard);

    // ── Saved sessions list ──
    const sessCard = makeSectionCard();
    Object.assign(sessCard.style, { display: "flex", flexDirection: "column", gap: "6px" });

    const sessTitle = document.createElement("div");
    sessTitle.textContent = "💾 Saved sessions";
    Object.assign(sessTitle.style, { fontWeight: "600", fontSize: "12px", color: "#38bdf8" });
    sessCard.appendChild(sessTitle);

    if (hasControlAPI() && typeof window.controlAPI.listSessions === "function") {
      try {
        const res = await window.controlAPI.listSessions();
        const sessions = (res && res.sessions) || [];
        if (!sessions.length) {
          const empty = document.createElement("div");
          empty.style.fontSize = "11px";
          empty.style.color = "#6b7280";
          empty.textContent = "No saved sessions. Use save-session step to save.";
          sessCard.appendChild(empty);
        } else {
          sessions.forEach(s => {
            const row = document.createElement("div");
            Object.assign(row.style, {
              display: "flex", alignItems: "center", gap: "6px",
              padding: "4px 6px", borderRadius: "6px",
              background: "rgba(15,23,42,0.8)", border: "1px solid #1e3a5f"
            });

            const nameEl = document.createElement("div");
            nameEl.style.flex = "1";
            nameEl.style.fontSize = "11px";
            nameEl.style.color = "#e2e8f0";
            nameEl.textContent = s.name + " (" + (s.cookieCount || 0) + " cookies)";
            nameEl.title = s.url || "";

            const dateEl = document.createElement("div");
            dateEl.style.fontSize = "10px";
            dateEl.style.color = "#6b7280";
            if (s.savedAt) {
              dateEl.textContent = new Date(s.savedAt).toLocaleDateString();
            }

            const delBtn = makeBtn("Del", "linear-gradient(90deg,#f97373,#ef4444)", "#fff");
            delBtn.style.fontSize = "10px";
            delBtn.style.padding = "2px 8px";
            delBtn.onclick = async () => {
              if (!confirm("Delete session '" + s.name + "'?")) return;
              await window.controlAPI.deleteSession({ name: s.name });
              renderSessionPanel(container);
            };

            row.appendChild(nameEl);
            row.appendChild(dateEl);
            row.appendChild(delBtn);
            sessCard.appendChild(row);
          });
        }
      } catch (err) {
        const errEl = document.createElement("div");
        errEl.style.fontSize = "11px";
        errEl.style.color = "#f87171";
        errEl.textContent = "Error loading sessions: " + err.message;
        sessCard.appendChild(errEl);
      }
    }

    container.appendChild(sessCard);
  }

  function renderNotiRulesPanel() {
    if (!sidebarEl || !sidebarEl.notiList) return;

    const list = sidebarEl.notiList;
    list.innerHTML = "";

    if (!Array.isArray(notiRules) || !notiRules.length) {
      const empty = document.createElement("div");
      empty.textContent = "No notification rules.";
      empty.style.fontSize = "12px";
      empty.style.color = "#9ca3af";
      list.appendChild(empty);
      return;
    }

    notiRules.forEach((rule, idx) => {
      const box = document.createElement("div");
      Object.assign(box.style, {
        padding: "8px",
        marginBottom: "6px",
        borderRadius: "8px",
        background: "rgba(2,6,23,0.55)",
        border: "1px solid rgba(37,99,235,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "8px"
      });

      const left = document.createElement("div");
      Object.assign(left.style, {
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        flex: "1"
      });

      const patternInput = makeSmallInput("text", rule.pattern || "", "100%");
      patternInput.style.width = "100%";
      patternInput.placeholder = "Message contains...";
      patternInput.onchange = () => {
        rule.pattern = (patternInput.value || "").trim();
        saveJsonToStorage(STORAGE_KEYS().NOTI, notiRules);
        sendAllNotiRulesToPage();
      };

      const choiceSelect = makeSelect(["ok", "cancel"], rule.choice === "cancel" ? "cancel" : "ok", "90px");
      choiceSelect.onchange = () => {
        rule.choice = choiceSelect.value === "cancel" ? "cancel" : "ok";
        saveJsonToStorage(STORAGE_KEYS().NOTI, notiRules);
        sendAllNotiRulesToPage();
      };

      const statusLine = document.createElement("div");
      statusLine.textContent = rule.enabled === false ? "Disabled" : "Enabled";
      statusLine.style.fontSize = "10px";
      statusLine.style.color = "#9ca3af";

      left.appendChild(patternInput);
      left.appendChild(choiceSelect);
      left.appendChild(statusLine);

      const right = document.createElement("div");
      Object.assign(right.style, {
        display: "flex",
        gap: "6px",
        alignItems: "center"
      });

      const enabledCheck = document.createElement("input");
      enabledCheck.type = "checkbox";
      enabledCheck.checked = rule.enabled !== false;
      enabledCheck.onchange = () => {
        rule.enabled = enabledCheck.checked;
        saveJsonToStorage(STORAGE_KEYS().NOTI, notiRules);
        renderNotiRulesPanel();
        sendAllNotiRulesToPage();
      };

      const dupBtn = makeBtn("Dup", "linear-gradient(90deg,#e5e7eb,#94a3b8)", "#020617");
      dupBtn.onclick = () => {
        const clone = deepClone(rule);
        clone.id = uid("rule");
        notiRules.splice(idx + 1, 0, clone);
        saveJsonToStorage(STORAGE_KEYS().NOTI, notiRules);
        renderNotiRulesPanel();
        sendAllNotiRulesToPage();
      };

      const delBtn = makeBtn("Del", "linear-gradient(90deg,#f97373,#ef4444)", "#fff");
      delBtn.onclick = () => {
        if (!confirm("Delete this notification rule?")) return;
        notiRules.splice(idx, 1);
        saveJsonToStorage(STORAGE_KEYS().NOTI, notiRules);
        renderNotiRulesPanel();
        sendAllNotiRulesToPage();
      };

      right.appendChild(enabledCheck);
      right.appendChild(dupBtn);
      right.appendChild(delBtn);

      box.appendChild(left);
      box.appendChild(right);
      list.appendChild(box);
    });
  }

  function sendAllNotiRulesToPage() {
    try {
      const payload = (notiRules || [])
        .filter(r => r && r.enabled !== false && r.pattern && String(r.pattern).trim())
        .map(r => ({
          pattern: String(r.pattern || "").toLowerCase(),
          choice: String(r.choice || "ok").toLowerCase() === "cancel" ? "cancel" : "ok"
        }));

      // 1. Gửi xuống web page (hook window.confirm qua preload-web isolated world)
      domExec({
        type: "setNotiRules",
        rules: payload
      });

      // 2. Sync lên main process để inject vào MAIN WORLD (bypass contextIsolation)
      //    Đây là cách duy nhất override window.confirm thật của trang
      if (hasControlAPI() && typeof window.controlAPI.syncNotiRules === "function") {
        window.controlAPI.syncNotiRules(activeSlotId, payload).catch(err => {
          console.warn("[DetectLab] syncNotiRules error:", err);
        });
      }

      console.log("[DetectLab] sendAllNotiRulesToPage: payload=", payload.length, "rules, slotId=", activeSlotId);
    } catch (err) {
      console.warn("[DetectLab] sendAllNotiRulesToPage error:", err);
    }
  }

  // ───────────────────────────────────────────────────────────
  // Noti 2-way: resolve, mode, render
  // ───────────────────────────────────────────────────────────

  /**
   * Gửi quyết định về web slot đang chờ.
   * decision: "ok" | "cancel" | "ignore" | "always-ok" | "always-cancel"
   */
  function resolvePendingNotiFull(slotId, requestId, decision) {
    const st = slotStates[slotId];
    if (!st) return;

    // Tìm pending item trước khi xóa (cần dialogText cho always-*)
    const pendingItem = (st.pendingNotiRequests || []).find(r => r.requestId === requestId);

    // Xóa khỏi danh sách ngay để UI update nhanh
    st.pendingNotiRequests = (st.pendingNotiRequests || []).filter(r => r.requestId !== requestId);
    renderPendingNotiPanel();
    highlightNotiTab();

    if (decision === "always-ok" || decision === "always-cancel") {
      const realDecision = decision === "always-ok" ? "ok" : "cancel";
      const patternText = (pendingItem && pendingItem.dialogText)
        ? pendingItem.dialogText.slice(0, 60).trim()
        : "";

      if (patternText) {
        // Tạo rule mới và sync xuống web
        notiRules.push({
          id: uid("rule"),
          pattern: patternText,
          choice: realDecision,
          enabled: true
        });
        saveJsonToStorage(STORAGE_KEYS().NOTI, notiRules);
        renderNotiRulesPanel();
        sendAllNotiRulesToPage();
        setLog(`[Noti] Always ${realDecision}: added rule "${patternText}"`);
      }

      domExec({ type: "noti:resolve", requestId, decision: realDecision }, slotId);
      return;
    }

    // ok / cancel / ignore — gửi thẳng
    domExec({ type: "noti:resolve", requestId, decision }, slotId);
  }

  /** Set notiMode cho slot, sync xuống web */
  function setNotiMode(slotId, mode) {
    const st = slotStates[slotId];
    if (!st) return;
    st.notiMode = mode;
    domExec({ type: "setNotiMode", mode }, slotId);
    setLog(`[Slot ${slotId}] Noti mode: ${mode}`);
  }

  /** Render khu vực pending notifications trong tab Noti */
  function renderPendingNotiPanel() {
    const container = document.getElementById("dl-pending-noti-container");
    if (!container) return;

    // Gom pending từ tất cả slot
    const allPending = [];
    for (let sid = 1; sid <= 3; sid++) {
      const st = slotStates[sid];
      if (st && Array.isArray(st.pendingNotiRequests)) {
        st.pendingNotiRequests.forEach(p => allPending.push({ ...p, slotId: sid }));
      }
    }

    container.innerHTML = "";

    if (!allPending.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:11px;color:#9ca3af;padding:4px 0";
      empty.textContent = "No pending notifications";
      container.appendChild(empty);
      return;
    }

    allPending.forEach(item => {
      const card = document.createElement("div");
      card.style.cssText = [
        "padding:8px",
        "margin-bottom:6px",
        "border-radius:8px",
        "background:rgba(234,179,8,0.08)",
        "border:1px solid rgba(234,179,8,0.4)"
      ].join(";");

      // Header
      const header = document.createElement("div");
      header.style.cssText = "display:flex;align-items:center;gap:6px;margin-bottom:4px";

      const slotBadge = document.createElement("span");
      slotBadge.style.cssText = "background:#1d4ed8;color:#fff;font-size:10px;padding:1px 6px;border-radius:999px;font-weight:700";
      slotBadge.textContent = "Slot " + item.slotId;

      const timeEl = document.createElement("span");
      timeEl.style.cssText = "font-size:10px;color:#9ca3af";
      const ago = Math.round((Date.now() - item.ts) / 1000);
      timeEl.textContent = ago + "s ago";

      header.appendChild(slotBadge);
      header.appendChild(timeEl);

      if (item.matchedRule) {
        const ruleBadge = document.createElement("span");
        ruleBadge.style.cssText = "font-size:10px;color:#22c55e;margin-left:auto";
        ruleBadge.textContent = 'Rule: "' + item.matchedRule.pattern + '"';
        header.appendChild(ruleBadge);
      }

      // Dialog text preview
      const textEl = document.createElement("div");
      textEl.style.cssText = "font-size:11px;color:#e2e8f0;margin-bottom:6px;word-break:break-word";
      const preview = (item.dialogText || "");
      textEl.textContent = preview.length > 120 ? preview.slice(0, 120) + "…" : preview;

      // Action buttons
      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex;gap:5px;flex-wrap:wrap";

      const makeActionBtn = (label, bg, color, decision) => {
        const btn = makeBtn(label, bg, color);
        btn.style.fontSize = "11px";
        btn.style.padding = "3px 10px";
        btn.onclick = () => resolvePendingNotiFull(item.slotId, item.requestId, decision);
        return btn;
      };

      btnRow.appendChild(makeActionBtn("OK", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16", "ok"));
      btnRow.appendChild(makeActionBtn("Cancel", "linear-gradient(90deg,#f97373,#ef4444)", "#fff", "cancel"));
      btnRow.appendChild(makeActionBtn("Ignore", "linear-gradient(90deg,#6b7280,#4b5563)", "#fff", "ignore"));
      btnRow.appendChild(makeActionBtn("Always OK", "linear-gradient(90deg,#22c55e,#16a34a)", "#052e16", "always-ok"));
      btnRow.appendChild(makeActionBtn("Always Cancel", "linear-gradient(90deg,#f97373,#ef4444)", "#fff", "always-cancel"));

      card.appendChild(header);
      card.appendChild(textEl);
      card.appendChild(btnRow);
      container.appendChild(card);
    });
  }

  /** Badge số pending trên tab Noti */
  function highlightNotiTab() {
    const tabNoti = document.querySelector("[data-tab='noti']");
    if (!tabNoti) return;

    const total = Object.values(slotStates)
      .reduce((sum, st) => sum + (st.pendingNotiRequests ? st.pendingNotiRequests.length : 0), 0);

    const old = tabNoti.querySelector(".dl-noti-badge");
    if (old) old.remove();

    if (total > 0) {
      const badge = document.createElement("span");
      badge.className = "dl-noti-badge";
      badge.style.cssText = [
        "display:inline-block",
        "margin-left:4px",
        "background:#ef4444",
        "color:#fff",
        "font-size:9px",
        "font-weight:700",
        "padding:0 5px",
        "border-radius:999px",
        "line-height:16px",
        "vertical-align:middle"
      ].join(";");
      badge.textContent = String(total);
      tabNoti.appendChild(badge);
    }
  }

  function downloadNotiRules() {
    try {
      console.log("[DetectLab] downloadNotiRules: start", {
        count: Array.isArray(notiRules) ? notiRules.length : 0
      });

      const exportObj = { version: 1, rules: notiRules || [] };
      const json = JSON.stringify(exportObj, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);

      console.log("[DetectLab] downloadNotiRules: blob/url created", {
        size: json.length,
        urlPreview: typeof url === "string" ? url.slice(0, 64) + "..." : String(url)
      });

      const a = document.createElement("a");
      a.href = url;
      a.download = "detectlab_notirules.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      console.log("[DetectLab] downloadNotiRules: click dispatched & URL revoked");
    } catch (err) {
      console.warn("[DetectLab] downloadNotiRules error:", err);
      alert("Download notification rules failed.");
    }
  }
    function uploadNotiRulesFromFile() {
      try {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json,application/json";
        input.style.display = "none";

        input.onchange = e => {
          const file = e.target.files && e.target.files[0];
          if (!file) {
            input.remove();
            return;
          }

          const reader = new FileReader();
          reader.onload = ev => {
            try {
              const text = ev.target.result || "";
              const data = JSON.parse(text);

              if (!data || typeof data !== "object" || !Array.isArray(data.rules)) {
                alert("Invalid notification rules file format.");
                input.remove();
                return;
              }

              notiRules = data.rules.map(r => ({
                id: r.id || uid("rule"),
                pattern: (r.pattern || "").trim(),
                choice: (r.choice || "").toLowerCase() === "cancel" ? "cancel" : "ok",
                enabled: r.enabled !== false
              }));

              saveJsonToStorage(STORAGE_KEYS().NOTI, notiRules);
              renderNotiRulesPanel();
              sendAllNotiRulesToPage();
              alert("Imported " + notiRules.length + " notification rules.");
            } catch (err) {
              console.warn("[DetectLab] uploadNotiRulesFromFile parse error:", err);
              alert("Cannot read notification rules file.");
            } finally {
              input.remove();
            }
          };
          reader.readAsText(file);
        };

        document.body.appendChild(input);
        input.click();
      } catch (err) {
        console.warn("[DetectLab] uploadNotiRulesFromFile error:", err);
        alert("Upload notification rules failed.");
      }
    }



})();
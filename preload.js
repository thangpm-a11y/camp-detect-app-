const { contextBridge, ipcRenderer } = require("electron");

console.log("XXX_PRELOAD_CONTROL_LOADED");

function safeInvoke(channel, payload) {
  try {
    return ipcRenderer.invoke(channel, payload);
  } catch (err) {
    console.warn("[PRELOAD] invoke error:", channel, err);
    return Promise.resolve({
      ok: false,
      reason: err && err.message ? err.message : "invoke error"
    });
  }
}

function safeOn(channel, handler) {
  if (typeof handler !== "function") {
    console.warn("[PRELOAD] safeOn ignored: handler is not a function for", channel);
    return () => {};
  }

  const wrapped = (_event, data) => {
    try {
      handler(data);
    } catch (err) {
      console.warn("[PRELOAD] listener error on", channel, err);
    }
  };

  ipcRenderer.on(channel, wrapped);

  return () => {
    try {
      ipcRenderer.removeListener(channel, wrapped);
    } catch (err) {
      console.warn("[PRELOAD] removeListener error on", channel, err);
    }
  };
}

contextBridge.exposeInMainWorld("controlAPI", {
// backward compat: payload có thể là string hoặc { url, slotId }
loadUrl: payload => safeInvoke("web:load-url", payload),
execOnWeb: payload => safeInvoke("web:exec", payload || {}),
cdpClick: payload => safeInvoke("web:cdp-click", payload || {}),
popupPickPoint: payload => safeInvoke("popup:pick-point", payload || {}),
popupPickSelector: payload => safeInvoke("popup:pick-selector", payload || {}),

// Session (cookie) management
saveSession: payload => safeInvoke("session:save", payload || {}),
loadSession: payload => safeInvoke("session:load", payload || {}),
listSessions: () => safeInvoke("session:list", {}),
deleteSession: payload => safeInvoke("session:delete", payload || {}),
clearSessionCookies: payload => safeInvoke("session:clear-cookies", payload || {}),
onWebResult: handler => safeOn("web:result", handler),

// Slot management
openSlot: slotId => safeInvoke("slot:open", { slotId }),
closeSlot: slotId => safeInvoke("slot:close", { slotId }),
listSlots: () => safeInvoke("slot:list", {}),
resizeSlot: (slotId, width, height) => safeInvoke("slot:resize", { slotId, width, height }),
setSlotVisible: (slotId, visible) => safeInvoke("slot:set-visible", { slotId, visible }),

on(channel, handler) {
return safeOn(channel, handler);
},
invoke(channel, payload) {
return safeInvoke(channel, payload);
},

// ── Noti 2-way helpers ──
// Gửi quyết định cho dialog đang chờ trên một slot
resolveNoti: (slotId, requestId, decision) =>
safeInvoke("web:exec", { type: "noti:resolve", slotId, requestId, decision }),

// Đổi mode xử lý noti của một slot
setNotiMode: (slotId, mode) =>
safeInvoke("web:exec", { type: "setNotiMode", slotId, mode }),

// Sync noti rules xuống main process để intercept window.confirm native dialog
syncNotiRules: (slotId, rules) =>
safeInvoke("noti:sync-rules", { slotId, rules }),

// ── Media download from sheet ──
// payload: { slotId, items: [{ id, fileName, url, rowId }] }
downloadMediaFromSheet: payload =>
safeInvoke("media:download-from-sheet", payload || {}),

  // Lấy index media hiện tại từ main để render tab Image
  getMediaIndex: () =>
    safeInvoke("media:get-index", {}),
  // Xóa media: { ids: [...] } để xóa chọn lọc, hoặc bỏ ids để xóa tất cả
  deleteMedia: payload =>
    safeInvoke("media:delete", payload || {}),
  pickFiles: payload =>
    safeInvoke("dialog:pick-files", payload || {}),

  // ── Preview / always-on-top ──
  setControlAlwaysOnTop: flag =>
    safeInvoke("control:set-always-on-top", { flag: !!flag }),
  focusControl: () =>
    safeInvoke("control:focus", {}),
  openPreviewWindow: () =>
    safeInvoke("preview:open-window", {}),
  closePreviewWindow: () =>
    safeInvoke("preview:close-window", {}),
  minimizePreviewWindow: () =>
    safeInvoke("preview:minimize-window", {}),
  setPreviewAboveTaskbar: flag =>
    safeInvoke("preview:set-above-taskbar", { flag: !!flag }),
  previewAction: payload =>
    safeInvoke("preview:action", payload || {}),
  pushPreviewStates: payload =>
    safeInvoke("preview:push-states", payload || {})
});

// ========= Detect Lab ⇄ Google Sheet =========

async function detectLabFetchSheetRows(config) {
  const res = await ipcRenderer.invoke("detectlab:fetch-sheet-rows", config);
  if (!res || !res.ok || !Array.isArray(res.rawRows) || !res.rawRows.length) {
    return null;
  }
  return res.rawRows;
}

contextBridge.exposeInMainWorld("sheetBridge", {
  async fetchAndInject(cfg) {
    try {
      const baseUrl = String(cfg.baseUrl || "").trim();
      const sheetId = String(cfg.sheetId || "").trim();
      const sheetName = String(cfg.sheetName || "").trim();

      if (!baseUrl || !sheetId || !sheetName) {
        console.warn("[DetectLabBridge] missing sheet config", cfg);
        return { ok: false, reason: "missing sheet config" };
      }

      let startRow = parseInt(String(cfg.startRow ?? "2").trim(), 10);
      let endRow   = parseInt(String(cfg.endRow ?? "0").trim(), 10);

      if (!Number.isFinite(startRow) || startRow < 2) startRow = 2;
      if (!Number.isFinite(endRow) || endRow < startRow) endRow = 0; // 0 = auto

      const maxRows =
        endRow && endRow >= startRow
          ? (endRow - startRow + 1)
          : 500;

      const rawRows = await detectLabFetchSheetRows({
        baseUrl,
        sheetId,
        sheetName,
        startRow,
        maxRows
      });

      if (!Array.isArray(rawRows) || !rawRows.length) {
        console.warn("[DetectLabBridge] Sheet API returned no rows");
        return { ok: false, reason: "no rows" };
      }
        window.DetectLabSheetStartRow = startRow;
      // Gửi rawRows cho DetectLab theo event DetectLabRawRows
      window.postMessage(
        {
          type: "DetectLabRawRows",
          rawRows,
          startRow,  
          endRow
        },
        "*"
      );

      console.log("[DetectLabBridge] DetectLabRawRows posted", {
        startRow,
        endRow,
        count: rawRows.length
      });

      return {
        ok: true,
        count: rawRows.length,
        startRow,
        endRow: endRow || (startRow + rawRows.length - 1)
      };
    } catch (err) {
      console.warn("[DetectLabBridge] fetchAndInject error", err);
      return {
        ok: false,
        reason: err && err.message ? err.message : "fetchAndInject error"
      };
    }
  }
});
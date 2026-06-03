// control-3.js – Camping Detect Control (Electron)
// Điều khiển webview + cầu nối nhẹ với DetectLab panel trong #detectlab-root

(function () {
  "use strict";

  function hasControlAPI() {
    return !!(window && window.controlAPI);
  }

  function setStatus(text) {
    const statusEl = document.getElementById("status");
    if (!statusEl) return;
    statusEl.textContent = text || "";
  }

  function safeExecOnWeb(payload) {
    if (!hasControlAPI() || typeof window.controlAPI.execOnWeb !== "function") {
      console.warn("[Control] controlAPI.execOnWeb not available", payload);
      setStatus("Bridge not ready");
      return null;
    }
    try {
      return window.controlAPI.execOnWeb(payload);
    } catch (err) {
      console.warn("[Control] execOnWeb error:", err, payload);
      setStatus("execOnWeb error");
      return null;
    }
  }

  function safeLoadUrl(url) {
    if (!hasControlAPI() || typeof window.controlAPI.loadUrl !== "function") {
      console.warn("[Control] controlAPI.loadUrl not available");
      setStatus("Bridge not ready");
      return;
    }
    try {
      window.controlAPI.loadUrl(url);
    } catch (err) {
      console.warn("[Control] loadUrl error:", err);
      setStatus("loadUrl error");
    }
  }

  async function safeFetchUrl(url) {
    if (!hasControlAPI() || typeof window.controlAPI.fetchUrl !== "function") {
      console.warn("[Control] controlAPI.fetchUrl not available – main must implement fetchUrl(url) → Promise<{ok, status, body}>", url);
      return { ok: false, error: "fetchUrl not available" };
    }
    try {
      const res = await window.controlAPI.fetchUrl(url);
      console.log("[Control] fetchUrl response", res);
      return res;
    } catch (err) {
      console.warn("[Control] fetchUrl error:", err, url);
      return { ok: false, error: String(err) };
    }
  }

  // ===== DetectLab control wrapper (để gọi từ DevTools hoặc bind thêm nút) =====

  const detectLabControl = {
    ping() {
      // cho web biết control window đang sống
      safeExecOnWeb({ type: "detectlab_ping" });
    },
    openPanel() {
      // hiện DetectLab panel trong control window nếu mã trong detectlab_app-2.js hỗ trợ
      try {
        const root = document.getElementById("detectlab-root");
        if (!root) return;
        // detectlab_app-2.js đã tự init khi DOMContentLoaded, nên ở đây chỉ cần ping
        this.ping();
        setStatus("DetectLab ready");
      } catch (err) {
        console.warn("[Control] openPanel error:", err);
      }
    },
    start() {
      // forward lệnh start xuống webview (nếu bạn xử lý trong preload / content)
      safeExecOnWeb({ type: "detectlab_start" });
      setStatus("Sent: detectlab_start");
    },
    pause() {
      safeExecOnWeb({ type: "detectlab_pause" });
      setStatus("Sent: detectlab_pause");
    },
    resume() {
      safeExecOnWeb({ type: "detectlab_resume" });
      setStatus("Sent: detectlab_resume");
    }
  };

  window.detectLabControl = detectLabControl;

  // ===== Main UI wiring =====

window.addEventListener("DOMContentLoaded", () => {
  const statusEl = document.getElementById("status");

  const apiKeyInput = document.getElementById("gs-api-key");
  const sheetIdInput = document.getElementById("gs-sheet-id");
  const urlBaseInput = document.getElementById("gs-url-base");
  const urlReturnInput = document.getElementById("gs-url-return");
  const sheetTabInput = document.getElementById("gs-sheet-tab");
  const btnSaveGsConfig = document.getElementById("btn-save-gs-config");

  if (!statusEl) {
    console.warn("[Control] Missing status element in HTML");
    return;
  }

  // ----- Load existing config -----
  try {
    const raw = window.localStorage.getItem("detectlabSheetConfig");
    if (raw) {
      const cfg = JSON.parse(raw);
      if (apiKeyInput && cfg.apiKey) apiKeyInput.value = cfg.apiKey;
      if (sheetIdInput && cfg.sheetId) sheetIdInput.value = cfg.sheetId;
      if (urlBaseInput && cfg.urlBase) urlBaseInput.value = cfg.urlBase;
      if (urlReturnInput && cfg.urlReturn) urlReturnInput.value = cfg.urlReturn;
      if (sheetTabInput && cfg.sheetTab) sheetTabInput.value = cfg.sheetTab;
    }
  } catch (err) {
    console.warn("[Control] load detectlabSheetConfig error:", err);
  }

  // ----- Save config -----
  if (btnSaveGsConfig) {
    btnSaveGsConfig.onclick = () => {
      const cfg = {
        apiKey: (apiKeyInput && apiKeyInput.value) || "",
        sheetId: (sheetIdInput && sheetIdInput.value) || "",
        urlBase: (urlBaseInput && urlBaseInput.value) || "",
        urlReturn: (urlReturnInput && urlReturnInput.value) || "",
        sheetTab: (sheetTabInput && sheetTabInput.value) || ""
      };
      try {
        window.localStorage.setItem("detectlabSheetConfig", JSON.stringify(cfg));
        setStatus("Saved Google Sheet config");
      } catch (err) {
        console.warn("[Control] save detectlabSheetConfig error:", err);
        setStatus("Save config failed");
      }
    };
  }

  // ----- Listen result from webview -----
  if (hasControlAPI() && typeof window.controlAPI.onWebResult === "function") {
    window.controlAPI.onWebResult(async data => {
      try {
        if (!data || !statusEl) return;

        if (data.type === "getText") {
          statusEl.textContent = `getText result: "${data.text || ""}"`;
          return;
        }

        if (data.type === "detectlab_status") {
          statusEl.textContent = String(data.message || "DetectLab status");
          return;
        }

        if (data.type === "detectlab_log") {
          statusEl.textContent = String(data.message || "DetectLab log");
          return;
        }

        // DetectLab yêu cầu bridge gọi Apps Script RETURN URL
        if (data.type === "detectlab_return_to_sheet" && data.url) {
          setStatus("Returning to sheet...");
          console.log("[Control] detectlab_return_to_sheet → fetchUrl", data.url, data.payload || {});
          const res = await safeFetchUrl(data.url);
          if (res && res.ok) {
            setStatus("Return OK (" + (res.status || "") + ")");
          } else {
            setStatus("Return error");
            console.warn("[Control] RETURN fetch failed", res);
          }
          return;
        }
      } catch (err) {
        console.warn("[Control] onWebResult handler error:", err, data);
      }
    });
  }

  // init status
  if (hasControlAPI()) {
    setStatus("Ready – bridge OK");
  } else {
    setStatus("Bridge not ready");
  }

  // ping DetectLab khi control vừa load
  detectLabControl.openPanel();
});
})();
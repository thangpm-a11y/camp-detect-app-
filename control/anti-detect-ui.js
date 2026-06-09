/**
 * anti-detect-ui.js
 * Widget độc lập trong control panel cho:
 *   - Harvest cookie từ Chrome thật riêng của slot → cookie pool
 *   - Xem trạng thái pool (clean / used / burned) theo domain
 *   - Bật/tắt captcha auto-reset + auto-harvest khi pool cạn
 *   - Reset identity thủ công cho từng slot
 *
 * Hoàn toàn tự chứa, chỉ phụ thuộc window.controlAPI (preload.js).
 */
(function () {
  "use strict";
  const api = window.controlAPI;
  if (!api || typeof api.poolStatus !== "function") {
    console.warn("[anti-detect-ui] controlAPI chưa sẵn sàng — bỏ qua widget");
    return;
  }

  // ── Styles ────────────────────────────────────────────────────────────
  const css = `
  #adx-panel{position:fixed;right:12px;bottom:12px;width:340px;z-index:999999;
    font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#e5e7eb;
    background:rgba(15,23,42,.97);border:1px solid rgba(255,255,255,.12);
    border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.5);overflow:hidden}
  #adx-head{display:flex;align-items:center;justify-content:space-between;
    padding:8px 10px;background:rgba(255,255,255,.05);cursor:pointer;user-select:none}
  #adx-head b{font-size:12px;letter-spacing:.3px}
  #adx-body{padding:10px;max-height:60vh;overflow:auto}
  #adx-panel.collapsed #adx-body{display:none}
  .adx-row{display:flex;gap:6px;align-items:center;margin:6px 0;flex-wrap:wrap}
  .adx-row input[type=text]{flex:1;min-width:120px;background:#0b1220;color:#e5e7eb;
    border:1px solid rgba(255,255,255,.15);border-radius:6px;padding:5px 7px;font-size:12px}
  .adx-btn{background:#1d4ed8;color:#fff;border:0;border-radius:6px;padding:5px 9px;
    cursor:pointer;font-size:12px}
  .adx-btn.sec{background:#334155}
  .adx-btn.warn{background:#b45309}
  .adx-btn:disabled{opacity:.5;cursor:default}
  .adx-tag{display:inline-block;padding:1px 6px;border-radius:5px;font-size:11px}
  .adx-clean{background:#065f46}.adx-used{background:#854d0e}.adx-burned{background:#7f1d1d}
  .adx-sec{border-top:1px solid rgba(255,255,255,.08);margin-top:8px;padding-top:8px}
  .adx-muted{color:#94a3b8}
  #adx-log{font-family:ui-monospace,monospace;font-size:11px;color:#cbd5e1;
    max-height:90px;overflow:auto;background:#0b1220;border-radius:6px;padding:6px;margin-top:6px}
  .adx-sw{position:relative;display:inline-block;width:34px;height:18px}
  .adx-sw input{display:none}
  .adx-sl{position:absolute;inset:0;background:#475569;border-radius:18px;transition:.2s}
  .adx-sl:before{content:"";position:absolute;width:14px;height:14px;left:2px;top:2px;
    background:#fff;border-radius:50%;transition:.2s}
  .adx-sw input:checked+.adx-sl{background:#2563eb}
  .adx-sw input:checked+.adx-sl:before{transform:translateX(16px)}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  // ── Markup ────────────────────────────────────────────────────────────
  const panel = document.createElement("div");
  panel.id = "adx-panel";
  panel.innerHTML = `
    <div id="adx-head"><b>🛡️ Anti-detect / Cookie Pool</b><span id="adx-toggle">▾</span></div>
    <div id="adx-body">
      <div class="adx-row">
        <label class="adx-sw"><input type="checkbox" id="adx-enabled" checked><span class="adx-sl"></span></label>
        <span>Captcha auto-reset</span>
      </div>
      <div class="adx-row">
        <label class="adx-sw"><input type="checkbox" id="adx-harvest-empty" checked><span class="adx-sl"></span></label>
        <span>Auto-harvest khi pool cạn</span>
      </div>

      <div class="adx-sec">
        <div class="adx-muted">Proxy / IP riêng mỗi slot (chống abuse)</div>
        <div class="adx-row">
          <input type="text" id="adx-px-slot" placeholder="slot" style="max-width:55px" value="1">
          <input type="text" id="adx-px" placeholder="scheme://user:pass@host:port">
        </div>
        <div class="adx-row">
          <button class="adx-btn" id="adx-px-set">Đặt proxy slot</button>
          <button class="adx-btn sec" id="adx-px-test">Test IP</button>
          <button class="adx-btn sec" id="adx-px-clear">Direct</button>
        </div>
        <div class="adx-row">
          <label class="adx-sw"><input type="checkbox" id="adx-rotate" checked><span class="adx-sl"></span></label>
          <span>Xoay IP từ pool khi reset</span>
        </div>
        <textarea id="adx-px-pool" placeholder="Mỗi dòng 1 proxy (pool xoay vòng khi captcha)" style="width:100%;height:54px;background:#0b1220;color:#e5e7eb;border:1px solid rgba(255,255,255,.15);border-radius:6px;font-size:11px;padding:5px"></textarea>
        <div class="adx-row"><button class="adx-btn sec" id="adx-px-pool-save">Lưu pool</button>
          <span id="adx-px-cur" class="adx-muted" style="font-size:11px"></span></div>
      </div>

      <div class="adx-sec">
        <div class="adx-muted">Harvest cookie từ Chrome thật</div>
        <div class="adx-row">
          <input type="text" id="adx-url" placeholder="https://site-can-login.com">
        </div>
        <div class="adx-row">
          <input type="text" id="adx-slot" placeholder="slot (1-3)" style="max-width:70px" value="1">
          <button class="adx-btn sec" id="adx-open">Mở Chrome</button>
          <button class="adx-btn" id="adx-harvest">Harvest → pool</button>
        </div>
        <div class="adx-muted" style="font-size:11px">Mở Chrome → đăng nhập/giải captcha tay → bấm Harvest để lưu identity sạch.</div>
      </div>

      <div class="adx-sec">
        <div class="adx-row" style="justify-content:space-between">
          <span class="adx-muted">Pool theo domain</span>
          <button class="adx-btn sec" id="adx-refresh">↻ Refresh</button>
        </div>
        <div id="adx-pool"><span class="adx-muted">—</span></div>
      </div>

      <div class="adx-sec">
        <div class="adx-muted">Reset identity thủ công</div>
        <div class="adx-row" id="adx-reset-row"></div>
      </div>

      <div class="adx-sec">
        <div class="adx-muted">Pattern captcha tuỳ chỉnh (giảm/thêm phát hiện)</div>
        <textarea id="adx-cap-url" placeholder="URL patterns (mỗi dòng 1) — vd: /challenge, /verify" style="width:100%;height:38px;background:#0b1220;color:#e5e7eb;border:1px solid rgba(255,255,255,.15);border-radius:6px;font-size:11px;padding:5px;margin-bottom:4px"></textarea>
        <textarea id="adx-cap-text" placeholder="Text patterns (mỗi dòng 1) — vd: vui lòng xác minh" style="width:100%;height:38px;background:#0b1220;color:#e5e7eb;border:1px solid rgba(255,255,255,.15);border-radius:6px;font-size:11px;padding:5px"></textarea>
        <div class="adx-row"><button class="adx-btn sec" id="adx-cap-save">Lưu pattern</button></div>
      </div>

      <div id="adx-log"></div>
    </div>`;
  document.body.appendChild(panel);

  // ── Helpers ───────────────────────────────────────────────────────────
  const $ = (id) => panel.querySelector(id);
  function logLine(msg, cls) {
    const el = $("#adx-log");
    const line = document.createElement("div");
    line.textContent = msg;
    if (cls) line.style.color = cls;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    while (el.childNodes.length > 60) el.removeChild(el.firstChild);
  }

  // collapse
  $("#adx-head").addEventListener("click", () => {
    panel.classList.toggle("collapsed");
    $("#adx-toggle").textContent = panel.classList.contains("collapsed") ? "▸" : "▾";
  });

  // reset buttons cho slot 1-3
  const resetRow = $("#adx-reset-row");
  [1, 2, 3].forEach((sid) => {
    const b = document.createElement("button");
    b.className = "adx-btn warn";
    b.textContent = "Slot " + sid;
    b.addEventListener("click", async () => {
      b.disabled = true;
      logLine(`↻ reset identity slot ${sid}...`);
      try {
        const r = await api.resetSlotIdentity({ slotId: sid, reason: "manual" });
        logLine(r && r.ok ? `✓ slot ${sid}: identity=${r.identityId || "fresh"}` : `✗ slot ${sid}: ${r && r.reason}`);
      } catch (e) { logLine("✗ " + e.message); }
      b.disabled = false;
      refreshPool();
    });
    resetRow.appendChild(b);
  });

  // ── Pool render ───────────────────────────────────────────────────────
  async function refreshPool() {
    try {
      const r = await api.poolStatus({});
      const box = $("#adx-pool");
      const list = (r && r.status) ? (Array.isArray(r.status) ? r.status : [r.status]) : [];
      if (!list.length) { box.innerHTML = '<span class="adx-muted">chưa có pool</span>'; }
      else {
        box.innerHTML = list.map((s) =>
          `<div class="adx-row" style="justify-content:space-between">
             <span title="${s.domain}">${s.domain}</span>
             <span>
               <span class="adx-tag adx-clean">${s.clean || 0} clean</span>
               <span class="adx-tag adx-used">${s.used || 0} used</span>
               <span class="adx-tag adx-burned">${s.burned || 0} burn</span>
             </span>
           </div>`).join("");
      }
      if (r && r.chromePath === null) {
        logLine("⚠ Không tìm thấy Chrome — set env CHROME_PATH", "#fca5a5");
      }
    } catch (e) { logLine("✗ pool: " + e.message); }
  }

  // ── Actions ───────────────────────────────────────────────────────────
  $("#adx-open").addEventListener("click", async () => {
    const url = $("#adx-url").value.trim();
    const slotId = Number($("#adx-slot").value) || 1;
    logLine(`mở Chrome riêng slot ${slotId}...`);
    try {
      const r = await api.chromeOpen({ slotId, url: url || undefined });
      logLine(r && r.ok ? `✓ Chrome slot ${slotId} (port ${r.port})` : `✗ ${r && r.reason}`);
    } catch (e) { logLine("✗ " + e.message); }
  });

  $("#adx-harvest").addEventListener("click", async () => {
    const url = $("#adx-url").value.trim();
    const slotId = Number($("#adx-slot").value) || 1;
    // URL trống vẫn harvest được — sẽ tự lấy từ tab Chrome đang mở
    const btn = $("#adx-harvest");
    btn.disabled = true; btn.textContent = "Đang harvest...";
    if (!url) logLine("URL trống → lấy cookie từ tab Chrome đang mở của slot " + slotId);
    try {
      const r = await api.chromeHarvest({ url: url || undefined, slotId });
      logLine(r && r.ok
        ? `✓ harvest ${r.cookieCount} cookie @ ${r.domain} (id ${r.identityId})`
        : `✗ harvest: ${r && r.reason}`);
    } catch (e) { logLine("✗ " + e.message); }
    btn.disabled = false; btn.textContent = "Harvest → pool";
    refreshPool();
  });

  $("#adx-refresh").addEventListener("click", refreshPool);

  function pushConfig() {
    api.captchaConfig({
      enabled: $("#adx-enabled").checked,
      autoReset: $("#adx-enabled").checked,
      autoHarvestOnEmpty: $("#adx-harvest-empty").checked,
    }).then((r) => logLine("cfg: captcha=" + ($("#adx-enabled").checked ? "ON" : "OFF")));
  }
  $("#adx-enabled").addEventListener("change", pushConfig);
  $("#adx-harvest-empty").addEventListener("change", pushConfig);

  // ── Proxy actions ─────────────────────────────────────────────────────
  async function refreshProxy() {
    try {
      const r = await api.proxyGet();
      if (!r || !r.ok) return;
      $("#adx-rotate").checked = r.rotateOnReset !== false;
      if (Array.isArray(r.pool)) $("#adx-px-pool").value = (window.__adxPoolRaw || r.pool).join("\n");
      const cur = Object.keys(r.slots || {}).map((k) => `slot${k}:${r.slots[k]}`).join("  ");
      $("#adx-px-cur").textContent = cur || "tất cả: direct";
    } catch (_) {}
  }

  $("#adx-px-set").addEventListener("click", async () => {
    const slotId = Number($("#adx-px-slot").value) || 1;
    const proxy = $("#adx-px").value.trim();
    logLine(`đặt proxy slot ${slotId}...`);
    try {
      const r = await api.proxySet({ slotId, proxy, reload: true });
      logLine(r && r.ok ? `✓ slot ${slotId} proxy=${r.proxy || "direct"}` : `✗ ${r && r.reason}`);
    } catch (e) { logLine("✗ " + e.message); }
    refreshProxy();
  });

  $("#adx-px-clear").addEventListener("click", async () => {
    const slotId = Number($("#adx-px-slot").value) || 1;
    try {
      const r = await api.proxySet({ slotId, proxy: "", reload: true });
      logLine(r && r.ok ? `✓ slot ${slotId} → direct` : `✗ ${r && r.reason}`);
    } catch (e) { logLine("✗ " + e.message); }
    refreshProxy();
  });

  $("#adx-px-test").addEventListener("click", async () => {
    const proxy = $("#adx-px").value.trim();
    if (!proxy) { logLine("✗ nhập proxy trước"); return; }
    const btn = $("#adx-px-test"); btn.disabled = true; btn.textContent = "...";
    try {
      const r = await api.proxyTest({ proxy });
      logLine(r && r.ok ? `✓ IP qua proxy: ${r.body}` : `✗ test: ${r && r.reason}`, r && r.ok ? "#86efac" : "#fca5a5");
    } catch (e) { logLine("✗ " + e.message); }
    btn.disabled = false; btn.textContent = "Test IP";
  });

  $("#adx-px-pool-save").addEventListener("click", async () => {
    const pool = $("#adx-px-pool").value.split("\n").map((s) => s.trim()).filter(Boolean);
    window.__adxPoolRaw = pool;
    try {
      const r = await api.proxySetPool({ pool, rotateOnReset: $("#adx-rotate").checked });
      logLine(r && r.ok ? `✓ pool ${r.count} proxy, rotate=${r.rotateOnReset}` : `✗ ${r && r.reason}`);
    } catch (e) { logLine("✗ " + e.message); }
  });
  $("#adx-rotate").addEventListener("change", () => {
    const pool = $("#adx-px-pool").value.split("\n").map((s) => s.trim()).filter(Boolean);
    api.proxySetPool({ pool, rotateOnReset: $("#adx-rotate").checked });
  });

  // ── Captcha pattern editor ────────────────────────────────────────────
  $("#adx-cap-save").addEventListener("click", async () => {
    const urlPatterns = $("#adx-cap-url").value.split("\n").map((s) => s.trim()).filter(Boolean);
    const textPatterns = $("#adx-cap-text").value.split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean);
    try {
      const r = await api.captchaConfig({ urlPatterns, textPatterns });
      logLine(r && r.ok ? `✓ lưu pattern: ${urlPatterns.length} url, ${textPatterns.length} text` : `✗ ${r && r.reason}`);
    } catch (e) { logLine("✗ " + e.message); }
  });

  // ── Events từ main ────────────────────────────────────────────────────
  if (api.onCaptcha) api.onCaptcha((d) => logLine(`⚠ CAPTCHA slot ${d.slotId}: ${d.signal}`, "#fbbf24"));
  if (api.onResetStart) api.onResetStart((d) => logLine(`↻ reset slot ${d.slotId} (${d.reason})...`));
  if (api.onResetDone) api.onResetDone((d) => {
    logLine(`✓ slot ${d.slotId} ← ${d.identityId || "fresh"} (${d.injected || 0} cookie)`, "#86efac");
    refreshPool();
  });

  // init
  api.captchaGetConfig().then((r) => {
    if (r && r.ok && r.config) {
      $("#adx-enabled").checked = r.config.enabled !== false && r.config.autoReset !== false;
      $("#adx-harvest-empty").checked = r.config.autoHarvestOnEmpty !== false;
      if (Array.isArray(r.config.customUrlPatterns)) $("#adx-cap-url").value = r.config.customUrlPatterns.join("\n");
      if (Array.isArray(r.config.customTextPatterns)) $("#adx-cap-text").value = r.config.customTextPatterns.join("\n");
    }
  }).catch(() => {});
  refreshPool();
  refreshProxy();
  logLine("Anti-detect UI sẵn sàng.");
})();

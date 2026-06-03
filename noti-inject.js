/**
 * noti-inject.js
 * Được load bởi Electron qua session.setPreloads() vào MAIN WORLD
 * Chạy trước bất kỳ JS nào của trang → override window.confirm/alert
 * 100% reliable vì không có race condition với page load
 */
(function () {
  // Lưu original
  var _origConfirm = window.confirm;
  var _origAlert = window.alert;

  // Rules được inject từ main process qua IPC
  // Khởi tạo rỗng, sẽ được update qua __dlUpdateNotiRules
  window.__dlNotiRules = window.__dlNotiRules || [];

  function matchRule(msg) {
    var rules = window.__dlNotiRules || [];
    var lower = String(msg || "").toLowerCase();
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r && r.pattern && lower.includes(r.pattern.toLowerCase())) {
        return r;
      }
    }
    return null;
  }

  window.confirm = function (msg) {
    var matched = matchRule(msg);
    if (matched) {
      var isCancel = (matched.choice || "ok").toLowerCase() === "cancel";
      console.log(
        "[DL-NotiHook] AUTO confirm(" + !isCancel + ") for: " +
        String(msg).slice(0, 100)
      );
      return !isCancel;
    }
    return _origConfirm ? _origConfirm.call(window, msg) : true;
  };

  window.alert = function (msg) {
    var matched = matchRule(msg);
    if (matched) {
      console.log("[DL-NotiHook] AUTO alert() suppressed");
      return;
    }
    if (_origAlert) _origAlert.call(window, msg);
  };

  // Update rules từ main process
  window.__dlUpdateNotiRules = function (newRules) {
    if (Array.isArray(newRules) && newRules.length > 0) {
      window.__dlNotiRules = newRules;
      console.log("[DL-NotiHook] rules updated:", newRules.length);
    }
  };

  window.__dlConfirmPatched = true;
  console.log("[DL-NotiHook] preload injected into main world");
})();

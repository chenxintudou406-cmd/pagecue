(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PageCueQuickCreatePolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function validateSelection(value, options = {}) {
    const raw = String(value || "");
    if (/[\r\n]/.test(raw)) return { ok: false, reason: "line_break" };
    const selected = raw.trim();
    const terms = [...new Set(selected.split(/[\/／]/).map(item => item.trim()).filter(Boolean))];
    if (terms.some(term => Array.from(term).length < 2)) return { ok: false, reason: "too_short" };
    if (terms.some(term => Array.from(term).length > 20)) return { ok: false, reason: "too_long" };
    if (options.editable) {
      const input = options.input || {};
      if (!["", "text", "search"].includes(String(input.type || "").toLowerCase())) {
        return { ok: false, reason: "unsafe_input_type" };
      }
      if (input.selectedText !== selected) return { ok: false, reason: "selection_mismatch" };
      const identity = `${input.name || ""} ${input.id || ""} ${input.autocomplete || ""}`.toLowerCase();
      if (/(password|passwd|pwd|token|secret|credential|username|one-time-code|otp|captcha|email|e-mail|phone|mobile|telephone|tel-|idcard|identity|身份证|手机号|邮箱|验证码|密钥|令牌)/i.test(identity)) {
        return { ok: false, reason: "sensitive_field" };
      }
      if (input.formHasPassword) return { ok: false, reason: "sensitive_form" };
    }
    return terms.length ? { ok: true, terms } : { ok: false, reason: "empty" };
  }

  return { validateSelection };
});

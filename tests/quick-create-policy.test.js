const test = require("node:test");
const assert = require("node:assert/strict");

const { validateSelection, isTrustedRichTextUrl } = require("../extension/shared/quick-create-policy.js");

test("安全单行输入框只返回用户实际选中的关键词", () => {
  const result = validateSelection("氯乙酸", {
    editable: true,
    input: {
      type: "search",
      name: "productQuery",
      id: "product-search",
      autocomplete: "off",
      selectedText: "氯乙酸",
      formHasPassword: false
    }
  });

  assert.deepEqual(result, { ok: true, terms: ["氯乙酸"] });
});

test("每个右键创建关键词必须为2到20个字符", () => {
  assert.deepEqual(validateSelection("甲"), { ok: false, reason: "too_short" });
  assert.deepEqual(validateSelection("123456789012345678901"), { ok: false, reason: "too_long" });
  assert.deepEqual(validateSelection("12345678901234567890"), { ok: true, terms: ["12345678901234567890"] });
});

test("右键创建关键词不允许包含换行", () => {
  assert.deepEqual(validateSelection("氯乙酸\n79-11-8"), { ok: false, reason: "line_break" });
  assert.deepEqual(validateSelection("氯乙酸\r\n79-11-8"), { ok: false, reason: "line_break" });
});

test("可编辑区域只允许普通文本和搜索输入框", () => {
  for (const type of ["textarea", "password", "email", "tel", "url"]) {
    assert.deepEqual(validateSelection("氯乙酸", {
      editable: true,
      input: { type, selectedText: "氯乙酸" }
    }), { ok: false, reason: "unsafe_input_type" });
  }
});

test("飞书可信富文本只允许实际选中的单行关键词", () => {
  assert.equal(isTrustedRichTextUrl("https://example.feishu.cn/docx/abc"), true);
  assert.equal(isTrustedRichTextUrl("https://example.larksuite.com/wiki/abc"), true);
  assert.equal(isTrustedRichTextUrl("https://feishu.cn.attacker.example/docx/abc"), false);

  assert.deepEqual(validateSelection("44444-44-4", {
    editable: true,
    input: {
      type: "contenteditable",
      selectedText: "44444-44-4",
      trustedRichText: true,
      formHasPassword: false
    }
  }), { ok: true, terms: ["44444-44-4"] });

  assert.deepEqual(validateSelection("44444-44-4", {
    editable: true,
    input: {
      type: "contenteditable",
      selectedText: "44444-44-4",
      trustedRichText: false
    }
  }), { ok: false, reason: "unsafe_input_type" });
});

test("敏感字段和包含密码框的表单禁止创建提醒", () => {
  assert.deepEqual(validateSelection("13800138000", {
    editable: true,
    input: { type: "text", name: "mobile", selectedText: "13800138000" }
  }), { ok: false, reason: "sensitive_field" });
  assert.deepEqual(validateSelection("客户账号", {
    editable: true,
    input: { type: "text", autocomplete: "username", selectedText: "客户账号" }
  }), { ok: false, reason: "sensitive_field" });
  assert.deepEqual(validateSelection("客户账号", {
    editable: true,
    input: { type: "text", selectedText: "客户账号", formHasPassword: true }
  }), { ok: false, reason: "sensitive_form" });
});

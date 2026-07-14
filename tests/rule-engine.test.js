const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../extension/shared/rule-engine.js");

test("中文关键词 AND 规则全部命中", () => {
  const result = engine.evaluateRule({ includeTerms: ["客户", "报价"], excludeTerms: [], operator: "AND" }, { text: "客户正在查看企业版报价", url: "https://crm.example.com/deal/1" });
  assert.equal(result.matched, true);
});

test("OR、排除词和大小写规则", () => {
  assert.equal(engine.evaluateRule({ includeTerms: ["合同", "报价"], operator: "OR" }, { text: "页面包含报价" }).matched, true);
  assert.equal(engine.evaluateRule({ includeTerms: ["报价"], excludeTerms: ["招聘"] }, { text: "招聘岗位报价" }).matched, false);
  assert.equal(engine.evaluateRule({ includeTerms: ["CRM"], caseSensitive: true }, { text: "crm" }).matched, false);
});

test("站点白名单支持通配符", () => {
  assert.equal(engine.matchesSite("https://sales.example.com/deal/1", ["https://*.example.com/*"]), true);
  assert.equal(engine.matchesSite("https://other.test/deal/1", ["https://*.example.com/*"]), false);
});

test("正则表达式匹配且非法表达式安全失败", () => {
  assert.equal(engine.evaluateRule({ includeTerms: ["订单\\d+"], useRegex: true }, { text: "订单123" }).matched, true);
  assert.equal(engine.evaluateRule({ includeTerms: ["["], useRegex: true }, { text: "任意内容" }).matched, false);
});

test("过滤草稿、未开始和已过期备忘", () => {
  const memos = [
    { id: "active", status: "published", rule: { includeTerms: ["客户"] } },
    { id: "draft", status: "draft", rule: { includeTerms: ["客户"] } },
    { id: "future", status: "published", startsAt: "2099-01-01T00:00:00Z", rule: { includeTerms: ["客户"] } },
    { id: "expired", status: "published", expiresAt: "2020-01-01T00:00:00Z", rule: { includeTerms: ["客户"] } }
  ];
  assert.deepEqual(engine.evaluateMemos(memos, { text: "客户" }).map(item => item.id), ["active"]);
});

test("相同关键词新增出现次数会产生不同触发签名", () => {
  const rule = { includeTerms: ["客户", "报价"], operator: "OR" };
  const first = engine.matchSignature(rule, { text: "客户正在查看报价" });
  const repeated = engine.matchSignature(rule, { text: "客户正在查看报价，另一个客户再次查看报价" });
  assert.notEqual(first, repeated);
  assert.equal(first, "1:1");
  assert.equal(repeated, "2:2");
});

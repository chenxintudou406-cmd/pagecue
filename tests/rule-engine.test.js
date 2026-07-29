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
  assert.equal(engine.matchesSite("file:///C:/Users/44982/Documents/demo.html", ["file:///C:/Users/44982/Documents/*"]), true);
  assert.equal(engine.matchesSite("file:///D:/other/demo.html", ["file:///C:/Users/44982/Documents/*"]), false);
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

test("全局提醒默认不依赖页面组即可在普通网页命中", () => {
  const memos = [
    { id: "global", status: "published", rule: { pageScope: "global", sitePatterns: [], includeTerms: ["供应商"] } },
    { id: "scoped", status: "published", rule: { pageScope: "page_groups", sitePatterns: ["https://crm.example.com/*"], includeTerms: ["供应商"] } }
  ];
  assert.deepEqual(engine.evaluateMemos(memos, { url: "https://book.example.com/product/1", text: "供应商产品信息" }).map(item => item.id), ["global"]);
});

test("相同关键词新增出现次数会产生不同触发签名", () => {
  const rule = { includeTerms: ["客户", "报价"], operator: "OR" };
  const first = engine.matchSignature(rule, { text: "客户正在查看报价" });
  const repeated = engine.matchSignature(rule, { text: "客户正在查看报价，另一个客户再次查看报价" });
  assert.notEqual(first, repeated);
  assert.equal(first, "1:1");
  assert.equal(repeated, "2:2");
});

test("AND 关键词必须出现在同一个模块或同一行内", () => {
  const rule = { includeTerms: ["CAS", "待报价"], excludeTerms: [], operator: "AND" };
  const splitAcrossRows = engine.evaluateRuleUnits(rule, [
    { text: "产品 A CAS 123-45-6" },
    { text: "产品 B 待报价" }
  ], { url: "https://example.com/inquiry" });
  const sameRow = engine.evaluateRuleUnits(rule, [
    { text: "产品 A CAS 123-45-6 待报价" },
    { text: "产品 B 已完成" }
  ], { url: "https://example.com/inquiry" });

  assert.equal(splitAcrossRows.matched, false);
  assert.equal(sameRow.matched, true);
  assert.deepEqual(sameRow.matchedUnitIndexes, [0]);
});

test("页面组策略按网址解析，未配置时保持整页匹配", () => {
  const scoped = engine.resolvePageStrategy({
    pageStrategies: [
      { sitePatterns: ["https://example.com/inquiry/*"], matchScope: "row", selector: ".quote-row" }
    ]
  }, "https://example.com/inquiry/123");
  const fallback = engine.resolvePageStrategy({}, "https://example.com/other");

  assert.equal(scoped.matchScope, "row");
  assert.equal(scoped.selector, ".quote-row");
  assert.equal(fallback.matchScope, "page");
});

test("1000 条知识规则中单页命中 100 条时保持轻量本地计算", () => {
  const memos = Array.from({ length: 1000 }, (_, index) => ({
    id: `memo_${index}`,
    status: "published",
    rule: {
      sitePatterns: [index < 100 ? "https://crm.example.com/*" : "https://other.example.com/*"],
      includeTerms: [index < 100 ? "询单" : `不存在-${index}`],
      operator: "AND"
    }
  }));
  const started = performance.now();
  const matches = engine.evaluateMemos(memos, { url: "https://crm.example.com/inquiry/1", text: "客户询单需要报价" });
  const elapsed = performance.now() - started;
  assert.equal(matches.length, 100);
  assert.ok(elapsed < 250, `1000 条规则本地计算耗时 ${elapsed.toFixed(1)}ms`);
});

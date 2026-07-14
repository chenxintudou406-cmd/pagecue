const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { server, visibleTo, isActive, normalizeRule, resolveMemoPageGroups, cleanMemo, cleanPageGroup, eventStats } = require("../server.js");

test("成员组隔离与个人所有权", () => {
  const sales = { id: "u1", groupIds: ["sales"] };
  const support = { id: "u2", groupIds: ["support"] };
  assert.equal(visibleTo({ scope: "organization", targetGroupIds: ["sales"] }, sales), true);
  assert.equal(visibleTo({ scope: "organization", targetGroupIds: ["sales"] }, support), false);
  assert.equal(visibleTo({ scope: "personal", ownerId: "u1" }, sales), true);
  assert.equal(visibleTo({ scope: "personal", ownerId: "u1" }, support), false);
});

test("内容有效期和数据清洗", () => {
  assert.equal(isActive({ status: "published", expiresAt: "2099-01-01T00:00:00Z" }), true);
  assert.equal(isActive({ status: "archived" }), false);
  const memo = cleanMemo({ scope: "organization", title: " 测试 ", rule: { operator: "OR", cooldownMinutes: 0 } });
  assert.equal(memo.title, "测试"); assert.equal(memo.rule.operator, "OR"); assert.equal(memo.rule.cooldownMinutes, 30); assert.equal(memo.version, 1);
});

test("关键词范围支持全局和特定页面组", () => {
  const pageGroup = cleanPageGroup({ name: "询单页面", sitePatterns: ["https://example.com/inquiry/*"] });
  const scoped = resolveMemoPageGroups({ id: "memo_scoped", rule: normalizeRule({ pageScope: "page_groups", pageGroupIds: [pageGroup.id], includeTerms: ["询单"] }) }, [pageGroup]);
  const global = resolveMemoPageGroups({ id: "memo_global", rule: normalizeRule({ pageScope: "global", sitePatterns: ["https://legacy.example/*"], includeTerms: ["公告"] }) }, [pageGroup]);
  assert.deepEqual(scoped.rule.sitePatterns, ["https://example.com/inquiry/*"]);
  assert.deepEqual(global.rule.sitePatterns, []);
  assert.deepEqual(scoped.rule.pageGroupIds, [pageGroup.id]);
});

test("匿名事件统计", () => {
  const stats = eventStats([{ action: "triggered" }, { action: "triggered" }, { action: "opened" }, { action: "helpful" }, { action: "unhelpful" }]);
  assert.equal(stats.openRate, 0.5); assert.equal(stats.helpfulRate, 0.5);
});

test("Manifest V3 使用可选站点权限且没有全站强制权限", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.optional_host_permissions.includes("https://*/*"));
  assert.equal(manifest.host_permissions.includes("<all_urls>"), false);
});

test("管理后台包含新版响应式与无障碍结构", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "admin", "styles.css"), "utf8");
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-view="pagegroups"/);
  assert.match(html, /location\.protocol === "file:"/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media \(max-width: 430px\)/);
});

test("工具箱只保留 COA 生成器", () => {
  const db = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
  assert.equal(db.tools.length, 1);
  assert.equal(db.tools[0].title, "COA生成器");
  assert.equal(db.tools[0].description, "生成前衍和瀚香的 COA");
  assert.equal(db.tools[0].url, "https://coa.herotop.cn/");
});

test("本地 API 可返回按成员过滤的启动数据", async t => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bootstrap?userId=user_demo`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.user.id, "user_demo");
  assert.ok(payload.memos.every(item => item.scope !== "personal" || item.ownerId === "user_demo"));
  assert.ok(Array.isArray(payload.pageGroups));
  assert.ok(payload.memos.every(item => item.rule.pageScope === "global" || item.rule.sitePatterns.length > 0));
});

test("个人备忘 CRUD 与匿名事件可持久化", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-companion-test-"));
  const dataFile = path.join(tempDir, "db.json");
  fs.copyFileSync(path.join(__dirname, "..", "data", "db.json"), dataFile);
  const baselineTriggered = JSON.parse(fs.readFileSync(dataFile, "utf8")).events.filter(event => event.action === "triggered").length;
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), CONTEXT_COMPANION_DATA: dataFile },
    stdio: "ignore"
  });
  t.after(() => { child.kill(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const pageGroupResponse = await fetch(`${base}/api/admin/page-groups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "测试页面组", sitePatterns: ["https://scope.example/*"] }) });
  assert.equal(pageGroupResponse.status, 201);
  const pageGroup = await pageGroupResponse.json();
  const scopedMemoResponse = await fetch(`${base}/api/admin/memos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "页面组提醒", body: "测试", rule: { pageScope: "page_groups", pageGroupIds: [pageGroup.id], includeTerms: ["测试"] } }) });
  assert.equal(scopedMemoResponse.status, 201);
  const scopedMemo = await scopedMemoResponse.json();
  const scopedBootstrap = await (await fetch(`${base}/api/bootstrap?userId=user_demo`)).json();
  assert.deepEqual(scopedBootstrap.memos.find(item => item.id === scopedMemo.id).rule.sitePatterns, ["https://scope.example/*"]);
  const usedDeleteResponse = await fetch(`${base}/api/admin/page-groups/${pageGroup.id}`, { method: "DELETE" });
  assert.equal(usedDeleteResponse.status, 409);
  const createdResponse = await fetch(`${base}/api/personal-memos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerId: "user_demo", title: "临时备忘", body: "测试正文", rule: { includeTerms: ["测试"] } }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  const updatedResponse = await fetch(`${base}/api/personal-memos/${created.id}?userId=user_demo`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "已更新备忘", body: "测试正文", rule: { includeTerms: ["测试"] } }) });
  assert.equal(updatedResponse.status, 200);
  assert.equal((await updatedResponse.json()).title, "已更新备忘");
  const eventResponse = await fetch(`${base}/api/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "user_demo", memoId: created.id, domain: "example.com", action: "triggered" }) });
  assert.equal(eventResponse.status, 201);
  const adminState = await (await fetch(`${base}/api/admin/state`)).json();
  assert.equal(adminState.stats.triggered, baselineTriggered + 1);
  assert.ok(adminState.memos.some(item => item.id === created.id && item.version === 2));
});

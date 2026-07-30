const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomBytes, scryptSync } = require("node:crypto");
const webPush = require("web-push");
const { server, visibleTo, isActive, normalizeRule, normalizePageStrategy, normalizeAnnotation, resolveMemoPageGroups, cleanMemo, cleanSupplier, cleanPageGroup, cleanGroup, ensurePersonalMemoFolders, personalMemoFolderId, eventStats } = require("../server.js");

test("成员分组支持新增和编辑且保持稳定 ID", () => {
  const created = cleanGroup({ name: " 采购组 ", description: "采购与供应商协同" }, {}, "admin_demo");
  assert.match(created.id, /^group_/);
  assert.equal(created.name, "采购组");
  assert.equal(created.description, "采购与供应商协同");
  const updated = cleanGroup({ name: "采购支持组", description: "" }, created, "admin_demo");
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, "采购支持组");
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedBy, "admin_demo");
  assert.throws(() => cleanGroup({ name: "   " }), /分组名称不能为空/);
});

test("个人知识与操作提醒使用固定自动归类文件夹", () => {
  const db = { memoFolders: [] };
  assert.equal(ensurePersonalMemoFolders(db), true);
  assert.deepEqual(db.memoFolders.map(folder => [folder.id, folder.name, folder.sortOrder, folder.systemManaged]), [
    ["memo_folder_personal_knowledge", "20-个人关注知识", 20, true],
    ["memo_folder_personal_operation", "99-个人操作提醒", 99, true]
  ]);
  assert.equal(ensurePersonalMemoFolders(db), false);
  assert.equal(personalMemoFolderId("knowledge"), "memo_folder_personal_knowledge");
  assert.equal(personalMemoFolderId("operation"), "memo_folder_personal_operation");
  const existingDb = { memoFolders: [{ id: "existing_personal", name: "20-个人关注知识" }] };
  assert.equal(ensurePersonalMemoFolders(existingDb), true);
  assert.equal(personalMemoFolderId("knowledge", existingDb), "existing_personal");
  assert.equal(existingDb.memoFolders.length, 2);
});

function testPasswordHash(password) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("base64url")}:${scryptSync(password, salt, 64).toString("base64url")}`;
}

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

test("供应商资料只保留百分位并支持提醒引用", () => {
  const supplier = cleanSupplier({ companyName: " 测试供应商 ", customerId: " C-100 ", matchTerms: ["测试供应商", "C-100"], metrics: { productPercentile: 105, orderPercentile: 81.25, afterSalesRate: -2 }, advantageProducts: [{ name: "氯乙酸", cas: "79-11-8", closeRate: 72 }] });
  assert.equal(supplier.companyName, "测试供应商");
  assert.equal(supplier.metrics.productPercentile, 100);
  assert.equal(supplier.metrics.orderPercentile, 81.3);
  assert.equal(supplier.metrics.afterSalesRate, 0);
  assert.equal(Object.hasOwn(supplier.metrics, "productCount"), false);
  assert.deepEqual(supplier.matchTerms, ["测试供应商", "C-100"]);
  const organizationMemo = cleanMemo({ scope: "organization", title: "供应商提醒", entityRefs: [{ type: "supplier", id: supplier.id }] });
  const personalMemo = cleanMemo({ scope: "personal", ownerId: "u1", title: "个人提醒", entityRefs: [{ type: "supplier", id: supplier.id }] });
  assert.equal(organizationMemo.entityRefs[0].id, supplier.id);
  assert.deepEqual(personalMemo.entityRefs, []);
});

test("正式产品包含 328px 供应商卡片和后台手工维护入口", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "admin", "app.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "content.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "content.css"), "utf8");
  assert.match(html, /data-view="suppliers"/);
  assert.match(html, /data-view="memo-folders"/);
  assert.match(html, /id="view-memo-folders"/);
  assert.match(html, /id="memo-folder-list"/);
  assert.match(html, /data-open-memo-folder/);
  assert.match(html, /name="durationPreset"/);
  assert.match(html, /yezhi-bulk-import-template\.xlsx/);
  assert.match(html, /id="bulk-import-template-download"/);
  assert.match(html, /bulk-import-template-download"\)\.href = adminAsset\("yezhi-bulk-import-template\.xlsx"\)/);
  assert.match(html, /name="supplierId"/);
  assert.match(html, /name="matchTerms"/);
  assert.match(app, /api\/admin\/memo-folders/);
  assert.match(app, /api\/admin\/memos\/.*\/folder/);
  assert.match(app, /data-move-memo/);
  assert.match(app, /function localDateStartIso/);
  assert.match(app, /api\/admin\/suppliers/);
  assert.match(content, /GET_SUPPLIER/);
  assert.match(css, /width:328px/);
});

test("知识、操作、个人和组织提醒共享评论入口并按需加载", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "extension", "sidepanel", "index.html"), "utf8");
  const sidepanel = fs.readFileSync(path.join(__dirname, "..", "extension", "sidepanel", "app.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "content.js"), "utf8");
  assert.doesNotMatch(html, /id="comments-dialog"/);
  assert.match(sidepanel, /function commentButton/);
  assert.match(sidepanel, /class="inline-comments"/);
  assert.match(sidepanel, /api\/memos\/.*\/comments/);
  assert.match(content, /toggleCardComments/);
  assert.match(content, /GET_MEMO_COMMENTS/);
});

test("关键词范围支持全局和特定页面组", () => {
  const pageGroup = cleanPageGroup({
    name: "询单页面",
    sitePatterns: ["https://example.com/inquiry/*"],
    strategy: { matchScope: "row", selector: ".quote-row", excludeSelector: ".summary-row" }
  });
  const scoped = resolveMemoPageGroups({ id: "memo_scoped", rule: normalizeRule({ pageScope: "page_groups", pageGroupIds: [pageGroup.id], includeTerms: ["询单"] }) }, [pageGroup]);
  const global = resolveMemoPageGroups({ id: "memo_global", rule: normalizeRule({ pageScope: "global", sitePatterns: ["https://legacy.example/*"], includeTerms: ["公告"] }) }, [pageGroup]);
  assert.deepEqual(scoped.rule.sitePatterns, ["https://example.com/inquiry/*"]);
  assert.deepEqual(global.rule.sitePatterns, []);
  assert.deepEqual(scoped.rule.pageGroupIds, [pageGroup.id]);
  assert.deepEqual(scoped.rule.pageStrategies, [{
    pageGroupId: pageGroup.id,
    sitePatterns: ["https://example.com/inquiry/*"],
    matchScope: "row",
    selector: ".quote-row",
    excludeSelector: ".summary-row"
  }]);
  assert.deepEqual(global.rule.pageStrategies, []);
});

test("模块和同一行策略必须提供选择器", () => {
  assert.equal(normalizePageStrategy({ matchScope: "row", selector: ".item" }).matchScope, "row");
  assert.throws(() => cleanPageGroup({ name: "无效行策略", strategy: { matchScope: "row" } }), error => error.statusCode === 400);
});

test("匿名事件统计", () => {
  const stats = eventStats([{ action: "triggered" }, { action: "triggered" }, { action: "opened" }, { action: "helpful" }, { action: "unhelpful" }]);
  assert.equal(stats.openRate, 0.5); assert.equal(stats.helpfulRate, 0.5);
});

test("V2 批注迁移和锚点上限保持向后兼容", () => {
  assert.equal(normalizeAnnotation(undefined, "normal", "organization").template, "standard");
  assert.equal(normalizeAnnotation(undefined, "important", "organization").template, "strong");
  assert.equal(normalizeAnnotation(undefined, "normal", "personal").template, "light");
  const annotation = normalizeAnnotation({
    template: "strong",
    keywordTerms: ["危险化学品"],
    anchors: Array.from({ length: 25 }, (_, index) => ({ pageGroupId: "group", primarySelector: `.item-${index}`, fingerprintHash: "a".repeat(64) }))
  });
  assert.equal(annotation.anchors.length, 20);
  assert.equal(annotation.anchors[0].fingerprintHash, "a".repeat(64));
  assert.equal(Object.hasOwn(annotation.anchors[0], "text"), false);
});

test("Manifest V3 在安装时获得网页权限，并按组织页面组动态注册监控", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
  const worker = fs.readFileSync(path.join(__dirname, "..", "extension", "background", "service-worker.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "content.js"), "utf8");
  const sidepanel = fs.readFileSync(path.join(__dirname, "..", "extension", "sidepanel", "app.js"), "utf8");
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.permissions.includes("alarms"));
  assert.ok(manifest.host_permissions.includes("http://*/*"));
  assert.ok(manifest.host_permissions.includes("https://*/*"));
  assert.ok(manifest.host_permissions.includes("file:///*"));
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.ok(manifest.content_scripts?.[0]?.matches.includes("http://*/*"));
  assert.ok(manifest.content_scripts?.[0]?.matches.includes("https://*/*"));
  assert.ok(manifest.content_scripts?.[0]?.matches.includes("file:///*"));
  assert.ok(manifest.content_scripts?.[0]?.all_frames);
  assert.equal(manifest.content_scripts?.[0]?.match_about_blank, true);
  assert.match(worker, /DEFAULT_SCAN_PATTERNS/);
  assert.match(worker, /managedExcludedSitePatterns/);
  assert.match(worker, /isAllowedFileSchemeAccess/);
  assert.match(worker, /registerContentScripts/);
  assert.match(worker, /matchAboutBlank:\s*true/);
  assert.match(worker, /matchOriginAsFallback/);
  assert.match(worker, /senderDomain/);
  assert.doesNotMatch(worker, /!message\.domain/);
  assert.match(content, /isCurrentPageExcluded/);
  assert.match(content, /PAGE_EXCLUDED/);
  assert.match(content, /url\.protocol === "file:"/);
  assert.match(content, /patterns\.length > 0 && ContextRuleEngine\.matchesSite/);
  assert.match(sidepanel, /excludedSitePatterns/);
});

test("实时推送具备 Push 唤醒和每小时兜底，而不是高频轮询", () => {
  const worker = fs.readFileSync(path.join(__dirname, "..", "extension", "background", "service-worker.js"), "utf8");
  const admin = fs.readFileSync(path.join(__dirname, "..", "admin", "index.html"), "utf8");
  assert.match(worker, /SYNC_INTERVAL_MINUTES = 60/);
  assert.match(worker, /addEventListener\("push"/);
  assert.match(worker, /requestUpdateCheck/);
  assert.match(worker, /chrome\.runtime\.onUpdateAvailable/);
  assert.match(admin, /发布并推送/);
});

test("兼容浏览器缺少侧栏能力时仍可使用弹窗兼容模式", () => {
  const worker = fs.readFileSync(path.join(__dirname, "..", "extension", "background", "service-worker.js"), "utf8");
  assert.match(worker, /SIDE_PANEL_AVAILABLE/);
  assert.match(worker, /chrome\.action\.setPopup/);
  assert.match(worker, /chrome\.tabs\.create/);
});

test("双安装包都支持侧栏且兼容包保留悬挂窗口退路", () => {
  const root = path.join(__dirname, "..", ".deploy", "staging");
  const version = require(path.join(__dirname, "..", "package.json")).version;
  const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, "chrome-edge", "manifest.json"), "utf8"));
  const sogouManifest = JSON.parse(fs.readFileSync(path.join(root, "sogou", "manifest.json"), "utf8"));
  assert.equal(chromeManifest.version, version);
  assert.equal(chromeManifest.minimum_chrome_version, "116");
  assert.ok(chromeManifest.side_panel);
  assert.ok(chromeManifest.permissions.includes("sidePanel"));
  assert.equal(sogouManifest.minimum_chrome_version, "109");
  assert.ok(sogouManifest.side_panel);
  assert.ok(sogouManifest.permissions.includes("sidePanel"));
  assert.equal(sogouManifest.action.default_popup, "sidepanel/index.html");
  assert.ok(chromeManifest.content_scripts?.[0]?.matches.includes("https://*/*"));
  assert.ok(sogouManifest.content_scripts?.[0]?.matches.includes("https://*/*"));
  assert.ok(fs.statSync(path.join(__dirname, "..", ".deploy", `pagecue-chrome-edge-${version}.zip`)).size > 0);
  assert.ok(fs.statSync(path.join(__dirname, "..", ".deploy", `pagecue-sogou-${version}.zip`)).size > 0);
});

test("批注运行时遵守搜狗兼容与页面隐私边界", () => {
  const content = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "content.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "content.css"), "utf8");
  assert.match(content, /MAX_HIGHLIGHTS = 500/);
  assert.match(content, /fingerprintElement/);
  assert.match(content, /annotation_unresolved/);
  assert.match(content, /cc-annotation-pin/);
  assert.doesNotMatch(css, /:has\(/);
  assert.doesNotMatch(css, /@container/);
  const worker = fs.readFileSync(path.join(__dirname, "..", "extension", "background", "service-worker.js"), "utf8");
  const eventPayloadSource = worker.match(/function eventPayload[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(eventPayloadSource, /pageText|matchedText|formValue|cookie|query/);
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

test("后台新建内容不会复用编辑 ID 且反馈记录不截断", () => {
  const adminApp = fs.readFileSync(path.join(__dirname, "..", "admin", "app.js"), "utf8");
  const sidepanelApp = fs.readFileSync(path.join(__dirname, "..", "extension", "sidepanel", "app.js"), "utf8");
  const worker = fs.readFileSync(path.join(__dirname, "..", "extension", "background", "service-worker.js"), "utf8");
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.equal((adminApp.match(/form\.elements\.id\.value = ""/g) || []).length, 3);
  assert.doesNotMatch(adminApp, /data\.get\("id"\)/);
  assert.match(adminApp, /state\.editingPageGroup\?\.id/);
  assert.match(adminApp, /state\.editingMemo\?\.id/);
  assert.match(adminApp, /state\.editingTool\?\.id/);
  assert.match(sidepanelApp, /form\.elements\.id\.value = ""/);
  assert.match(sidepanelApp, /const id = state\.editing\?\.id/);
  assert.match(sidepanelApp, /GET_DEVICE_ID/);
  assert.doesNotMatch(worker, /eventQueue\.slice/);
  assert.doesNotMatch(serverSource, /db\.events = db\.events\.slice/);
});

test("工具箱只保留 COA 生成器", () => {
  const db = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
  assert.equal(db.tools.length, 1);
  assert.equal(db.tools[0].title, "COA生成器");
  assert.equal(db.tools[0].description, "生成标准 COA");
  assert.equal(db.tools[0].url, "https://coa.example.com/");
});

test("启动数据不再信任可手填的成员 ID", async t => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/api/bootstrap?userId=user_demo`);
  assert.equal(response.status, 401);
});

test("V3 邀请绑定、操作确认、个人提醒与闹钟退休策略可持久化", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-companion-test-"));
  const dataFile = path.join(tempDir, "db.json");
  fs.copyFileSync(path.join(__dirname, "..", "data", "db.json"), dataFile);
  const baselineTriggered = JSON.parse(fs.readFileSync(dataFile, "utf8")).events.filter(event => event.action === "triggered").length;
  const vapidKeys = webPush.generateVAPIDKeys();
  const adminPhone = "13000000000";
  const adminPassword = "test-only-password";
  const workbuddyToken = "test-workbuddy-token-at-least-32-characters";
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const value = probe.address().port; probe.close(() => resolve(value)); });
  });
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), CONTEXT_COMPANION_DATA: dataFile, VAPID_PUBLIC_KEY: vapidKeys.publicKey, VAPID_PRIVATE_KEY: vapidKeys.privateKey, VAPID_SUBJECT: "mailto:test@example.com", ADMIN_PHONE: adminPhone, ADMIN_PASSWORD_HASH: testPasswordHash(adminPassword), ADMIN_SESSION_SECRET: randomBytes(32).toString("base64url"), WORKBUDDY_API_TOKEN: workbuddyToken },
    stdio: "ignore"
  });
  t.after(() => { child.kill(); fs.rmSync(tempDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const unauthorizedWorkbuddy = await fetch(`${base}/api/integrations/workbuddy/health`);
  assert.equal(unauthorizedWorkbuddy.status, 401);
  const workbuddyFetch = (pathname, options = {}) => fetch(`${base}${pathname}`, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${workbuddyToken}` } });
  const workbuddyHealth = await workbuddyFetch("/api/integrations/workbuddy/health");
  assert.equal(workbuddyHealth.status, 200);
  assert.equal((await workbuddyHealth.json()).status, "ready");
  const workbuddyRequestId = "wecom-message-20260721-001";
  const workbuddyCreate = await workbuddyFetch("/api/integrations/workbuddy/reminders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requestId: workbuddyRequestId,
      submittedBy: "@Zhang San",
      type: "knowledge",
      title: "WeCom knowledge reminder",
      body: "Read the linked SOP before quoting.",
      keywords: ["chloroacetic acid", "79-11-8"],
      keywordOperator: "OR",
      intensity: "medium",
      targetGroups: ["group_sales"],
      links: ["https://example.com/sop"]
    })
  });
  assert.equal(workbuddyCreate.status, 201);
  const workbuddyCreated = await workbuddyCreate.json();
  assert.equal(workbuddyCreated.status, "created");
  assert.equal(workbuddyCreated.submittedBy, "Zhang San");
  assert.equal(workbuddyCreated.reminder.type, "knowledge");
  assert.deepEqual(workbuddyCreated.reminder.keywords, ["chloroacetic acid", "79-11-8"]);
  assert.deepEqual(workbuddyCreated.reminder.targetGroups, ["销售组"]);
  assert.equal(workbuddyCreated.reminder.expiresAt, null);
  assert.match(workbuddyCreated.message, /^创建成功\n提醒类型：知识提醒/);
  assert.match(workbuddyCreated.message, /提交人：Zhang San/);
  assert.match(workbuddyCreated.message, /关键词：chloroacetic acid、79-11-8（OR）/);
  assert.match(workbuddyCreated.message, /强度：中度$/);
  assert.doesNotMatch(workbuddyCreated.message, /页面范围|投放对象|有效期|同步状态|提醒 ID/);
  const missingSubmitterResponse = await workbuddyFetch("/api/integrations/workbuddy/reminders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "wecom-message-missing-submitter", title: "Missing submitter", keywords: ["test"] })
  });
  assert.equal(missingSubmitterResponse.status, 400);
  assert.match((await missingSubmitterResponse.json()).message, /提交人姓名/);
  const defaultOperationResponse = await workbuddyFetch("/api/integrations/workbuddy/reminders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "wecom-message-operation-defaults", submittedBy: "Li Si", type: "operation", keywords: ["pending quote"] })
  });
  assert.equal(defaultOperationResponse.status, 201);
  const defaultOperation = await defaultOperationResponse.json();
  assert.equal(defaultOperation.reminder.type, "operation");
  assert.equal(defaultOperation.reminder.title, "pending quote操作提醒");
  assert.equal(defaultOperation.reminder.intensity, "light");
  assert.match(defaultOperation.message, /关键词：pending quote（OR）/);
  assert.ok(Date.parse(defaultOperation.reminder.startsAt) <= Date.now());
  const defaultDurationDays = (Date.parse(defaultOperation.reminder.expiresAt) - Date.parse(defaultOperation.reminder.startsAt)) / (24 * 60 * 60_000);
  assert.ok(defaultDurationDays >= 28 && defaultDurationDays <= 31);
  assert.ok(defaultOperation.defaultsApplied.includes("强度=轻度"));
  assert.ok(defaultOperation.defaultsApplied.includes("关键词关系=OR"));
  assert.ok(defaultOperation.defaultsApplied.includes("结束时间=1个月后"));
  assert.match(defaultOperation.message, /^创建成功\n标题：pending quote操作提醒/);
  assert.doesNotMatch(defaultOperation.message, /提醒类型/);
  assert.match(defaultOperation.message, /强度：轻度\n有效期：.+ 至 .+$/);
  const duplicateWorkbuddyCreate = await workbuddyFetch("/api/integrations/workbuddy/reminders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: workbuddyRequestId, title: "Should not be created", keywords: ["duplicate"] })
  });
  assert.equal(duplicateWorkbuddyCreate.status, 200);
  const duplicateWorkbuddyResult = await duplicateWorkbuddyCreate.json();
  assert.equal(duplicateWorkbuddyResult.status, "duplicate");
  assert.equal(duplicateWorkbuddyResult.reminder.id, workbuddyCreated.reminder.id);
  const queriedWorkbuddyResult = await (await workbuddyFetch(`/api/integrations/workbuddy/requests/${encodeURIComponent(workbuddyRequestId)}`)).json();
  assert.equal(queriedWorkbuddyResult.reminder.id, workbuddyCreated.reminder.id);
  const loginResponse = await fetch(`${base}/api/admin/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: adminPhone, password: adminPassword }) });
  assert.equal(loginResponse.status, 200);
  const adminCookie = loginResponse.headers.get("set-cookie").split(";")[0];
  const adminFetch = (pathname, options = {}) => fetch(`${base}${pathname}`, { ...options, headers: { ...(options.headers || {}), Cookie: adminCookie } });
  const groupResponse = await adminFetch("/api/admin/groups", { method: "POST", body: JSON.stringify({ name: "质量组", description: "质量与合规成员" }) });
  assert.equal(groupResponse.status, 201);
  const group = await groupResponse.json();
  assert.match(group.id, /^group_/);
  assert.equal((await adminFetch("/api/admin/groups", { method: "POST", body: JSON.stringify({ name: "质量组" }) })).status, 409);
  const groupUpdateResponse = await adminFetch(`/api/admin/groups/${group.id}`, { method: "PUT", body: JSON.stringify({ name: "质量支持组", description: "更新说明" }) });
  assert.equal(groupUpdateResponse.status, 200);
  assert.equal((await groupUpdateResponse.json()).id, group.id);
  const groupState = await (await adminFetch("/api/admin/state")).json();
  assert.equal(groupState.groups.find(item => item.id === group.id).name, "质量支持组");
  assert.ok(groupState.auditLog.some(item => item.entityType === "group" && item.entityId === group.id));
  const folderResponse = await adminFetch("/api/admin/memo-folders", { method: "POST", body: JSON.stringify({ name: "报价知识", description: "报价前需要核查的知识", sortOrder: 10 }) });
  assert.equal(folderResponse.status, 201);
  const folder = await folderResponse.json();
  assert.equal((await adminFetch("/api/admin/memo-folders", { method: "POST", body: JSON.stringify({ name: "报价知识" }) })).status, 409);
  const folderMemoResponse = await adminFetch("/api/admin/memos", { method: "POST", body: JSON.stringify({ title: "文件夹测试提醒", status: "draft", folderId: folder.id, rule: { includeTerms: ["文件夹测试"] } }) });
  assert.equal(folderMemoResponse.status, 201);
  const folderMemo = await folderMemoResponse.json();
  const secondFolderResponse = await adminFetch("/api/admin/memo-folders", { method: "POST", body: JSON.stringify({ name: "供应商知识", sortOrder: 20 }) });
  assert.equal(secondFolderResponse.status, 201);
  const secondFolder = await secondFolderResponse.json();
  const moveFolderResponse = await adminFetch(`/api/admin/memos/${folderMemo.id}/folder`, { method: "PUT", body: JSON.stringify({ folderId: secondFolder.id }) });
  assert.equal(moveFolderResponse.status, 200);
  assert.equal((await moveFolderResponse.json()).folderId, secondFolder.id);
  assert.equal((await adminFetch(`/api/admin/memos/${folderMemo.id}/folder`, { method: "PUT", body: JSON.stringify({ folderId: "missing_folder" }) })).status, 400);
  assert.equal((await adminFetch(`/api/admin/memo-folders/${secondFolder.id}`, { method: "DELETE" })).status, 200);
  const folderState = await (await adminFetch("/api/admin/state")).json();
  assert.ok(folderState.memoFolders.some(item => item.id === folder.id));
  assert.equal(folderState.memoFolders.some(item => item.id === secondFolder.id), false);
  assert.equal(folderState.memos.find(item => item.id === folderMemo.id).folderId, null);
  assert.ok(folderState.auditLog.some(item => item.action === "folder_changed" && item.entityId === folderMemo.id));
  const bulkFolderResponse = await adminFetch("/api/admin/memo-folders", { method: "POST", body: JSON.stringify({ name: "批量整理目标", sortOrder: 30 }) });
  assert.equal(bulkFolderResponse.status, 201);
  const bulkFolder = await bulkFolderResponse.json();
  const bulkMemoA = await (await adminFetch("/api/admin/memos", { method: "POST", body: JSON.stringify({ title: "批量提醒 A", rule: { includeTerms: ["批量A"] } }) })).json();
  const bulkMemoB = await (await adminFetch("/api/admin/memos", { method: "POST", body: JSON.stringify({ title: "批量提醒 B", rule: { includeTerms: ["批量B"] } }) })).json();
  const bulkMoveResponse = await adminFetch("/api/admin/memos/bulk", { method: "POST", body: JSON.stringify({ action: "move", memoIds: [bulkMemoA.id, bulkMemoB.id], folderId: bulkFolder.id }) });
  assert.equal(bulkMoveResponse.status, 200);
  assert.equal((await bulkMoveResponse.json()).changedCount, 2);
  const stateAfterBulkMove = await (await adminFetch("/api/admin/state")).json();
  assert.equal(stateAfterBulkMove.memos.find(item => item.id === bulkMemoA.id).folderId, bulkFolder.id);
  assert.equal(stateAfterBulkMove.memos.find(item => item.id === bulkMemoB.id).folderId, bulkFolder.id);
  const bulkArchiveResponse = await adminFetch("/api/admin/memos/bulk", { method: "POST", body: JSON.stringify({ action: "archive", memoIds: [bulkMemoA.id, bulkMemoB.id] }) });
  assert.equal(bulkArchiveResponse.status, 200);
  assert.equal((await bulkArchiveResponse.json()).changedCount, 2);
  const stateAfterBulkArchive = await (await adminFetch("/api/admin/state")).json();
  assert.equal(stateAfterBulkArchive.memos.find(item => item.id === bulkMemoA.id).status, "archived");
  assert.equal(stateAfterBulkArchive.memos.find(item => item.id === bulkMemoB.id).status, "archived");
  assert.ok(stateAfterBulkArchive.auditLog.some(item => item.action === "archived" && item.entityId === bulkMemoA.id));
  assert.equal((await adminFetch("/api/admin/memos/bulk", { method: "POST", body: JSON.stringify({ action: "unknown", memoIds: [bulkMemoA.id] }) })).status, 400);
  const invitationResponse = await adminFetch("/api/admin/invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "user_demo", validMinutes: 60 }) });
  assert.equal(invitationResponse.status, 201);
  const invitation = await invitationResponse.json();
  const bindingResponse = await fetch(`${base}/api/device-bindings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inviteCode: invitation.code, deviceId: "test-device", browser: "test", extensionVersion: "3.0.0" }) });
  assert.equal(bindingResponse.status, 201);
  const binding = await bindingResponse.json();
  assert.equal((await (await adminFetch("/api/admin/state")).json()).invitations.some(item => item.id === invitation.id), false);
  const memberFetch = (pathname, options = {}) => fetch(`${base}${pathname}`, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${binding.token}` } });
  const firstMemberSession = await memberFetch("/api/device/session");
  const secondMemberSession = await memberFetch("/api/device/session");
  assert.equal(firstMemberSession.status, 200);
  assert.equal(secondMemberSession.status, 200);
  const supplierResponse = await adminFetch("/api/admin/suppliers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyName: "自动匹配供应商", customerId: "SUP-001", matchTerms: ["自动匹配供应商", "SUP-001"], contact: {}, metrics: {}, advantageProducts: [], evaluations: {}, source: { type: "manual" } }) });
  assert.equal(supplierResponse.status, 201);
  const supplier = await supplierResponse.json();
  const bootstrapWithSupplier = await (await memberFetch("/api/bootstrap")).json();
  const supplierTrigger = bootstrapWithSupplier.memos.find(item => item.sourceSupplierId === supplier.id);
  assert.ok(supplierTrigger);
  assert.deepEqual(supplierTrigger.rule.includeTerms, ["自动匹配供应商", "SUP-001"]);
  assert.equal(supplierTrigger.rule.operator, "OR");
  assert.equal(supplierTrigger.entityRefs[0].id, supplier.id);
  assert.equal((await memberFetch(`/api/suppliers/${supplier.id}`)).status, 200);
  const managedInvitationResponse = await adminFetch("/api/admin/invitations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "user_demo", validMinutes: 60 }) });
  const managedInvitation = await managedInvitationResponse.json();
  const invitationState = await (await adminFetch("/api/admin/state")).json();
  const visibleInvitation = invitationState.invitations.find(item => item.id === managedInvitation.id);
  assert.equal(visibleInvitation.code, managedInvitation.code);
  assert.equal(Object.hasOwn(visibleInvitation, "codeHash"), false);
  assert.equal(Object.hasOwn(visibleInvitation, "codeCipher"), false);
  assert.equal((await adminFetch(`/api/admin/invitations/${managedInvitation.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await (await adminFetch("/api/admin/state")).json()).invitations.some(item => item.id === managedInvitation.id), false);
  const inactiveInvitationCleanup = await adminFetch("/api/admin/invitations/inactive", { method: "DELETE" });
  assert.equal(inactiveInvitationCleanup.status, 200);
  assert.equal(typeof (await inactiveInvitationCleanup.json()).deletedCount, "number");
  const versionResponse = await fetch(`${base}/api/version`);
  assert.equal(versionResponse.status, 200);
  assert.equal((await versionResponse.json()).checkIntervalMinutes, 60);
  const versionEtag = versionResponse.headers.get("etag");
  assert.ok(versionEtag);
  assert.equal((await fetch(`${base}/api/version`, { headers: { "If-None-Match": versionEtag } })).status, 304);
  const pushConfig = await (await fetch(`${base}/api/push/config`)).json();
  assert.equal(pushConfig.enabled, true);
  assert.equal(pushConfig.checkIntervalMinutes, 60);
  const pageGroupResponse = await adminFetch(`/api/admin/page-groups`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    name: "测试页面组",
    sitePatterns: ["https://scope.example/*"],
    strategy: { matchScope: "row", selector: ".quote-row", excludeSelector: ".summary-row" }
  }) });
  assert.equal(pageGroupResponse.status, 201);
  const pageGroup = await pageGroupResponse.json();
  const secondPageGroupResponse = await adminFetch(`/api/admin/page-groups`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": "admin_demo" }, body: JSON.stringify({
    id: pageGroup.id,
    name: "新增页面组",
    sitePatterns: ["https://second.example/*"],
    strategy: { matchScope: "page" }
  }) });
  assert.equal(secondPageGroupResponse.status, 201);
  const secondPageGroup = await secondPageGroupResponse.json();
  assert.notEqual(secondPageGroup.id, pageGroup.id);
  const pageGroupsAfterAppend = (await (await adminFetch(`/api/admin/state`)).json()).pageGroups;
  assert.ok(pageGroupsAfterAppend.some(item => item.id === pageGroup.id && item.name === "测试页面组"));
  assert.ok(pageGroupsAfterAppend.some(item => item.id === secondPageGroup.id && item.name === "新增页面组"));
  const scopedMemoResponse = await adminFetch(`/api/admin/memos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "页面组提醒", body: "测试", rule: { pageScope: "page_groups", pageGroupIds: [pageGroup.id], includeTerms: ["测试"] } }) });
  assert.equal(scopedMemoResponse.status, 201);
  const scopedMemo = await scopedMemoResponse.json();
  const deniedSessionResponse = await fetch(`${base}/api/admin/annotation-sessions`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": "user_demo" }, body: JSON.stringify({ memoId: scopedMemo.id, pageGroupId: pageGroup.id, url: "https://scope.example/inquiry/1" }) });
  assert.equal(deniedSessionResponse.status, 401);
  const mismatchedSessionResponse = await adminFetch(`/api/admin/annotation-sessions`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": "admin_demo" }, body: JSON.stringify({ memoId: scopedMemo.id, pageGroupId: pageGroup.id, url: "https://outside.example/inquiry/1" }) });
  assert.equal(mismatchedSessionResponse.status, 400);
  const sessionResponse = await adminFetch(`/api/admin/annotation-sessions`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": "admin_demo" }, body: JSON.stringify({ memoId: scopedMemo.id, pageGroupId: pageGroup.id, url: "https://scope.example/inquiry/1" }) });
  assert.equal(sessionResponse.status, 201);
  const session = await sessionResponse.json();
  assert.match(session.code, /^\d{6}$/);
  const publicSessionResponse = await fetch(`${base}/api/annotation-sessions/${session.code}`);
  assert.equal(publicSessionResponse.status, 200);
  const publicSession = await publicSessionResponse.json();
  assert.equal(publicSession.code, undefined);
  assert.equal(publicSession.memo.id, scopedMemo.id);
  const anchorPayload = { label: "报价按钮", pathPattern: "/inquiry/*", primarySelector: ".quote-button", fallbackSelector: "button", fingerprintHash: "b".repeat(64), relativeToMatchUnit: true };
  const completeSessionResponse = await fetch(`${base}/api/admin/annotation-sessions/${session.id}/complete`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": "user_demo" }, body: JSON.stringify({ code: session.code, anchor: anchorPayload }) });
  assert.equal(completeSessionResponse.status, 201);
  const completed = await completeSessionResponse.json();
  assert.equal(completed.anchor.pageGroupId, pageGroup.id);
  assert.equal(completed.anchor.relativeToMatchUnit, true);
  assert.equal(Object.hasOwn(completed.anchor, "text"), false);
  const replayResponse = await fetch(`${base}/api/admin/annotation-sessions/${session.id}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: session.code, anchor: anchorPayload }) });
  assert.equal(replayResponse.status, 409);
  const secondMemoResponse = await adminFetch(`/api/admin/memos`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": "admin_demo" }, body: JSON.stringify({ id: scopedMemo.id, title: "新增知识规则", body: "第二条", rule: { pageScope: "global", includeTerms: ["新增"] } }) });
  assert.equal(secondMemoResponse.status, 201);
  const secondMemo = await secondMemoResponse.json();
  assert.notEqual(secondMemo.id, scopedMemo.id);
  const firstToolResponse = await adminFetch(`/api/admin/tools`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": "admin_demo" }, body: JSON.stringify({ title: "新增工具一", category: "测试", url: "https://tool-one.example/" }) });
  const firstTool = await firstToolResponse.clone().json();
  const secondToolResponse = await adminFetch(`/api/admin/tools`, { method: "POST", headers: { "Content-Type": "application/json", "X-User-Id": "admin_demo" }, body: JSON.stringify({ id: firstTool.id, title: "新增工具二", category: "测试", url: "https://tool-two.example/" }) });
  assert.equal(firstToolResponse.status, 201);
  assert.equal(secondToolResponse.status, 201);
  assert.notEqual(firstTool.id, (await secondToolResponse.json()).id);
  const pushResponse = await adminFetch(`/api/admin/push`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memoId: scopedMemo.id, type: "sync" }) });
  assert.equal(pushResponse.status, 201);
  const pushDelivery = await pushResponse.json();
  assert.equal(pushDelivery.configured, true);
  assert.equal(pushDelivery.targetCount, 0);
  const subscriptionResponse = await memberFetch(`/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: "user_demo",
      deviceId: "test-device",
      browser: "test",
      extensionVersion: "1.9.0",
      subscription: { endpoint: "https://push.example.invalid/device", keys: { p256dh: "test-p256dh", auth: "test-auth" } }
    })
  });
  assert.equal(subscriptionResponse.status, 201);
  const scopedBootstrap = await (await memberFetch(`/api/bootstrap`)).json();
  assert.deepEqual(scopedBootstrap.memos.find(item => item.id === scopedMemo.id).rule.sitePatterns, ["https://scope.example/*"]);
  assert.equal(scopedBootstrap.memos.find(item => item.id === scopedMemo.id).rule.pageStrategies[0].matchScope, "row");
  const startTestResponse = await adminFetch(`/api/admin/page-groups/${pageGroup.id}/test`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://scope.example/inquiry/1", keywords: ["CAS", "待报价"] })
  });
  assert.equal(startTestResponse.status, 201);
  const startedTest = await startTestResponse.json();
  const pendingTests = await (await fetch(`${base}/api/strategy-tests/pending`)).json();
  assert.ok(pendingTests.tests.some(item => item.request.id === startedTest.request.id && item.strategy.matchScope === "row"));
  const reportTestResponse = await fetch(`${base}/api/strategy-tests/${startedTest.request.id}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://scope.example/inquiry/1",
      matchScope: "row",
      selectorValid: true,
      unitCount: 3,
      matchedUnitCount: 1,
      matchedTerms: ["CAS", "待报价"],
      missingTerms: []
    })
  });
  assert.equal(reportTestResponse.status, 201);
  const reportedTest = await reportTestResponse.json();
  assert.equal(reportedTest.matchedUnitCount, 1);
  const completedTests = await (await fetch(`${base}/api/strategy-tests/pending`)).json();
  assert.equal(completedTests.tests.some(item => item.request.id === startedTest.request.id), false);
  const usedDeleteResponse = await adminFetch(`/api/admin/page-groups/${pageGroup.id}`, { method: "DELETE" });
  assert.equal(usedDeleteResponse.status, 409);
  const createdResponse = await memberFetch(`/api/personal-memos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ownerId: "admin_demo", deviceId: "forged-device", title: "临时备忘", body: "测试正文", rule: { includeTerms: ["测试"] } }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.ownerId, "user_demo");
  assert.equal(created.folderId, "memo_folder_personal_knowledge");
  const personalBulkMoveResponse = await adminFetch("/api/admin/memos/bulk", { method: "POST", body: JSON.stringify({ action: "move", memoIds: [created.id], folderId: bulkFolder.id }) });
  assert.equal(personalBulkMoveResponse.status, 400);
  assert.match((await personalBulkMoveResponse.json()).error, /个人提醒由系统自动归类/);
  const personalOperationResponse = await memberFetch(`/api/personal-memos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    type: "operation",
    title: "个人操作测试",
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    folderId: "forged_folder",
    rule: { includeTerms: ["个人操作"] }
  }) });
  assert.equal(personalOperationResponse.status, 201);
  const personalOperation = await personalOperationResponse.json();
  assert.equal(personalOperation.folderId, "memo_folder_personal_operation");
  const personalFolderState = await (await adminFetch("/api/admin/state")).json();
  assert.ok(personalFolderState.memoFolders.some(folder => folder.id === "memo_folder_personal_knowledge" && folder.name === "20-个人关注知识"));
  assert.ok(personalFolderState.memoFolders.some(folder => folder.id === "memo_folder_personal_operation" && folder.name === "99-个人操作提醒"));
  assert.equal((await adminFetch("/api/admin/memo-folders/memo_folder_personal_knowledge", { method: "DELETE" })).status, 409);
  assert.equal((await adminFetch("/api/admin/memo-folders/memo_folder_personal_operation", { method: "PUT", body: JSON.stringify({ name: "不可改名" }) })).status, 409);
  const updatedResponse = await memberFetch(`/api/personal-memos/${created.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "已更新备忘", body: "测试正文", rule: { includeTerms: ["测试"] } }) });
  assert.equal(updatedResponse.status, 200);
  assert.equal((await updatedResponse.json()).title, "已更新备忘");
  const organizationCommentResponse = await memberFetch(`/api/memos/${secondMemo.id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "组织知识评论" }) });
  const personalCommentResponse = await memberFetch(`/api/memos/${created.id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "个人知识评论" }) });
  assert.equal(organizationCommentResponse.status, 201);
  assert.equal(personalCommentResponse.status, 201);
  const personalComment = await personalCommentResponse.json();
  assert.equal(personalComment.userId, "user_demo");
  assert.equal(personalComment.canDelete, true);
  const personalComments = await (await memberFetch(`/api/memos/${created.id}/comments`)).json();
  assert.equal(personalComments.comments[0].content, "个人知识评论");
  assert.equal((await memberFetch(`/api/memo-comments/${personalComment.id}`, { method: "DELETE" })).status, 200);
  const eventResponse = await memberFetch(`/api/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "admin_demo", memoId: created.id, domain: "example.com", action: "triggered" }) });
  assert.equal(eventResponse.status, 201);
  const feedbackResponse = await memberFetch(`/api/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "admin_demo", deviceId: "forged-device", memoId: secondMemo.id, domain: "feedback.example.com", action: "helpful", presentation: "sidepanel" }) });
  assert.equal(feedbackResponse.status, 201);
  const feedbackUpResponse = await memberFetch(`/api/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memoId: secondMemo.id, domain: "feedback.example.com", action: "feedback_up", presentation: "sidepanel" }) });
  assert.equal(feedbackUpResponse.status, 201);
  assert.equal((await feedbackUpResponse.json()).feedback.action, "feedback_up");
  const feedbackDownResponse = await memberFetch(`/api/events`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memoId: secondMemo.id, domain: "feedback.example.com", action: "feedback_down", presentation: "sidepanel" }) });
  assert.equal(feedbackDownResponse.status, 201);
  assert.equal((await feedbackDownResponse.json()).feedback.action, "feedback_down");
  const feedbackBootstrap = await (await memberFetch("/api/bootstrap")).json();
  assert.equal(feedbackBootstrap.memos.find(item => item.id === secondMemo.id).myFeedback, undefined);
  const operationResponse = await adminFetch("/api/admin/memos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    type: "operation",
    title: "每日确认询单",
    body: "今日确认一次",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-12-31T00:00:00.000Z",
    targetUserIds: ["user_demo"],
    rule: { includeTerms: ["询单"] }
  }) });
  assert.equal(operationResponse.status, 201);
  const operation = await operationResponse.json();
  const operationCommentResponse = await memberFetch(`/api/memos/${operation.id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "组织操作评论" }) });
  assert.equal(operationCommentResponse.status, 201);
  const firstReceiptResponse = await memberFetch("/api/operation-receipts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memoId: operation.id }) });
  const secondReceiptResponse = await memberFetch("/api/operation-receipts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memoId: operation.id }) });
  assert.equal(firstReceiptResponse.status, 201);
  assert.equal(secondReceiptResponse.status, 200);
  assert.equal((await firstReceiptResponse.json()).id, (await secondReceiptResponse.json()).id);

  const alarmResponse = await memberFetch("/api/personal-alarms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    title: "每天回访",
    body: "联系客户",
    links: [{ label: "客户页", url: "https://example.com/customer" }],
    schedule: { mode: "daily", timeOfDay: "09:00", timezone: "Asia/Shanghai" }
  }) });
  assert.equal(alarmResponse.status, 410);

  const bootstrapAfterV21 = await (await memberFetch("/api/bootstrap")).json();
  assert.ok(bootstrapAfterV21.memos.some(item => item.id === operation.id && item.type === "operation"));
  assert.equal(bootstrapAfterV21.memos.find(item => item.id === secondMemo.id).commentCount, 1);
  assert.equal(Object.hasOwn(bootstrapAfterV21, "memoComments"), false);
  assert.ok(bootstrapAfterV21.operationReceipts.some(item => item.memoId === operation.id));
  assert.equal(Object.hasOwn(bootstrapAfterV21, "personalAlarms"), false);
  const adminState = await (await adminFetch(`/api/admin/state`)).json();
  assert.equal(adminState.stats.triggered, baselineTriggered + 1);
  assert.ok(adminState.memos.some(item => item.id === created.id && item.version === 2));
  assert.equal(adminState.pushStats.checkIntervalMinutes, 60);
  assert.equal(adminState.pushStats.activeSubscriptions, 1);
  assert.equal(Object.hasOwn(adminState, "pushSubscriptions"), false);
  assert.equal(adminState.pushDeliveries.at(-1).id, pushDelivery.id);
  assert.ok(adminState.pageGroups.some(item => item.id === pageGroup.id));
  assert.ok(adminState.pageGroups.some(item => item.id === secondPageGroup.id));
  assert.ok(adminState.memos.some(item => item.id === scopedMemo.id));
  assert.ok(adminState.memos.some(item => item.id === secondMemo.id && item.createdBy === "admin_demo"));
  assert.ok(adminState.tools.some(item => item.title === "COA生成器"));
  assert.ok(adminState.tools.some(item => item.title === "新增工具一"));
  assert.ok(adminState.tools.some(item => item.title === "新增工具二"));
  const secondMemoActivity = adminState.memoActivity.find(item => item.memoId === secondMemo.id);
  assert.equal(secondMemoActivity.comments[0].content, "组织知识评论");
  assert.equal(secondMemoActivity.stats.helpful, 1);
  assert.equal(secondMemoActivity.recentFeedback[0].userId, "user_demo");
  assert.equal(secondMemoActivity.recentFeedback[0].deviceId, "test-device");
  assert.equal(secondMemoActivity.recentFeedback[0].domain, "example.com");
  assert.equal(adminState.memoActivity.find(item => item.memoId === created.id).createdFromDeviceId, "test-device");
  assert.equal(Object.hasOwn(adminState, "personalAlarms"), false);
  assert.ok(adminState.operationReceipts.some(item => item.memoId === operation.id));
  assert.equal(adminState.accountEvents.filter(item => item.userId === "user_demo" && item.type === "member_login").length, 1);
  assert.ok(adminState.accountEvents.some(item => item.userId === "user_demo" && item.type === "device_bound"));
  assert.ok(adminState.deviceBindings.find(item => item.userId === "user_demo").lastLoginAt);
  assert.equal(Object.hasOwn(adminState.deviceBindings[0], "tokenHash"), false);
  assert.ok(adminState.auditLog.some(item => item.action === "created" && item.entityId === secondMemo.id && item.userId === "admin_demo"));
  const deletableMemoResponse = await adminFetch("/api/admin/memos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    title: "待删除组织提醒",
    body: "删除后不应保留 archived 实体",
    audienceType: "members",
    targetUserIds: ["user_demo"],
    rule: { includeTerms: ["删除测试"] }
  }) });
  assert.equal(deletableMemoResponse.status, 201);
  const deletableMemo = await deletableMemoResponse.json();
  const deleteOrganizationMemoResponse = await adminFetch(`/api/admin/memos/${deletableMemo.id}`, { method: "DELETE" });
  assert.equal(deleteOrganizationMemoResponse.status, 200);
  const deleteOrganizationMemoResult = await deleteOrganizationMemoResponse.json();
  assert.deepEqual(deleteOrganizationMemoResult, { ok: true, deletedId: deletableMemo.id, sync: { targetCount: 1, acceptedCount: 0 } });
  const stateAfterOrganizationDelete = await (await adminFetch("/api/admin/state")).json();
  assert.equal(stateAfterOrganizationDelete.memos.some(item => item.id === deletableMemo.id), false);
  assert.ok(stateAfterOrganizationDelete.auditLog.some(item => item.action === "deleted" && item.entityId === deletableMemo.id));
  assert.equal((await (await memberFetch("/api/bootstrap")).json()).memos.some(item => item.id === deletableMemo.id), false);
  assert.ok(fs.readdirSync(path.join(tempDir, "backups")).length > 0);
});

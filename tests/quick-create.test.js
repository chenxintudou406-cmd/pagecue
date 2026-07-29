const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");

const { canPublishOrganizationMemos } = require("../server.js");

test("only administrators or members of a publishing-enabled group can create organization reminders", () => {
  const db = {
    groups: [
      { id: "group_sales", name: "销售组", canPublishOrganizationMemos: false },
      { id: "group_management", name: "管理组", canPublishOrganizationMemos: true }
    ]
  };

  assert.equal(canPublishOrganizationMemos(db, { id: "sales", role: "member", groupIds: ["group_sales"] }), false);
  assert.equal(canPublishOrganizationMemos(db, { id: "manager", role: "member", groupIds: ["group_management"] }), true);
  assert.equal(canPublishOrganizationMemos(db, { id: "admin", role: "admin", groupIds: [] }), true);
});

test("quick reminder endpoint enforces personal and organization publishing permissions", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pagecue-quick-create-"));
  const dataFile = path.join(tempDir, "db.json");
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
  const ordinaryToken = "ordinary-device-token";
  const managerToken = "manager-device-token";
  data.groups = [
    { id: "group_sales", name: "销售组", canPublishOrganizationMemos: false },
    { id: "group_management", name: "管理组", canPublishOrganizationMemos: true }
  ];
  data.users = [
    { id: "user_ordinary", name: "普通成员", role: "member", groupIds: ["group_sales"], status: "active" },
    { id: "user_manager", name: "管理成员", role: "member", groupIds: ["group_management"], status: "active" }
  ];
  data.deviceBindings = [
    { id: "binding_ordinary", userId: "user_ordinary", deviceId: "ordinary-device", tokenHash: createHash("sha256").update(ordinaryToken).digest("hex"), status: "active" },
    { id: "binding_manager", userId: "user_manager", deviceId: "manager-device", tokenHash: createHash("sha256").update(managerToken).digest("hex"), status: "active" }
  ];
  data.memos = data.memos.filter(item => item.systemGeneratedSupplier);
  fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");

  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const value = probe.address().port;
      probe.close(() => resolve(value));
    });
  });
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(port), CONTEXT_COMPANION_DATA: dataFile },
    stdio: "ignore"
  });
  t.after(() => {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const memberFetch = (token, pathname, options = {}) => fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  const payload = {
    scope: "organization",
    type: "knowledge",
    title: "氯乙酸提醒",
    body: "报价前核对运输要求",
    rule: {
      pageScope: "global",
      pageGroupIds: [],
      sitePatterns: [],
      includeTerms: ["氯乙酸"],
      excludeTerms: [],
      operator: "OR",
      caseSensitive: false,
      useRegex: false,
      cooldownMinutes: 30
    }
  };

  const denied = await memberFetch(ordinaryToken, "/api/quick-memos", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(denied.status, 403);

  const tooLong = await memberFetch(ordinaryToken, "/api/quick-memos", {
    method: "POST",
    body: JSON.stringify({
      ...payload,
      scope: "personal",
      rule: { ...payload.rule, includeTerms: ["123456789012345678901"] }
    })
  });
  assert.equal(tooLong.status, 400);

  const personal = await memberFetch(ordinaryToken, "/api/quick-memos", {
    method: "POST",
    body: JSON.stringify({ ...payload, scope: "personal" })
  });
  assert.equal(personal.status, 201);
  const personalMemo = await personal.json();
  assert.equal(personalMemo.scope, "personal");
  assert.equal(personalMemo.ownerId, "user_ordinary");
  assert.equal(personalMemo.folderId, "memo_folder_personal_knowledge");

  const created = await memberFetch(managerToken, "/api/quick-memos", { method: "POST", body: JSON.stringify(payload) });
  assert.equal(created.status, 201);
  const organizationMemo = await created.json();
  assert.equal(organizationMemo.scope, "organization");
  assert.equal(organizationMemo.ownerId, null);
  assert.equal(organizationMemo.audienceType, "all");
  assert.deepEqual(organizationMemo.targetGroupIds, []);
  assert.deepEqual(organizationMemo.targetUserIds, []);
  assert.equal(organizationMemo.submittedByMemberId, "user_manager");

  const ordinaryBootstrap = await (await memberFetch(ordinaryToken, "/api/bootstrap")).json();
  const managerBootstrap = await (await memberFetch(managerToken, "/api/bootstrap")).json();
  assert.equal(ordinaryBootstrap.capabilities.canPublishOrganizationMemos, false);
  assert.equal(managerBootstrap.capabilities.canPublishOrganizationMemos, true);
});

test("admin group editor exposes the organization publishing permission", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "admin", "index.html"), "utf8");
  const app = fs.readFileSync(path.join(__dirname, "..", "admin", "app.js"), "utf8");

  assert.match(html, /name="canPublishOrganizationMemos"/);
  assert.match(html, /允许发布全员提醒/);
  assert.match(app, /state\.editingGroup\.canPublishOrganizationMemos/);
  assert.match(app, /canPublishOrganizationMemos:\s*data\.get\("canPublishOrganizationMemos"\)\s*===\s*"on"/);
});

test("extension exposes a selection context menu and quick reminder composer", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "extension", "manifest.json"), "utf8"));
  const worker = fs.readFileSync(path.join(__dirname, "..", "extension", "background", "service-worker.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "content.js"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "..", "extension", "content", "content.css"), "utf8");

  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.match(worker, /页知：创建提醒/);
  assert.match(worker, /chrome\.contextMenus\.onClicked/);
  assert.match(worker, /OPEN_QUICK_MEMO/);
  assert.match(worker, /CREATE_QUICK_MEMO/);
  assert.match(worker, /\/api\/quick-memos/);
  assert.match(worker, /activeMatch\?\.frameId/);
  assert.match(content, /OPEN_QUICK_MEMO/);
  assert.match(content, /canPublishOrganizationMemos/);
  assert.match(content, /cc-quick-memo-dialog/);
  assert.match(content, /isTrustedRichTextPage/);
  assert.match(content, /cc-rich-highlight/);
  assert.match(styles, /\.cc-rich-highlight\[data-cc-highlight\]/);
  assert.ok(manifest.content_scripts[0].js.includes("shared/quick-create-policy.js"));
  assert.match(worker, /shared\/quick-create-policy\.js/);
  assert.match(content, /PageCueQuickCreatePolicy\.validateSelection/);
  assert.match(content, /selectionStart/);
  assert.match(content, /formHasPassword/);
  assert.match(styles, /\.cc-quick-memo-dialog/);
});

test("management group migration is idempotent and does not assign members", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pagecue-management-group-"));
  const dataFile = path.join(tempDir, "db.json");
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "db.json"), "utf8"));
  data.groups = [
    ...(data.groups || []).filter(group => group.id !== "group_management" && group.name !== "管理组"),
    { id: "group_existing_management", name: "管理组", description: "线上已有管理组", canPublishOrganizationMemos: false }
  ];
  data.users = [{ id: "user_sales", name: "销售", role: "member", groupIds: ["group_sales"], status: "active" }];
  fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  const script = path.join(__dirname, "..", "scripts", "migrate-management-group-v326.js");

  const first = require("node:child_process").spawnSync(process.execPath, [script], {
    env: { ...process.env, CONTEXT_COMPANION_DATA: dataFile },
    encoding: "utf8"
  });
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(afterFirst.groups.filter(group => group.name === "管理组").length, 1);
  assert.equal(afterFirst.groups.find(group => group.name === "管理组").id, "group_existing_management");
  assert.equal(afterFirst.groups.find(group => group.name === "管理组").canPublishOrganizationMemos, true);
  assert.deepEqual(afterFirst.users[0].groupIds, ["group_sales"]);

  const second = require("node:child_process").spawnSync(process.execPath, [script], {
    env: { ...process.env, CONTEXT_COMPANION_DATA: dataFile },
    encoding: "utf8"
  });
  assert.equal(second.status, 0, second.stderr);
  const afterSecond = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(afterSecond.groups.filter(group => group.name === "管理组").length, 1);
  assert.deepEqual(afterSecond.users[0].groupIds, ["group_sales"]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

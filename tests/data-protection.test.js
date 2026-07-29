const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { backupDatabase } = require("../scripts/backup-data.js");
const { verifyBackup, restoreBackup } = require("../scripts/restore-backup.js");

function fixture() {
  return {
    meta: { organizationId: "org_test", schemaVersion: 3 },
    users: [{ id: "member_a", name: "张三", groupIds: ["sales"], status: "active" }],
    groups: [{ id: "sales", name: "销售组" }],
    memos: [{ id: "memo_a", version: 2, scope: "organization", title: "报价提醒", createdBy: "member_a", targetUserIds: ["member_a"], targetGroupIds: [] }],
    memoComments: [{ id: "comment_a", memoId: "memo_a", userId: "member_a", content: "需要补充" }],
    events: [{ id: "event_a", userId: "member_a", memoId: "memo_a", domain: "https://www.biochemsafebuy.com/admin/enquiries?secret=1", action: "opened", createdAt: "2026-07-24T00:00:00.000Z" }],
    auditLog: [{ id: "audit_a", userId: "member_a", action: "created" }],
    accountEvents: [{ id: "account_a", userId: "member_a", type: "device_bound" }],
    operationReceipts: [{ id: "receipt_a", memoId: "memo_a", userId: "member_a", localDate: "2026-07-24" }],
    deviceBindings: [{ id: "binding_a", userId: "member_a", deviceId: "device_a" }],
    invitations: [{ id: "invite_a", userId: "member_a" }]
  };
}

test("备份包含哈希和集合计数，恢复后数据完全一致", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagecue-backup-"));
  const dataFile = path.join(directory, "db.json");
  fs.writeFileSync(dataFile, `${JSON.stringify(fixture(), null, 2)}\n`);
  const result = backupDatabase({ dataFile, backupDir: path.join(directory, "backups"), now: new Date("2026-07-24T08:00:00.000Z") });
  assert.equal(verifyBackup(result.backupFile).counts.memos, 1);
  const restoredFile = path.join(directory, "restore", "db.json");
  restoreBackup(result.backupFile, restoredFile);
  assert.deepEqual(JSON.parse(fs.readFileSync(restoredFile, "utf8")), fixture());
});

test("P0 迁移保留原记录并补齐成员快照、投放范围和网站归类", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagecue-p0-"));
  const dataFile = path.join(directory, "db.json");
  fs.writeFileSync(dataFile, `${JSON.stringify(fixture(), null, 2)}\n`);
  execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "migrate-p0.js")], {
    env: { ...process.env, CONTEXT_COMPANION_DATA: dataFile },
    stdio: "pipe"
  });
  const migrated = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(migrated.memos.length, 1);
  assert.equal(migrated.memoComments.length, 1);
  assert.equal(migrated.events.length, 1);
  assert.equal(migrated.memos[0].audienceType, "members");
  assert.equal(migrated.memos[0].submittedByMemberId, "member_a");
  assert.equal(migrated.memos[0].submittedByNameSnapshot, "张三");
  assert.equal(migrated.memoComments[0].memberId, "member_a");
  assert.equal(migrated.events[0].pageBucket, "biochemsafebuy.com/admin");
  assert.equal(migrated.invitations[0].memberId, "member_a");
  assert.equal(migrated.auditLog[0].memberId, "member_a");
  assert.equal(migrated.accountEvents[0].memberNameSnapshot, "张三");
  assert.equal(migrated.operationReceipts[0].memberId, "member_a");
  assert.equal(migrated.deviceBindings[0].memberId, "member_a");
  assert.ok(migrated.submissionSnapshots.some(item => item.entityType === "memo" && item.entityId === "memo_a"));
  assert.ok(migrated.submissionSnapshots.some(item => item.entityType === "comment" && item.entityId === "comment_a"));
  assert.ok(fs.readdirSync(path.join(directory, "backups", "protected")).some(name => name.endsWith(".json")));
});

test("默认成员分组迁移保留 ID、成员关系和自定义分组且可重复执行", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagecue-groups-"));
  const dataFile = path.join(directory, "db.json");
  const data = fixture();
  data.groups = [
    { id: "group_sales", name: "销售组" },
    { id: "group_support", name: "客服组" },
    { id: "group_custom", name: "特殊项目组" }
  ];
  data.users[0].groupIds = ["group_support", "group_custom"];
  fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`);
  const run = () => execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "migrate-groups-v320.js")], {
    env: { ...process.env, CONTEXT_COMPANION_DATA: dataFile },
    stdio: "pipe"
  });
  run();
  const once = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.deepEqual(once.users[0].groupIds, ["group_support", "group_custom"]);
  assert.equal(once.groups.find(item => item.id === "group_support").name, "支持组");
  assert.equal(once.groups.find(item => item.id === "group_procurement").name, "采购组");
  assert.equal(once.groups.find(item => item.id === "group_sales").name, "销售组");
  assert.equal(once.groups.find(item => item.id === "group_custom").name, "特殊项目组");
  const auditCount = once.auditLog.filter(item => item.action === "migrated_default_groups_v320").length;
  run();
  const twice = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(twice.auditLog.filter(item => item.action === "migrated_default_groups_v320").length, auditCount);
  assert.deepEqual(twice.groups.map(item => item.id), once.groups.map(item => item.id));
});

test("个人提醒文件夹迁移只归类个人提醒并保持组织提醒不变", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagecue-personal-folders-"));
  const dataFile = path.join(directory, "db.json");
  const data = fixture();
  data.memoFolders = [
    { id: "custom_folder", name: "组织知识", status: "active" },
    { id: "existing_personal_knowledge", name: "20-个人关注知识", status: "active" },
    { id: "existing_personal_operation", name: "99-个人操作提醒", status: "active" }
  ];
  data.memos = [
    { id: "personal_knowledge", scope: "personal", type: "knowledge", ownerId: "member_a", folderId: null },
    { id: "personal_operation", scope: "personal", type: "operation", ownerId: "member_a", folderId: "legacy_folder" },
    { id: "organization_memo", scope: "organization", type: "knowledge", folderId: "custom_folder" }
  ];
  fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`);
  const run = () => execFileSync(process.execPath, [path.join(__dirname, "..", "scripts", "migrate-personal-folders-v320.js")], {
    env: { ...process.env, CONTEXT_COMPANION_DATA: dataFile },
    stdio: "pipe"
  });
  run();
  const once = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(once.memos.find(item => item.id === "personal_knowledge").folderId, "existing_personal_knowledge");
  assert.equal(once.memos.find(item => item.id === "personal_operation").folderId, "existing_personal_operation");
  assert.equal(once.memos.find(item => item.id === "organization_memo").folderId, "custom_folder");
  assert.ok(once.memoFolders.some(folder => folder.id === "existing_personal_knowledge" && folder.systemManaged));
  assert.ok(once.memoFolders.some(folder => folder.id === "existing_personal_operation" && folder.systemManaged));
  assert.equal(once.memoFolders.filter(folder => folder.name === "20-个人关注知识").length, 1);
  assert.equal(once.memoFolders.filter(folder => folder.name === "99-个人操作提醒").length, 1);
  const auditCount = once.auditLog.filter(item => item.action === "migrated_personal_memo_folders_v320").length;
  run();
  const twice = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(twice.auditLog.filter(item => item.action === "migrated_personal_memo_folders_v320").length, auditCount);
});

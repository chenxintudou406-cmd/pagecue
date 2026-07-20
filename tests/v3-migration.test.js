const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("V3 迁移保留提醒与历史，只归档闹钟并补齐强度字段", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pagecue-v3-"));
  const file = path.join(directory, "db.json");
  const original = {
    meta: { version: 8 },
    memos: [{ id: "m1", scope: "organization", priority: "important", annotation: { template: "strong", keywordTerms: ["CAS"], anchors: [] } }],
    personalAlarms: [{ id: "a1", status: "active", nextTriggerAt: "2099-01-01T00:00:00.000Z" }],
    events: [{ id: "e1" }], auditLog: []
  };
  fs.writeFileSync(file, JSON.stringify(original), "utf8");
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "scripts", "migrate-v3.js")], { env: { ...process.env, CONTEXT_COMPANION_DATA: file }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(migrated.memos.length, 1);
  assert.equal(migrated.events.length, 1);
  assert.equal(migrated.memos[0].intensity, "heavy");
  assert.equal(migrated.personalAlarms[0].status, "archived");
  assert.equal(migrated.personalAlarms[0].archivedReason, "feature_retired_v3");
  assert.equal(migrated.meta.schemaVersion, 3);
  assert.ok(fs.readdirSync(path.join(directory, "backups")).some(name => name.startsWith("pre-v3-")));
});

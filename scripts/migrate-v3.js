const fs = require("node:fs");
const path = require("node:path");

const dataFile = process.env.CONTEXT_COMPANION_DATA || path.join(__dirname, "..", "data", "db.json");
const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const now = new Date().toISOString();
const backupDir = path.join(path.dirname(dataFile), "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, `pre-v3-${Date.now()}.json`);
fs.copyFileSync(dataFile, backupFile);

const aliases = { light: "light", medium: "standard", standard: "standard", heavy: "strong", strong: "strong" };
let migratedMemos = 0;
for (const memo of data.memos || []) {
  const fallback = memo.scope === "personal" ? "light" : memo.priority === "important" ? "strong" : "standard";
  const template = aliases[memo.annotation?.template || memo.intensity] || fallback;
  memo.annotation = { ...(memo.annotation || {}), template, intensity: template === "strong" ? "heavy" : template === "standard" ? "medium" : "light" };
  memo.intensity = memo.annotation.intensity;
  migratedMemos += 1;
}

let archivedAlarms = 0;
for (const alarm of data.personalAlarms || []) {
  if (alarm.status === "active") {
    alarm.status = "archived";
    alarm.archivedReason = "feature_retired_v3";
    alarm.nextTriggerAt = null;
    alarm.snoozedUntil = null;
    alarm.updatedAt = now;
    archivedAlarms += 1;
  }
}

data.meta ||= {};
data.meta.schemaVersion = 3;
data.meta.productVersion = "3.0.0";
data.meta.migratedToV3At ||= now;
data.auditLog ||= [];
if (!data.auditLog.some(item => item.action === "migrated_to_v3")) {
  data.auditLog.push({ id: `audit_v3_${Date.now()}`, action: "migrated_to_v3", entityType: "system", entityId: "pagecue", userId: "system", details: { migratedMemos, archivedAlarms }, createdAt: now });
}

const temp = `${dataFile}.v3.tmp`;
fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
fs.renameSync(temp, dataFile);
console.log(JSON.stringify({ dataFile, backupFile, migratedMemos, archivedAlarms }));

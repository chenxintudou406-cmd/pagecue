const fs = require("node:fs");
const path = require("node:path");
const { backupDatabase } = require("./backup-data.js");

const dataFile = path.resolve(process.env.CONTEXT_COMPANION_DATA || path.join(__dirname, "..", "data", "db.json"));
const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const backup = backupDatabase({ dataFile });
const now = new Date().toISOString();

data.groups = Array.isArray(data.groups) ? data.groups : [];
data.auditLog = Array.isArray(data.auditLog) ? data.auditLog : [];
data.meta = data.meta && typeof data.meta === "object" ? data.meta : { version: 0 };

const definition = {
  id: "group_management",
  name: "管理组",
  description: "可从网页右键创建全体成员提醒的管理成员",
  canPublishOrganizationMemos: true
};

let group = data.groups.find(item => item.id === definition.id || item.name === definition.name);
let changed = false;
if (!group) {
  group = {
    ...definition,
    createdBy: "system",
    updatedBy: "system",
    createdAt: now,
    updatedAt: now
  };
  data.groups.push(group);
  changed = true;
} else {
  const managedValues = {
    name: definition.name,
    description: group.description || definition.description,
    canPublishOrganizationMemos: true
  };
  for (const [key, value] of Object.entries(managedValues)) {
    if (group[key] === value) continue;
    group[key] = value;
    changed = true;
  }
  if (changed) {
    group.updatedBy = "system";
    group.updatedAt = now;
  }
}

if (changed) {
  data.auditLog.push({
    id: `audit_management_group_${Date.now()}`,
    action: "migrated_management_group_v326",
    entityType: "group",
    entityId: definition.id,
    userId: "system",
    memberId: "system",
    memberNameSnapshot: "系统",
    details: { backupFile: backup.backupFile, autoAssignedMembers: 0 },
    createdAt: now
  });
  data.meta.version = Number(data.meta.version || 0) + 1;
}

const temporary = `${dataFile}.${process.pid}.management-group.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
fs.renameSync(temporary, dataFile);

process.stdout.write(`${JSON.stringify({
  dataFile,
  backupFile: backup.backupFile,
  changed,
  group: {
    id: group.id,
    name: group.name,
    canPublishOrganizationMemos: group.canPublishOrganizationMemos
  },
  autoAssignedMembers: 0
}, null, 2)}\n`);

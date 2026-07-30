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

const defaults = [
  { id: "group_support", name: "支持组", legacyNames: ["客服组"], description: "支持、客服与内部协同成员" },
  { id: "group_procurement", name: "采购组", legacyNames: [], description: "采购与供应商协同成员" },
  { id: "group_sales", name: "销售组", legacyNames: [], description: "销售与客户协同成员" }
];

let changed = false;
for (const definition of defaults) {
  let group = data.groups.find(item => item.id === definition.id);
  if (!group) {
    group = {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      createdBy: "system",
      updatedBy: "system",
      createdAt: now,
      updatedAt: now
    };
    data.groups.push(group);
    changed = true;
    continue;
  }
  if (definition.legacyNames.includes(group.name)) {
    group.name = definition.name;
    group.updatedBy = "system";
    group.updatedAt = now;
    changed = true;
  }
  if (!Object.hasOwn(group, "description")) {
    group.description = definition.description;
    changed = true;
  }
}

if (changed && !data.auditLog.some(item => item.action === "migrated_default_groups_v320")) {
  data.auditLog.push({
    id: `audit_groups_${Date.now()}`,
    action: "migrated_default_groups_v320",
    entityType: "system",
    entityId: "groups",
    userId: "system",
    memberId: "system",
    memberNameSnapshot: "系统",
    details: { backupFile: backup.backupFile, groupIds: defaults.map(item => item.id) },
    createdAt: now
  });
}

if (changed) data.meta.version = Number(data.meta.version || 0) + 1;
const temporary = `${dataFile}.${process.pid}.groups.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
fs.renameSync(temporary, dataFile);

process.stdout.write(`${JSON.stringify({
  dataFile,
  backupFile: backup.backupFile,
  changed,
  groups: data.groups.map(item => ({ id: item.id, name: item.name }))
}, null, 2)}\n`);

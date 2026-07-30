const fs = require("node:fs");
const path = require("node:path");
const { backupDatabase } = require("./backup-data.js");

const dataFile = path.resolve(process.env.CONTEXT_COMPANION_DATA || path.join(__dirname, "..", "data", "db.json"));
const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const backup = backupDatabase({ dataFile });
const now = new Date().toISOString();

data.memoFolders = Array.isArray(data.memoFolders) ? data.memoFolders : [];
data.memos = Array.isArray(data.memos) ? data.memos : [];
data.auditLog = Array.isArray(data.auditLog) ? data.auditLog : [];
data.meta = data.meta && typeof data.meta === "object" ? data.meta : { version: 0 };

const definitions = [
  {
    id: "memo_folder_personal_knowledge",
    name: "20-个人关注知识",
    description: "成员自己提交的个人知识提醒自动归类",
    sortOrder: 20,
    scope: "personal",
    systemKey: "personal_knowledge"
  },
  {
    id: "memo_folder_personal_operation",
    name: "99-个人操作提醒",
    description: "成员自己提交的个人操作提醒自动归类",
    sortOrder: 99,
    scope: "personal",
    systemKey: "personal_operation"
  }
];

let changed = false;
for (const definition of definitions) {
  let folder = data.memoFolders.find(item => item.systemKey === definition.systemKey || item.id === definition.id || item.name === definition.name);
  if (!folder) {
    folder = {
      ...definition,
      status: "active",
      systemManaged: true,
      createdBy: "system",
      updatedBy: "system",
      createdAt: now,
      updatedAt: now
    };
    data.memoFolders.push(folder);
    changed = true;
    continue;
  }
  let folderChanged = false;
  const { id: _defaultId, ...managedDefinition } = definition;
  for (const [key, value] of Object.entries({ ...managedDefinition, status: "active", systemManaged: true })) {
    if (folder[key] !== value) {
      folder[key] = value;
      folderChanged = true;
    }
  }
  if (folderChanged) {
    folder.updatedBy = "system";
    folder.updatedAt = now;
    changed = true;
  }
}

let reassigned = 0;
for (const memo of data.memos) {
  if (memo.scope !== "personal") continue;
  const definition = definitions[memo.type === "operation" ? 1 : 0];
  const folderId = data.memoFolders.find(item => item.systemKey === definition.systemKey || item.id === definition.id || item.name === definition.name).id;
  if (memo.folderId === folderId) continue;
  memo.folderId = folderId;
  memo.updatedAt = now;
  reassigned += 1;
  changed = true;
}

if (changed && !data.auditLog.some(item => item.action === "migrated_personal_memo_folders_v320")) {
  data.auditLog.push({
    id: `audit_personal_folders_${Date.now()}`,
    action: "migrated_personal_memo_folders_v320",
    entityType: "system",
    entityId: "memoFolders",
    userId: "system",
    memberId: "system",
    memberNameSnapshot: "系统",
    detail: { backupFile: backup.backupFile, reassigned },
    createdAt: now
  });
}

if (changed) data.meta.version = Number(data.meta.version || 0) + 1;
const temporary = `${dataFile}.${process.pid}.personal-folders.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
fs.renameSync(temporary, dataFile);

process.stdout.write(`${JSON.stringify({
  dataFile,
  backupFile: backup.backupFile,
  changed,
  reassigned,
  memoFolders: data.memoFolders.map(item => ({ id: item.id, name: item.name, systemManaged: Boolean(item.systemManaged) }))
}, null, 2)}\n`);

const fs = require("node:fs");
const path = require("node:path");

const filename = path.resolve(process.argv[2] || path.join(__dirname, "..", "data", "db.json"));
const source = fs.readFileSync(filename, "utf8");
const db = JSON.parse(source);
const before = { memos: (db.memos || []).length, events: (db.events || []).length, pageGroups: (db.pageGroups || []).length, tools: (db.tools || []).length };
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const backupDir = path.join(path.dirname(filename), "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `pre-v21-${stamp}.json`);
fs.writeFileSync(backup, source);

for (const key of ["operationReceipts", "personalAlarms", "invitations", "deviceBindings"]) if (!Array.isArray(db[key])) db[key] = [];
db.users = (db.users || []).map(user => ({ ...user, groupIds: Array.isArray(user.groupIds) ? user.groupIds : [], status: user.status === "disabled" ? "disabled" : "active" }));
db.memos = (db.memos || []).map(memo => ({
  ...memo,
  type: memo.type === "operation" ? "operation" : "knowledge",
  targetUserIds: Array.isArray(memo.targetUserIds) ? memo.targetUserIds : [],
  links: Array.isArray(memo.links) ? memo.links.slice(0, 20) : [],
  dailyReminder: memo.type === "operation" ? { enabled: true, timezone: memo.dailyReminder?.timezone || "Asia/Shanghai" } : { enabled: false, timezone: "Asia/Shanghai" }
}));
const after = { memos: db.memos.length, events: (db.events || []).length, pageGroups: (db.pageGroups || []).length, tools: (db.tools || []).length };
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("迁移前后核心数据数量不一致");
const temporary = `${filename}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(db, null, 2)}\n`);
fs.renameSync(temporary, filename);
console.log(JSON.stringify({ backup, before, after, operationReceipts: db.operationReceipts.length, personalAlarms: db.personalAlarms.length }));

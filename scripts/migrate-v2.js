const fs = require("node:fs");
const path = require("node:path");

const filename = path.resolve(process.argv[2] || path.join(__dirname, "..", "data", "db.json"));
const source = fs.readFileSync(filename, "utf8");
const db = JSON.parse(source);
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const backupDir = path.join(path.dirname(filename), "backups");
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `pre-v2-${stamp}.json`);
fs.writeFileSync(backup, source);

db.annotationSessions = Array.isArray(db.annotationSessions) ? db.annotationSessions : [];
db.memos = (db.memos || []).map(memo => ({
  ...memo,
  annotation: memo.annotation && typeof memo.annotation === "object" ? {
    template: ["light", "standard", "strong"].includes(memo.annotation.template) ? memo.annotation.template : (memo.scope === "personal" ? "light" : memo.priority === "important" ? "strong" : "standard"),
    keywordTerms: Array.isArray(memo.annotation.keywordTerms) ? memo.annotation.keywordTerms : [],
    anchors: Array.isArray(memo.annotation.anchors) ? memo.annotation.anchors.slice(0, 20) : []
  } : {
    template: memo.scope === "personal" ? "light" : memo.priority === "important" ? "strong" : "standard",
    keywordTerms: [],
    anchors: []
  }
}));

const temporary = `${filename}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(db, null, 2)}\n`);
fs.renameSync(temporary, filename);
console.log(JSON.stringify({ backup, memos: db.memos.length, events: (db.events || []).length, pageGroups: (db.pageGroups || []).length, tools: (db.tools || []).length }));

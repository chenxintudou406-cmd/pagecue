const fs = require("node:fs");
const path = require("node:path");
const { backupDatabase } = require("./backup-data.js");
const { normalizeAudience, normalizePageBucket, createSubmissionSnapshot } = require("../shared/p0-model.js");

const dataFile = path.resolve(process.env.CONTEXT_COMPANION_DATA || path.join(__dirname, "..", "data", "db.json"));
const data = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const now = new Date().toISOString();
const backup = backupDatabase({ dataFile });

for (const key of ["submissionSnapshots", "memberFeedback", "broadcastReceipts"]) {
  if (!Array.isArray(data[key])) data[key] = [];
}

const userName = memberId => data.users?.find(user => user.id === memberId)?.name || memberId || "历史成员";
for (const invitation of data.invitations || []) invitation.memberId ||= invitation.userId || null;

for (const memo of data.memos || []) {
  Object.assign(memo, normalizeAudience(memo, { allowEmpty: true }));
  memo.triggerMode = memo.triggerMode === "broadcast" ? "broadcast" : "page_match";
  memo.createdByMemberId ||= memo.createdBy || memo.ownerId || null;
  memo.submittedByMemberId ||= memo.createdByMemberId;
  memo.createdByNameSnapshot ||= userName(memo.createdByMemberId);
  memo.submittedByNameSnapshot ||= memo.integration?.submittedBy || userName(memo.submittedByMemberId);
  const exists = data.submissionSnapshots.some(item => item.entityType === "memo" && item.entityId === memo.id && item.entityVersion === Number(memo.version || 1));
  if (!exists) data.submissionSnapshots.push(createSubmissionSnapshot(memo, {
    entityType: "memo",
    actorMemberId: memo.submittedByMemberId || "migration",
    actorName: memo.submittedByNameSnapshot || "历史成员",
    source: "migration",
    now
  }));
}

for (const comment of data.memoComments || []) {
  comment.memberId ||= comment.userId || null;
  comment.memberNameSnapshot ||= userName(comment.memberId);
  const exists = data.submissionSnapshots.some(item => item.entityType === "comment" && item.entityId === comment.id);
  if (!exists) data.submissionSnapshots.push(createSubmissionSnapshot(comment, {
    entityType: "comment",
    actorMemberId: comment.memberId || "migration",
    actorName: comment.memberNameSnapshot || "历史成员",
    source: "migration",
    now
  }));
}

for (const event of data.events || []) {
  event.memberId ||= event.userId || null;
  event.memberNameSnapshot ||= userName(event.memberId);
  event.eventId ||= `legacy:${event.id}`;
  event.pageBucket = normalizePageBucket(event.pageBucket || event.domain || "unknown");
  event.domain = event.pageBucket;
  event.occurredAt ||= event.createdAt || now;
}

for (const audit of data.auditLog || []) {
  audit.memberId ||= audit.userId || null;
  audit.memberNameSnapshot ||= userName(audit.memberId);
}

for (const accountEvent of data.accountEvents || []) {
  accountEvent.memberId ||= accountEvent.userId || null;
  accountEvent.memberNameSnapshot ||= userName(accountEvent.memberId);
}

for (const receipt of data.operationReceipts || []) {
  receipt.memberId ||= receipt.userId || null;
  receipt.memberNameSnapshot ||= userName(receipt.memberId);
}

for (const binding of data.deviceBindings || []) binding.memberId ||= binding.userId || null;

data.meta ||= {};
data.meta.schemaVersion = Math.max(4, Number(data.meta.schemaVersion || 0));
data.meta.productVersion = "3.2.0";
data.meta.migratedToP0At ||= now;
data.auditLog ||= [];
if (!data.auditLog.some(item => item.action === "migrated_to_p0")) {
  data.auditLog.push({
    id: `audit_p0_${Date.now()}`,
    action: "migrated_to_p0",
    entityType: "system",
    entityId: "pagecue",
    userId: "system",
    memberId: "system",
    memberNameSnapshot: "系统",
    details: { backupFile: backup.backupFile },
    createdAt: now
  });
}

const temporary = `${dataFile}.${process.pid}.p0.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, "utf8");
fs.renameSync(temporary, dataFile);
process.stdout.write(`${JSON.stringify({ dataFile, backupFile: backup.backupFile, memos: data.memos?.length || 0, snapshots: data.submissionSnapshots.length }, null, 2)}\n`);

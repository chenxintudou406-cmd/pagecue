const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeAudience,
  normalizePageBucket,
  createSubmissionSnapshot,
  funnelStats
} = require("../shared/p0-model.js");

test("提醒投放方式在全体、成员组和成员之间互斥", () => {
  assert.deepEqual(normalizeAudience({ audienceType: "all", targetGroupIds: ["sales"], targetUserIds: ["u1"] }), {
    audienceType: "all",
    targetGroupIds: [],
    targetUserIds: []
  });
  assert.deepEqual(normalizeAudience({ audienceType: "groups", targetGroupIds: ["sales", "sales"], targetUserIds: ["u1"] }), {
    audienceType: "groups",
    targetGroupIds: ["sales"],
    targetUserIds: []
  });
  assert.deepEqual(normalizeAudience({ audienceType: "members", targetGroupIds: ["sales"], targetUserIds: ["u1", "u2"] }), {
    audienceType: "members",
    targetGroupIds: [],
    targetUserIds: ["u1", "u2"]
  });
  assert.throws(() => normalizeAudience({ audienceType: "groups", targetGroupIds: [] }), /成员组/);
  assert.throws(() => normalizeAudience({ audienceType: "members", targetUserIds: [] }), /成员/);
});

test("网站归类只保存业务域名并单独拆分 Biochemsafebuy 后台", () => {
  assert.equal(normalizePageBucket("https://supplier.chemicalbook.com/product?id=secret"), "chemicalbook.com");
  assert.equal(normalizePageBucket("https://www.biochemsafebuy.com/79-11-8-p123/"), "biochemsafebuy.com");
  assert.equal(normalizePageBucket("https://www.biochemsafebuy.com/admin/enquiries?token=secret"), "biochemsafebuy.com/admin");
  assert.equal(normalizePageBucket("file:///C:/private/report.pdf"), "file");
  assert.equal(normalizePageBucket("sub.example.com"), "example.com");
});

test("提交快照包含成员和姓名快照且内容哈希稳定", () => {
  const entity = { id: "memo_1", title: "报价前核查", body: "检查合同", targetUserIds: ["u1"] };
  const first = createSubmissionSnapshot(entity, {
    entityType: "memo",
    actorMemberId: "admin_demo",
    actorName: "陈鑫",
    source: "admin",
    requestId: "request-1",
    now: "2026-07-24T01:00:00.000Z"
  });
  const second = createSubmissionSnapshot({ ...entity }, {
    entityType: "memo",
    actorMemberId: "admin_demo",
    actorName: "陈鑫",
    source: "admin",
    requestId: "request-1",
    now: "2026-07-24T02:00:00.000Z"
  });
  assert.equal(first.actorMemberId, "admin_demo");
  assert.equal(first.actorNameSnapshot, "陈鑫");
  assert.equal(first.contentHash, second.contentHash);
  assert.equal(first.payload.title, "报价前核查");
});

test("漏斗同时返回事件次数、去重成员数和任意互动", () => {
  const events = [
    { memberId: "u1", memoId: "m1", action: "matched", pageBucket: "chemicalbook.com" },
    { memberId: "u1", memoId: "m1", action: "matched", pageBucket: "chemicalbook.com" },
    { memberId: "u2", memoId: "m1", action: "matched", pageBucket: "chemicalbook.com" },
    { memberId: "u1", memoId: "m1", action: "expanded", pageBucket: "chemicalbook.com" },
    { memberId: "u1", memoId: "m1", action: "link_opened", pageBucket: "chemicalbook.com" },
    { memberId: "u2", memoId: "m1", action: "comment_submitted", pageBucket: "chemicalbook.com" }
  ];
  const stats = funnelStats(events);
  assert.deepEqual(stats.actions.matched, { events: 3, members: 2 });
  assert.deepEqual(stats.actions.expanded, { events: 1, members: 1 });
  assert.deepEqual(stats.anyInteraction, { events: 2, members: 2 });
});

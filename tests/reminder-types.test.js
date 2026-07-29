const test = require("node:test");
const assert = require("node:assert/strict");
const { cleanMemo, cleanMemoFolder, cleanPersonalAlarm, visibleTo, localDateKey } = require("../server.js");

test("现有提醒默认迁移为知识提醒，操作提醒必须有有效期限", () => {
  const knowledge = cleanMemo({ title: "旧提醒", rule: {} });
  assert.equal(knowledge.type, "knowledge");

  assert.throws(
    () => cleanMemo({ type: "operation", title: "跟进询单", startsAt: null, expiresAt: null, rule: {} }),
    /开始和结束时间/
  );

  const operation = cleanMemo({
    type: "operation",
    title: "跟进询单",
    startsAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-20T00:00:00.000Z",
    rule: {}
  });
  assert.equal(operation.type, "operation");
  assert.deepEqual(operation.dailyReminder, { enabled: true, timezone: "Asia/Shanghai" });
});

test("组织提醒按全体、成员组或指定成员互斥投放", () => {
  const sales = { id: "u_sales", groupIds: ["sales"] };
  const support = { id: "u_support", groupIds: ["support"] };
  const direct = { id: "u_direct", groupIds: ["other"] };
  const memberMemo = { scope: "organization", audienceType: "members", targetUserIds: ["u_direct"], targetGroupIds: [] };
  const groupMemo = { scope: "organization", audienceType: "groups", targetUserIds: [], targetGroupIds: ["sales"] };
  const allMemo = { scope: "organization", audienceType: "all", targetUserIds: [], targetGroupIds: [] };

  assert.equal(visibleTo(memberMemo, direct), true);
  assert.equal(visibleTo(memberMemo, sales), false);
  assert.equal(visibleTo(groupMemo, sales), true);
  assert.equal(visibleTo(groupMemo, support), false);
  assert.equal(visibleTo(allMemo, support), true);
});

test("三类提醒链接仅保留 HTTP 和 HTTPS 地址", () => {
  const memo = cleanMemo({
    title: "资料入口",
    links: [
      { label: "SOP", url: "https://example.com/sop" },
      { label: "危险链接", url: "javascript:alert(1)" },
      { label: "站内工具", url: "http://localhost/tool" }
    ],
    rule: {}
  });
  assert.deepEqual(memo.links, [
    { label: "SOP", url: "https://example.com/sop" },
    { label: "站内工具", url: "http://localhost/tool" }
  ]);
});

test("提醒支持后台文件夹归类且不改变触发规则", () => {
  const folder = cleanMemoFolder({ name: " 报价知识 ", description: "批量导入使用", sortOrder: 2 });
  const memo = cleanMemo({ title: "报价前核查", folderId: folder.id, rule: { includeTerms: ["报价"], operator: "OR" } });
  assert.equal(folder.name, "报价知识");
  assert.equal(folder.status, "active");
  assert.equal(memo.folderId, folder.id);
  assert.equal(memo.rule.operator, "OR");
});

test("操作提醒按成员时区生成每日确认日期", () => {
  assert.equal(localDateKey("2026-07-18T15:59:59.000Z", "Asia/Shanghai"), "2026-07-18");
  assert.equal(localDateKey("2026-07-18T16:00:00.000Z", "Asia/Shanghai"), "2026-07-19");
  assert.equal(localDateKey("2026-07-18T16:00:00.000Z", "Invalid/Timezone"), "2026-07-19");
});

test("个人闹钟保存统一字段并计算下一次触发", () => {
  const alarm = cleanPersonalAlarm({
    ownerId: "user_demo",
    title: "联系客户",
    body: "确认报价",
    links: [{ label: "询单", url: "https://example.com/inquiry/1" }],
    schedule: { mode: "once", triggerAt: "2099-07-20T01:00:00.000Z", timezone: "Asia/Shanghai" }
  });
  assert.equal(alarm.ownerId, "user_demo");
  assert.equal(alarm.status, "active");
  assert.equal(alarm.nextTriggerAt, "2099-07-20T01:00:00.000Z");
  assert.equal(alarm.links.length, 1);
});

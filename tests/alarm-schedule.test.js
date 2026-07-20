const test = require("node:test");
const assert = require("node:assert/strict");
const { nextAlarmOccurrence } = require("../extension/shared/alarm-schedule.js");

test("单次闹钟只返回尚未到达的触发时间", () => {
  const schedule = { mode: "once", triggerAt: "2026-07-20T01:00:00.000Z", timezone: "Asia/Shanghai" };
  assert.equal(nextAlarmOccurrence(schedule, "2026-07-20T00:00:00.000Z"), "2026-07-20T01:00:00.000Z");
  assert.equal(nextAlarmOccurrence(schedule, "2026-07-20T01:00:00.000Z"), null);
});

test("每日闹钟按用户时区计算下一次触发", () => {
  const schedule = { mode: "daily", timeOfDay: "09:30", timezone: "Asia/Shanghai" };
  assert.equal(nextAlarmOccurrence(schedule, "2026-07-20T00:00:00.000Z"), "2026-07-20T01:30:00.000Z");
  assert.equal(nextAlarmOccurrence(schedule, "2026-07-20T02:00:00.000Z"), "2026-07-21T01:30:00.000Z");
});

test("工作日和每周闹钟跳过不允许的日期", () => {
  const weekdays = { mode: "weekdays", timeOfDay: "09:00", timezone: "Asia/Shanghai" };
  assert.equal(nextAlarmOccurrence(weekdays, "2026-07-17T02:00:00.000Z"), "2026-07-20T01:00:00.000Z");

  const weekly = { mode: "weekly", timeOfDay: "15:00", weekdays: [1, 3], timezone: "Asia/Shanghai" };
  assert.equal(nextAlarmOccurrence(weekly, "2026-07-20T08:00:00.000Z"), "2026-07-22T07:00:00.000Z");
});

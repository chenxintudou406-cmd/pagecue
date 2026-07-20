const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("3.0 插件只保留页面提醒、提醒库和工具箱，并使用邀请码身份", () => {
  const html = read("extension/sidepanel/index.html") + read("extension/sidepanel/app.js");
  const app = read("extension/sidepanel/app.js");
  const worker = read("extension/background/service-worker.js");
  for (const tab of ["alerts", "memos", "tools"]) assert.match(html, new RegExp(`data-tab="${tab}"`));
  assert.doesNotMatch(html, /data-tab="alarms"|alarm-dialog|personal-alarms/);
  assert.match(html, /invite-code/);
  assert.doesNotMatch(html, /name="userId"|id="user-id"/);
  assert.doesNotMatch(worker, /X-User-Id|user_demo/);
  assert.match(worker, /Authorization: `Bearer/);
  assert.match(app, /MATCH_ACTION/);
});

test("3.0.4 后台 iframe 和普通搜索输入值可在本地参与匹配", () => {
  const worker = read("extension/background/service-worker.js");
  const content = read("extension/content/content.js");
  assert.match(worker, /allFrames:\s*true/);
  assert.match(content, /input\[type="text"\]/);
  assert.match(content, /input\[type="search"\]/);
  assert.match(content, /field\.value\.trim\(\)/);
  assert.match(content, /input\[type="password"\]/);
  assert.match(content, /password\|passwd\|pwd\|token\|secret\|credential/);
  assert.match(content, /addEventListener\("input"/);
  assert.match(content, /addEventListener\("change"/);
  assert.match(content, /chrome\.storage\.onChanged\.addListener/);
});

test("3.0 退休个人闹钟，只保留每小时规则同步并清理旧计划", () => {
  const html = read("extension/sidepanel/index.html") + read("extension/sidepanel/app.js");
  const worker = read("extension/background/service-worker.js");
  assert.match(worker, /PERSONAL_ALARM_PREFIX/);
  assert.match(worker, /clearPersonalAlarmSchedules/);
  assert.match(worker, /SYNC_INTERVAL_MINUTES = 60/);
  assert.doesNotMatch(worker, /schedulePersonalAlarms|ALARM_COMPLETE|ALARM_SNOOZE/);
  assert.doesNotMatch(html, /data-alarm-snooze|name="mode"/);
});

test("3.0 卡片明确区分知识操作与轻中重，网页卡宽度受控", () => {
  const html = read("extension/sidepanel/index.html") + read("admin/index.html");
  const content = read("extension/content/content.js");
  const css = read("extension/content/content.css") + read("extension/sidepanel/styles.css");
  for (const value of ["light", "standard", "strong"]) assert.match(html, new RegExp(`value="${value}"`));
  for (const label of ["知识提醒", "操作提醒", "轻", "中", "重"]) assert.match(html + content, new RegExp(label));
  assert.match(css, /width:\s*360px/);
  assert.match(css, /#2f7df4/i);
  assert.match(css, /#e4b423/i);
  assert.match(css, /#de4141/i);
  assert.match(content, /负责：/);
  for (const className of ["cc-card-head", "cc-card-content", "cc-card-footer", "cc-level-pill"]) {
    assert.match(content, new RegExp(className));
  }
  assert.match(content, /memo\.links/);
  assert.match(content, /data-action="link"/);
  assert.match(content, /target="_blank"/);
  assert.match(content, /inline_link/);
  assert.match(content, /annotation_link/);
  assert.match(content, /data-cc-business-link/);
  assert.match(content, /cc-popover-card cc-card cc-template-/);
  assert.match(content, /cc-operation-card/);
  assert.match(content, /data-cc-popover-action="locate"/);
  assert.match(css, /\.cc-popover-card/);
  assert.match(css, /\.cc-template-light \.cc-card-head/);
  assert.doesNotMatch(content, /class="cc-popover-head"/);
  assert.match(content, /查看具体信息/);
  assert.match(content, /复制链接/);
  assert.match(content, /copyText/);
  assert.match(css, /min-height:\s*54px/);
  assert.match(css, /blur\(22px\)/);
  assert.doesNotMatch(content, /class="cc-level"/);
});

test("后台支持提醒类型、人员投放、多链接和成员邀请码管理", () => {
  const html = read("admin/index.html");
  const app = read("admin/app.js");
  for (const token of ["name=\"type\"", "name=\"targetUserIds\"", "name=\"links\"", "member-dialog", "invite-member", "data-operation-start"]) assert.match(html + app, new RegExp(token));
});

test("组织提醒只提供永久删除，不再保留撤回状态", () => {
  const html = read("admin/index.html");
  const app = read("admin/app.js");
  const server = read("server.js");
  assert.doesNotMatch(html, /<option value="archived">已撤回<\/option>/);
  assert.doesNotMatch(app, /确认撤回这条组织提醒|提醒已撤回/);
  assert.match(app, /确认永久删除这条组织提醒/);
  assert.match(app, /组织提醒已删除/);
  assert.match(app, /icons\.trash/);
  assert.match(server, /req\.method === "DELETE" && collection === "memos"/);
  assert.match(server, /db\[collection\]\.splice\(index, 1\)/);
  assert.match(server, /dispatchPush\(db, \{ type: "sync"/);
});
